import type { FastifyInstance, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { formatZodError, passwordChangeSchema } from "@mcsm/shared";
import { hashToken, safeEqualHex } from "../lib/tokens.js";
import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_COOKIE } from "./plugin.js";
import { FailureLimiter, ipKey } from "../lib/security.js";

const passwordBody = z.object({ password: z.string().min(8, "Minimum 8 characters").max(200) });
const setupBody = passwordBody.extend({ setupToken: z.string().max(200).optional() });

export async function authRoutes(app: FastifyInstance) {
  await app.register(rateLimit, { global: false, keyGenerator: (req) => ipKey(req.ip) });
  const failures = new FailureLimiter(); // plan-9 (L6): one per panel instance

  const setCookie = (reply: FastifyReply, sessionId: string) =>
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: "/", httpOnly: true, sameSite: "strict", signed: true, maxAge: app.config.sessionTtlSeconds,
    });

  app.get("/api/auth/status", async (req) => ({
    configured: app.auth.getSetting("admin_password_hash") !== null,
    authenticated: req.sessionId !== null,
    setupTokenRequired: app.config.setupToken !== "" && app.auth.getSetting("admin_password_hash") === null,
  }));

  app.post("/api/auth/setup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const yaConfigurada = () => reply.code(409).send({ error: "The password is already configured" });
    if (app.auth.getSetting("admin_password_hash")) return yaConfigurada();
    const parsed = setupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
    if (app.config.setupToken && !safeEqualHex(hashToken(parsed.data.setupToken ?? ""), hashToken(app.config.setupToken))) {
      return reply.code(403).send({ error: "Wrong setup token: it is in the panel log (docker compose logs panel)" });
    }
    const hash = await hashPassword(parsed.data.password);
    // Atomic: if another setup won while we were hashing, the insert does nothing.
    if (!app.auth.setSettingIfAbsent("admin_password_hash", hash)) return yaConfigurada();
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (failures.blocked()) {
      return reply.code(429).send({ error: "Too many failed attempts in the last minute: wait a moment and try again" });
    }
    const parsed = passwordBody.safeParse(req.body);
    const stored = app.auth.getSetting("admin_password_hash");
    // After the await, the hash may have changed (password change in between): the credential is no longer valid.
    if (!parsed.success || !stored || !(await verifyPassword(parsed.data.password, stored)) || app.auth.getSetting("admin_password_hash") !== stored) {
      failures.fail();
      return reply.code(401).send({ error: "Wrong password" });
    }
    app.auth.purgeExpired();
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  // Session required (not in the guard's public list). A wrong current password is 400, not 401: in the web a
  // 401 outside /api/auth/ means an expired session.
  app.post("/api/auth/password", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (failures.blocked()) {
      return reply.code(429).send({ error: "Too many failed attempts in the last minute: wait a moment and try again" });
    }
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: formatZodError(parsed.error) });
    const stored = app.auth.getSetting("admin_password_hash");
    if (!stored || !(await verifyPassword(parsed.data.currentPassword, stored))) {
      failures.fail();
      return reply.code(400).send({ error: "The current password is not correct" });
    }
    app.auth.setSetting("admin_password_hash", await hashPassword(parsed.data.newPassword));
    // All of them, including the current one (it may be the stolen cookie that motivates the change), and a new one for whoever changes it.
    app.auth.deleteAllSessions();
    app.events.emit("sessions_revoked"); // closes the WS of all sessions
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) {
      app.auth.deleteSession(req.sessionId);
      app.events.emit("sessions_revoked", req.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
