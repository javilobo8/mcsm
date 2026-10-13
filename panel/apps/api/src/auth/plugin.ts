import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthRepo } from "./repo.js";
import { randomToken } from "../lib/tokens.js";
import { originAllowed } from "../lib/origin.js";

export const SESSION_COOKIE = "mcsm_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
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
    // Decided by the routed route pattern, not by the raw URL: find-my-way decodes
    // the path when routing, so `/%61pi/x` reaches `/api/x`.
    const route = req.routeOptions.url;
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value && repo.getSession(unsigned.value)) {
        req.sessionId = unsigned.value;
      }
    }
    if (route === undefined) return;
    // SameSite=Strict does not stop pages on the same host on another port: a write with an Origin that is not the
    // panel's is rejected (as on the WS). With no Origin (curl, agent) it passes; /agent/* is left out.
    if (route.startsWith("/api/") && !SAFE_METHODS.has(req.method) && !originAllowed(req.headers.origin, req.host, app.settings.publicUrl())) {
      return reply.code(403).send({ error: "Origin not allowed" });
    }
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
