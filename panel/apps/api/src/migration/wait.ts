import type { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import { observedToDto } from "../agents/service.js";
import type { Timers } from "../files/stream.js";
import type { JobDto } from "../jobs/repo.js";
import { FINAL_STATES } from "../jobs/service.js";
import type { ObservedDto } from "../servers/repo.js";
import { StepError } from "./errors.js";

export interface Waiter<T> { promise: Promise<T>; cancel(): void }

/** Listens to the agents' unsolicited messages (the same ones AgentService dispatches). */
export function onAgentMessage(agents: EventEmitter, fn: (nodeId: string, env: Envelope) => void): () => void {
  agents.on("message", fn);
  return () => { agents.off("message", fn); };
}

/**
 * Waits for the job to end (ok, failed or cancelled). `onProgress` receives each update; with no updates for `idleMs`
 * rejects with `idleMessage`. Also looks at the current state: if it already ended, it resolves right away.
 */
export function waitJob(app: FastifyInstance, jobId: string, opts: { idleMs: number; timers: Timers; idleMessage: string; onProgress?: (j: JobDto) => void }): Waiter<JobDto> {
  let off = () => {};
  let disarm = () => {};
  const promise = new Promise<JobDto>((resolve, reject) => {
    const settle = (fn: () => void) => { off(); disarm(); fn(); };
    const arm = () => {
      disarm();
      disarm = opts.timers.set(() => settle(() => reject(new StepError(opts.idleMessage))), opts.idleMs);
    };
    const h = (j: JobDto) => {
      if (j.id !== jobId) return;
      if (FINAL_STATES.has(j.status)) settle(() => resolve(j));
      else {
        opts.onProgress?.(j);
        arm();
      }
    };
    app.events.on("job", h);
    off = () => { app.events.off("job", h); };
    arm();
    const now = app.jobs.get(jobId);
    if (now && FINAL_STATES.has(now.status)) settle(() => resolve(now));
  });
  promise.catch(() => {});
  return { promise, cancel: () => { off(); disarm(); } };
}

/**
 * Waits for the server to become healthy on the node: `running` with healthcheck `healthy` or a correct SLP ping. An
 * `exited`/`dead` rejects immediately; if `timeoutMs` expires, it does too. It must be created BEFORE ordering the start.
 */
export function waitObserved(agents: EventEmitter, nodeId: string, serverId: string, opts: { timeoutMs: number; timers: Timers; onObserved?: (o: ObservedDto) => void }): Waiter<ObservedDto> {
  let off = () => {};
  let disarm = () => {};
  const promise = new Promise<ObservedDto>((resolve, reject) => {
    const settle = (fn: () => void) => { off(); disarm(); fn(); };
    off = onAgentMessage(agents, (from, env) => {
      if (from !== nodeId || env.body.case !== "serverObserved" || env.body.value.serverId !== serverId) return;
      const o = observedToDto(env.body.value.observed);
      opts.onObserved?.(o);
      if (o.state === "running" && (o.health === "healthy" || o.mc.online)) settle(() => resolve(o));
      else if (o.state === "exited" || o.state === "dead") {
        settle(() => reject(new StepError(`The server stopped on the target (exit code ${o.exitCode})${o.error ? `: ${o.error}` : ""}`)));
      }
    });
    const minutes = Math.round(opts.timeoutMs / 60_000);
    disarm = opts.timers.set(() => settle(() => reject(new StepError(`The server did not become healthy on the target within ${minutes} min (healthcheck or ping)`))), opts.timeoutMs);
  });
  promise.catch(() => {});
  return { promise, cancel: () => { off(); disarm(); } };
}
