import type { ServerResponse } from "node:http";
import { finished, type Readable } from "node:stream";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { baseName, filePathSchema } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { contentLength } from "../transfers/routes.js";
import { FilesService } from "./service.js";
import { contentDisposition } from "./disposition.js";
import { drain, type Timers } from "./stream.js";

const pathQuery = z.object({ path: filePathSchema });
const writeBody = z.object({ path: filePathSchema, content: z.string({ error: "Missing content" }) });
const renameBody = z.object({ from: filePathSchema, to: filePathSchema });

/** 2 MiB of text can take up quite a bit more in JSON (escapes); the real limit is applied by the service. */
const WRITE_BODY_LIMIT = 16 * 1024 * 1024;

/** Decorates the service at the root and registers the encapsulated routes (errors: global handler). */
export const fileRoutes = fp(async function fileRoutes(root: FastifyInstance) {
  root.decorate("filesService", new FilesService(root));
  await root.register(fileRoutesInner);
}, { name: "files" });

/**
 * "The browser left" signal: aborted if the response closes without having finished (the
 * browser cancelled, the network dropped or the panel cut the connection on shutdown). Fastify's
 * `request.signal` does not work: it fires as soon as the request body has been read, with the
 * upload still waiting for the agent's response.
 */
function browserGone(reply: FastifyReply, live: Set<ServerResponse>): AbortSignal {
  const res = reply.raw;
  const ctrl = new AbortController();
  if (res.destroyed) {
    ctrl.abort();
    return ctrl.signal;
  }
  live.add(res);
  res.once("close", () => {
    live.delete(res);
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

/**
 * "Short read" after responding with `Connection: close` to an upload that was not fully drained: Node
 * closes the connection when sending the response; if for whatever reason it stayed open, the body is
 * destroyed after this time.
 */
const LINGER_MS = 2_000;

/** Download headers that are not valid for a JSON error response. */
const DOWNLOAD_ONLY_HEADERS = ["content-type", "content-length", "content-disposition"];

/**
 * Prepares the error response of an upload: drains up to DRAIN_MAX_BYTES so the browser
 * receives the JSON (if it is cut off while sending, it usually shows "network error" instead of the message).
 * If more is still to arrive, the response carries `Connection: close` and the rest is not waited for.
 */
async function settleBody(body: Readable, reply: FastifyReply, timers: Timers): Promise<void> {
  if (await drain(body, { timers })) return;
  if (body.destroyed) return; // the browser left or went silent: there is nobody to respond to
  reply.header("connection", "close");
  reply.raw.once("finish", () => {
    const disarm = timers.set(() => body.destroy(), LINGER_MS);
    body.once("close", disarm);
  });
}

async function fileRoutesInner(app: FastifyInstance) {
  const svc = app.filesService;

  // Transfers with the browser in progress. They are cut when the panel shuts down: the HTTP server
  // waits for open requests and a large upload or download would hold it back (for hours). The
  // agent's are cut by `transfers.closeAll`; here, the browser's.
  const live = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const res of live) res.destroy();
  });

  type P = { Params: { id: string } };

  app.get<P>("/api/servers/:id/files", async (req) => svc.list(req.params.id, pathQuery.parse(req.query).path));

  app.get<P>("/api/servers/:id/files/upload-check", async (req, reply) => {
    svc.uploadCheck(req.params.id);
    return reply.code(204).send();
  });

  app.get<P>("/api/servers/:id/files/stat", async (req) => svc.stat(req.params.id, pathQuery.parse(req.query).path));

  app.get<P>("/api/servers/:id/files/content", async (req) => svc.read(req.params.id, pathQuery.parse(req.query).path));

  app.post<P>("/api/servers/:id/files/content", { bodyLimit: WRITE_BODY_LIMIT }, async (req, reply) => {
    const { path, content } = writeBody.parse(req.body);
    await svc.write(req.params.id, path, content);
    return reply.code(204).send();
  });

  app.post<P>("/api/servers/:id/files/mkdir", async (req, reply) => {
    await svc.mkdir(req.params.id, pathQuery.parse(req.body).path);
    return reply.code(204).send();
  });

  app.post<P>("/api/servers/:id/files/rename", async (req, reply) => {
    const { from, to } = renameBody.parse(req.body);
    await svc.rename(req.params.id, from, to);
    return reply.code(204).send();
  });

  app.delete<P>("/api/servers/:id/files", async (req, reply) => {
    await svc.remove(req.params.id, pathQuery.parse(req.query).path);
    return reply.code(204).send();
  });

  // ── transfers with the browser (without going through the panel's disk) ──
  // The octet-stream body arrives as a stream, unread and without bodyLimit (Fastify only applies it to
  // parsers with parseAs): neither the default 1 MiB cap nor WRITE_BODY_LIMIT.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.get<P>("/api/servers/:id/files/download", {
    // No automatic HEAD: a HEAD would ask the agent to upload the whole file.
    exposeHeadRoute: false,
    // A stream failure before the first byte (e.g. the node sends nothing) is answered in
    // JSON. Fastify already copied the download headers into the raw response: with its
    // Content-Type it would not serialize the JSON (FST_ERR_REP_INVALID_PAYLOAD_TYPE → 500) and with its
    // Content-Disposition the browser would save the error as if it were the file.
    onError: async (_req, reply) => {
      for (const h of DOWNLOAD_ONLY_HEADERS) {
        reply.removeHeader(h);
        if (!reply.raw.headersSent) reply.raw.removeHeader(h);
      }
    },
  }, async (req, reply) => {
    const { path } = pathQuery.parse(req.query);
    const gone = browserGone(reply, live);
    const dl = await svc.download(req.params.id, path, gone);
    // The agent confirms (Ack) when its PUT finishes. If the confirmation does not arrive (e.g. the WS drops)
    // but the browser received the whole file, it is only informational; if the download was cut,
    // Fastify already logs that cut, or it was the browser that cancelled.
    dl.done.catch((e) => {
      finished(reply.raw, () => {
        if (reply.raw.writableFinished) req.log.info({ err: e, path }, "the download reached the browser in full, but the agent did not confirm it");
      });
    });
    reply.header("content-type", "application/octet-stream");
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    reply.header("content-disposition", contentDisposition(baseName(path)));
    if (dl.size !== null) reply.header("content-length", String(dl.size));
    return reply.send(dl.stream);
  });

  app.put<P>("/api/servers/:id/files/upload", async (req, reply) => {
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw new HttpError(415, "Send the file as application/octet-stream");
    const gone = browserGone(reply, live);
    try {
      const { path } = pathQuery.parse(req.query);
      if (path === "/") throw new HttpError(400, "Specify the destination file path");
      await svc.upload(req.params.id, path, body, contentLength(req), gone);
    } catch (e) {
      await settleBody(body, reply, svc.timers);
      throw e;
    }
    return reply.code(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance { filesService: FilesService }
}
