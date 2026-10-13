import { pipeline, type Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { BackupTrigger, JobStatus, type BackupCreated, type BackupDeleted, type BackupInfo, type BackupInventory, type Envelope, type JobProgress } from "@mcsm/proto";
import { AgentError, type AgentConn, type Body } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import type { JobDto, JobState } from "../jobs/repo.js";
import { AGENT_JOB_TYPES, FINAL_STATES } from "../jobs/service.js";
import { toHttpError } from "../files/service.js";
import { IDLE_TIMEOUT_MS, idleGuard } from "../files/stream.js";
import { agentErrorToHttp } from "../lib/http.js";
import { agentIso, nowIso } from "../lib/time.js";
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
/** Deleting a backup is deleting a file: 60 s is plenty. */
const DELETE_TIMEOUT_MS = 60_000;
/**
 * Deleting pre-restore data is deleting a whole world (a folder): on an SD card or a slow disk it takes minutes, and
 * with 60 s the browser would see 504 while the agent keeps deleting. Same deadline as deleting in Files.
 */
const PRE_RESTORE_DELETE_TIMEOUT_MS = 5 * 60_000;
const LOST = "interrupted: the agent has no record of this job (the command never arrived or the agent restarted)";

const msToIso = (ms: bigint): string | null => (ms > 0n ? new Date(Number(ms)).toISOString() : null);

export function infoToInput(b: BackupInfo): BackupInput {
  return {
    serverId: b.serverId, filename: b.filename, sizeBytes: Number(b.sizeBytes), sha256: b.sha256,
    specVersion: Number(b.specVersion), trigger: TRIGGERS[b.trigger] ?? "manual",
    startedAt: msToIso(b.startedUnixMs) ?? nowIso(), finishedAt: msToIso(b.finishedUnixMs),
  };
}

/** No overall deadline: lasts as long as needed while bytes flow (cut by the watchdog, expiry and the WS). */
const DOWNLOAD_DEADLINE_MS = 2 ** 31 - 1;

/** How often the panel requests the inventory from online nodes (m-f: the agent's periodic one is not correlated). */
export const INVENTORY_EVERY_MS = 10 * 60_000;

/** Backups (spec §7 BackupService): `backups` table, commands to the agent and inventory. */
export class BackupService {
  /** Idempotency-Key of POST /backups → job (in memory, bounded). */
  private keys = new Map<string, string>();
  /**
   * Last inventory request per node: BackupList id (ids are not repeated across sessions,
   * see `AgentHub.allocateId`) and its start. Replaced on every Hello, so it is the current session's.
   */
  private lastList = new Map<string, { id: bigint; since: string }>();

  constructor(private app: FastifyInstance, private repo: BackupsRepo) {}

  start() {
    // After every Hello (not on "attached": until then the agent does not serve requests).
    this.app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case === "hello") void this.sync(nodeId);
    });
    // plan-9 (m-f): also, every 10 min, a correlated inventory from each online node: applies the negative path
    // (deleted backups whose BackupDeleted was lost) without waiting for the next reconnection.
    const timer = setInterval(() => this.syncAll(), INVENTORY_EVERY_MS);
    timer.unref();
    this.app.addHook("onClose", async () => clearInterval(timer));
  }

  /** Requests the inventory from all online nodes. */
  syncAll(): void {
    for (const nodeId of this.app.agents.onlineIds()) void this.sync(nodeId);
  }

  list(serverId: string): BackupDto[] {
    this.requireServer(serverId);
    return this.repo.list(serverId).map(toBackupDto);
  }

  /** Requests the backup and job inventory from the agent; it arrives as an unsolicited BackupInventory. */
  async sync(nodeId: string): Promise<void> {
    const conn = this.app.agents.get(nodeId);
    if (!conn) return;
    const since = nowIso();
    const { id, response } = conn.requestTracked({ case: "backupList", value: { serverId: "" } }, 30_000);
    // Before waiting: the inventory goes through the agent's notice queue and may overtake the Ack.
    this.lastList.set(nodeId, { id, since });
    try {
      await response;
    } catch (e) {
      // A disconnection is normal (the WS flickers): the next Hello requests it again.
      if (e instanceof AgentError && e.code === AgentErrorCode.Disconnected) {
        this.app.log.info({ nodeId }, "backup inventory unanswered: the agent disconnected; it will be requested on reconnect");
        return;
      }
      this.app.log.warn({ nodeId, err: e }, "could not request the backup inventory from the agent");
    }
  }

  /** Unsolicited messages from the agent (dispatched by AgentService). */
  onAgentMessage(nodeId: string, env: Envelope): void {
    switch (env.body.case) {
      case "jobProgress": return this.onJobProgress(nodeId, env.body.value);
      case "backupCreated": return this.onBackupCreated(nodeId, env.body.value);
      case "backupDeleted": return this.onBackupDeleted(nodeId, env.body.value);
      case "backupInventory": return this.onInventory(nodeId, env.body.value);
      default: return;
    }
  }

  // User actions

  /** Immediate manual backup. Returns the job; progress arrives on the `jobs` topic. */
  async createNow(serverId: string, idempotencyKey?: string): Promise<JobDto> {
    const row = this.requireServer(serverId);
    // A browser retry with the same key returns the job already created.
    const keyed = idempotencyKey ? `${serverId}:${idempotencyKey}` : "";
    const prior = keyed ? this.keys.get(keyed) : undefined;
    const existing = prior ? this.app.jobs.get(prior) : null;
    if (existing) return existing;
    const conn = this.onlineConn(row.node_id);
    const job = this.app.jobs.create({
      type: "backup", serverId, nodeId: row.node_id, status: "running", message: "Requesting the backup from the agent", payload: { trigger: "manual" },
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
      throw new HttpError(400, "This is the data that existed before a restore: it cannot be restored from here. Delete it when you no longer need it.");
    }
    const conn = this.onlineConn(row.node_id);
    const job = this.app.jobs.create({
      type: "restore", serverId, nodeId: row.node_id, status: "running", message: "Requesting the restore from the agent",
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
      throw agentErrorToHttp(e, "Could not delete the backup");
    }
    this.repo.markDeleted(serverId, b.filename);
    this.app.events.emit("backups", serverId);
  }

  /**
   * Changes `spec.backups` (schedule and retention) with the Plan 3 spec PATCH (`serversService.patch`). It is a
   * first-level merge: the body replaces the whole `backups` section (whatever is omitted inside it goes back to its
   * defaults). Same limits, zod errors in English with the field path and port check;
   * if nothing changes, no new version and no ApplySpec. It is not an immediate action: with the node offline it is saved and
   * versioned without 409, and the spec arrives in the next SyncSpecs.
   */
  async updateSchedule(serverId: string, input: Record<string, unknown>) {
    return this.app.serversService.patch(serverId, { spec: { backups: input } });
  }

  // Internal

  /** Sends a job's command. With no response (disconnection or timeout) the job stays open: the agent
   * may be executing it and the inventory on reconnect will clear it up. An explicit Error closes it. */
  private async dispatch(conn: AgentConn, jobId: string, body: Body): Promise<void> {
    try {
      await conn.request(body, 30_000);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Disconnected || e.code === AgentErrorCode.Timeout)) {
        this.app.jobs.update(jobId, { message: "The agent has not confirmed the command yet; the status will be updated when it reports" });
        return;
      }
      const err = agentErrorToHttp(e, "The agent rejected the command");
      this.app.jobs.finish(jobId, "failed", err.message);
      throw err;
    }
  }

  /**
   * Download of a backup to the browser (spec §6.5 “download”): the agent uploads it with BackupPush (Plan 7) to an
   * incoming transfer, which is forwarded to the browser without touching disk. Pre-restore data is a folder:
   * it is not downloaded.
   */
  async download(serverId: string, backupId: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null; filename: string; done: Promise<void> }> {
    const row = this.requireServer(serverId);
    const b = this.requireBackup(serverId, backupId);
    if (b.trigger === "pre_restore") throw new HttpError(400, "This is the data from before a restore (a folder on the node): it cannot be downloaded from here");
    const conn = this.onlineConn(row.node_id);
    const t = this.app.transfers.inbound(row.node_id);
    signal?.addEventListener("abort", () => t.cancel("the browser cancelled the download"), { once: true });
    const req = conn.request({ case: "backupPush", value: { serverId, filename: b.filename, transferId: t.id } }, DOWNLOAD_DEADLINE_MS);
    const done = req.then(() => undefined);
    done.catch(() => {});
    try {
      const incoming = await Promise.race([
        t.incoming,
        req.then((): never => { throw new HttpError(502, "The agent finished without sending the backup"); }),
      ]);
      const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
        t.cancel("the node stopped sending the backup");
        return new HttpError(504, "The node stopped sending the backup");
      });
      pipeline(incoming.stream, guard, () => { /* the response sees the result */ });
      return { stream: guard, size: incoming.size, filename: b.filename, done };
    } catch (e) {
      t.cancel("download failed");
      throw toHttpError(e, "Could not download the backup");
    }
  }

  private requireBackup(serverId: string, backupId: string) {
    const b = this.repo.get(backupId);
    if (!b || b.server_id !== serverId || b.status === "deleted") throw new HttpError(404, "Backup not found");
    return b;
  }

  private onlineConn(nodeId: string): AgentConn {
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "The node is offline");
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
   * Agent inventory: after each request (`sync`) and, unprompted, every 10 min. The positive part (new backups and
   * job statuses) is always applied. The negative path (deleted backups, lost jobs) only if the inventory
   * answers this node's last request (`request_id`): the agent computed it after receiving it, so whatever was
   * created before `since` and is absent no longer exists (backups) or was lost (jobs), and whatever was created later is not
   * touched (races with notices that cross the inventory). The periodic one (request_id 0) and one from an earlier request
   * (queued in another session and delivered after this one's Hello) may predate a live job: only the
   * positive part. That is why a backup whose BackupDeleted was discarded (agent queue full) stays listed until the
   * next Hello.
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
      // The agent's log is only the tail (4 KiB): it replaces the panel's only if the latter has nothing yet
      // (a job the panel was not following); otherwise the periodic inventory would eat the header every 10 min.
      const hasLog = (this.app.jobs.getRow(r.jobId)?.log ?? "") !== "";
      const status = STATUSES[r.status] ?? "running";
      this.app.jobs.update(r.jobId, {
        status, progress: r.progress, message: r.message, ...(hasLog ? {} : { log: r.log }),
        finishedAt: FINAL_STATES.has(status) ? agentIso(r.finishedUnixMs) ?? undefined : undefined,
      });
    }
    if (!since) return;
    // Backup/restore jobs of this node that the agent does not know: they were lost.
    for (const row of this.app.jobs.openAgentJobs(nodeId, since)) {
      if (!known.has(row.id)) this.app.jobs.finish(row.id, "failed", LOST);
    }
  }

  /**
   * Idempotent get-or-create: the agent resends its jobs after reconnecting and `create({id})` would throw
   * UNIQUE. Returns false if the job belongs to another node or is new and its server is not on this node.
   * A job that is already terminal is left as is (`JobService.update` ignores it).
   */
  private ensureJob(nodeId: string, jobId: string, serverId: string, type: string, startedAt: string | null): boolean {
    if (!jobId) return false;
    const existing = this.app.jobs.getRow(jobId);
    // plan-9: only jobs the agent runs; the migration one (source node) is run by the panel.
    if (existing) return existing.node_id === nodeId && (AGENT_JOB_TYPES as readonly string[]).includes(existing.type);
    if (!this.ownServer(nodeId, serverId)) return false;
    // Job started by the agent itself (scheduled backup): created at the first notice, with its start time (m12).
    this.app.jobs.create({ id: jobId, type: type || "backup", serverId, nodeId, status: "running", payload: { trigger: "scheduled" }, startedAt: startedAt ?? undefined });
    return true;
  }

  private ownServer(nodeId: string, serverId: string): ServerRow | null {
    const row = serverId ? this.app.servers.get(serverId) : null;
    return row && row.node_id === nodeId ? row : null;
  }

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Server not found");
    return row;
  }
}
