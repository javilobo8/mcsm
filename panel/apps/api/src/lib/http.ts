import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentError } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";

/**
 * Error HTTP con mensaje para el usuario (en castellano). El manejador global responde
 * `{ error: message }` con `status`, salvo 500, que siempre sale como "Error interno".
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "HttpError"; }
}

/** Código del agente (o local de AgentConn) → estado HTTP. Lo que no esté aquí: 502. */
const STATUS_BY_CODE: Record<string, number> = {
  [AgentErrorCode.InvalidSpec]: 400,
  [AgentErrorCode.InvalidRequest]: 400,
  [AgentErrorCode.UnknownServer]: 404,
  [AgentErrorCode.NotFound]: 404,
  [AgentErrorCode.Busy]: 409,
  [AgentErrorCode.Exists]: 409,
  [AgentErrorCode.Disconnected]: 409,
  [AgentErrorCode.Syncing]: 409,
  [AgentErrorCode.Unsupported]: 409,
  [AgentErrorCode.TooLarge]: 413,
  [AgentErrorCode.Timeout]: 504,
  // Archivos (Plan 5): rutas inválidas o del tipo equivocado.
  invalid_path: 400, path_outside: 400, root: 400, is_dir: 400, not_dir: 400,
};

/**
 * Traduce un fallo de una petición al agente a HttpError. Conserva el texto del agente o de
 * Docker (spec §10) salvo en `unsupported`, que explica que el agente está desactualizado.
 * Un HttpError pasa tal cual; cualquier otra cosa es 502 con `fallback`.
 */
export function agentErrorToHttp(e: unknown, fallback = "Fallo al comunicar con el agente"): HttpError {
  if (e instanceof HttpError) return e;
  if (!(e instanceof AgentError)) return new HttpError(502, fallback);
  if (e.code === AgentErrorCode.Unsupported) {
    return new HttpError(409, "El agente del nodo está desactualizado y no entiende esta orden: actualízalo");
  }
  return new HttpError(STATUS_BY_CODE[e.code] ?? 502, e.message || fallback);
}

/** Mensajes para los 4xx que genera Fastify o sus plugins (vienen en inglés). */
const GENERIC_4XX: Record<number, string> = {
  400: "Petición inválida",
  401: "No autenticado",
  403: "Prohibido",
  404: "No encontrado",
  405: "Método no permitido",
  413: "La petición es demasiado grande",
  415: "Tipo de contenido no admitido",
  429: "Demasiadas peticiones: espera un momento y vuelve a intentarlo",
};

/**
 * Manejador de errores global (se registra en buildApp antes que cualquier plugin, así que lo
 * heredan todas las rutas). Formato único `{ error: "…" }`:
 * - HttpError: su estado y su mensaje (500 → "Error interno").
 * - AgentError: `agentErrorToHttp` (502 con el texto del agente).
 * - ZodError: 400 con el primer mensaje.
 * - Errores 4xx de Fastify y plugins: mensaje genérico en castellano por estado.
 * - Lo demás: se registra y sale como 500 "Error interno", sin filtrar detalles.
 */
export function errorHandler(app: FastifyInstance) {
  return (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const e = err instanceof AgentError ? agentErrorToHttp(err) : err;
    if (e instanceof HttpError) {
      if (e.status >= 500 && e.status !== 502 && e.status !== 504) {
        req.log.error({ err }, "error interno");
        return reply.code(500).send({ error: "Error interno" });
      }
      return reply.code(e.status).send({ error: e.message });
    }
    if (e instanceof z.ZodError) return reply.code(400).send({ error: e.issues[0]?.message ?? "Datos inválidos" });
    const status = (e as FastifyError).statusCode;
    if (status === undefined || status >= 500 || status < 400) {
      app.log.error({ err }, "error interno");
      return reply.code(500).send({ error: "Error interno" });
    }
    return reply.code(status).send({ error: GENERIC_4XX[status] ?? "Petición rechazada" });
  };
}
