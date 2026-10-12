import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const DATA = "/home/lobo/mc/viejo";
/** Un importado con dataPath, insertado como lo hará ImportService (Task 10). */
function imported() {
  const row = app.servers.create({
    nodeId, name: "Viejo", slug: "viejo", desiredState: "running",
    spec: specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25570 }, rconPassword: "abcdefgh", dataPath: DATA }),
  });
  return app.servers.setImportedFrom(row.id, {
    containerId: "c".repeat(64), containerName: "viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z", composeProject: "casa", composeService: "viejo",
  });
}

describe("servidores importados", () => {
  it("la migración 050 deja imported_from en null para los servidores del panel; el DTO lo expone", async () => {
    const s = (await req("POST", "/api/servers", { nodeId, name: "Nuevo" })).json();
    expect(s.importedFrom).toBeNull();
    const row = imported();
    const dto = (await req("GET", `/api/servers/${row.id}`)).json();
    expect(dto.importedFrom).toMatchObject({ containerName: "viejo", specVersion: 1, composeProject: "casa" });
    expect(dto.spec.dataPath).toBe(DATA);
  });

  it("crear un servidor con dataPath da 400 (solo lo fija la importación)", async () => {
    const res = await req("POST", "/api/servers", { nodeId, name: "X", spec: { dataPath: "/home/lobo/otra" } });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH: el formulario conserva dataPath; cambiarlo o quitarlo (null) da 400", async () => {
    const row = imported();
    let res = await req("PATCH", `/api/servers/${row.id}`, { spec: { memory: "3G" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { memory: "3G", dataPath: DATA } });
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: "/home/lobo/otra" } });
    expect(res.statusCode).toBe(400);
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: DATA } });
    expect(res.json().specVersion).toBe(2);
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("importación");
    const after = (await req("GET", `/api/servers/${row.id}`)).json();
    expect(after).toMatchObject({ specVersion: 2, spec: { dataPath: DATA } });
  });

  it("con dataPath no se pueden programar copias", async () => {
    const row = imported();
    const res = await req("PATCH", `/api/servers/${row.id}`, { spec: { backups: { enabled: true, cron: "0 4 * * *" } } });
    expect(res.statusCode).toBe(400);
  });

  it("borrar con datos un servidor con dataPath da 400; sin datos se borra", async () => {
    const row = imported();
    let res = await req("DELETE", `/api/servers/${row.id}?deleteData=true`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(DATA);
    res = await req("DELETE", `/api/servers/${row.id}?deleteData=false`);
    expect(res.statusCode).toBe(204);
  });

  it("guardar un importado como plantilla no arrastra dataPath", async () => {
    const row = imported();
    const tpl = (await req("POST", "/api/templates", { name: "Del viejo", fromServerId: row.id })).json();
    expect(tpl.spec).not.toHaveProperty("dataPath");
  });
});
