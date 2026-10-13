import type { EventEmitter } from "node:events";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { JobsRepo, toJobDetailDto, toJobDto, type JobDetailDto, type JobDto, type JobListFilter, type JobRow, type JobState } from "./repo.js";

export const FINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(["ok", "failed", "cancelled"]);
/** Jobs run by the agent: they survive a panel restart; the agent reports on reconnect (spec §10).
 *  migrate_in: the receiving end of a migration on the target node (Plan 7). */
export const AGENT_JOB_TYPES = ["backup", "restore", "migrate_in"] as const;
export const MAX_JOB_LOG = 256 * 1024;
export const INTERRUPTED = "interrupted: the panel restarted during the job";

export interface CreateJobInput {
  id?: string; type: string; serverId?: string | null; nodeId?: string | null;
  status?: "queued" | "running"; message?: string; payload?: Record<string, unknown>;
  /** Actual start time (the agent's): only sets started_at. created_at is always the panel's time
   *  (the lost-jobs sweep compares it with panel clocks). */
  startedAt?: string;
}

export interface JobUpdate {
  status?: JobState; progress?: number; message?: string;
  /** Actual end time (the agent's), with a final status. */
  finishedAt?: string;
  /** New lines to append to the log. */
  logChunk?: string;
  /** Full log that replaces the stored one (agent inventory). */
  log?: string;
}

function capLog(log: string): string {
  if (log.length <= MAX_JOB_LOG) return log;
  const mark = "…(trimmed)\n";
  return mark + log.slice(log.length - MAX_JOB_LOG + mark.length);
}

/** Generic jobs with progress and log (spec §7). Each change emits `events.emit("job", dto, logChunk)`. */
export class JobService {
  constructor(private repo: JobsRepo, private events: EventEmitter) {}

  create(input: CreateJobInput): JobDto {
    const now = nowIso();
    const status = input.status ?? "queued";
    const started = input.startedAt ?? now;
    const row: JobRow = {
      id: input.id ?? newId(), type: input.type, server_id: input.serverId ?? null, node_id: input.nodeId ?? null,
      status, progress: 0, message: input.message ?? "", log: "", payload: JSON.stringify(input.payload ?? {}),
      created_at: now, updated_at: now, started_at: status === "running" ? started : null, finished_at: null,
    };
    this.repo.insert(row);
    return this.emit(row, "");
  }

  /** Applies a progress update. A finished job no longer changes: a late notice does not reopen it. */
  update(id: string, u: JobUpdate): JobDto | null {
    const row = this.repo.get(id);
    if (!row) return null;
    if (FINAL_STATES.has(row.status)) return toJobDto(row);
    const now = nowIso();
    const next: JobRow = { ...row, updated_at: now };
    if (u.status) {
      next.status = u.status;
      if (u.status === "running" && !next.started_at) next.started_at = now;
      if (FINAL_STATES.has(u.status)) next.finished_at = u.finishedAt ?? now;
    }
    if (u.progress !== undefined) next.progress = Math.max(0, Math.min(100, Math.round(u.progress)));
    if (u.message !== undefined) next.message = u.message;
    if (u.log !== undefined) next.log = capLog(u.log);
    else if (u.logChunk) next.log = capLog(next.log + u.logChunk);
    if (next.status === "ok") next.progress = 100;
    this.repo.save(next);
    return this.emit(next, u.log !== undefined ? "" : (u.logChunk ?? ""));
  }

  finish(id: string, status: "ok" | "failed" | "cancelled", message: string): JobDto | null {
    return this.update(id, { status, message });
  }

  get(id: string): JobDetailDto | null {
    const r = this.repo.get(id);
    return r ? toJobDetailDto(r) : null;
  }

  getRow(id: string): JobRow | null {
    return this.repo.get(id);
  }

  list(f: JobListFilter): JobDto[] {
    return this.repo.list(f).map(toJobDto);
  }

  /** When the panel starts: half-done jobs become failed "interrupted", except the agent's (spec §10). */
  interruptStale(): number {
    const ids = this.repo.failOpen(AGENT_JOB_TYPES, INTERRUPTED, nowIso());
    for (const id of ids) {
      const r = this.repo.get(id);
      if (r) this.emit(r, "");
    }
    return ids.length;
  }

  /** Open jobs of a server (plan-9: pre-check of an upload). */
  activeForServer(serverId: string): JobDto[] {
    return this.repo.openForServer(serverId).map(toJobDto);
  }

  /** Agent jobs (backup, restore) of a node, still open and created before `createdBefore`. */
  openAgentJobs(nodeId: string, createdBefore: string): JobRow[] {
    return this.repo.openForNode(nodeId, AGENT_JOB_TYPES, createdBefore);
  }

  purgeFinishedBefore(iso: string): number {
    return this.repo.purgeFinishedBefore(iso);
  }

  private emit(row: JobRow, logChunk: string): JobDto {
    const dto = toJobDto(row);
    this.events.emit("job", dto, logChunk);
    return dto;
  }
}
