import { MAX_CLOCK_SKEW_SECONDS } from "@mcsm/shared";
export const nowIso = (): string => new Date().toISOString();
export const plusSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();

/** How far back an agent's time is accepted. */
const MAX_AGENT_AGE_MS = 30 * 86_400_000;

/** Agent time (ms) if reasonable: neither more than MAX_CLOCK_SKEW_SECONDS in the future nor more than 30 days old. */
export function agentIso(ms: bigint, now = Date.now()): string | null {
  const n = Number(ms);
  if (!(n > 0) || n > now + MAX_CLOCK_SKEW_SECONDS * 1000 || n < now - MAX_AGENT_AGE_MS) return null;
  return new Date(n).toISOString();
}
