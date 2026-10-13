import { MAX_CLOCK_SKEW_SECONDS } from "@mcsm/shared";
export const nowIso = (): string => new Date().toISOString();
export const plusSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();

/** Cuánto atrás se acepta la hora de un agente. */
const MAX_AGENT_AGE_MS = 30 * 86_400_000;

/** Hora del agente (ms) si es razonable: ni más de MAX_CLOCK_SKEW_SECONDS en el futuro ni de hace más de 30 días. */
export function agentIso(ms: bigint, now = Date.now()): string | null {
  const n = Number(ms);
  if (!(n > 0) || n > now + MAX_CLOCK_SKEW_SECONDS * 1000 || n < now - MAX_AGENT_AGE_MS) return null;
  return new Date(n).toISOString();
}
