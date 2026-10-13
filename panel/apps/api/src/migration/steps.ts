import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { pipeline, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { BackupTrigger, PowerActionType } from "@mcsm/proto";
import { AgentError, type AgentConn } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { IDLE_TIMEOUT_MS, idleGuard, type Timers } from "../files/stream.js";
import { newId } from "../lib/ids.js";
import { toServerSpecMessage, type ObservedDto, type ServerRow } from "../servers/repo.js";
import type { StagedFile } from "../transfers/staging.js";
import { errorText, StepError } from "./errors.js";
import { requiredSpace, retargetFilename, SPACE_MARGIN_MIN } from "./propose.js";
import type { MigrationRow } from "./repo.js";
import type { Reporter } from "./report.js";
import { onAgentMessage, waitJob, waitObserved } from "./wait.js";

export interface MigrationTimings {
  /** How long to wait for the server to become healthy on the target (spec §7: 5 min). */
  verifyTimeoutMs: number;
  /** With no progress from an agent sub-job (backup, receive) for this long, it is considered dead. */
  jobIdleMs: number;
  /** Attempts of the receive on the target (the backup stays in the staging between attempts). */
  receiveAttempts: number;
  /** Free space in bytes of dir's filesystem. */
  freeSpace: (dir: string) => Promise<number>;
  /** Every how many received bytes the panel's free space is checked again while the backup is saved. */
  spaceCheckEveryBytes: number;
}

export const DEFAULT_TIMINGS: MigrationTimings = {
  verifyTimeoutMs: 5 * 60_000,
  jobIdleMs: 30 * 60_000,
  receiveAttempts: 2,
  freeSpace: async (dir) => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  },
  spaceCheckEveryBytes: 64 * 1024 * 1024,
};

/**
 * What is still to be written into the panel's staging for the backups being uploaded (all of the process's migrations).
 * Each upload's pre-check subtracts it and the checks during writing require it to be free:
 * two large migrations at once do not fill the panel's disk (the same one as its SQLite). Pre-checks go
 * one at a time so that each sees what the previous one reserved.
 */
export class StagingBudget {
  /** Bytes still to write of the uploads in progress. */
  pendingBytes = 0;
  private turn: Promise<void> = Promise.resolve();

  /** Runs `check(pendingBytes)` exclusively and, if it does not throw, reserves `bytes`. Returns how to subtract progressively. */
  async reserve(bytes: number, check: (pending: number) => Promise<void>): Promise<{ wrote(n: number): void; release(): void }> {
    const run = this.turn.then(async () => {
      await check(this.pendingBytes);
      this.pendingBytes += bytes;
    });
    this.turn = run.catch(() => {});
    await run;
    let left = bytes;
    return {
      wrote: (n) => { const k = Math.min(n, left); left -= k; this.pendingBytes -= k; },
      release: () => { this.pendingBytes -= left; left = 0; },
    };
  }
}

export interface StepDeps { app: FastifyInstance; timers: Timers; timings: MigrationTimings; report: Reporter; budget: StagingBudget }
export interface BackupMade { filename: string; sizeBytes: number; sha256: string }
export interface Pushed { staged: StagedFile; dataBytes: number }

/**
 * Deadline for the target to claim the backup (GET /agent/transfer). The receive waits for one of the node's 2 backup/restore
 * slots BEFORE downloading (“Queued…”): with Files' 60 s deadline, two scheduled backups
 * at once on the target would make the migration fail for no reason. The same order as jobIdleMs.
 */
export const MIGRATION_CLAIM_TTL_MS = 30 * 60_000;

/** No overall deadline (setTimeout's maximum): a transfer that makes progress lasts as long as needed (as in Files). */
const NO_DEADLINE_MS = 2 ** 31 - 1;
/** Setting a directory aside (rename) or confirming a marker: fast, except waiting for the server's turn on the agent. */
const LONG_MS = 5 * 60_000;
/**
 * Deleting a whole world (undoing on the target, or removing with “delete source”) on an SD card or a slow disk can take
 * much longer. The agent does abort/retire/confirm of a server one at a time: if the deadline expires, the retry
 * waits its turn behind the delete in progress and then has nothing to do.
 */
const REMOVE_WORLD_MS = 30 * 60_000;

export const stagingId = (migrationId: string): string => `mig-${migrationId}`;

const isDoubtful = (e: unknown): boolean =>
  e instanceof AgentError && (e.code === AgentErrorCode.Disconnected || e.code === AgentErrorCode.Timeout);

function fmtBytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(n / 1024 ** 2)} MiB`;
}

function connOf(app: FastifyInstance, nodeId: string): AgentConn {
  const conn = app.agents.get(nodeId);
  if (!conn) throw new StepError(`Node “${app.nodes.get(nodeId)?.name ?? nodeId}” is offline`);
  return conn;
}

/**
 * The row as it ends up on the target, for `toServerSpecMessage`: another node, slug, spec and version, and without
 * `imported_from` (Plan 6): a migrated server no longer follows any original container (no `adopt`).
 */
export function targetRow(row: ServerRow, m: MigrationRow, desired: "running" | "stopped"): ServerRow {
  return { ...row, node_id: m.target_node_id, slug: m.target_slug, spec: m.target_spec, spec_version: m.target_version, desired_state: desired, imported_from: null };
}

/** Step 1. Stops the server on the source and leaves `stopped` as the desired state on the agent and in the row. */
export async function stopSource(d: StepDeps, m: MigrationRow): Promise<void> {
  try {
    await d.app.serversService.power(m.server_id, "stop");
  } catch (e) {
    throw new StepError(`Could not stop the server on the source: ${errorText(e)}`);
  }
  d.report.log(m.was_running ? "Server stopped on the source" : "The server was already stopped on the source");
}

/**
 * Step 2. `pre_migration` backup on the source (BackupNow) as a `backup` sub-job; its progress is reflected in the job. The
 * file, its size and its sha256 come from the BackupCreated with the same job_id, which the agent queues before the end of the
 * job (same FIFO queue): when the job ends well, the notice has already arrived.
 */
export async function backupSource(d: StepDeps, m: MigrationRow): Promise<BackupMade> {
  const { app } = d;
  const conn = connOf(app, m.source_node_id);
  const jobId = newId();
  app.jobs.create({
    id: jobId, type: "backup", serverId: m.server_id, nodeId: m.source_node_id, status: "running",
    message: "Requesting the pre-migration backup", payload: { trigger: "pre_migration", migrationId: m.id },
  });
  let made: BackupMade | null = null;
  const offCreated = onAgentMessage(app.agents, (nodeId, env) => {
    if (nodeId !== m.source_node_id || env.body.case !== "backupCreated" || env.body.value.jobId !== jobId) return;
    const b = env.body.value.backup;
    if (b && b.serverId === m.server_id) made = { filename: b.filename, sizeBytes: Number(b.sizeBytes), sha256: b.sha256 };
  });
  const wait = waitJob(app, jobId, {
    idleMs: d.timings.jobIdleMs, timers: d.timers, idleMessage: "The pre-migration backup has gone too long without progress",
    onProgress: (j) => safely(() => d.report.within(2, j.progress / 100, j.message || "copying")),
  });
  try {
    try {
      await conn.request({ case: "backupNow", value: { serverId: m.server_id, jobId, trigger: BackupTrigger.PRE_MIGRATION } }, 30_000);
    } catch (e) {
      if (!isDoubtful(e)) {
        app.jobs.finish(jobId, "failed", errorText(e));
        throw new StepError(`The source node could not make the backup: ${errorText(e)}`);
      }
      d.report.log("The source node has not confirmed the backup yet; waiting for it to report");
    }
    const job = await wait.promise;
    if (job.status !== "ok") throw new StepError(`The pre-migration backup failed: ${job.message}`);
    const got = made as BackupMade | null;
    if (!got) throw new StepError("The backup was made but the panel did not receive its notice (BackupCreated): try again");
    if (!got.sha256) throw new StepError("The backup has no sha256: it is not migrated without being able to verify it");
    d.report.log(`Backup ${got.filename}: ${fmtBytes(got.sizeBytes)}, sha256 ${got.sha256}`);
    return got;
  } finally {
    offCreated();
    wait.cancel();
  }
}

/**
 * Step 3. The source uploads the backup (BackupPush → PUT /agent/transfer) to the panel's staging. The panel's
 * space is checked beforehand and, on arrival, the exact size and the sha256 (against BackupCreated and BackupPushResult). If anything
 * fails, nothing is left in the staging.
 */
export async function pushToPanel(d: StepDeps, m: MigrationRow, made: BackupMade): Promise<Pushed> {
  const { app } = d;
  const dir = app.config.dataDir;
  const need = requiredSpace(made.sizeBytes);
  const budget = await d.budget.reserve(made.sizeBytes, async (pending) => {
    const free = await d.timings.freeSpace(dir).catch(() => null);
    if (free !== null && free - pending < need) {
      const others = pending > 0 ? ` (${fmtBytes(pending)} reserved by other migrations that are uploading their backup)` : "";
      throw new StepError(`There is no space on the panel for the backup: ${fmtBytes(need)} needed and ${fmtBytes(Math.max(free - pending, 0))} free${others}`);
    }
  });
  const conn = connOf(app, m.source_node_id);
  const t = app.transfers.inbound(m.source_node_id);
  const req = conn.request({ case: "backupPush", value: { serverId: m.server_id, filename: made.filename, transferId: t.id } }, NO_DEADLINE_MS);
  req.catch(() => {});
  let staged: StagedFile | null = null;
  try {
    const incoming = await Promise.race([
      t.incoming,
      req.then((): never => { throw new StepError("The source node finished without sending the backup"); }),
    ]);
    if (incoming.size !== null && incoming.size !== made.sizeBytes) {
      throw new StepError(`The source node sends ${incoming.size} bytes and the backup is ${made.sizeBytes}`);
    }
    const hash = createHash("sha256");
    let received = 0;
    let nextCheck = d.timings.spaceCheckEveryBytes;
    const progress = throttled((detail: string, fraction: number) => d.report.within(3, fraction, detail));
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        budget.wrote(chunk.length);
        progress(received, `uploading (${fmtBytes(received)} of ${fmtBytes(made.sizeBytes)})`, received / Math.max(made.sizeBytes, 1));
        if (received < nextCheck) {
          cb(null, chunk);
          return;
        }
        // Every N MiB: what remains of all uploads in progress plus the margin must still fit (spec: “watch
        // during the write”); the panel's disk is also its SQLite's.
        nextCheck = received + d.timings.spaceCheckEveryBytes;
        d.timings.freeSpace(dir).then((free) => {
          if (free < d.budget.pendingBytes + SPACE_MARGIN_MIN) {
            cb(new StepError(`The panel's disk is filling up (${fmtBytes(free)} free): the backup is cut to avoid filling it`));
          } else {
            cb(null, chunk);
          }
        }, () => cb(null, chunk));
      },
    });
    const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
      t.cancel("the source node stopped sending the backup");
      return new StepError("The source node stopped sending the backup");
    }, d.timers);
    const src = pipeline(incoming.stream, guard, meter, () => { /* save sees the result */ });
    staged = await app.staging.save(stagingId(m.id), src, { maxBytes: made.sizeBytes });
    const res = await req;
    if (res.body.case !== "backupPushResult") throw new StepError("Unexpected response from the source node");
    const digest = hash.digest("hex");
    if (staged.size !== made.sizeBytes || digest !== made.sha256 || res.body.value.sha256 !== made.sha256) {
      throw new StepError(`The backup arrived at the panel corrupted: sha256 ${digest}, expected ${made.sha256}`);
    }
    d.report.log(`Backup on the panel: ${fmtBytes(staged.size)}, sha256 verified`);
    return { staged, dataBytes: Number(res.body.value.dataBytes) };
  } catch (e) {
    t.cancel("migration failed");
    if (staged) await app.staging.remove(staged).catch(() => {});
    throw e;
  } finally {
    budget.release();
  }
}

/** Upload progress: at most one every PROGRESS_EVERY_BYTES or PROGRESS_EVERY_MS (and the first). */
const PROGRESS_EVERY_BYTES = 8 * 1024 * 1024;
const PROGRESS_EVERY_MS = 2_000;

/**
 * Progress of a step from a stream (Transform) or an event handler: bounded (m7: each update is a write to
 * SQLite and a WebSocket event) and never throwing. An exception inside transform() or an emitter would bring down the
 * process or cut off the other listeners; with the panel's disk full, jobs.update throws SQLITE_FULL.
 */
function throttled(report: (detail: string, fraction: number) => void): (bytes: number, detail: string, fraction: number) => void {
  let lastBytes = -Infinity;
  let lastAt = -Infinity;
  return (bytes, detail, fraction) => {
    const now = Date.now();
    if (bytes - lastBytes < PROGRESS_EVERY_BYTES && now - lastAt < PROGRESS_EVERY_MS) return;
    lastBytes = bytes;
    lastAt = now;
    safely(() => report(detail, fraction));
  };
}

/** Runs a progress notice without letting exceptions escape (see throttled). */
function safely(fn: () => void): void {
  try {
    fn();
  } catch { /* progress is informational: a failure to save it does not cut the migration */ }
}

/**
 * Step 4. The target receives the backup from the staging (MigrateReceive → GET /agent/transfer) and restores it, as a
 * `migrate_in` sub-job. `target_touched` is set BEFORE requesting it: from here, undoing requires MigrateAbort. A
 * job failure (or a command with no response) is retried once after cleaning up the previous attempt; an
 * explicit rejection from the agent (exists, too_large…) is not.
 */
export async function receiveOnTarget(d: StepDeps, m: MigrationRow, pushed: Pushed, made: BackupMade): Promise<void> {
  const { app } = d;
  app.migrations.update(m.id, { target_touched: 1 });
  const filename = retargetFilename(made.filename, m.source_slug, m.target_slug);
  let last = "";
  for (let attempt = 1; attempt <= d.timings.receiveAttempts; attempt++) {
    if (attempt > 1) {
      d.report.log(`Retrying the receive on the target (attempt ${attempt} of ${d.timings.receiveAttempts})`);
      // The agent serves each message in its own goroutine: without the cleanup's Ack, a still-pending MigrateAbort
      // could run after the new receive and delete it. If it is not confirmed, it is not retried (rolling back
      // will keep trying the cleanup).
      try {
        await abortTarget(d, m);
      } catch (e) {
        throw new StepError(`The receive on the target failed (${last}) and the previous attempt could not be cleaned up: ${errorText(e)}`);
      }
    }
    const conn = connOf(app, m.target_node_id);
    const jobId = newId();
    app.jobs.create({
      id: jobId, type: "migrate_in", serverId: m.server_id, nodeId: m.target_node_id, status: "running",
      message: "Requesting the backup receive", payload: { migrationId: m.id },
    });
    const out = app.transfers.outbound(m.target_node_id, app.staging.source(pushed.staged, { removeAfter: false }), { claimTtlMs: MIGRATION_CLAIM_TTL_MS });
    out.done.catch(() => {});
    const wait = waitJob(app, jobId, {
      idleMs: d.timings.jobIdleMs, timers: d.timers, idleMessage: "The receive on the target has gone too long without progress",
      onProgress: (j) => safely(() => d.report.within(4, j.progress / 100, j.message || "receiving")),
    });
    try {
      try {
        await conn.request({ case: "migrateReceive", value: {
          serverId: m.server_id, slug: m.target_slug, jobId, migrationId: m.id, transferId: out.id, filename,
          sizeBytes: BigInt(made.sizeBytes), sha256: made.sha256, dataBytes: BigInt(pushed.dataBytes),
        } }, 30_000);
      } catch (e) {
        app.jobs.finish(jobId, "failed", errorText(e));
        if (!isDoubtful(e)) throw new StepError(`The target node rejected the backup: ${errorText(e)}`);
        last = errorText(e);
        continue;
      }
      const job = await wait.promise;
      if (job.status === "ok") {
        d.report.log("Backup received, verified (sha256) and restored on the target");
        return;
      }
      last = job.message;
    } finally {
      out.cancel("receive finished"); // no effect if it already ended
      wait.cancel();
    }
  }
  throw new StepError(`The receive on the target failed: ${last}`);
}

/** Step 5. The target stores the spec (target slug and port, version +1) with the server stopped. */
export async function applyOnTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  const row = d.app.servers.get(m.server_id);
  if (!row) throw new StepError("The server no longer exists in the panel");
  const conn = connOf(d.app, m.target_node_id);
  try {
    await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(targetRow(row, m, "stopped"), d.app.curseforge.get()) } }, 120_000);
  } catch (e) {
    throw new StepError(`The target node could not create the server: ${errorText(e)}`);
  }
  d.report.log(`Server created on the target (slug ${m.target_slug}, port ${m.target_port}, version ${m.target_version})`);
}

/**
 * Step 6. Starts on the target and waits for it to become healthy (at most `verifyTimeoutMs`). `target_started` is set
 * BEFORE the command: if anything fails from here, the source is not restarted until the target copy has been removed.
 */
export async function startAndVerify(d: StepDeps, m: MigrationRow): Promise<ObservedDto> {
  d.app.migrations.update(m.id, { target_started: 1 });
  const conn = connOf(d.app, m.target_node_id);
  const w = waitObserved(d.app.agents, m.target_node_id, m.server_id, {
    timeoutMs: d.timings.verifyTimeoutMs, timers: d.timers,
    onObserved: (o) => safely(() => d.report.within(6, 0.5, `state ${o.state}${o.health ? `, healthcheck ${o.health}` : ""}`)),
  });
  try {
    await conn.request({ case: "powerAction", value: { serverId: m.server_id, action: PowerActionType.START } }, 90_000);
  } catch (e) {
    w.cancel();
    throw new StepError(`The server did not start on the target: ${errorText(e)}`);
  }
  d.report.within(6, 0.2, `waiting for it to start and respond (max. ${Math.round(d.timings.verifyTimeoutMs / 60_000)} min)`);
  const o = await w.promise;
  d.report.log(`The server responds on the target (${o.health === "healthy" ? "healthy healthcheck" : "successful ping"})`);
  return o;
}

/** Step 6 (if it was stopped). Stops it again on the target after checking it. */
export async function stopTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  try {
    await connOf(d.app, m.target_node_id).request({ case: "powerAction", value: { serverId: m.server_id, action: PowerActionType.STOP } }, 90_000);
  } catch (e) {
    throw new StepError(`Could not stop the server again on the target: ${errorText(e)}`);
  }
}

/**
 * Step 7 (after the commit). Removes the server from the source: <slug>.migrated-<ts> or deleted with “delete source”. Carries the
 * version that was migrated: the agent does not touch a server that has another (e.g. it later came back to that node).
 */
export async function retireSource(d: StepDeps, m: MigrationRow): Promise<void> {
  await connOf(d.app, m.source_node_id).request({ case: "migrateRetire", value: {
    serverId: m.server_id, slug: m.source_slug, migrationId: m.id, deleteData: m.delete_source === 1, sourceVersion: BigInt(m.source_version),
  } }, m.delete_source === 1 ? REMOVE_WORLD_MS : LONG_MS);
}

/**
 * Step 7 (after the commit). Confirms the migration on the target (MigrateConfirm): its marker becomes “committed” and
 * from then on no MigrateAbort (e.g. from a panel restored from a snapshot before the commit) deletes it.
 */
export async function confirmTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  await connOf(d.app, m.target_node_id).request({ case: "migrateConfirm", value: {
    serverId: m.server_id, slug: m.target_slug, migrationId: m.id,
  } }, LONG_MS);
}

/**
 * Undo: deletes from the target the spec, the container and the marked directory of this migration. NEVER after the commit:
 * the marker stays in the target's directory and the agent does not know about the commit, so a late MigrateAbort
 * would delete the live server. The phase is read from the table just before sending (the commit changes it in its transaction
 * and a confirmed migration does not go back, see MigrationsRepo.update).
 */
export async function abortTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  const cur = d.app.migrations.get(m.id);
  if (!cur || (cur.phase !== "running" && cur.phase !== "rolling_back")) {
    throw new StepError(`The migration is already ${cur ? "confirmed or closed" : "deleted"}: nothing is undone on the target`);
  }
  await connOf(d.app, m.target_node_id).request({ case: "migrateAbort", value: { serverId: m.server_id, slug: m.target_slug, migrationId: m.id } }, REMOVE_WORLD_MS);
}

/** Undo: starts the server again on the source (desired state `running` on the agent and in the row). */
export async function restartSource(d: StepDeps, m: MigrationRow): Promise<void> {
  await d.app.serversService.power(m.server_id, "start");
}
