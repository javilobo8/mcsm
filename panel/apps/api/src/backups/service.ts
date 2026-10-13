import type { FastifyInstance } from "fastify";
import { BackupTrigger, JobStatus, type BackupCreated, type BackupDeleted, type BackupInfo, type BackupInventory, type Envelope, type JobProgress } from "@mcsm/proto";
import { MAX_CLOCK_SKEW_SECONDS } from "@mcsm/shared";
import { AgentError, type AgentConn, type Body } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import type { JobDto, JobState } from "../jobs/repo.js";
import { AGENT_JOB_TYPES, FINAL_STATES } from "../jobs/service.js";
import { agentErrorToHttp } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import type { ServerRow } from "../servers/repo.js";
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
/** Borrar una copia es borrar un fichero: 60 s sobran. */
const DELETE_TIMEOUT_MS = 60_000;
/**
 * Borrar unos datos pre-restore es borrar un mundo entero (una carpeta): en una SD o un disco lento tarda minutos, y
 * con 60 s el navegador vería 504 mientras el agente sigue borrando. El mismo plazo que el borrado de Archivos.
 */
const PRE_RESTORE_DELETE_TIMEOUT_MS = 5 * 60_000;
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
/** Cada cuánto el panel pide el inventario a los nodos conectados (m-f: el periódico del agente no va correlacionado). */
export const INVENTORY_EVERY_MS = 10 * 60_000;

/** Hora del agente (ms) si es razonable: ni más de MAX_CLOCK_SKEW_SECONDS en el futuro ni de hace más de 30 días (m12). */
export function agentIso(ms: bigint, now = Date.now()): string | null {
  const n = Number(ms);
  if (!(n > 0) || n > now + MAX_CLOCK_SKEW_SECONDS * 1000 || n < now - 30 * 86_400_000) return null;
  return new Date(n).toISOString();
}

export class BackupService {
  /** Idempotency-Key de POST /backups → job (en memoria, acotado). */
  private keys = new Map<string, string>();
  /**
   * Última petición de inventario por nodo: id del BackupList (los ids no se repiten entre sesiones,
   * ver `AgentHub.allocateId`) y su inicio. Se sustituye en cada Hello, así que es la de la sesión vigente.
   */
  private lastList = new Map<string, { id: bigint; since: string }>();

  constructor(private app: FastifyInstance, private repo: BackupsRepo) {}

  start() {
    // Tras cada Hello (no en "attached": hasta entonces el agente no atiende peticiones).
    this.app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case === "hello") void this.sync(nodeId);
    });
    // plan-9 (m-f): además, cada 10 min, un inventario correlacionado de cada nodo conectado: aplica la vía negativa
    // (copias borradas cuyo BackupDeleted se perdió) sin esperar a la siguiente reconexión.
    const timer = setInterval(() => this.syncAll(), INVENTORY_EVERY_MS);
    timer.unref();
    this.app.addHook("onClose", async () => clearInterval(timer));
  }

  /** Pide el inventario a todos los nodos conectados. */
  syncAll(): void {
    for (const nodeId of this.app.agents.onlineIds()) void this.sync(nodeId);
  }

  list(serverId: string): BackupDto[] {
    this.requireServer(serverId);
    return this.repo.list(serverId).map(toBackupDto);
  }

  /** Pide el inventario de copias y jobs al agente; llega como BackupInventory no solicitado. */
  async sync(nodeId: string): Promise<void> {
    const conn = this.app.agents.get(nodeId);
    if (!conn) return;
    const since = nowIso();
    const { id, response } = conn.requestTracked({ case: "backupList", value: { serverId: "" } }, 30_000);
    // Antes de esperar: el inventario va por la cola de avisos del agente y puede adelantar al Ack.
    this.lastList.set(nodeId, { id, since });
    try {
      await response;
    } catch (e) {
      // Una desconexión es normal (el WS parpadea): el siguiente Hello vuelve a pedirlo.
      if (e instanceof AgentError && e.code === AgentErrorCode.Disconnected) {
        this.app.log.info({ nodeId }, "inventario de copias sin respuesta: el agente se desconectó; se pedirá al reconectar");
        return;
      }
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
      const timeout = b.trigger === "pre_restore" ? PRE_RESTORE_DELETE_TIMEOUT_MS : DELETE_TIMEOUT_MS;
      await conn.request({ case: "backupDelete", value: { serverId, filename: b.filename } }, timeout);
    } catch (e) {
      throw agentErrorToHttp(e, "No se pudo borrar la copia");
    }
    this.repo.markDeleted(serverId, b.filename);
    this.app.events.emit("backups", serverId);
  }

  /**
   * Cambia `spec.backups` (programación y retención) con el PATCH de spec del Plan 3 (`serversService.patch`). Es un
   * merge de primer nivel: el cuerpo sustituye la sección `backups` entera (lo omitido dentro de ella vuelve a sus
   * valores por defecto). Mismos topes, errores de zod en castellano con la ruta del campo y comprobación de puertos;
   * si nada cambia, sin versión nueva ni ApplySpec. No es una acción inmediata: con el nodo desconectado se guarda y
   * versiona sin 409, y la spec llega en el próximo SyncSpecs.
   */
  async updateSchedule(serverId: string, input: Record<string, unknown>) {
    return this.app.serversService.patch(serverId, { spec: { backups: input } });
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
    if (!this.ensureJob(nodeId, p.jobId, p.serverId, p.type, agentIso(p.tsUnixMs))) return;
    const status = STATUSES[p.status] ?? "running";
    const finishedAt = FINAL_STATES.has(status) ? agentIso(p.tsUnixMs) ?? undefined : undefined;
    this.app.jobs.update(p.jobId, { status, progress: p.progress, message: p.message, logChunk: p.logChunk, finishedAt });
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

  /**
   * Inventario del agente: tras cada petición (`sync`) y, sin pedirlo, cada 10 min. Lo positivo (altas de copias y
   * estados de jobs) se aplica siempre. La vía negativa (copias borradas, jobs perdidos) solo si el inventario
   * contesta a la última petición de este nodo (`request_id`): el agente lo calculó después de recibirla, así que lo
   * creado antes de `since` y ausente ya no existe (copias) o se perdió (jobs), y lo creado después no se toca
   * (carreras con avisos que cruzan el inventario). El periódico (request_id 0) y uno de una petición anterior
   * (encolado en otra sesión y entregado tras el Hello de esta) pueden ser anteriores a un job vivo: solo lo
   * positivo. Por eso una copia cuyo BackupDeleted se descartó (cola del agente llena) sigue listada hasta el
   * siguiente Hello.
   */
  private onInventory(nodeId: string, inv: BackupInventory) {
    const last = this.lastList.get(nodeId);
    const since = last && inv.requestId !== 0n && inv.requestId === last.id ? last.since : undefined;
    for (const serverId of inv.serverIds) {
      if (!this.ownServer(nodeId, serverId)) continue;
      const mine = inv.backups.filter((b) => b.serverId === serverId);
      for (const b of mine) this.repo.upsertOk(nodeId, infoToInput(b));
      if (since) this.repo.markMissingDeleted(serverId, new Set(mine.map((b) => b.filename)), since);
      this.app.events.emit("backups", serverId);
    }
    const known = new Set<string>();
    for (const r of inv.jobs) {
      known.add(r.jobId);
      if (!this.ensureJob(nodeId, r.jobId, r.serverId, r.type, agentIso(r.startedUnixMs))) continue;
      // El log del agente es solo la cola (4 KiB): sustituye al del panel únicamente si este aún no tiene nada
      // (job que el panel no seguía); si no, el inventario periódico se comería la cabecera cada 10 min.
      const hasLog = (this.app.jobs.getRow(r.jobId)?.log ?? "") !== "";
      const status = STATUSES[r.status] ?? "running";
      this.app.jobs.update(r.jobId, {
        status, progress: r.progress, message: r.message, ...(hasLog ? {} : { log: r.log }),
        finishedAt: FINAL_STATES.has(status) ? agentIso(r.finishedUnixMs) ?? undefined : undefined,
      });
    }
    if (!since) return;
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
  private ensureJob(nodeId: string, jobId: string, serverId: string, type: string, startedAt: string | null): boolean {
    if (!jobId) return false;
    const existing = this.app.jobs.getRow(jobId);
    // plan-9: solo jobs que ejecuta el agente; el de migración (nodo de origen) lo lleva el panel.
    if (existing) return existing.node_id === nodeId && (AGENT_JOB_TYPES as readonly string[]).includes(existing.type);
    if (!this.ownServer(nodeId, serverId)) return false;
    // Job que inicia el propio agente (copia programada): se crea al primer aviso, con su hora de inicio (m12).
    this.app.jobs.create({ id: jobId, type: type || "backup", serverId, nodeId, status: "running", payload: { trigger: "scheduled" }, startedAt: startedAt ?? undefined });
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
