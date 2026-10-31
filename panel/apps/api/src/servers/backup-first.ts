import type { BackupFirstAccepted, SpecPatch } from "@mcsm/shared";
import type { FastifyInstance } from "fastify";
import type { JobDto } from "../jobs/repo.js";
import { FINAL_STATES } from "../jobs/service.js";
import { HttpError } from "../lib/http.js";

export const SPEC_APPLY_JOB = "spec_apply";

type Input = { name?: string; spec?: SpecPatch };

interface Pending {
  serverId: string;
  input: Input;
  baseVersion: number;
  jobId: string | null;
  backupJobId: string | null;
  /** Set once the outcome is decided: later events for the same backup are ignored. */
  done: boolean;
}

/**
 * "Back up first" (plan 11): a configuration change is applied with `serversService.patch` only after a manual backup
 * of the server ends `ok`, and only if the spec version is still the one the change was based on and no migration
 * started meanwhile. At most one waiting change per server. In memory only: a panel restart fails the `spec_apply`
 * job (`JobService.interruptStale`, it is not an agent job type) and the change is never applied late.
 */
export class BackupFirst {
  private readonly byServer = new Map<string, Pending>();
  private readonly byBackup = new Map<string, Pending>();
  private readonly byJob = new Map<string, Pending>();

  constructor(private readonly app: FastifyInstance) {}

  start(): void {
    this.app.events.on("job", (dto: JobDto) => {
      if (!FINAL_STATES.has(dto.status)) return;
      const own = this.byJob.get(dto.id);
      if (own) { this.forget(own); return; } // the apply job ended (by us, or interrupted by a restart)
      const p = this.byBackup.get(dto.id);
      if (p) this.settleLogged(p, dto.status);
    });
  }

  /** Validates, starts the backup and returns the apply job; null when the change touches no spec (the route patches as usual). */
  async request(id: string, input: Input): Promise<BackupFirstAccepted | null> {
    const { row, spec } = this.app.serversService.prepare(id, input);
    if (!spec) return null;
    if (this.byServer.has(id)) throw new HttpError(409, "A change is already waiting for a backup of this server");
    const p: Pending = { serverId: id, input: { name: input.name, spec: input.spec }, baseVersion: row.spec_version, jobId: null, backupJobId: null, done: false };
    this.byServer.set(id, p); // reserved before the first await: a concurrent request gets the 409
    let backup: JobDto;
    try {
      backup = await this.app.backupsService.createNow(id);
    } catch (e) {
      this.byServer.delete(id);
      throw e;
    }
    const job = this.app.jobs.create({
      type: SPEC_APPLY_JOB, serverId: id, nodeId: row.node_id, status: "running",
      message: "Waiting for the backup before applying the change",
      payload: { backupJobId: backup.id, baseVersion: p.baseVersion, patch: p.input },
    });
    p.jobId = job.id;
    p.backupJobId = backup.id;
    this.byJob.set(job.id, p);
    this.byBackup.set(backup.id, p);
    // The backup may have ended before createNow returned (its final event was not ours to see yet).
    const now = this.app.jobs.get(backup.id);
    if (now && FINAL_STATES.has(now.status)) this.settleLogged(p, now.status);
    return { jobId: job.id };
  }

  /** Runs `settle` from an event: a failure to record the outcome (SQLite) is logged, never an unhandled rejection. */
  private settleLogged(p: Pending, backupStatus: JobDto["status"]): void {
    this.settle(p, backupStatus).catch((err: unknown) => this.app.log.error({ err, serverId: p.serverId }, "back up first: settle failed"));
  }

  private async settle(p: Pending, backupStatus: JobDto["status"]): Promise<void> {
    if (p.done || !p.jobId) return;
    p.done = true;
    const jobId = p.jobId;
    const fail = (message: string) => { this.app.jobs.finish(jobId, "failed", message); };
    try {
      const own = this.app.jobs.get(jobId);
      if (!own || FINAL_STATES.has(own.status)) return; // interrupted: never applied late
      if (backupStatus !== "ok") return fail("The backup failed: the change was not applied");
      if (this.app.migrations.blockingServer(p.serverId)) return fail("A migration started: the change was not applied");
      if (this.app.servers.get(p.serverId)?.spec_version !== p.baseVersion) {
        return fail("The configuration changed while the backup ran: the change was not applied. Review it and save again");
      }
      const dto = await this.app.serversService.patch(p.serverId, p.input);
      this.app.jobs.finish(jobId, "ok", `Backup done; change applied (v${dto.specVersion})`);
    } catch (e) {
      if (!(e instanceof HttpError)) this.app.log.error({ err: e, serverId: p.serverId }, "back up first: could not apply the change");
      fail(e instanceof HttpError ? e.message : "Could not apply the change");
    } finally {
      this.forget(p);
    }
  }

  private forget(p: Pending): void {
    p.done = true;
    if (this.byServer.get(p.serverId) === p) this.byServer.delete(p.serverId);
    if (p.jobId) this.byJob.delete(p.jobId);
    if (p.backupJobId) this.byBackup.delete(p.backupJobId);
  }
}

declare module "fastify" {
  interface FastifyInstance { backupFirst: BackupFirst }
}
