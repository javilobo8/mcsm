import { AgentError } from "../agents/hub.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { TransferError } from "../transfers/service.js";

/** Fallo de un paso de la migración, con un texto para el usuario (va al job). */
export class StepError extends Error {
  constructor(message: string) { super(message); this.name = "StepError"; }
}

/** Fallos que el panel conoce (los demás son un bug: se registran en el log). */
export const isKnownError = (e: unknown): boolean =>
  e instanceof StepError || e instanceof HttpError || e instanceof TransferError || e instanceof AgentError;

/** Texto de un fallo para el job: el del agente o Docker se conserva (spec §10); lo inesperado no filtra detalles. */
export function errorText(e: unknown): string {
  if (e instanceof StepError || e instanceof HttpError || e instanceof TransferError) return e.message;
  if (e instanceof AgentError) return agentErrorToHttp(e).message;
  return "error interno del panel (mira su log)";
}
