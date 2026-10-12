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
const writeBody = z.object({ path: filePathSchema, content: z.string({ error: "Falta el contenido" }) });
const renameBody = z.object({ from: filePathSchema, to: filePathSchema });

/** 2 MiB de texto pueden ocupar bastante más en JSON (escapes); el límite real lo aplica el servicio. */
const WRITE_BODY_LIMIT = 16 * 1024 * 1024;

/** Decora el servicio en la raíz y registra las rutas encapsuladas (errores: manejador global). */
export const fileRoutes = fp(async function fileRoutes(root: FastifyInstance) {
  root.decorate("filesService", new FilesService(root));
  await root.register(fileRoutesInner);
}, { name: "files" });

/**
 * Señal de "el navegador se fue": se aborta si la respuesta se cierra sin haber terminado (el
 * navegador canceló, se cayó la red o el panel cortó la conexión al cerrarse). No sirve
 * `request.signal` de Fastify: salta en cuanto se ha leído el cuerpo de la petición, con la
 * subida aún esperando la respuesta del agente.
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
 * "Lectura breve" tras responder con `Connection: close` a una subida que no se drenó entera: Node
 * cierra la conexión al enviar la respuesta; si por lo que sea siguiera abierta, el cuerpo se
 * destruye pasado este tiempo.
 */
const LINGER_MS = 2_000;

/** Cabeceras de la descarga que no valen para una respuesta de error en JSON. */
const DOWNLOAD_ONLY_HEADERS = ["content-type", "content-length", "content-disposition"];

/**
 * Prepara la respuesta de error de una subida: drena hasta DRAIN_MAX_BYTES para que el navegador
 * reciba el JSON (si se le corta mientras envía, suele mostrar "error de red" en vez del mensaje).
 * Si queda más por llegar, la respuesta lleva `Connection: close` y el resto no se espera.
 */
async function settleBody(body: Readable, reply: FastifyReply, timers: Timers): Promise<void> {
  if (await drain(body, { timers })) return;
  if (body.destroyed) return; // el navegador se fue o se calló: no hay a quién responder
  reply.header("connection", "close");
  reply.raw.once("finish", () => {
    const disarm = timers.set(() => body.destroy(), LINGER_MS);
    body.once("close", disarm);
  });
}

async function fileRoutesInner(app: FastifyInstance) {
  const svc = app.filesService;

  // Transferencias con el navegador en curso. Al cerrar el panel se cortan: el servidor HTTP
  // espera a las peticiones abiertas y una subida o descarga grande lo retendría (horas). Las
  // del agente las corta `transfers.closeAll`; aquí, las del navegador.
  const live = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const res of live) res.destroy();
  });

  type P = { Params: { id: string } };

  app.get<P>("/api/servers/:id/files", async (req) => svc.list(req.params.id, pathQuery.parse(req.query).path));

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

  // ── transferencias con el navegador (sin pasar por disco del panel) ──
  // El cuerpo octet-stream llega como stream, sin leer y sin bodyLimit (Fastify solo lo aplica a
  // los parsers con parseAs): ni el tope de 1 MiB por defecto ni el de WRITE_BODY_LIMIT.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.get<P>("/api/servers/:id/files/download", {
    // Sin HEAD automático: un HEAD pediría al agente subir el fichero entero.
    exposeHeadRoute: false,
    // Un fallo del stream antes del primer byte (p. ej. el nodo no envía nada) se responde en
    // JSON. Fastify ya copió las cabeceras de la descarga en la respuesta cruda: con su
    // Content-Type no serializaría el JSON (FST_ERR_REP_INVALID_PAYLOAD_TYPE → 500) y con su
    // Content-Disposition el navegador guardaría el error como si fuera el fichero.
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
    // El agente confirma (Ack) al terminar su PUT. Si la confirmación no llega (p. ej. cae el WS)
    // pero el navegador recibió el fichero entero, es solo informativo; si la descarga se cortó,
    // ese corte ya lo registra Fastify, o fue el navegador quien canceló.
    dl.done.catch((e) => {
      finished(reply.raw, () => {
        if (reply.raw.writableFinished) req.log.info({ err: e, path }, "la descarga llegó entera al navegador, pero el agente no la confirmó");
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
    if (!body || typeof body.pipe !== "function") throw new HttpError(415, "Envía el fichero como application/octet-stream");
    const gone = browserGone(reply, live);
    try {
      const { path } = pathQuery.parse(req.query);
      if (path === "/") throw new HttpError(400, "Indica la ruta del fichero de destino");
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
