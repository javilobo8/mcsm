import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { JobsRepo, type JobRow } from "./repo.js";
import { JobService, MAX_JOB_LOG } from "./service.js";

function makeService() {
  const db = openDb(":memory:");
  const events = new EventEmitter();
  const seen: unknown[][] = [];
  events.on("job", (...args: unknown[]) => seen.push(args));
  const repo = new JobsRepo(db);
  return { svc: new JobService(repo, events), repo, seen, db };
}

describe("JobService", () => {
  it("crea, avanza y termina emitiendo eventos; un job terminado ya no cambia", () => {
    const { svc, seen } = makeService();
    const j = svc.create({ type: "backup", status: "running", message: "Solicitando" });
    expect(j).toMatchObject({ status: "running", progress: 0, message: "Solicitando" });
    expect(j.startedAt).not.toBeNull();
    svc.update(j.id, { progress: 40, message: "Copiando", logChunk: "save-off\n" });
    svc.update(j.id, { logChunk: "save-all flush\n" });
    svc.finish(j.id, "ok", "Copia creada");
    svc.update(j.id, { status: "failed", message: "tarde" });
    const d = svc.get(j.id)!;
    expect(d).toMatchObject({ status: "ok", progress: 100, message: "Copia creada", log: "save-off\nsave-all flush\n" });
    expect(d.finishedAt).not.toBeNull();
    expect(seen).toHaveLength(4); // create + 2 avances + finish; el aviso tardío no emite
    expect(seen[1]![1]).toBe("save-off\n");
  });

  it("created_at es la hora del panel aunque el agente informe de otra: el barrido de perdidos no mata un job vivo", () => {
    const { svc, db } = makeService();
    db.prepare("INSERT INTO nodes (id, name, token_hash, data_root, created_at) VALUES ('n1', 'n', 'h', '/d', ?)").run(new Date().toISOString());
    const since = new Date().toISOString(); // inicio del BackupList del panel
    const agentStart = new Date(Date.parse(since) - 40_000).toISOString(); // reloj del agente atrasado
    const j = svc.create({ type: "backup", status: "running", nodeId: "n1", startedAt: agentStart });
    expect(j.startedAt).toBe(agentStart);
    expect(j.createdAt >= since).toBe(true);
    expect(svc.openAgentJobs("n1", since)).toEqual([]);
  });

  it("un log completo sustituye al guardado", () => {
    const { svc } = makeService();
    const j = svc.create({ type: "backup", status: "running" });
    svc.update(j.id, { logChunk: "parcial\n" });
    svc.update(j.id, { log: "completo\n", status: "ok" });
    expect(svc.get(j.id)!.log).toBe("completo\n");
  });

  it("recorta el log a 256 KiB conservando el final", () => {
    const { svc } = makeService();
    const j = svc.create({ type: "backup", status: "running" });
    const line = "x".repeat(1023) + "\n";
    for (let i = 0; i < 300; i++) svc.update(j.id, { logChunk: line });
    svc.update(j.id, { logChunk: "ULTIMA\n" });
    const log = svc.get(j.id)!.log;
    expect(log.length).toBeLessThanOrEqual(MAX_JOB_LOG);
    expect(log.startsWith("…(recortado)")).toBe(true);
    expect(log.endsWith("ULTIMA\n")).toBe(true);
  });

  it("lista los más nuevos primero y filtra por estado", () => {
    const { svc, repo } = makeService();
    const base: Omit<JobRow, "id" | "created_at" | "status"> = {
      type: "backup", server_id: null, node_id: null, progress: 0, message: "", log: "", payload: "{}", updated_at: "", started_at: null, finished_at: null,
    };
    repo.insert({ ...base, id: "a", status: "ok", created_at: "2026-10-12T04:00:00.000Z" });
    repo.insert({ ...base, id: "b", status: "running", created_at: "2026-10-12T05:00:00.000Z" });
    repo.insert({ ...base, id: "c", status: "ok", created_at: "2026-10-12T06:00:00.000Z" });
    expect(svc.list({}).map((j) => j.id)).toEqual(["c", "b", "a"]);
    expect(svc.list({ status: "ok" }).map((j) => j.id)).toEqual(["c", "a"]);
    expect(svc.list({ before: "2026-10-12T06:00:00.000Z", limit: 1 }).map((j) => j.id)).toEqual(["b"]);
  });

  it("purga solo los terminados antiguos", () => {
    const { svc } = makeService();
    const done = svc.create({ type: "backup", status: "running" });
    svc.finish(done.id, "ok", "hecho");
    const open = svc.create({ type: "backup", status: "running" });
    expect(svc.purgeFinishedBefore(new Date(Date.now() + 1000).toISOString())).toBe(1);
    expect(svc.get(done.id)).toBeNull();
    expect(svc.get(open.id)).not.toBeNull();
  });
});

describe("reinicio del panel", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcsm-jobs-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("los jobs a medias pasan a failed «interrumpido» salvo backup y restore", async () => {
    const path = join(dir, "panel.db");
    const app1 = await buildApp({ db: openDb(path) });
    await app1.ready();
    const applying = app1.jobs.create({ type: "apply_spec", status: "running" });
    const queued = app1.jobs.create({ type: "migrate" });
    const backup = app1.jobs.create({ type: "backup", status: "running" });
    const restore = app1.jobs.create({ type: "restore", status: "running" });
    const done = app1.jobs.create({ type: "apply_spec", status: "running" });
    app1.jobs.finish(done.id, "ok", "hecho");
    await app1.close();

    const app2 = await buildApp({ db: openDb(path) });
    await app2.ready();
    expect(app2.jobs.get(applying.id)).toMatchObject({ status: "failed", message: expect.stringMatching(/interrumpido/) });
    expect(app2.jobs.get(queued.id)!.status).toBe("failed");
    expect(app2.jobs.get(backup.id)!.status).toBe("running");
    expect(app2.jobs.get(restore.id)!.status).toBe("running");
    expect(app2.jobs.get(done.id)).toMatchObject({ status: "ok", message: "hecho" });
    await app2.close();
  });
});

describe("/api/jobs", () => {
  let app: FastifyInstance; let url: string; let cookie: string;

  beforeEach(async () => {
    app = await buildApp({ db: openDb(":memory:") });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const c = res.cookies.find((c) => c.name === "mcsm_session")!;
    cookie = `${c.name}=${c.value}`;
  });
  afterEach(async () => { await app.close(); });

  const get = (u: string) => app.inject({ method: "GET", url: u, headers: { cookie } });

  it("exige sesión", async () => {
    expect((await app.inject({ method: "GET", url: "/api/jobs" })).statusCode).toBe(401);
  });

  it("lista con filtros y devuelve el detalle con log", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
    const { nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json();
    const spec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec, desiredState: "running" });
    const mine = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" });
    app.jobs.update(mine.id, { logChunk: "save-off\n" });
    const other = app.jobs.create({ type: "backup", status: "running" });
    app.jobs.finish(other.id, "failed", "falló");

    let res = await get(`/api/jobs?serverId=${s.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().map((j: any) => j.id)).toEqual([mine.id]);
    expect(res.json()[0].log).toBeUndefined();
    res = await get("/api/jobs?status=failed");
    expect(res.json().map((j: any) => j.id)).toEqual([other.id]);
    expect((await get("/api/jobs?status=raro")).statusCode).toBe(400);
    res = await get("/api/jobs?status=queued,running");
    expect(res.json().map((j: any) => j.id)).toEqual([mine.id]);
    res = await get("/api/jobs?status=running,failed");
    expect(res.json().map((j: any) => j.id).sort()).toEqual([mine.id, other.id].sort());
    expect((await get("/api/jobs?status=running,raro")).statusCode).toBe(400);
    expect((await get("/api/jobs?status=")).statusCode).toBe(400);
    res = await get(`/api/jobs/${mine.id}`);
    expect(res.json()).toMatchObject({ id: mine.id, type: "backup", serverId: s.id, status: "running", log: "save-off\n" });
    expect((await get("/api/jobs/no-existe")).statusCode).toBe(404);
  });

  it("publica los cambios de jobs y de copias en el topic jobs del WebSocket", async () => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers: { cookie } });
    const queue: any[] = [];
    let wake: (() => void) | null = null;
    ws.on("message", (d) => { queue.push(JSON.parse(d.toString())); wake?.(); });
    const next = async () => {
      while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      return queue.shift();
    };
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "subscribe", topic: "jobs" }));
    // El hub atiende los mensajes en orden: el error de este llega después de procesar la suscripción.
    ws.send(JSON.stringify({ type: "subscribe", topic: "nope" }));
    expect(await next()).toMatchObject({ type: "error" });
    const j = app.jobs.create({ type: "backup", status: "running" });
    expect(await next()).toMatchObject({ type: "job", job: { id: j.id, status: "running" }, logChunk: "" });
    app.jobs.update(j.id, { logChunk: "save-off\n" });
    expect(await next()).toMatchObject({ type: "job", logChunk: "save-off\n" });
    app.events.emit("backups", "srv-1");
    expect(await next()).toEqual({ type: "backups", serverId: "srv-1" });
    ws.close();
  });
});

describe("avisos tardíos del agente", () => {
  it("ignora progreso y log que llegan tras un estado terminal (ok, failed, cancelled)", () => {
    const { svc, seen } = makeService();
    for (const st of ["ok", "failed", "cancelled"] as const) {
      const j = svc.create({ type: "backup", status: "running" });
      svc.finish(j.id, st, "fin");
      const before = seen.length;
      svc.update(j.id, { progress: 10, message: "tarde", logChunk: "tarde\n" });
      svc.update(j.id, { log: "otro\n" });
      expect(svc.get(j.id)).toMatchObject({ status: st, message: "fin", log: "" });
      expect(seen).toHaveLength(before);
    }
  });
});
