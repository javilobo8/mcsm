import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthRepo } from "./repo.js";
import { randomToken } from "../lib/tokens.js";

export const SESSION_COOKIE = "mcsm_session";
const PUBLIC = new Set(["/api/health", "/api/auth/status", "/api/auth/setup", "/api/auth/login"]);

async function plugin(app: FastifyInstance) {
  const repo = new AuthRepo(app.db);
  let secret = repo.getSetting("session_secret");
  if (!secret) {
    secret = randomToken();
    repo.setSetting("session_secret", secret);
  }
  await app.register(cookie, { secret });
  app.decorate("auth", repo);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    // Se decide por el patrón de ruta enrutada, no por la URL cruda: find-my-way decodifica
    // el path al enrutar, así que `/%61pi/x` llega a `/api/x`.
    const route = req.routeOptions.url;
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value && repo.getSession(unsigned.value)) {
        req.sessionId = unsigned.value;
      }
    }
    if (route === undefined) return;
    const protectedRoute = (route.startsWith("/api/") && !PUBLIC.has(route)) || route === "/ws";
    if (protectedRoute && !req.sessionId) {
      return reply.code(401).send({ error: "No autenticado" });
    }
  });
}

export const authPlugin = fp(plugin, { name: "auth" });

declare module "fastify" {
  interface FastifyInstance { auth: AuthRepo }
  interface FastifyRequest { sessionId: string | null }
}
