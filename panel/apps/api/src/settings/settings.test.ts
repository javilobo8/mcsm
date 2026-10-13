import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import type { Config } from "../config.js";

let app: FastifyInstance; let cookie: string;

async function start(config: Partial<Config> = {}) {
  app = await buildApp({ db: openDb(":memory:"), config });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
}
afterEach(async () => { await app.close(); });

const get = () => app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload });

describe("settings", () => {
  it("default values: the environment's; session required", async () => {
    await start();
    expect((await get()).json()).toEqual({
      publicUrl: "", publicUrlSource: "request", envPublicUrl: "",
      gamePortRange: { from: 25565, to: 25600 }, defaultGamePortRange: { from: 25565, to: 25600 },
      connectAddress: { host: "", port: null },
      curseforge: { configured: false, valid: true },
    });
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
    await app.close();
    await start({ publicUrl: "http://env:8080" });
    expect((await get()).json()).toMatchObject({ publicUrl: "http://env:8080", publicUrlSource: "env", envPublicUrl: "http://env:8080" });
  });

  it("public URL: stored normalized, used by the enrollment command, and empty goes back to the environment", async () => {
    await start({ publicUrl: "http://env:8080" });
    const res = await put({ publicUrl: "http://192.168.1.10:8080/" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ publicUrl: "http://192.168.1.10:8080", publicUrlSource: "settings" });
    const enroll = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "n" } })).json();
    expect(enroll.dockerRun).toContain("PANEL_URL=http://192.168.1.10:8080");
    expect((await put({ publicUrl: "" })).json()).toMatchObject({ publicUrl: "http://env:8080", publicUrlSource: "env" });
    for (const bad of ["http://x/path", "ftp://x"]) expect((await put({ publicUrl: bad })).statusCode).toBe(400);
    expect((await put({ unknown: true })).statusCode).toBe(400);
  });

  it("connection address: stored normalized, replaced as a whole, validated", async () => {
    await start();
    const res = await put({ connectAddress: { host: " MC.Example.com ", port: 55567 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connectAddress).toEqual({ host: "mc.example.com", port: 55567 });
    expect((await get()).json().connectAddress).toEqual({ host: "mc.example.com", port: 55567 });
    expect((await put({ connectAddress: { host: "mc.example.com", port: null } })).json().connectAddress).toEqual({ host: "mc.example.com", port: null });
    for (const bad of [{ host: "mc.example.com:55567", port: null }, { host: "x", port: 70000 }, { host: "x" }]) {
      expect((await put({ connectAddress: bad })).statusCode).toBe(400);
    }
    expect((await get()).json().connectAddress).toEqual({ host: "mc.example.com", port: null });
  });

  it("an unreadable stored connection address falls back to the default", async () => {
    await start();
    app.db.prepare("INSERT INTO settings (key, value) VALUES ('connect_address', '{broken')").run();
    expect((await get()).json().connectAddress).toEqual({ host: "", port: null });
  });

  it("the WS accepts the origin of the stored public URL", async () => {
    await start();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const open = (origin: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers: { cookie, origin } });
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(0));
    });
    expect(await open("http://lan.home:8080")).toBe(403);
    await put({ publicUrl: "http://lan.home:8080" });
    expect(await open("http://lan.home:8080")).toBe(101);
  });

  it("port range: ports are allocated from the stored range and it is validated", async () => {
    await start();
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
    const { nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas" } })).json();
    expect((await put({ gamePortRange: { from: 26000, to: 26001 } })).json().gamePortRange).toEqual({ from: 26000, to: 26001 });
    const mk = (name: string) => app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name } });
    expect((await mk("One")).json().spec.ports.game).toBe(26000);
    expect((await mk("Two")).json().spec.ports.game).toBe(26001);
    const third = await mk("Tres");
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toMatch(/26000 and 26001/);
    for (const bad of [{ from: 30000, to: 29000 }, { from: 80, to: 90 }, { from: 20000, to: 40000 }]) {
      expect((await put({ gamePortRange: bad })).statusCode).toBe(400);
    }
  });

  it("CurseForge: warns if the stored key is not valid (migration 020 did not validate it)", async () => {
    await start();
    app.db.prepare("INSERT INTO settings (key, value) VALUES ('curseforge_api_key', 'with spaces inside')").run();
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } })).json()).toEqual({ configured: true, valid: false });
    expect((await get()).json().curseforge).toEqual({ configured: true, valid: false });
  });
});
