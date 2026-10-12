import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:"), config: { publicUrl: "http://panel.lan:8080" } });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

describe("nodos y alta", () => {
  it("genera token de alta con docker run y lo canjea una sola vez", async () => {
    let res = await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } });
    expect(res.statusCode).toBe(200);
    const { token, dockerRun, expiresAt } = res.json();
    expect(token).toHaveLength(43);
    expect(dockerRun).toContain("ENROLL_TOKEN=" + token);
    expect(dockerRun).toContain("PANEL_URL=http://panel.lan:8080");
    expect(dockerRun).toContain("/var/run/docker.sock");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint: "nas", agentVersion: "0.1.0" } });
    expect(res.statusCode).toBe(200);
    const { nodeId, nodeToken } = res.json();
    expect(nodeId).toBeTruthy();
    expect(nodeToken).toHaveLength(43);

    res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint: "nas", agentVersion: "0.1.0" } });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } });
    const nodes = res.json();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: nodeId, name: "nas", status: "offline", dataRoot: "/srv/minecraft" });
    expect(nodes[0].tokenHash).toBeUndefined();
  });

  it("desambigua nombres repetidos y rechaza tokens inventados", async () => {
    for (const expected of ["nas", "nas-2"]) {
      const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
      const res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "x" } });
      expect(res.statusCode).toBe(200);
      const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
      expect(nodes.map((n: any) => n.name)).toContain(expected);
    }
    const res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: "nope", nameHint: "x", agentVersion: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("renombra, cambia data_root y borra", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "a" } })).json().token;
    const { nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "a", agentVersion: "x" } })).json();
    let res = await app.inject({ method: "PATCH", url: `/api/nodes/${nodeId}`, headers: { cookie }, payload: { name: "salon", dataRoot: "/mnt/mc" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "salon", dataRoot: "/mnt/mc" });
    res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } });
    expect(res.json()).toHaveLength(0);
  });
});

const enroll = (token: string, nameHint = "x") =>
  app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint, agentVersion: "x" } });
const newToken = async (payload: Record<string, unknown> = { nameHint: "n" }) =>
  (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload })).json();

describe("alta: dataRoot, caducidad, reuso y sesión", () => {
  it("persiste el dataRoot del token de alta en el nodo creado", async () => {
    const { token } = await newToken({ nameHint: "mc", dataRoot: "/data/mc" });
    expect((await enroll(token, "mc")).statusCode).toBe(200);
    const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
    expect(nodes[0]).toMatchObject({ name: "mc", dataRoot: "/data/mc" });
  });

  it("token caducado -> 401", async () => {
    const { token } = await newToken();
    app.db.prepare("UPDATE enrollment_tokens SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect((await enroll(token)).statusCode).toBe(401);
  });

  it("token ya usado -> 401 y no crea un segundo nodo", async () => {
    const { token } = await newToken();
    expect((await enroll(token)).statusCode).toBe(200);
    expect((await enroll(token)).statusCode).toBe(401);
    const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
    expect(nodes).toHaveLength(1);
  });

  it("rechaza dataRoot que no sea ruta absoluta segura", async () => {
    for (const dataRoot of ["/a; rm -rf /", "relativa/x", "/a/../b", "/a b", "/" + "x".repeat(201)]) {
      const res = await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { dataRoot } });
      expect(res.statusCode, dataRoot).toBe(400);
    }
  });

  it("sin sesión, las rutas de nodos responden 401", async () => {
    const cases = [
      { method: "GET", url: "/api/nodes" },
      { method: "POST", url: "/api/nodes/enrollment-tokens", payload: { nameHint: "n" } },
      { method: "PATCH", url: "/api/nodes/abc", payload: { name: "z" } },
      { method: "DELETE", url: "/api/nodes/abc" },
    ] as const;
    for (const c of cases) {
      const res = await app.inject(c as any);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });
});

describe("app.nodes en la raíz", () => {
  it("tras buildApp y ready, app.nodes está definido en la raíz", () => {
    expect(app.nodes).toBeDefined();
    expect(typeof app.nodes.list).toBe("function");
  });
});

describe("snippet de shell", () => {
  it("entrecomilla con comillas simples los valores que no son seguros", async () => {
    const { dockerRunSnippet } = await import("./routes.js");
    const s = dockerRunSnippet("http://h'x;rm", "tok", "/data/mc");
    expect(s).toContain("PANEL_URL='http://h'\\''x;rm'");
    expect(s).toContain("ENROLL_TOKEN=tok");
    expect(s).toContain("DATA_ROOT=/data/mc");
  });
});
