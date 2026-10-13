import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { loggerOptions, redactUrl } from "./log.js";
import { FailureLimiter, ipKey, SECURITY_HEADERS } from "./security.js";

describe("panel security", () => {
  it("headers on responses, also on errors", async () => {
    const app = await buildApp({ db: openDb(":memory:") });
    for (const url of ["/api/health", "/api/no-existe"]) {
      const res = await app.inject({ method: "GET", url });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers[k]).toBe(v);
    }
    expect(SECURITY_HEADERS["content-security-policy"]).toContain("frame-ancestors 'none'");
    await app.close();
  });

  it("ipKey groups IPv6 by /64", () => {
    expect(ipKey("192.168.1.10")).toBe("192.168.1.10");
    expect(ipKey("::ffff:192.168.1.10")).toBe("192.168.1.10");
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe(ipKey("2001:0db8:0001:0002:bbbb:0:0:2"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
    expect(ipKey("fe80::1%eth0")).toBe(ipKey("fe80::2"));
  });

  it("FailureLimiter: at most max failures per window", () => {
    let now = 0;
    const l = new FailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) { expect(l.blocked()).toBe(false); l.fail(); }
    expect(l.blocked()).toBe(true);
    now = 60_001;
    expect(l.blocked()).toBe(false);
  });

  it("global limit of login failures even if the IP changes", async () => {
    const app = await buildApp({ db: openDb(":memory:") });
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "mala" }, remoteAddress: `10.0.${i}.1` });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" }, remoteAddress: "10.9.9.9" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many failed attempts/);
    await app.close();
  });

  it("the access log does not show a transfer's id", async () => {
    expect(redactUrl("/agent/transfer/abc123?x=1")).toBe("/agent/transfer/[hidden]?x=1");
    expect(redactUrl("/api/servers/s1")).toBe("/api/servers/s1");
    let out = "";
    const stream = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const app = await buildApp({ db: openDb(":memory:"), logger: { ...(loggerOptions as object), level: "info", stream } });
    await app.inject({ method: "GET", url: "/agent/transfer/idsecreto123" });
    await app.close();
    expect(out).toContain("/agent/transfer/[hidden]");
    expect(out).not.toContain("idsecreto123");
  });
});
