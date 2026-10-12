import type { EventEmitter } from "node:events";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { JobsRepo, toJobDetailDto, toJobDto, type JobDetailDto, type JobDto, type JobListFilter, type JobRow, type JobState } from "./repo.js";

export const FINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(["ok", "failed", "cancelled"]);
/** Jobs que ejecuta el agente: sobreviven a un reinicio del panel; el agente informa al reconectar (spec §10). */
export const AGENT_JOB_TYPES = ["backup", "restore"] as const;
export const MAX_JOB_LOG = 256 * 1024;
export const INTERRUPTED = "interrumpido: el panel se reinició durante el job";

export interface CreateJobInput {
  id?: string; type: string; serverId?: string | null; nodeId?: string | null;
  status?: "queued" | "running"; message?: string; payload?: Record<string, unknown>;
}

export interface JobUpdate {
  status?: JobState; progress?: number; message?: string;
  /** Líneas nuevas que se añaden al log. */
  logChunk?: string;
  /** Log completo que sustituye al guardado (inventario del agente). */
  log?: string;
}

function capLog(log: string): string {
  if (log.length <= MAX_JOB_LOG) return log;
  const mark = "…(recortado)\n";
  return mark + log.slice(log.length - MAX_JOB_LOG + mark.length);
}

/** Jobs genéricos con progreso y log (spec §7). Cada cambio emite `events.emit("job", dto, logChunk)`. */
export class JobService {
  constructor(private repo: JobsRepo, private events: EventEmitter) {}

  create(input: CreateJobInput): JobDto {
    const now = nowIso();
    const status = input.status ?? "queued";
    const row: JobRow = {
      id: input.id ?? newId(), type: input.type, server_id: input.serverId ?? null, node_id: input.nodeId ?? null,
      status, progress: 0, message: input.message ?? "", log: "", payload: JSON.stringify(input.payload ?? {}),
      created_at: now, updated_at: now, started_at: status === "running" ? now : null, finished_at: null,
    };
    this.repo.insert(row);
    return this.emit(row, "");
  }

  /** Aplica un avance. Un job terminado ya no cambia: un aviso tardío no lo reabre. */
  update(id: string, u: JobUpdate): JobDto | null {
    const row = this.repo.get(id);
    if (!row) return null;
    if (FINAL_STATES.has(row.status)) return toJobDto(row);
    const now = nowIso();
    const next: JobRow = { ...row, updated_at: now };
    if (u.status) {
      next.status = u.status;
      if (u.status === "running" && !next.started_at) next.started_at = now;
      if (FINAL_STATES.has(u.status)) next.finished_at = now;
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

  /** Al arrancar el panel: los jobs a medias pasan a failed "interrumpido", salvo los del agente (spec §10). */
  interruptStale(): number {
    const ids = this.repo.failOpen(AGENT_JOB_TYPES, INTERRUPTED, nowIso());
    for (const id of ids) {
      const r = this.repo.get(id);
      if (r) this.emit(r, "");
    }
    return ids.length;
  }

  /** Jobs del agente (backup, restore) de un nodo, aún abiertos y creados antes de `createdBefore`. */
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
