import {
  CF_ID_RE, CONTENT_KINDS, CONTENT_PLATFORMS, MODRINTH_ID_RE, contentSearchQuerySchema, contentVersionsQuerySchema,
  lookupRequestSchema, resolveRequestSchema, updatesRequestSchema, type ContentPlatform,
} from "@mcsm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import type { ContentCatalog } from "./catalog.js";

/** Modrinth accepts a project id or its slug in the path. */
const MODRINTH_SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const categoriesQuery = z.object({ kind: z.enum(CONTENT_KINDS) }).strict();
const imageQuery = z.object({ url: z.string().max(2048) }).strict();

/** Headers of a proxied image: never rendered as a document, never sniffed, kept private. */
export const IMAGE_HEADERS = {
  "cache-control": "private, max-age=86400",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

function platformOf(p: string): ContentPlatform {
  if (!(CONTENT_PLATFORMS as readonly string[]).includes(p)) throw new HttpError(404, "Not found");
  return p as ContentPlatform;
}

function projectIdOf(platform: ContentPlatform, id: string): string {
  const ok = platform === "modrinth" ? MODRINTH_ID_RE.test(id) || MODRINTH_SLUG_RE.test(id) : CF_ID_RE.test(id);
  if (!ok) throw new HttpError(400, "Invalid project id");
  return id;
}

function versionIdOf(platform: ContentPlatform, id: string): string {
  if (!(platform === "modrinth" ? MODRINTH_ID_RE : CF_ID_RE).test(id)) throw new HttpError(400, "Invalid version id");
  return id;
}

/**
 * Content browser (plan 11): Modrinth and CurseForge through the panel (the CSP keeps the browser on 'self'). Params
 * and query are validated before any request leaves; all routes go through the session guard, POSTs also through
 * the Origin check.
 */
export async function contentRoutes(app: FastifyInstance) {
  type P = { Params: { platform: string } };
  type PP = { Params: { platform: string; projectId: string } };

  app.get<P>("/api/content/:platform/search", async (req) => {
    const adapter = app.content.adapter(platformOf(req.params.platform));
    const q = contentSearchQuerySchema.parse(req.query);
    return adapter.search({ ...q, gameVersion: q.gameVersion ?? null, category: q.category ?? null });
  });

  app.get<P>("/api/content/:platform/categories", async (req) => {
    const adapter = app.content.adapter(platformOf(req.params.platform));
    return { categories: await adapter.categories(categoriesQuery.parse(req.query).kind) };
  });

  app.get<PP>("/api/content/:platform/projects/:projectId", async (req) => {
    const platform = platformOf(req.params.platform);
    return app.content.adapter(platform).project(projectIdOf(platform, req.params.projectId));
  });

  app.get<PP>("/api/content/:platform/projects/:projectId/versions", async (req) => {
    const platform = platformOf(req.params.platform);
    const id = projectIdOf(platform, req.params.projectId);
    const q = contentVersionsQuerySchema.parse(req.query);
    return app.content.adapter(platform).versions(id, { ...q, gameVersion: q.gameVersion ?? null });
  });

  app.get<{ Params: { platform: string; projectId: string; versionId: string } }>("/api/content/:platform/packs/:projectId/:versionId", async (req) => {
    const platform = platformOf(req.params.platform);
    const projectId = projectIdOf(platform, req.params.projectId);
    return app.content.adapter(platform).pack(projectId, versionIdOf(platform, req.params.versionId));
  });

  app.post("/api/content/lookup", async (req) => ({ entries: await app.content.lookup(lookupRequestSchema.parse(req.body).entries) }));
  app.post("/api/content/resolve", async (req) => app.content.resolve(resolveRequestSchema.parse(req.body)));
  app.post("/api/content/updates", async (req) => ({ updates: await app.content.updates(updatesRequestSchema.parse(req.body)) }));

  app.get("/api/content/image", async (req, reply) => {
    const img = await app.content.image(imageQuery.parse(req.query).url);
    return reply.headers({ ...IMAGE_HEADERS, "content-type": img.contentType }).send(img.data);
  });
}

declare module "fastify" {
  interface FastifyInstance {
    content: ContentCatalog;
  }
}
