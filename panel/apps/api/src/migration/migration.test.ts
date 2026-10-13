import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { BackupTrigger, DesiredState, JobStatus, PowerActionType } from "@mcsm/proto";
import { routerDeploymentSpecSchema, specSchema, type Spec } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import type { JobDto } from "../jobs/repo.js";
import { newId } from "../lib/ids.js";
import { FakeNode, sha256 } from "../../test/fake-node.js";
import { ManualTimers } from "../../test/manual-timers.js";

let app: FastifyInstance; let url: string; let cookie: string; let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcsm-mig-"));
  app = await buildApp({ db: openDb(":memory:"), config: { dataDir } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  app.migrationService.timings = { ...app.migrationService.timings, freeSpace: async () => 1e12 };
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const spec = (game: number) => specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game }, rconPassword: "abcdefgh" });
const NAME = "survival-20261012T040000.000Z-1.tar.zst";
const stagingFiles = (): string[] => { try { return readdirSync(join(dataDir, "staging")); } catch { return []; } };
const begin = (serverId: string, body: object) => app.inject({ method: "POST", url: `/api/servers/${serverId}/migration`, headers: { cookie }, payload: body });

async function finished(jobId: string): Promise<JobDto> {
  await vi.waitFor(() => expect(["ok", "failed"]).toContain(app.jobs.get(jobId)?.status), { timeout: 10_000 });
  return app.jobs.get(jobId)!;
}

async function setup(opts: { desired?: "running" | "stopped"; busyPorts?: number[]; spec?: Spec } = {}) {
  const a = await FakeNode.enroll(app, url, cookie, "nodo-a");
  const b = await FakeNode.enroll(app, url, cookie, "nodo-b");
  const s = app.servers.create({ nodeId: a.id, name: "Survival", slug: "survival", spec: opts.spec ?? spec(25565), desiredState: opts.desired ?? "running" });
  for (const [i, port] of (opts.busyPorts ?? []).entries()) {
    app.servers.create({ nodeId: b.id, name: `Ocupa ${i}`, slug: `ocupa-${i}`, spec: spec(port), desiredState: "stopped" });
  }
  await a.connect({ [s.id]: 1n });
  await b.connect(Object.fromEntries(app.servers.list(b.id).map((r) => [r.id, 1n])));
  return { a, b, s };
}

/** Source: stop ack and pre_migration backup from `payload` (progress, BackupCreated and end, like the agent). */
async function sourceBackup(a: FakeNode, serverId: string, payload: Buffer) {
  const stop = await a.next("powerAction");
  if (stop.body.case !== "powerAction") throw new Error();
  expect(stop.body.value.action).toBe(PowerActionType.STOP);
  a.ack(stop);
  const now = await a.next("backupNow");
  if (now.body.case !== "backupNow") throw new Error();
  expect(now.body.value).toMatchObject({ serverId, trigger: BackupTrigger.PRE_MIGRATION });
  const jobId = now.body.value.jobId;
  a.ack(now);
  a.progress(jobId, serverId, "backup", JobStatus.RUNNING, 50, "Copying data");
  a.send({ body: { case: "backupCreated", value: { jobId, backup: {
    serverId, filename: NAME, sizeBytes: BigInt(payload.length), sha256: sha256(payload), specVersion: 1n,
    trigger: BackupTrigger.PRE_MIGRATION, startedUnixMs: 1n, finishedUnixMs: 2n,
  } } } });
  a.progress(jobId, serverId, "backup", JobStatus.OK, 100, `Backup created: ${NAME}`);
}

/** Source: uploads `sent` (by default, the backup) and responds with the backup's metadata. */
async function sourcePush(a: FakeNode, payload: Buffer, sent: Buffer = payload) {
  const push = await a.next("backupPush");
  if (push.body.case !== "backupPush") throw new Error();
  expect(push.body.value.filename).toBe(NAME);
  expect(await a.put(push.body.value.transferId, sent)).toBe(204);
  a.send({ id: push.id, body: { case: "backupPushResult", value: { sizeBytes: BigInt(payload.length), sha256: sha256(payload), dataBytes: 3_000_000n } } });
}

/** Target: accepts the reception, downloads and checks the backup, and ends its job. */
async function targetReceive(b: FakeNode, serverId: string, payload: Buffer) {
  const rx = await b.next("migrateReceive");
  if (rx.body.case !== "migrateReceive") throw new Error();
  expect(rx.body.value).toMatchObject({ serverId, slug: "survival", filename: NAME, sizeBytes: BigInt(payload.length), sha256: sha256(payload), dataBytes: 3_000_000n });
  b.ack(rx);
  expect(sha256(await b.get(rx.body.value.transferId))).toBe(sha256(payload));
  b.progress(rx.body.value.jobId, serverId, "migrate_in", JobStatus.OK, 100, "Backup received");
}

/** Target: checks the spec (stopped, version +1, port) and returns the start command without answering it. */
async function targetApplyAndStart(b: FakeNode, serverId: string, port: number) {
  const apply = await b.next("applySpec");
  if (apply.body.case !== "applySpec") throw new Error();
  const sp = apply.body.value.server!;
  expect(sp).toMatchObject({ serverId, slug: "survival", version: 2n, desiredState: DesiredState.STOPPED });
  const sent = JSON.parse(new TextDecoder().decode(sp.specJson)) as Spec & { adopt?: unknown };
  expect(sent.ports.game).toBe(port);
  expect(sent).not.toHaveProperty("adopt"); // Plan 6: the target never follows an original container of the source
  b.ack(apply);
  const start = await b.next("powerAction");
  if (start.body.case !== "powerAction") throw new Error();
  expect(start.body.value.action).toBe(PowerActionType.START);
  return start;
}

describe("migration", () => {
  it("running: stops the source, verified backup, healthy target, commit and removal of the source", async () => {
    const { a, b, s } = await setup();
    const payload = randomBytes(300_000);
    const res = await begin(s.id, { targetNodeId: b.id });
    expect(res.statusCode).toBe(202);
    const job = res.json() as JobDto;
    expect(job).toMatchObject({ type: "migrate", serverId: s.id, status: "running" });
    expect((await begin(s.id, { targetNodeId: b.id })).statusCode).toBe(409); // one at a time
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    b.observed(s.id, { state: "running", health: "starting" });
    b.observed(s.id, { state: "running", health: "healthy", online: true, appliedVersion: 2n });
    const confirm = await b.next("migrateConfirm");
    if (confirm.body.case !== "migrateConfirm") throw new Error();
    expect(confirm.body.value).toMatchObject({ serverId: s.id, slug: "survival", migrationId: job.id });
    b.ack(confirm);
    const retire = await a.next("migrateRetire");
    if (retire.body.case !== "migrateRetire") throw new Error();
    expect(retire.body.value).toMatchObject({ serverId: s.id, slug: "survival", migrationId: job.id, deleteData: false, sourceVersion: 1n });
    a.ack(retire);
    const done = await finished(job.id);
    expect(done.status).toBe("ok");
    expect(done.message).toMatch(/Migration completed: “Survival” is on “nodo-b”, port 25565/);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: b.id, slug: "survival", spec_version: 2, desired_state: "running", observed_spec_version: 2 });
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "done", source_pending: 0, target_confirm_pending: 0, pending_error: null });
    expect(stagingFiles()).toEqual([]);
    const log = app.jobs.get(job.id)!.log;
    for (let n = 1; n <= 7; n++) expect(log).toContain(`Step ${n}/7`);
    const latest = await app.inject({ method: "GET", url: `/api/servers/${s.id}/migration`, headers: { cookie } });
    expect(latest.json().migration).toMatchObject({ phase: "done", targetNodeId: b.id, targetPort: 25565 });
    // Closed: the server accepts actions again (they reach the target node).
    const power = app.inject({ method: "POST", url: `/api/servers/${s.id}/power`, headers: { cookie }, payload: { action: "stop" } });
    b.ack(await b.next("powerAction"));
    expect((await power).statusCode).toBe(200);
  });

  it("if the target does not start: the target copy is removed and ONLY then does the source start again", async () => {
    const { a, b, s } = await setup();
    const payload = randomBytes(100_000);
    const job = (await begin(s.id, { targetNodeId: b.id, port: 25590 })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.fail(await targetApplyAndStart(b, s.id, 25590), "power_failed", "Bind for 0.0.0.0:25590 failed: port is already allocated");
    const abort = await b.next("migrateAbort");
    if (abort.body.case !== "migrateAbort") throw new Error();
    expect(abort.body.value).toMatchObject({ serverId: s.id, slug: "survival", migrationId: job.id });
    await a.nothingFor(200); // the source waits for the target to confirm the cleanup
    b.ack(abort);
    const restart = await a.next("powerAction");
    if (restart.body.case !== "powerAction") throw new Error();
    expect(restart.body.value.action).toBe(PowerActionType.START);
    a.ack(restart);
    const done = await finished(job.id);
    expect(done.status).toBe("failed");
    expect(done.message).toMatch(/Step 6\/7.*port is already allocated.*world intact and it has been started again/);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.id, spec_version: 1, desired_state: "running" });
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "failed", target_pending: 0, source_pending: 0 });
  });

  it("if the target does not become healthy within 5 min, it is rolled back", async () => {
    const timers = new ManualTimers();
    app.migrationService.timers = timers;
    const { a, b, s } = await setup();
    const payload = randomBytes(50_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    await vi.waitFor(() => expect(app.jobs.get(job.id)!.message).toMatch(/waiting for it to start/));
    timers.advance(5 * 60_000);
    b.ack(await b.next("migrateAbort"));
    a.ack(await a.next("powerAction"));
    expect((await finished(job.id)).message).toMatch(/Step 6\/7.*did not become healthy on the target within 5 min/);
  });

  it("stopped and with its port taken on the target: new port, checked by starting it and stopped again", async () => {
    const { a, b, s } = await setup({ desired: "stopped", busyPorts: [25565] });
    const proposal = await app.inject({ method: "GET", url: `/api/servers/${s.id}/migration/proposal?targetNodeId=${b.id}`, headers: { cookie } });
    expect(proposal.json()).toEqual({ targetNodeId: b.id, slug: "survival", port: 25566, currentPort: 25565, portChanged: true });
    const payload = randomBytes(50_000);
    const job = (await begin(s.id, { targetNodeId: b.id, deleteSource: true })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25566));
    b.observed(s.id, { state: "running", health: "healthy" });
    const stop = await b.next("powerAction");
    if (stop.body.case !== "powerAction") throw new Error();
    expect(stop.body.value.action).toBe(PowerActionType.STOP);
    b.ack(stop);
    b.ack(await b.next("migrateConfirm"));
    const retire = await a.next("migrateRetire");
    if (retire.body.case !== "migrateRetire") throw new Error();
    expect(retire.body.value.deleteData).toBe(true);
    a.ack(retire);
    expect((await finished(job.id)).status).toBe("ok");
    const row = app.servers.get(s.id)!;
    expect(row).toMatchObject({ node_id: b.id, desired_state: "stopped", spec_version: 2, observed: null });
    expect((JSON.parse(row.spec) as Spec).ports.game).toBe(25566);
  });

  it("a backup that arrives at the panel damaged does not reach the target; the source starts again", async () => {
    const { a, b, s } = await setup();
    const payload = randomBytes(80_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload, randomBytes(payload.length));
    a.ack(await a.next("powerAction")); // restart
    const done = await finished(job.id);
    expect(done.message).toMatch(/Step 3\/7.*corrupted/);
    await b.nothingFor(200);
    expect(stagingFiles()).toEqual([]);
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "failed", target_touched: 0 });
  });

  it("if the source does not respond after the commit, it completes anyway and the removal arrives when it reconnects", async () => {
    const { a, b, s } = await setup();
    const payload = randomBytes(50_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    a.close();
    await vi.waitFor(() => expect(app.agents.get(a.id)).toBeUndefined());
    b.observed(s.id, { state: "running", health: "healthy" });
    b.ack(await b.next("migrateConfirm"));
    const done = await finished(job.id);
    expect(done.status).toBe("ok");
    expect(done.message).toMatch(/“nodo-a” is offline.*when it reconnects/);
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "committed", source_pending: 1 });
    // On returning, the source does not receive the server in removed_ids (the migration removes it) and does receive MigrateRetire.
    const sync = await a.connect({ [s.id]: 1n });
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.removedIds).toEqual([]);
    a.ack(await a.next("migrateRetire"));
    await vi.waitFor(() => expect(app.migrations.get(job.id)!.phase).toBe("done"));
    expect(app.migrations.protects(a.id, s.id)).toBe(false);
  });

  it("after restarting the panel midway: cleans the target and only then starts the source", async () => {
    const { a, b, s } = await setup();
    const id = newId();
    app.jobs.create({ id, type: "migrate", serverId: s.id, nodeId: a.id, status: "running" });
    app.migrations.insert({
      id, server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565)), was_running: 1, delete_source: 0,
    });
    app.migrations.update(id, { target_touched: 1, target_started: 1 });
    b.close();
    await vi.waitFor(() => expect(app.agents.get(b.id)).toBeUndefined());
    await app.migrationService.recover();
    expect(app.migrations.get(id)).toMatchObject({ phase: "rolling_back", target_pending: 1, source_pending: 1 });
    await a.nothingFor(200); // the target copy may have been left running: the source does not start yet
    const sync = await b.connect({ [s.id]: 2n });
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.removedIds).toEqual([]);
    b.ack(await b.next("migrateAbort"));
    a.ack(await a.next("powerAction"));
    await vi.waitFor(() => expect(app.migrations.get(id)!.phase).toBe("failed"));
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.id, desired_state: "running" });
  });

  it("an imported server (Plan 6): the target does not receive adopt and the commit stops following the original container", async () => {
    const { a, b, s } = await setup();
    app.servers.setImportedFrom(s.id, {
      containerId: "c".repeat(64), containerName: "mc-viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z",
      composeProject: "casa", composeService: "survival",
    });
    const payload = randomBytes(1000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565)); // checks that the target spec does not carry adopt
    b.observed(s.id, { state: "running", health: "healthy", online: true, appliedVersion: 2n });
    b.ack(await b.next("migrateConfirm"));
    a.ack(await a.next("migrateRetire"));
    expect((await finished(job.id)).status).toBe("ok");
    expect(app.servers.get(s.id)).toMatchObject({ node_id: b.id, imported_from: null });
    const dto = await app.inject({ method: "GET", url: `/api/servers/${s.id}`, headers: { cookie } });
    expect(dto.json().importedFrom).toBeNull();
  });

  it("validates before starting", async () => {
    const { a, b, s } = await setup();
    expect((await begin(s.id, { targetNodeId: a.id })).statusCode).toBe(400);
    expect((await begin(s.id, { targetNodeId: "nope" })).statusCode).toBe(404);
    expect((await begin(s.id, {})).statusCode).toBe(400);
    app.servers.create({ nodeId: b.id, name: "B", slug: "bb", spec: spec(25570), desiredState: "stopped" });
    const taken = await begin(s.id, { targetNodeId: b.id, port: 25570 });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatch(/25570 is already in use/);
    const ext = app.servers.create({ nodeId: a.id, name: "Ext", slug: "ext", spec: { ...spec(25580), dataPath: "/mnt/mundo" } as unknown as Spec, desiredState: "stopped" });
    const external = await begin(ext.id, { targetNodeId: b.id });
    expect(external.statusCode).toBe(409);
    expect(external.json().error).toMatch(/outside DATA_ROOT/);
    // Plan 6 forbids removing dataPath via PATCH: the way is to import it again with the data in DATA_ROOT.
    expect(external.json().error).toMatch(/\/mnt\/mundo/);
    expect(external.json().error).toMatch(/import it again/);
    expect(external.json().error).not.toMatch(/remove dataPath/);
    b.close();
    await vi.waitFor(() => expect(app.agents.get(b.id)).toBeUndefined());
    const offline = await begin(s.id, { targetNodeId: b.id });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toMatch(/target node “nodo-b” is offline/);
    expect(app.migrations.latestForServer(s.id)).toBeNull();
  });
});

describe("migration and router (Plan 8): check on confirm", () => {
  const routed = (game: number): Spec => ({ ...spec(game), router: { enabled: true, hostname: "survival.lan" } });

  /** Takes the migration to the healthy target; `meanwhile` runs just before (while it starts there). */
  async function untilCommit(meanwhile: (b: FakeNode) => void) {
    const { a, b, s } = await setup({ spec: routed(25565) });
    const payload = randomBytes(10_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    meanwhile(b);
    b.observed(s.id, { state: "running", health: "healthy" });
    b.ack(await b.next("migrateAbort")); // not confirmed: it is rolled back
    a.ack(await a.next("powerAction")); // and the source starts again
    const done = await finished(job.id);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.id, spec_version: 1 });
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "failed" });
    return done;
  }

  it("if another server on the target takes the hostname during the migration, it is not confirmed", async () => {
    const done = await untilCommit((b) => {
      // Direct write: the API already prevents it (the hostname is reserved by the migration).
      app.servers.create({ nodeId: b.id, name: "Intruso", slug: "intruso", spec: routed(25570), desiredState: "stopped" });
    });
    expect(done.status).toBe("failed");
    expect(done.message).toMatch(/Step 7\/7.*hostname “survival\.lan” is already used by “Intruso” on “nodo-b”/);
  });

  it("if the target's router is enabled on its port during the migration, it is not confirmed", async () => {
    const done = await untilCommit((b) => {
      app.db.prepare("INSERT INTO router_deployments (node_id, spec, updated_at) VALUES (?, ?, ?)")
        .run(b.id, JSON.stringify(routerDeploymentSpecSchema.parse({ enabled: true, port: 25565 })), new Date().toISOString());
    });
    expect(done.status).toBe("failed");
    expect(done.message).toMatch(/Step 7\/7.*port 25565 is now used by the router \(mc-router\) of “nodo-b”/);
  });
});

describe("migration: invariants", () => {
  it("a failure after the commit undoes nothing: never MigrateAbort to the target and the source is removed", async () => {
    const { a, b, s } = await setup();
    app.backupsService.sync = () => { throw new Error("failure after the commit"); };
    const payload = randomBytes(30_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    b.observed(s.id, { state: "running", health: "healthy" });
    b.ack(await b.next("migrateConfirm"));
    a.ack(await a.next("migrateRetire"));
    const done = await finished(job.id);
    expect(done.status).toBe("ok");
    await b.nothingFor(200); // neither MigrateAbort nor anything else to the target
    expect(app.servers.get(s.id)).toMatchObject({ node_id: b.id, spec_version: 2 });
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "done", target_pending: 0 });
  });

  it("with the removal of a source pending, another migration towards that node does not reuse its slug", async () => {
    const a = await FakeNode.enroll(app, url, cookie, "nodo-a");
    const b = await FakeNode.enroll(app, url, cookie, "nodo-b");
    const c = await FakeNode.enroll(app, url, cookie, "nodo-c");
    const s = app.servers.create({ nodeId: a.id, name: "Survival", slug: "survival", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565)), was_running: 1, delete_source: 0,
    });
    expect(app.migrations.commit(m, "running", null)).toBe(true); // <DATA_ROOT>/survival stays on nodo-a until MigrateRetire
    const t = app.servers.create({ nodeId: c.id, name: "Otro", slug: "survival", spec: spec(25565), desiredState: "stopped" });
    const p = await app.inject({ method: "GET", url: `/api/servers/${t.id}/migration/proposal?targetNodeId=${a.id}`, headers: { cookie } });
    expect(p.json()).toMatchObject({ slug: "survival-2" });
  });
});

describe("migration: pending work (I1, M4)", () => {
  async function committed(opts: { confirm?: "ack" | "busy"; retire?: "ack" | "busy" | "invalid" } = {}) {
    const { a, b, s } = await setup();
    const payload = randomBytes(20_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.ack(await targetApplyAndStart(b, s.id, 25565));
    b.observed(s.id, { state: "running", health: "healthy" });
    const confirm = await b.next("migrateConfirm");
    if (opts.confirm === "busy") b.fail(confirm, "busy", "server busy or reserved");
    else b.ack(confirm);
    const retire = await a.next("migrateRetire");
    if (opts.retire === "busy") a.fail(retire, "busy", "the container could not be deleted yet");
    else if (opts.retire === "invalid") a.fail(retire, "invalid_request", "the server on this node has version 3 and the migration was made with version 1");
    else a.ack(retire);
    return { a, b, s, job: await finished(job.id) };
  }

  it("the confirmation on the target is retried until the Ack without holding back the removal of the source", async () => {
    const { a, b, job } = await committed({ confirm: "busy" });
    expect(job.status).toBe("ok");
    expect(job.message).toMatch(/confirm the migration on “nodo-b”.*server busy.*it will be retried/);
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "committed", source_pending: 0, target_confirm_pending: 1 });
    expect(app.migrations.get(job.id)!.pending_error).toMatch(/server busy/);
    expect(app.migrations.blockingNodeCreate(a.id)).toBeNull(); // the source is already removed
    const pending = app.migrationService.runPending(b.id);
    b.ack(await b.next("migrateConfirm"));
    await pending;
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "done", target_confirm_pending: 0, pending_error: null });
    await a.nothingFor(100);
  });

  it("with the node online, the text says why the removal is missing and not “when it reconnects” (M4, m5)", async () => {
    const { job } = await committed({ retire: "busy" });
    expect(job.message).toMatch(/Could not remove the server from “nodo-a”.*could not be deleted yet.*it will be retried/);
    expect(job.message).not.toMatch(/when it reconnects|did not respond/);
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "committed", source_pending: 1 });
  });

  it("an invalid_request rejection of the removal is not retried: the reason stays and the source is released (M4)", async () => {
    const { a, job } = await committed({ retire: "invalid" });
    expect(job.status).toBe("ok");
    expect(job.message).toMatch(/was not removed.*version 3/);
    const m = app.migrations.get(job.id)!;
    expect(m).toMatchObject({ phase: "done", source_pending: 0 });
    expect(m.pending_error).toMatch(/version 3/);
    expect(app.migrations.blockingNodeCreate(a.id)).toBeNull();
    await app.migrationService.runPending(a.id);
    await a.nothingFor(100);
    const latest = await app.inject({ method: "GET", url: `/api/servers/${m.server_id}/migration`, headers: { cookie } });
    expect(latest.json().migration).toMatchObject({ phase: "done", pendingError: expect.stringMatching(/version 3/) });
  });

  it("a rejected MigrateAbort (invalid_request) is not retried and, if the target did start, the source does not start on its own (M4)", async () => {
    const { a, b, s } = await setup();
    const payload = randomBytes(20_000);
    const job = (await begin(s.id, { targetNodeId: b.id })).json() as JobDto;
    await sourceBackup(a, s.id, payload);
    await sourcePush(a, payload);
    await targetReceive(b, s.id, payload);
    b.fail(await targetApplyAndStart(b, s.id, 25565), "power_failed", "does not start");
    b.fail(await b.next("migrateAbort"), "invalid_request", "the server on this node is not an unconfirmed copy of this migration");
    const done = await finished(job.id);
    expect(done.status).toBe("failed");
    expect(done.message).toMatch(/is not an unconfirmed copy.*start it manually/);
    expect(app.migrations.get(job.id)).toMatchObject({ phase: "failed", target_pending: 0, source_pending: 0 });
    await app.migrationService.runPending();
    await a.nothingFor(100);
    await b.nothingFor(100);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.id, desired_state: "stopped" });
  });

  it("manual closing of a stuck migration, with the target node gone (M4)", async () => {
    const { a, b, s } = await setup();
    const id = newId();
    app.jobs.create({ id, type: "migrate", serverId: s.id, nodeId: a.id, status: "running" });
    app.jobs.finish(id, "failed", "Step 6/7: does not start");
    app.migrations.insert({
      id, server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565)), was_running: 1, delete_source: 0,
    });
    const close = () => app.inject({ method: "POST", url: `/api/servers/${s.id}/migration/close`, headers: { cookie } });
    expect((await close()).statusCode).toBe(409); // in progress: not closed by hand
    app.migrations.update(id, { phase: "rolling_back", target_pending: 1, target_started: 1, source_pending: 1 });
    b.close();
    await vi.waitFor(() => expect(app.agents.get(b.id)).toBeUndefined());
    const r = await close();
    expect(r.statusCode).toBe(200);
    expect(r.json().migration).toMatchObject({ phase: "failed", targetPending: false, sourcePending: false });
    expect(r.json().migration.pendingError).toMatch(/Closed by hand/);
    expect(app.migrations.blockingServer(s.id)).toBeNull();
    expect((await close()).statusCode).toBe(404); // nothing is open any more
    await a.nothingFor(100); // closing starts nothing
  });
});
