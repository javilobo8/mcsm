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
