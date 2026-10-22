import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import {
  formatZodError, MIGRATION_STEPS, migrationLeftovers, migrationProposalQuerySchema, migrationRequestSchema, specHostPorts, specSchema, stepMessage,
  type MigrationDto, type MigrationProposalDto, type MigrationStep, type Spec,
} from "@mcsm/shared";
import { realTimers, type Timers } from "../files/stream.js";
import type { JobDto } from "../jobs/repo.js";
import { HttpError } from "../lib/http.js";
import type { ObservedDto, ServerRow } from "../servers/repo.js";
import type { StagedFile } from "../transfers/staging.js";
import { errorText, isDefinitive, isKnownError, StepError } from "./errors.js";
import { proposeTarget, type TargetServer } from "./propose.js";
import { toMigrationDto, type MigrationPatch, type MigrationRow } from "./repo.js";
import { JobReporter, type Reporter } from "./report.js";
import {
  abortTarget, applyOnTarget, backupSource, confirmTarget, DEFAULT_TIMINGS, pushToPanel, receiveOnTarget, restartSource, retireSource,
  StagingBudget, startAndVerify, stopSource, stopTarget, type MigrationTimings, type StepDeps,
} from "./steps.js";

/** How often what is pending is retried (undo, remove the source), in addition to after every Hello. */
export const PENDING_EVERY_MS = 30_000;
export const INTERRUPTED = "interrupted: the panel restarted during the migration";
/** The migration disappeared while rolling back: one of its nodes was deleted (its rows cascade). */
const GONE = "One of the nodes was deleted during the migration: the server remains on its source node, possibly stopped. Before starting it manually, " +
  "check that the target copy is not still running (if the node was only isolated from the network, its container may still be alive)";

/** Pending work of a migration that is rolling back or was already confirmed; its name leads `pending_error`. */
type PendingKind = "abort" | "restart" | "confirm" | "retire";
const PENDING_LABEL: Record<PendingKind, string> = {
  abort: "Clean up the target", restart: "Start the source again", confirm: "Confirm on the target", retire: "Remove the source",
};
/** Mark of a pending item that stopped being retried (definitive rejection by the agent). */
const DEFINITIVE = "not retried";

interface Plan {
  target: { id: string; name: string }; slug: string; port: number; portChanged: boolean; currentPort: number;
  rconPort: number | null; rconChanged: boolean; spec: Spec;
}

const silent = (log: (line: string) => void): Reporter => ({ step: () => {}, within: () => {}, message: () => {}, log });

/**
 * Migration between nodes (spec §7 MigrationService): 7-step `migrate` job, orchestrated here, over the
 * `migrations` table (durable state: what remains to undo or remove if the panel restarts or a node goes down).
 */
export class MigrationService {
  /** Timers for the waits (tests provide ManualTimers). */
  timers: Timers = realTimers;
  timings: MigrationTimings = { ...DEFAULT_TIMINGS };
  /** Bytes still to write into the staging of the backups being uploaded (all migrations, see StagingBudget). */
  private budget = new StagingBudget();
  /** Migrations with work in progress in this process (steps or pending): never two tasks at once on one. */
  private busy = new Set<string>();
  private tick: NodeJS.Timeout | undefined;

  constructor(private app: FastifyInstance) {}

  start(): void {
    // After a node's Hello, what is pending with it (requests wait on their own for the SyncSpecs Ack).
    this.app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case === "hello") void this.runPending(nodeId);
    });
  }

  /** When the panel starts: what was in progress starts rolling back; what is pending is retried every 30 s. */
  async recover(): Promise<void> {
    const rows = this.app.migrations.interruptRunning(INTERRUPTED);
    if (rows.length > 0) this.app.log.warn({ count: rows.length }, "migrations interrupted by the panel restart: rolling them back");
    if (!this.tick) {
      this.tick = setInterval(() => void this.runPending(), PENDING_EVERY_MS);
      this.tick.unref();
    }
    await this.runPending();
  }

  close(): void {
    clearInterval(this.tick);
    this.tick = undefined;
  }

  latest(serverId: string): { migration: MigrationDto | null } {
    this.requireServer(serverId);
    const m = this.app.migrations.latestForServer(serverId);
    return { migration: m ? toMigrationDto(m) : null };
  }

  proposal(serverId: string, query: unknown): MigrationProposalDto {
    const q = migrationProposalQuerySchema.parse(query);
    const p = this.plan(this.requireServer(serverId), q.targetNodeId, q.port);
    return {
      targetNodeId: p.target.id, slug: p.slug, port: p.port, currentPort: p.currentPort, portChanged: p.portChanged,
      rconPort: p.rconPort, rconChanged: p.rconChanged,
    };
  }

  /** Validates and launches the migration. Returns the job (202); progress goes through the `jobs` topic. */
  begin(serverId: string, body: unknown): JobDto {
    const input = migrationRequestSchema.parse(body);
    const row = this.requireServer(serverId);
    const p = this.plan(row, input.targetNodeId, input.port);
    const sourceName = this.nodeName(row.node_id);
    if (!this.app.agents.get(row.node_id)) throw new HttpError(409, `The source node “${sourceName}” is offline`);
    if (!this.app.agents.get(p.target.id)) throw new HttpError(409, `The target node “${p.target.name}” is offline`);
    // No await between the checks and the insert: two simultaneous requests do not launch two migrations.
    const wasRunning = row.desired_state === "running";
    const job = this.app.jobs.create({
      type: "migrate", serverId, nodeId: row.node_id, status: "running", message: stepMessage(1, "preparando"),
      payload: { targetNodeId: p.target.id, targetNodeName: p.target.name, sourceNodeName: sourceName, slug: p.slug, port: p.port, rconPort: p.rconPort, rconChanged: p.rconChanged, deleteSource: input.deleteSource, wasRunning },
    });
    this.app.migrations.insert({
      id: job.id, server_id: serverId, source_node_id: row.node_id, target_node_id: p.target.id, source_slug: row.slug, target_slug: p.slug,
      source_version: row.spec_version, target_version: row.spec_version + 1, target_port: p.port, target_spec: JSON.stringify(p.spec),
      was_running: wasRunning ? 1 : 0, delete_source: input.deleteSource ? 1 : 0,
    });
    void this.run(job.id);
    return job;
  }

  /**
   * Retries what is pending (of one node, or of all): undo, confirm on the target or remove the source. Each
   * migration goes on its own (in parallel): a slow delete on one node does not delay the pending work of the others.
   */
  async runPending(nodeId?: string): Promise<void> {
    const work: Promise<void>[] = [];
    for (const m of this.app.migrations.listOpen()) {
      if (m.phase === "running" || this.busy.has(m.id)) continue;
      if (nodeId && m.source_node_id !== nodeId && m.target_node_id !== nodeId) continue;
      this.busy.add(m.id);
      work.push((async () => {
        try {
          await this.settle(m.id, (line) => this.app.log.info({ migrationId: m.id, serverId: m.server_id }, line));
        } catch (e) {
          this.app.log.warn({ err: e, migrationId: m.id }, "failure retrying a migration's pending work");
        } finally {
          this.busy.delete(m.id);
        }
      })());
    }
    await Promise.all(work);
  }

  /**
   * Manual closing of a stuck migration (rolling_back or committed): stops retrying what is pending and notes what
   * is left undone, to resolve it by hand. Sends nothing to the nodes.
   */
  closeManually(serverId: string): { migration: MigrationDto } {
    this.requireServer(serverId);
    const m = this.app.migrations.openForServer(serverId);
    if (!m) throw new HttpError(404, "This server has no open migration");
    if (m.phase === "running") throw new HttpError(409, "The migration is in progress: wait for it to finish or fail (only what remains pending is closed manually)");
    if (this.busy.has(m.id)) throw new HttpError(409, "This migration's pending work is being retried: wait a few seconds and try again");
    const left = migrationLeftovers(toMigrationDto(m), (id) => this.nodeName(id));
    const row = this.app.migrations.update(m.id, {
      phase: m.phase === "committed" ? "done" : "failed", source_pending: 0, target_pending: 0, target_confirm_pending: 0,
      pending_error: `Closed by hand${left.length ? `: ${left.join("; ")}` : ""}`,
    });
    this.app.log.warn({ migrationId: m.id, serverId, left }, "migration closed manually");
    return { migration: toMigrationDto(row) };
  }

  // Internal

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Server not found");
    return row;
  }

  private nodeName(id: string): string {
    return this.app.nodes.get(id)?.name ?? "another node";
  }

  private deps(report: Reporter): StepDeps {
    return { app: this.app, timers: this.timers, timings: this.timings, report, budget: this.budget };
  }

  /** Checks that it can be migrated and computes slug, port and spec on the target. Throws HttpError. */
  private plan(row: ServerRow, targetNodeId: string, port?: number): Plan {
    if (targetNodeId === row.node_id) throw new HttpError(400, "The server is already on that node");
    const target = this.app.nodes.get(targetNodeId);
    if (!target) throw new HttpError(404, "Target node not found");
    const open = this.app.migrations.openForServer(row.id);
    if (open) throw new HttpError(409, this.openMessage(open));
    const spec = JSON.parse(row.spec) as Spec;
    // dataPath (Plan 6): the data is outside DATA_ROOT and the agent can neither copy nor restore it. dataPath
    // is not removed via PATCH (dataPathPatchError): the way is the same as Plan 6 gives, import it again.
    if (spec.dataPath) {
      throw new HttpError(409, `The data of “${row.name}” is in ${spec.dataPath}, outside DATA_ROOT, and the agent cannot copy it: it cannot be migrated. To migrate it, remove it without deleting data, move that folder to DATA_ROOT/${row.slug}/data on the node and import it again`);
    }
    // Plan 8 (H1): with the source router's autoscale, mc-router would start the stopped server (it has a hostname) as
    // soon as a player tried to join, between step 1 and the removal: the backup would be out of date or what was
    // played there would be lost. Parking it (Park) is not enough: when the backup's reservation is released it is recreated and started.
    if (spec.router?.enabled && this.app.routerService.autoscaleOn(row.node_id)) {
      const source = this.nodeName(row.node_id);
      throw new HttpError(409, `“${row.name}” has a hostname and the router of “${source}” has autoscale enabled: mc-router could start it on the source ` +
        `during the migration. Remove autoscale from the router of “${source}” or disable the server's hostname before migrating it`);
    }
    // Plan 8: the router hostname, free on the target too (counting open migrations towards it).
    this.app.routerService.checkHostname(targetNodeId, spec, row.id, target.name);
    const targetServers: TargetServer[] = this.app.servers.list(targetNodeId).map((r) => ({ slug: r.slug, spec: JSON.parse(r.spec) as Spec }));
    // What other unconfirmed migrations towards that node already reserve and, if the node is the source of a confirmed
    // migration with the removal pending, its slug: <DATA_ROOT>/<slug> is still there until MigrateRetire, which
    // sets it aside without a spec (its ports are not: that server is stopped and already lives on another node).
    const reservedSlugs: string[] = [];
    for (const m of this.app.migrations.listOpen()) {
      if (m.target_node_id === targetNodeId && m.phase !== "committed" && m.server_id !== row.id) {
        targetServers.push({ slug: m.target_slug, spec: JSON.parse(m.target_spec) as Spec });
      }
      if (m.source_node_id === targetNodeId && m.phase === "committed") reservedSlugs.push(m.source_slug);
    }
    const p = proposeTarget({
      slug: row.slug, spec, targetServers, reservedSlugs, range: this.app.settings.gamePortRange(), requestedPort: port,
      routerPort: this.app.routerService.reservedPort(targetNodeId), // plan-8
    });
    if (!p.ok) throw new HttpError(409, p.error);
    const parsed = specSchema.safeParse({ ...spec, ports: { ...spec.ports, game: p.port, ...(p.rconPort === null ? {} : { rcon: p.rconPort }) } });
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return { target: { id: target.id, name: target.name }, slug: p.slug, port: p.port, portChanged: p.portChanged, currentPort: spec.ports.game, rconPort: p.rconPort, rconChanged: p.rconChanged, spec: parsed.data };
  }

  private openMessage(m: MigrationRow): string {
    if (m.phase === "running") return "There is already a migration in progress for this server";
    if (m.phase === "rolling_back") {
      const parts = [m.target_pending ? `clean up “${this.nodeName(m.target_node_id)}”` : "", m.source_pending ? `start on “${this.nodeName(m.source_node_id)}”` : ""].filter(Boolean);
      return `A previous migration is being rolled back (pending: ${parts.join(" and ")}); wait for the nodes to come back`;
    }
    return `The previous migration still has to remove the server from node “${this.nodeName(m.source_node_id)}”; wait for it to reconnect`;
  }

  private async run(id: string): Promise<void> {
    this.busy.add(id);
    const report = new JobReporter(this.app.jobs, id);
    const d = this.deps(report);
    let step: MigrationStep = 1;
    let staged: StagedFile | null = null;
    try {
      try {
        const m = this.app.migrations.get(id)!;
        report.step(1, m.was_running ? "stopping the server" : "checking that it is stopped");
        await stopSource(d, m);
        step = 2;
        report.step(2, "requesting the backup from the source node");
        const made = await backupSource(d, m);
        step = 3;
        report.step(3, made.filename);
        const pushed = await pushToPanel(d, m, made);
        staged = pushed.staged;
        step = 4;
        report.step(4, `sending the backup to “${this.nodeName(m.target_node_id)}”`);
        await receiveOnTarget(d, m, pushed, made);
        await this.app.staging.remove(pushed.staged);
        staged = null;
        step = 5;
        report.step(5, `slug ${m.target_slug}, port ${m.target_port}, version ${m.target_version}`);
        await applyOnTarget(d, m);
        step = 6;
        report.step(6, "starting");
        let observed: ObservedDto | null = await startAndVerify(d, m);
        if (!m.was_running) {
          report.within(6, 0.9, "it was stopped: stopping it again");
          await stopTarget(d, m);
          observed = null; // the target's next ServerObserved fills it in
        }
        step = 7;
        report.step(7, "confirming the node change");
        this.commit(id, observed);
        // From here the server lives on the target: nothing that follows can undo (see rollback).
        this.afterCommit(id, observed);
      } catch (e) {
        if (staged) await this.app.staging.remove(staged).catch(() => {});
        await this.rollback(id, step, e, report);
        return;
      }
      await this.finishCommitted(id, report);
    } catch (e) {
      // Neither rollback nor finishCommitted should throw; if it happens, do not leave an unhandled rejection.
      this.app.log.error({ err: e, migrationId: id }, "unexpected failure managing a migration");
    } finally {
      this.busy.delete(id);
    }
  }

  /** Commit: the row moves to the target in one transaction (if the version did not change). Throws StepError if it could not. */
  private commit(id: string, observed: ObservedDto | null): void {
    const m = this.app.migrations.get(id)!;
    this.checkRouterOnCommit(m); // synchronous, no await until the transaction
    if (!this.app.migrations.commit(m, m.was_running ? "running" : "stopped", observed)) {
      throw new StepError("Could not confirm: the server's configuration changed during the migration, or its slug or port stopped being free on the target");
    }
  }

  /**
   * Plan 8, just before the commit: during the migration another server on the target may have taken the router hostname, or
   * the router may have been enabled there on one of its ports (the API already prevents it; this covers whatever slips through). Throws StepError.
   */
  private checkRouterOnCommit(m: MigrationRow): void {
    const spec = JSON.parse(m.target_spec) as Spec;
    const target = this.nodeName(m.target_node_id);
    const user = this.app.routerService.hostnameUser(m.target_node_id, spec, m.server_id);
    if (user) throw new StepError(`Could not confirm: hostname “${spec.router!.hostname}” is already used by “${user.name}” on “${target}”`);
    const port = this.app.routerService.reservedPort(m.target_node_id);
    if (port !== null && specHostPorts(spec).includes(port)) {
      throw new StepError(`Could not confirm: port ${port} is now used by the router (mc-router) of “${target}”`);
    }
  }

  /**
   * After the commit: notice of the last observed state and backup inventory of the target (registers the received pre_migration
   * backup; those on the source are given up as deleted). Never throws: a failure here cannot undo an already
   * confirmed migration.
   */
  private afterCommit(id: string, observed: ObservedDto | null): void {
    const m = this.app.migrations.get(id);
    if (!m) return;
    try {
      if (observed) this.app.events.emit("observed", m.server_id, observed);
      void Promise.resolve(this.app.backupsService.sync(m.target_node_id)).catch((e: unknown) => this.app.log.warn({ err: e, migrationId: id }, "target backup inventory failed after the migration"));
    } catch (e) {
      this.app.log.error({ err: e, migrationId: id }, "failure after confirming a migration (it is not undone)");
    }
  }

  private async finishCommitted(id: string, report: Reporter): Promise<void> {
    report.within(7, 0.5, "confirming on the target and removing the server from the source node");
    const m = await this.settle(id, (line) => report.log(line));
    if (!m) {
      this.app.jobs.finish(id, "ok", "Migration completed; one of the nodes was deleted before the pending work finished");
      return;
    }
    this.app.jobs.finish(id, "ok", this.committedText(m));
  }

  /** Final message of a confirmed migration, with whatever is missing and why (without assuming the node is down). */
  private committedText(m: MigrationRow): string {
    const name = this.app.servers.get(m.server_id)?.name ?? "The server";
    const src = this.nodeName(m.source_node_id);
    const dst = this.nodeName(m.target_node_id);
    const notes: string[] = [];
    if (m.source_pending) {
      const kept = m.delete_source ? "its data will be deleted" : `its data will be left in ${m.source_slug}.migrated-…`;
      notes.push(this.app.agents.isOnline(m.source_node_id)
        ? `Could not remove the server from “${src}”${this.errorFor(m, "retire")}: it will be retried every 30 s (${kept})`
        : `“${src}” is offline: the server will be removed from there (${kept}) when it reconnects`);
    }
    if (m.target_confirm_pending) {
      notes.push(this.app.agents.isOnline(m.target_node_id)
        ? `Could not confirm the migration on “${dst}”${this.errorFor(m, "confirm")}: it will be retried every 30 s`
        : `“${dst}” is offline: the migration will be confirmed there when it reconnects`);
    }
    if (this.definitive(m, "retire")) notes.push(`The server was not removed from “${src}”: ${this.errorText(m, "retire")}`);
    if (this.definitive(m, "confirm")) notes.push(`The migration was not confirmed on “${dst}”: ${this.errorText(m, "confirm")}`);
    // The source's RCON port is not kept anywhere after the commit: the job's payload remembers whether it moved.
    const payload = this.app.jobs.get(m.id)?.payload;
    const rcon = payload?.rconChanged === true && typeof payload.rconPort === "number" ? `, RCON port ${payload.rconPort} (changed: the old one was taken)` : "";
    return [`Migration completed: “${name}” is on “${dst}”, port ${m.target_port}${rcon}`, ...notes].join(". ");
  }

  /** " (reason)" of the last failure of that pending item, or "". */
  private errorFor(m: MigrationRow, kind: PendingKind): string {
    const t = this.errorText(m, kind);
    return t ? ` (${t})` : "";
  }

  private errorText(m: MigrationRow, kind: PendingKind): string {
    const prefix = `${PENDING_LABEL[kind]}: `;
    return m.pending_error?.startsWith(prefix) ? m.pending_error.slice(prefix.length) : "";
  }

  private definitive(m: MigrationRow, kind: PendingKind): boolean {
    return this.errorText(m, kind).includes(DEFINITIVE);
  }

  private async rollback(id: string, step: MigrationStep, err: unknown, report: Reporter): Promise<void> {
    const msg = errorText(err);
    if (!isKnownError(err)) this.app.log.error({ err, migrationId: id }, "unexpected failure in a migration");
    // Only what is still in progress is rolled back: if it was already confirmed, the server lives on the target and undoing would delete it.
    if (!this.app.migrations.startRollback(id, `Step ${step}: ${msg}`)) {
      const cur = this.app.migrations.get(id);
      if (cur && (cur.phase === "committed" || cur.phase === "done")) {
        this.app.log.error({ err, migrationId: id }, "failure after confirming a migration: it is not undone");
        await this.finishCommitted(id, report);
        return;
      }
      this.app.jobs.finish(id, "failed", `Step ${step}/7 (${MIGRATION_STEPS[step - 1]}): ${msg}. The migration no longer exists (was a node deleted?): check the server on its source node`);
      return;
    }
    report.log(`ERROR in step ${step}: ${msg}`);
    report.message(step, "rolling back the migration");
    const m = await this.settle(id, (line) => report.log(line));
    this.app.jobs.finish(id, "failed", `Step ${step}/7 (${MIGRATION_STEPS[step - 1]}): ${msg}. ${m ? this.originText(m) : GONE}`);
  }

  private originText(m: MigrationRow): string {
    const src = this.nodeName(m.source_node_id);
    const dst = this.nodeName(m.target_node_id);
    if (m.phase === "failed") {
      const base = m.was_running ? `The server remains on “${src}” with its world intact` : `The server remains on “${src}” with its world intact (stopped, as it was)`;
      if (m.pending_error) return `${base}. Something remains to be resolved manually: ${m.pending_error}`;
      return m.was_running ? `${base} and it has been started again` : base;
    }
    const parts: string[] = [];
    if (m.target_pending) {
      parts.push(this.app.agents.isOnline(m.target_node_id)
        ? `the half-made copy on “${dst}” could not be deleted yet${this.errorFor(m, "abort")}: it will be retried every 30 s`
        : `the half-made copy on “${dst}” will be deleted when it reconnects`);
    }
    if (m.source_pending) {
      if (m.target_started && m.target_pending) {
        parts.push(`the server is stopped: it will be started once the copy on “${dst}” has been removed (to avoid having two live servers with the same world)`);
      } else {
        parts.push(this.app.agents.isOnline(m.source_node_id)
          ? `could not be started again${this.errorFor(m, "restart")}: it will be retried every 30 s`
          : `it will be started again when “${src}” reconnects`);
      }
    }
    return `The server remains on “${src}” with its world intact; ${parts.join("; ")}`;
  }

  /**
   * Tries what is pending of a migration that is rolling back or was already confirmed and returns the resulting row (null if
   * it disappeared: deleting a node deletes its migrations in cascade). Undo: first the target (MigrateAbort) and then
   * the source; if the target did get started and could not be cleaned up, the source is NOT started (never two live servers
   * with the same world). Confirmed: MigrateConfirm on the target and MigrateRetire on the source, each one on its
   * own. A definitive rejection (isDefinitive) is noted and no longer retried.
   */
  private async settle(id: string, log: (line: string) => void): Promise<MigrationRow | null> {
    const repo = this.app.migrations;
    const d = this.deps(silent(log));
    let m = repo.get(id);
    if (m?.phase === "rolling_back") {
      const src = this.nodeName(m.source_node_id);
      const dst = this.nodeName(m.target_node_id);
      if (m.target_pending) {
        const cur = m;
        // If the target copy did start and the target refuses to clean it up, the source is not started on its own either.
        const stop = cur.target_started === 1 && cur.source_pending === 1;
        m = await this.tryPending(id, "abort", () => abortTarget(d, cur), log, {
          done: { target_pending: 0 }, ok: `Target clean: what the migration left on “${dst}” was deleted`,
          definitive: stop ? { target_pending: 0, source_pending: 0 } : { target_pending: 0 },
          hint: stop ? `the server is not started automatically on “${src}”: check “${dst}” and start it manually` : `check ${cur.target_slug} on “${dst}”`,
        });
      }
      if (m && m.source_pending && !(m.target_started && m.target_pending)) {
        const cur = m;
        m = await this.tryPending(id, "restart", () => restartSource(d, cur), log, {
          done: { source_pending: 0 }, ok: `Server started again on “${src}”`,
          definitive: { source_pending: 0 }, hint: `start it manually on “${src}”`,
        });
      }
      if (m && !m.target_pending && !m.source_pending) m = repo.update(id, { phase: "failed" });
    } else if (m?.phase === "committed") {
      const cur = m;
      const src = this.nodeName(cur.source_node_id);
      const dst = this.nodeName(cur.target_node_id);
      await Promise.all([
        cur.target_confirm_pending ? this.tryPending(id, "confirm", () => confirmTarget(d, cur), log, {
          done: { target_confirm_pending: 0 }, ok: `Migration confirmed on “${dst}”`,
          definitive: { target_confirm_pending: 0 }, hint: "do not restore the panel database to a copy from before this migration",
        }) : null,
        cur.source_pending ? this.tryPending(id, "retire", () => retireSource(d, cur), log, {
          done: { source_pending: 0 }, ok: `Server removed from “${src}” (${cur.delete_source ? "data deleted" : `data in ${cur.source_slug}.migrated-…`})`,
          definitive: { source_pending: 0 }, hint: `check ${cur.source_slug} in the DATA_ROOT of “${src}” and set it aside or delete it manually`,
        }) : null,
      ]);
      m = repo.get(id);
      if (m?.phase === "committed" && !m.source_pending && !m.target_confirm_pending) m = repo.update(id, { phase: "done" });
    }
    return m;
  }

  /**
   * One pending item. OK: applies `done` (and clears its last failure). Definitive rejection: applies `definitive` and leaves the reason
   * (“… is not retried: hint”). Other failure: notes it in pending_error and it will be retried. Rereads the row (null if it disappeared).
   */
  private async tryPending(id: string, kind: PendingKind, fn: () => Promise<void>, log: (line: string) => void,
    o: { done: MigrationPatch; ok: string; definitive: MigrationPatch; hint: string }): Promise<MigrationRow | null> {
    const repo = this.app.migrations;
    const label = PENDING_LABEL[kind];
    try {
      await fn();
      const cur = repo.get(id);
      if (!cur) return null;
      log(o.ok);
      return repo.update(id, { ...o.done, ...(cur.pending_error?.startsWith(`${label}: `) ? { pending_error: null } : {}) });
    } catch (e) {
      if (!repo.get(id)) return null;
      const text = errorText(e);
      if (isDefinitive(e)) {
        const note = `${label}: ${text}; ${DEFINITIVE}: ${o.hint}`;
        log(note);
        return repo.update(id, { ...o.definitive, pending_error: note });
      }
      log(`${label}: ${text} (it will be retried)`);
      return repo.update(id, { pending_error: `${label}: ${text}` });
    }
  }
}
