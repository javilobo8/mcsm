import type { FastifyInstance, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_COOKIE } from "./plugin.js";

const passwordBody = z.object({ password: z.string().min(8, "Mínimo 8 caracteres").max(200) });

export async function authRoutes(app: FastifyInstance) {
  await app.register(rateLimit, { global: false });

  const setCookie = (reply: FastifyReply, sessionId: string) =>
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: "/", httpOnly: true, sameSite: "strict", signed: true, maxAge: app.config.sessionTtlSeconds,
    });

  app.get("/api/auth/status", async (req) => ({
    configured: app.auth.getSetting("admin_password_hash") !== null,
    authenticated: req.sessionId !== null,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (app.auth.getSetting("admin_password_hash")) return reply.code(409).send({ error: "La contraseña ya está configurada" });
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" });
    app.auth.setSetting("admin_password_hash", await hashPassword(parsed.data.password));
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = passwordBody.safeParse(req.body);
    const stored = app.auth.getSetting("admin_password_hash");
    if (!parsed.success || !stored || !(await verifyPassword(parsed.data.password, stored))) {
      return reply.code(401).send({ error: "Contraseña incorrecta" });
    }
    app.auth.purgeExpired();
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) app.auth.deleteSession(req.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
