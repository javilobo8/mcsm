import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("nodes and enrollment", () => {
  it("generates an enrollment token with docker run and redeems it only once", async () => {
    let res = await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } });
    expect(res.statusCode).toBe(200);
    const { token, dockerRun, expiresAt } = res.json();
    expect(token).toHaveLength(43);
    expect(dockerRun).toContain("ENROLL_TOKEN=" + token);
    expect(dockerRun).toContain("PANEL_URL=http://panel.lan:8080");
    expect(dockerRun).toContain("/var/run/docker.sock");
    // docker stop kills after 10 s; the agent needs up to 25 s to close its file and backup operations.
    expect(dockerRun.match(/--stop-timeout 30/g)).toHaveLength(1);
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

  it("disambiguates repeated names and rejects made-up tokens", async () => {
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

  it("renames, changes data_root and deletes", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "a" } })).json().token;
    const { nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "a", agentVersion: "x" } })).json();
    let res = await app.inject({ method: "PATCH", url: `/api/nodes/${nodeId}`, headers: { cookie }, payload: { name: "salon", dataRoot: "/mnt/mc" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "salon", dataRoot: "/mnt/mc" });
    const forget = vi.spyOn(app.metrics, "forgetNode");
    res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(forget).toHaveBeenCalledWith(nodeId); // no leak of the deleted node's clock skew
    res = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } });
    expect(res.json()).toHaveLength(0);
  });
});

const enroll = (token: string, nameHint = "x") =>
  app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint, agentVersion: "x" } });
const newToken = async (payload: Record<string, unknown> = { nameHint: "n" }) =>
  (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload })).json();

describe("enrollment: dataRoot, expiry, reuse and session", () => {
  it("persists the enrollment token's dataRoot on the created node", async () => {
    const { token } = await newToken({ nameHint: "mc", dataRoot: "/data/mc" });
    expect((await enroll(token, "mc")).statusCode).toBe(200);
    const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
    expect(nodes[0]).toMatchObject({ name: "mc", dataRoot: "/data/mc" });
  });

  it("expired token -> 401", async () => {
    const { token } = await newToken();
    app.db.prepare("UPDATE enrollment_tokens SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect((await enroll(token)).statusCode).toBe(401);
  });

  it("already used token -> 401 and does not create a second node", async () => {
    const { token } = await newToken();
    expect((await enroll(token)).statusCode).toBe(200);
    expect((await enroll(token)).statusCode).toBe(401);
    const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
    expect(nodes).toHaveLength(1);
  });

  it("rejects a dataRoot that is not a safe absolute path", async () => {
    for (const dataRoot of ["/a; rm -rf /", "relativa/x", "/a/../b", "/a b", "/" + "x".repeat(201)]) {
      const res = await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { dataRoot } });
      expect(res.statusCode, dataRoot).toBe(400);
    }
  });

  it("without a session, the node routes respond 401", async () => {
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

describe("app.nodes at the root", () => {
  it("after buildApp and ready, app.nodes is defined at the root", () => {
    expect(app.nodes).toBeDefined();
    expect(typeof app.nodes.list).toBe("function");
  });
});

describe("snippet without PANEL_PUBLIC_URL", () => {
  it("uses the request's Host with its port", async () => {
    const other = await buildApp({ db: openDb(":memory:"), config: { publicUrl: "" } });
    try {
      const setup = await other.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
      const c = setup.cookies.find((c) => c.name === "mcsm_session")!;
      const res = await other.inject({
        method: "POST", url: "/api/nodes/enrollment-tokens",
        headers: { cookie: `${c.name}=${c.value}`, host: "192.168.1.10:8080" }, payload: { nameHint: "nas" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dockerRun).toContain("PANEL_URL=http://192.168.1.10:8080 ");
    } finally {
      await other.close();
    }
  });
});

describe("shell snippet", () => {
  it("single-quotes values that are not safe", async () => {
    const { dockerRunSnippet } = await import("./routes.js");
    const s = dockerRunSnippet("http://h'x;rm", "tok", "/data/mc");
    expect(s).toContain("PANEL_URL='http://h'\\''x;rm'");
    expect(s).toContain("ENROLL_TOKEN=tok");
    expect(s).toContain("DATA_ROOT=/data/mc");
  });

  it("ends with the agent image: the local default or the given one, quoted if needed", async () => {
    const { dockerRunSnippet } = await import("./routes.js");
    expect(dockerRunSnippet("http://p", "tok").split("\n").at(-1)).toBe("  mcsm-agent:latest");
    const s = dockerRunSnippet("http://p", "tok", "/srv/minecraft", "ghcr.io/javilobo8/mcsm-agent:0.9.0");
    expect(s.split("\n").at(-1)).toBe("  ghcr.io/javilobo8/mcsm-agent:0.9.0");
    expect(dockerRunSnippet("http://p", "tok", "/srv/minecraft", "x;rm -rf /").split("\n").at(-1)).toBe("  'x;rm -rf /'");
  });
});

describe("agent image in enrollment", () => {
  it("uses config.agentImage (MCSM_AGENT_IMAGE, set in the published panel image)", async () => {
    const other = await buildApp({ db: openDb(":memory:"), config: { publicUrl: "http://panel.lan:8080", agentImage: "ghcr.io/javilobo8/mcsm-agent:1.2.3" } });
    try {
      await other.ready();
      const setup = await other.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
      const c = setup.cookies.find((c) => c.name === "mcsm_session")!;
      const res = await other.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie: `${c.name}=${c.value}` }, payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().dockerRun.split("\n").at(-1)).toBe("  ghcr.io/javilobo8/mcsm-agent:1.2.3");
    } finally {
      await other.close();
    }
  });
});
