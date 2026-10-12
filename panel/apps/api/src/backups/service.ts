import type { FastifyInstance } from "fastify";
import { BackupTrigger, JobStatus, type BackupCreated, type BackupDeleted, type BackupInfo, type BackupInventory, type Envelope, type JobProgress } from "@mcsm/proto";
import { specSchema, type Spec } from "@mcsm/shared";
import { AgentError, type AgentConn, type Body } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import type { JobDto, JobState } from "../jobs/repo.js";
import { agentErrorToHttp } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { toServerDto, type ServerRow } from "../servers/repo.js";
import { HttpError } from "../servers/service.js";
import { BackupsRepo, toBackupDto, type BackupDto, type BackupInput, type BackupTriggerName } from "./repo.js";

const TRIGGERS: Record<number, BackupTriggerName> = {
  [BackupTrigger.MANUAL]: "manual",
  [BackupTrigger.SCHEDULED]: "scheduled",
  [BackupTrigger.PRE_MIGRATION]: "pre_migration",
  [BackupTrigger.PRE_RESTORE]: "pre_restore",
};
const STATUSES: Record<number, JobState> = {
  [JobStatus.RUNNING]: "running",
  [JobStatus.OK]: "ok",
  [JobStatus.FAILED]: "failed",
};
const LOST = "interrumpido: el agente no tiene constancia de este job (la orden no llegó o el agente se reinició)";

const msToIso = (ms: bigint): string | null => (ms > 0n ? new Date(Number(ms)).toISOString() : null);

export function infoToInput(b: BackupInfo): BackupInput {
  return {
    serverId: b.serverId, filename: b.filename, sizeBytes: Number(b.sizeBytes), sha256: b.sha256,
    specVersion: Number(b.specVersion), trigger: TRIGGERS[b.trigger] ?? "manual",
    startedAt: msToIso(b.startedUnixMs) ?? nowIso(), finishedAt: msToIso(b.finishedUnixMs),
  };
}

/** Copias de seguridad (spec §7 BackupService): tabla `backups`, órdenes al agente e inventario. */
export class BackupService {
  /** Inicio de la última petición de inventario por nodo: solo se dan por perdidos los jobs anteriores. */
  /** Idempotency-Key de POST /backups → job (en memoria, acotado). */
  private keys = new Map<string, string>();
  private syncStartedAt = new Map<string, string>();

  constructor(private app: FastifyInstance, private repo: BackupsRepo) {}

  start() {
    // Tras cada Hello (no en "attached": hasta entonces el agente no atiende peticiones).
    this.app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case === "hello") void this.sync(nodeId);
    });
  }

  list(serverId: string): BackupDto[] {
    this.requireServer(serverId);
    return this.repo.list(serverId).map(toBackupDto);
  }

  /** Pide el inventario de copias y jobs al agente; llega como BackupInventory no solicitado. */
  async sync(nodeId: string): Promise<void> {
    const conn = this.app.agents.get(nodeId);
    if (!conn) return;
    this.syncStartedAt.set(nodeId, nowIso());
    try {
      await conn.request({ case: "backupList", value: { serverId: "" } }, 30_000);
    } catch (e) {
      this.app.log.warn({ nodeId, err: e }, "no se pudo pedir el inventario de copias al agente");
    }
  }

  /** Mensajes no solicitados del agente (los despacha AgentService). */
  onAgentMessage(nodeId: string, env: Envelope): void {
    switch (env.body.case) {
      case "jobProgress": return this.onJobProgress(nodeId, env.body.value);
      case "backupCreated": return this.onBackupCreated(nodeId, env.body.value);
      case "backupDeleted": return this.onBackupDeleted(nodeId, env.body.value);
      case "backupInventory": return this.onInventory(nodeId, env.body.value);
      default: return;
    }
  }

  // Acciones del usuario

  /** Copia manual inmediata. Devuelve el job; el avance llega por el topic `jobs`. */
  async createNow(serverId: string, idempotencyKey?: string): Promise<JobDto> {
    const row = this.requireServer(serverId);
    // Un reintento del navegador con la misma clave devuelve el job ya creado.
    const keyed = idempotencyKey ? `${serverId}:${idempotencyKey}` : "";
    const prior = keyed ? this.keys.get(keyed) : undefined;
    const existing = prior ? this.app.jobs.get(prior) : null;
    if (existing) return existing;
    const conn = this.onlineConn(row.node_id);
    const job = this.app.jobs.create({
      type: "backup", serverId, nodeId: row.node_id, status: "running", message: "Solicitando la copia al agente", payload: { trigger: "manual" },
    });
    if (keyed) {
      this.keys.set(keyed, job.id);
      if (this.keys.size > 500) this.keys.delete(this.keys.keys().next().value!);
    }
    await this.dispatch(conn, job.id, { case: "backupNow", value: { serverId, jobId: job.id, trigger: BackupTrigger.MANUAL } });
    return this.app.jobs.get(job.id)!;
  }

  async restore(serverId: string, backupId: string): Promise<JobDto> {
    const row = this.requireServer(serverId);
    const b = this.requireBackup(serverId, backupId);
    if (b.trigger === "pre_restore") {
      throw new HttpError(400, "Son los datos que había antes de una restauración: no se restauran desde aquí. Bórralos cuando ya no los necesites.");
    }
    const conn = this.onlineConn(row.node_id);
    const job = this.app.jobs.create({
      type: "restore", serverId, nodeId: row.node_id, status: "running", message: "Solicitando la restauración al agente",
      payload: { backupId: b.id, filename: b.filename },
    });
    await this.dispatch(conn, job.id, { case: "backupRestore", value: { serverId, filename: b.filename, jobId: job.id } });
    return this.app.jobs.get(job.id)!;
  }

  async remove(serverId: string, backupId: string): Promise<void> {
    const row = this.requireServer(serverId);
    const b = this.requireBackup(serverId, backupId);
    const conn = this.onlineConn(row.node_id);
    try {
      await conn.request({ case: "backupDelete", value: { serverId, filename: b.filename } }, 60_000);
    } catch (e) {
      throw agentErrorToHttp(e, "No se pudo borrar la copia");
    }
    this.repo.markDeleted(serverId, b.filename);
    this.app.events.emit("backups", serverId);
  }

  /** Cambia `spec.backups` (programación y retención) y la envía al agente como una spec nueva. El cuerpo REEMPLAZA
   * `backups` entero (lo omitido vuelve a sus valores por defecto). No es acción inmediata: con el nodo desconectado
   * se guarda y versiona sin 409, y la spec llega en el próximo SyncSpecs. */
  async updateSchedule(serverId: string, input: unknown) {
    const row = this.requireServer(serverId);
    const current = JSON.parse(row.spec) as Spec;
    const parsed = specSchema.safeParse({ ...current, backups: input });
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Programación de copias inválida");
    const updated = this.app.servers.updateSpec(serverId, parsed.data);
    void this.app.serversService.push(updated);
    return toServerDto(updated, { includeSecrets: true });
  }

  // Internos

  /** Envía la orden de un job. Sin respuesta (desconexión o timeout) el job sigue abierto: el agente
   * puede estar ejecutándola y el inventario al reconectar lo aclarará. Un Error explícito lo cierra. */
  private async dispatch(conn: AgentConn, jobId: string, body: Body): Promise<void> {
    try {
      await conn.request(body, 30_000);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Disconnected || e.code === AgentErrorCode.Timeout)) {
        this.app.jobs.update(jobId, { message: "El agente aún no ha confirmado la orden; el estado se actualizará cuando informe" });
        return;
      }
      const err = agentErrorToHttp(e, "El agente rechazó la orden");
      this.app.jobs.finish(jobId, "failed", err.message);
      throw err;
    }
  }

  private requireBackup(serverId: string, backupId: string) {
    const b = this.repo.get(backupId);
    if (!b || b.server_id !== serverId || b.status === "deleted") throw new HttpError(404, "Copia no encontrada");
    return b;
  }

  private onlineConn(nodeId: string): AgentConn {
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return conn;
  }

  private onJobProgress(nodeId: string, p: JobProgress) {
    if (!this.ensureJob(nodeId, p.jobId, p.serverId, p.type)) return;
    this.app.jobs.update(p.jobId, { status: STATUSES[p.status] ?? "running", progress: p.progress, message: p.message, logChunk: p.logChunk });
  }

  private onBackupCreated(nodeId: string, m: BackupCreated) {
    const b = m.backup;
    if (!b || !this.ownServer(nodeId, b.serverId)) return;
    this.repo.upsertOk(nodeId, infoToInput(b));
    this.app.events.emit("backups", b.serverId);
  }

  private onBackupDeleted(nodeId: string, m: BackupDeleted) {
    if (!this.ownServer(nodeId, m.serverId)) return;
    if (this.repo.markDeleted(m.serverId, m.filename)) this.app.events.emit("backups", m.serverId);
  }

  private onInventory(nodeId: string, inv: BackupInventory) {
    const since = this.syncStartedAt.get(nodeId) ?? nowIso();
    for (const serverId of inv.serverIds) {
      if (!this.ownServer(nodeId, serverId)) continue;
      const mine = inv.backups.filter((b) => b.serverId === serverId);
      for (const b of mine) this.repo.upsertOk(nodeId, infoToInput(b));
      this.repo.markMissingDeleted(serverId, new Set(mine.map((b) => b.filename)));
      this.app.events.emit("backups", serverId);
    }
    const known = new Set<string>();
    for (const r of inv.jobs) {
      known.add(r.jobId);
      if (!this.ensureJob(nodeId, r.jobId, r.serverId, r.type)) continue;
      this.app.jobs.update(r.jobId, { status: STATUSES[r.status] ?? "running", progress: r.progress, message: r.message, log: r.log });
    }
    // Jobs de copia/restauración de este nodo que el agente no conoce: se perdieron.
    for (const row of this.app.jobs.openAgentJobs(nodeId, since)) {
      if (!known.has(row.id)) this.app.jobs.finish(row.id, "failed", LOST);
    }
  }

  /**
   * Get-or-create idempotente: el agente reenvía sus jobs tras reconectar y `create({id})` lanzaría
   * UNIQUE. Devuelve false si el job es de otro nodo o es nuevo y su servidor no es de este nodo.
   * Un job ya terminal se deja como está (`JobService.update` lo ignora).
   */
  private ensureJob(nodeId: string, jobId: string, serverId: string, type: string): boolean {
    if (!jobId) return false;
    const existing = this.app.jobs.getRow(jobId);
    if (existing) return existing.node_id === nodeId;
    if (!this.ownServer(nodeId, serverId)) return false;
    // Job que inicia el propio agente (copia programada): se crea al primer aviso.
    this.app.jobs.create({ id: jobId, type: type || "backup", serverId, nodeId, status: "running", payload: { trigger: "scheduled" } });
    return true;
  }

  private ownServer(nodeId: string, serverId: string): ServerRow | null {
    const row = serverId ? this.app.servers.get(serverId) : null;
    return row && row.node_id === nodeId ? row : null;
  }

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    return row;
  }
}
