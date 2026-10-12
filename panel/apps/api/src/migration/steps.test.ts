import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { JobStatus } from "@mcsm/proto";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { FakeNode, sha256 } from "../../test/fake-node.js";
import { ManualTimers } from "../../test/manual-timers.js";
import type { MigrationRow } from "./repo.js";
import { abortTarget, DEFAULT_TIMINGS, pushToPanel, receiveOnTarget, startAndVerify, stagingId, type StepDeps } from "./steps.js";
import { waitJob } from "./wait.js";

let app: FastifyInstance; let url: string; let cookie: string; let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcsm-mig-steps-"));
  app = await buildApp({ db: openDb(":memory:"), config: { dataDir } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const spec = (game: number) => specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game }, rconPassword: "abcdefgh" });
const NAME = "uno-20261012T040000.000Z-1.tar.zst";
const stagingFiles = (): string[] => { try { return readdirSync(join(dataDir, "staging")); } catch { return []; } };

async function setup(): Promise<{ a: FakeNode; b: FakeNode; m: MigrationRow; d: StepDeps; timers: ManualTimers }> {
  const a = await FakeNode.enroll(app, url, cookie, "a");
  const b = await FakeNode.enroll(app, url, cookie, "b");
  const s = app.servers.create({ nodeId: a.id, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
  await a.connect({ [s.id]: 1n });
  await b.connect();
  const m = app.migrations.insert({
    id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "uno", target_slug: "uno",
    source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565)), was_running: 1, delete_source: 0,
  });
  const timers = new ManualTimers();
  const d: StepDeps = {
    app, timers, timings: { ...DEFAULT_TIMINGS, freeSpace: async () => 1e12 },
    report: { step: () => {}, within: () => {}, message: () => {}, log: () => {} },
  };
  return { a, b, m, d, timers };
}

describe("pushToPanel", () => {
  it("guarda la copia en el staging con tamaño y sha256 comprobados", async () => {
    const { a, m, d } = await setup();
    const payload = randomBytes(200_000);
    const pushing = pushToPanel(d, m, { filename: NAME, sizeBytes: payload.length, sha256: sha256(payload) });
    const push = await a.next("backupPush");
    if (push.body.case !== "backupPush") throw new Error();
    expect(push.body.value).toMatchObject({ serverId: m.server_id, filename: NAME });
    expect(await a.put(push.body.value.transferId, payload)).toBe(204);
    a.send({ id: push.id, body: { case: "backupPushResult", value: { sizeBytes: BigInt(payload.length), sha256: sha256(payload), dataBytes: 900_000n } } });
    const pushed = await pushing;
    expect(pushed.dataBytes).toBe(900_000);
    expect(readFileSync(pushed.staged.path).equals(payload)).toBe(true);
  });

  it("una copia que llega distinta se rechaza y no queda en el staging", async () => {
    const { a, m, d } = await setup();
    const payload = randomBytes(100_000);
    const pushing = pushToPanel(d, m, { filename: NAME, sizeBytes: payload.length, sha256: sha256(payload) });
    pushing.catch(() => {});
    const push = await a.next("backupPush");
    if (push.body.case !== "backupPush") throw new Error();
    await a.put(push.body.value.transferId, randomBytes(payload.length));
    a.send({ id: push.id, body: { case: "backupPushResult", value: { sizeBytes: BigInt(payload.length), sha256: sha256(payload), dataBytes: 0n } } });
    await expect(pushing).rejects.toThrow(/dañada/);
    expect(stagingFiles()).toEqual([]);
  });

  it("sin espacio en el panel no pide nada al origen", async () => {
    const { a, m, d } = await setup();
    d.timings = { ...d.timings, freeSpace: async () => 1024 };
    await expect(pushToPanel(d, m, { filename: NAME, sizeBytes: 10, sha256: "ab".repeat(32) })).rejects.toThrow(/espacio en el panel/);
    await a.nothingFor(200);
  });
});

describe("startAndVerify", () => {
  it("marca target_started antes de la orden y espera a que el destino esté sano", async () => {
    const { b, m, d } = await setup();
    const p = startAndVerify(d, m);
    const start = await b.next("powerAction");
    expect(app.migrations.get(m.id)!.target_started).toBe(1);
    b.ack(start);
    b.observed(m.server_id, { state: "running", health: "starting" });
    b.observed(m.server_id, { state: "running", health: "healthy" });
    await expect(p).resolves.toMatchObject({ state: "running", health: "healthy" });
  });

  it("un servidor que se para en el destino falla al instante", async () => {
    const { b, m, d } = await setup();
    const p = startAndVerify(d, m);
    p.catch(() => {});
    b.ack(await b.next("powerAction"));
    b.observed(m.server_id, { state: "exited", exitCode: 1 });
    await expect(p).rejects.toThrow(/se paró en el destino.*código de salida 1/);
  });

  it("sin quedar sano en el plazo, falla", async () => {
    const { b, m, d, timers } = await setup();
    const p = startAndVerify(d, m);
    p.catch(() => {});
    b.ack(await b.next("powerAction"));
    await vi.waitFor(() => expect(timers.pending).toBeGreaterThan(0));
    timers.advance(DEFAULT_TIMINGS.verifyTimeoutMs);
    await expect(p).rejects.toThrow(/no quedó sano/);
  });

  it("si el agente rechaza el arranque, falla con su texto", async () => {
    const { b, m, d } = await setup();
    const p = startAndVerify(d, m);
    p.catch(() => {});
    b.fail(await b.next("powerAction"), "power_failed", "Bind for 0.0.0.0:25565 failed: port is already allocated");
    await expect(p).rejects.toThrow(/port is already allocated/);
  });
});

describe("waitJob", () => {
  it("se resuelve al terminar el job y falla si deja de avanzar", async () => {
    const timers = new ManualTimers();
    const j = app.jobs.create({ type: "backup", status: "running" });
    const seen: number[] = [];
    const w = waitJob(app, j.id, { idleMs: 1000, timers, idleMessage: "parado", onProgress: (x) => seen.push(x.progress) });
    app.jobs.update(j.id, { progress: 40 });
    app.jobs.finish(j.id, "ok", "hecho");
    await expect(w.promise).resolves.toMatchObject({ status: "ok" });
    expect(seen).toEqual([40]);
    const k = app.jobs.create({ type: "backup", status: "running" });
    const w2 = waitJob(app, k.id, { idleMs: 1000, timers, idleMessage: "parado" });
    timers.advance(1000);
    await expect(w2.promise).rejects.toThrow("parado");
  });
});

describe("deshacer en el destino", () => {
  it("abortTarget nunca envía MigrateAbort de una migración confirmada (el servidor ya vive en el destino)", async () => {
    const { b, m, d } = await setup();
    expect(app.migrations.commit(m, "running", null)).toBe(true);
    await expect(abortTarget(d, m)).rejects.toThrow(/confirmada/);
    app.migrations.update(m.id, { phase: "done", source_pending: 0 });
    await expect(abortTarget(d, m)).rejects.toThrow(/confirmada/);
    await b.nothingFor(200);
  });
});

describe("receiveOnTarget", () => {
  async function staged(m: { id: string }, payload: Buffer) {
    return app.staging.save(stagingId(m.id), Readable.from([payload]));
  }

  it("el reintento espera a que el destino confirme la limpieza antes de volver a pedir la copia", async () => {
    const { b, m, d } = await setup();
    const payload = randomBytes(40_000);
    const made = { filename: NAME, sizeBytes: payload.length, sha256: sha256(payload) };
    const p = receiveOnTarget(d, m, { staged: await staged(m, payload), dataBytes: 1000 }, made);
    p.catch(() => {});
    const rx1 = await b.next("migrateReceive");
    if (rx1.body.case !== "migrateReceive") throw new Error();
    expect(app.migrations.get(m.id)!.target_touched).toBe(1);
    b.ack(rx1);
    b.progress(rx1.body.value.jobId, m.server_id, "migrate_in", JobStatus.FAILED, 10, "se cortó la descarga");
    const abort = await b.next("migrateAbort");
    await b.nothingFor(200); // sin el Ack de la limpieza, no hay segundo MigrateReceive
    b.ack(abort);
    const rx2 = await b.next("migrateReceive");
    if (rx2.body.case !== "migrateReceive") throw new Error();
    expect(rx2.body.value.jobId).not.toBe(rx1.body.value.jobId);
    b.ack(rx2);
    expect(sha256(await b.get(rx2.body.value.transferId))).toBe(sha256(payload));
    b.progress(rx2.body.value.jobId, m.server_id, "migrate_in", JobStatus.OK, 100, "Copia recibida");
    await expect(p).resolves.toBeUndefined();
  });

  it("la copia espera al destino en cola: su transferencia no caduca a los 60 s (M2)", async () => {
    const { b, m, d } = await setup();
    const payload = randomBytes(20_000);
    const made = { filename: NAME, sizeBytes: payload.length, sha256: sha256(payload) };
    const p = receiveOnTarget(d, m, { staged: await staged(m, payload), dataBytes: 1000 }, made);
    p.catch(() => {});
    const rx = await b.next("migrateReceive");
    if (rx.body.case !== "migrateReceive") throw new Error();
    b.ack(rx);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000); // 10 min en cola en el destino
    try {
      expect(app.transfers.sweep()).toBe(0);
    } finally {
      clock.mockRestore();
    }
    expect(sha256(await b.get(rx.body.value.transferId))).toBe(sha256(payload));
    b.progress(rx.body.value.jobId, m.server_id, "migrate_in", JobStatus.OK, 100, "Copia recibida");
    await expect(p).resolves.toBeUndefined();
  });

  it("si el destino no confirma la limpieza del intento fallido, no se reintenta", async () => {
    const { b, m, d } = await setup();
    const payload = randomBytes(10_000);
    const made = { filename: NAME, sizeBytes: payload.length, sha256: sha256(payload) };
    const p = receiveOnTarget(d, m, { staged: await staged(m, payload), dataBytes: 1000 }, made);
    p.catch(() => {});
    const rx1 = await b.next("migrateReceive");
    if (rx1.body.case !== "migrateReceive") throw new Error();
    b.ack(rx1);
    b.progress(rx1.body.value.jobId, m.server_id, "migrate_in", JobStatus.FAILED, 10, "se cortó la descarga");
    b.fail(await b.next("migrateAbort"), "busy", "servidor ocupado o reservado");
    await expect(p).rejects.toThrow(/se cortó la descarga.*no se pudo limpiar/);
    await b.nothingFor(200);
  });
});
