import { AgentError } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { TransferError } from "../transfers/service.js";

/** Failure of a migration step, with a text for the user (goes to the job). */
export class StepError extends Error {
  constructor(message: string) { super(message); this.name = "StepError"; }
}

/** Failures the panel knows about (the rest are a bug: they are logged). */
export const isKnownError = (e: unknown): boolean =>
  e instanceof StepError || e instanceof HttpError || e instanceof TransferError || e instanceof AgentError;

/** Text of a failure for the job: the agent's or Docker's is kept (spec §10); anything unexpected does not leak details. */
export function errorText(e: unknown): string {
  if (e instanceof StepError || e instanceof HttpError || e instanceof TransferError) return e.message;
  if (e instanceof AgentError) return agentErrorToHttp(e).message;
  return "internal panel error (see its log)";
}

/**
 * Rejections that retrying what is pending (undo, confirm, remove) does not fix: the agent says the node's state
 * is not what the panel believes (invalid_request), does not understand the command (unsupported: out-of-date agent), or
 * the panel no longer has the server (404). They are noted and no longer retried; the user decides.
 */
export function isDefinitive(e: unknown): boolean {
  if (e instanceof AgentError) return e.code === AgentErrorCode.InvalidRequest || e.code === AgentErrorCode.Unsupported;
  if (e instanceof HttpError) return e.status === 400 || e.status === 404;
  return false;
}
