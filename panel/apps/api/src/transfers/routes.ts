import { finished, type Readable } from "node:stream";
import { finished as finishedAsync } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../lib/http.js";
import { hashToken } from "../lib/tokens.js";
import type { NodeRow } from "../nodes/repo.js";
import { TransferError, type TransferPayload } from "./service.js";

const NOT_FOUND = "Transferencia desconocida, caducada o ya usada";
const CUT = "La transferencia se cortó antes de terminar";

/** Content-Length de la petición, o null si no viene (cuerpo chunked) o no es un entero válido. */
export function contentLength(req: FastifyRequest): number | null {
  const v = req.headers["content-length"];
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Nodo dueño del token Bearer, o null. Mismo criterio que /agent/ws. */
function nodeFromAuth(app: FastifyInstance, req: FastifyRequest): NodeRow | null {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token ? app.nodes.findByTokenHash(hashToken(token)) : null;
}

const isReadable = (v: unknown): v is Readable => typeof (v as Readable | undefined)?.pipe === "function";

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Transferencias HTTP de los agentes (spec §5.1), fuera del guard de sesión y con el token
 * del nodo. El cuerpo nunca se carga en memoria: se pasa el stream tal cual.
 *
 * Toda transferencia reclamada termina en `complete`/`fail` (o en `deliver`, que la libera al
 * acabar su cuerpo) por cualquier salida, y su `signal` corta la conexión HTTP si se cancela.
 */
export async function transferRoutes(app: FastifyInstance) {
  // Nodo autenticado de cada petición de este contexto.
  const nodes = new WeakMap<FastifyRequest, NodeRow>();

  // Token del nodo en TODA petición de este contexto, antes de leer el cuerpo. El hook es de
  // este plugin encapsulado: corre en cada ruta registrada aquí y solo en ellas, y Fastify llega
  // a ellas con el path ya decodificado (`/%61gent/transfer/x` es `/agent/transfer/:id`), así
  // que ninguna codificación de la URL lo salta. Lo que no enruta aquí es un 404 sin datos.
  app.addHook("onRequest", async (req) => {
    const node = nodeFromAuth(app, req);
    if (!node) throw new HttpError(401, "token inválido");
    nodes.set(req, node);
  });

  // Ningún cuerpo se interpreta (ni JSON ni texto): solo application/octet-stream, y como
  // stream (req.body) sin límite de tamaño. Otro tipo → 415 antes de llegar a la ruta.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  // Panel → agente. Sin ruta HEAD automática: un HEAD consumiría la transferencia.
  app.get<{ Params: { id: string } }>("/agent/transfer/:id", { exposeHeadRoute: false }, async (req, reply) => {
    const claimed = app.transfers.claim(req.params.id, nodes.get(req)!.id, "GET");
    if (claimed?.kind !== "outbound") throw new HttpError(404, NOT_FOUND);
    const res = reply.raw;
    let stream: Readable | undefined;

    // Cancelada (cancel/closeAll): se corta la conexión y el agente ve el corte.
    const onAbort = () => res.destroy();
    claimed.signal.addEventListener("abort", onAbort, { once: true });
    // Toda salida pasa por aquí, también si el agente se va antes de abrir el origen o si
    // la respuesta ya estaba cerrada. Solo cuenta como entregada si el origen llegó a su fin
    // y la respuesta terminó: un 500 por un origen que falla antes del primer byte no lo es.
    finished(res, (err) => {
      claimed.signal.removeEventListener("abort", onAbort);
      if (!err && stream?.readableEnded) {
        claimed.complete();
      } else {
        stream?.destroy();
        claimed.fail(new TransferError("aborted", CUT));
      }
    });

    let payload: TransferPayload;
    try {
      payload = await claimed.source();
    } catch (e) {
      const err = asError(e);
      claimed.fail(err);
      // El origen caducó o se canceló (p. ej. el PUT de otro agente que alimenta este GET): el
      // agente recibe el motivo. Si es esta la cancelada, la conexión ya está cortada.
      if (err instanceof TransferError) throw new HttpError(410, err.message);
      throw err; // el manejador global lo registra y responde 500 "Error interno"
    }
    // Si el agente se fue mientras se abría el origen, Fastify destruye el stream al ver la
    // respuesta ya cerrada (y `fail` ya se llamó arriba, en finished).
    stream = payload.stream;
    reply.header("content-type", "application/octet-stream");
    if (payload.size !== null) reply.header("content-length", String(payload.size));
    return reply.send(payload.stream);
  });

  // Agente → panel: se entrega el cuerpo a quien espera y se responde cuando lo ha leído entero.
  app.put<{ Params: { id: string } }>("/agent/transfer/:id", async (req, reply) => {
    const claimed = app.transfers.claim(req.params.id, nodes.get(req)!.id, "PUT");
    if (claimed?.kind !== "inbound") throw new HttpError(404, NOT_FOUND);
    const body = req.body;
    if (!isReadable(body)) {
      // Solo llega aquí un PUT sin cuerpo ni Content-Type.
      claimed.fail(new TransferError("aborted", "El agente no envió el cuerpo de la transferencia"));
      throw new HttpError(415, "Envía el cuerpo como application/octet-stream");
    }
    // Cancelada: se corta la petición del agente (además, el servicio destruye el cuerpo).
    const onAbort = () => req.raw.destroy();
    claimed.signal.addEventListener("abort", onAbort, { once: true });
    // En el mismo tick que el claim: nadie puede cancelar entre medias sin que deliver lo vea.
    claimed.deliver({ stream: body, size: contentLength(req) });
    try {
      await finishedAsync(body);
    } catch {
      claimed.fail(new TransferError("aborted", CUT));
      throw new HttpError(400, CUT);
    } finally {
      claimed.signal.removeEventListener("abort", onAbort);
    }
    return reply.code(204).send();
  });
}
