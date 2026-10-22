import { describe, expect, it } from "vitest";
import type { MigrationDto } from "@mcsm/shared";
import type { JobDto, NodeDto } from "./api";
import { jobTypeLabel } from "./jobs";
import {
  activeMigrationJob, canCloseMigration, closeMigrationText, confirmText, lastMigrationJob, migrateBlockedReason, migrateFormDirty, migrationBody, migrationFinished,
  migrationSync, parsePortInput, pendingText, portHint, proposalPath, routerDnsNote, stepStates, targetOptions,
} from "./migration";

const node = (id: string, name: string, status: "online" | "offline" = "online"): NodeDto => ({
  id, name, dataRoot: "/srv/minecraft", status, agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "", tokenRotationPending: false,
});
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j", type: "migrate", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "", payload: {},
  createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});
const mig = (over: Partial<MigrationDto>): MigrationDto => ({
  id: "m", serverId: "s1", sourceNodeId: "a", targetNodeId: "b", sourceSlug: "x", targetSlug: "x", targetPort: 25565, targetVersion: 2,
  wasRunning: true, deleteSource: false, phase: "done", sourcePending: false, targetPending: false, targetStarted: false, targetConfirmPending: false,
  error: null, pendingError: null, createdAt: "", updatedAt: "", ...over,
});
const names = (id: string) => ({ a: "Home", b: "Garage" })[id] ?? "?";

describe("migration in the web", () => {
  it("target nodes: all except the current one; offline ones disabled", () => {
    expect(targetOptions([node("a", "Home"), node("b", "Garage"), node("c", "Attic", "offline")], "a")).toEqual([
      { id: "b", label: "Garage", disabled: false },
      { id: "c", label: "Attic (offline)", disabled: true },
    ]);
    expect(targetOptions(undefined, "a")).toEqual([]);
  });

  it("active job and latest migration job", () => {
    const jobs = [job({ id: "x", type: "backup" }), job({ id: "y", status: "ok" }), job({ id: "z", status: "failed" })];
    expect(activeMigrationJob(jobs)).toBeUndefined();
    expect(lastMigrationJob(jobs)?.id).toBe("y");
    expect(activeMigrationJob([job({ id: "w", status: "running" }), ...jobs])?.id).toBe("w");
  });

  it("port: empty = the proposed one; valid number; anything else is not valid", () => {
    expect(parsePortInput("")).toBeUndefined();
    expect(parsePortInput(" 25570 ")).toBe(25570);
    for (const bad of ["0", "70000", "25 565", "1e3", "abc", "-1"]) expect(parsePortInput(bad)).toBeNull();
    expect(migrationBody("b", undefined, false)).toEqual({ targetNodeId: "b", deleteSource: false });
    expect(migrationBody("b", 25570, true)).toEqual({ targetNodeId: "b", port: 25570, deleteSource: true });
  });

  it("port hint", () => {
    expect(portHint(undefined, undefined)).toMatch(/Choose the target node first/);
    expect(portHint({ targetNodeId: "b", slug: "x", port: 25566, currentPort: 25565, portChanged: true, rconPort: null, rconChanged: false }, undefined)).toMatch(/Proposed: 25566 \(25565 is busy/);
    expect(portHint({ targetNodeId: "b", slug: "x", port: 25565, currentPort: 25565, portChanged: false, rconPort: null, rconChanged: false }, undefined)).toMatch(/the same as now/);
    expect(portHint(undefined, 25570)).toBe("Port 25570 will be used.");
    expect(portHint(undefined, null)).toMatch(/between 1 and 65535/);
  });

  it("reasons for blocking a migration", () => {
    const ok = { sourceOnline: true, active: undefined, migration: null, target: { id: "b", label: "B", disabled: false }, portInvalid: false, proposalError: null };
    expect(migrateBlockedReason(ok)).toBeNull();
    expect(migrateBlockedReason({ ...ok, active: job({}) })).toMatch(/in progress/);
    expect(migrateBlockedReason({ ...ok, migration: mig({ phase: "rolling_back" }) })).toMatch(/pending steps/);
    expect(migrateBlockedReason({ ...ok, migration: mig({ phase: "failed" }) })).toBeNull();
    expect(migrateBlockedReason({ ...ok, sourceOnline: false })).toMatch(/offline/);
    expect(migrateBlockedReason({ ...ok, target: undefined })).toMatch(/Choose/);
    expect(migrateBlockedReason({ ...ok, target: { id: "b", label: "B", disabled: true } })).toMatch(/target node is offline/);
    expect(migrateBlockedReason({ ...ok, portInvalid: true })).toMatch(/port/);
    expect(migrateBlockedReason({ ...ok, proposalError: "Extra port 19132 is already used by another" })).toMatch(/19132/);
  });

  it("status of the 7 steps according to the job", () => {
    expect(stepStates({ progress: 0, status: "running" })).toEqual(["current", "pending", "pending", "pending", "pending", "pending", "pending"]);
    expect(stepStates({ progress: 40, status: "failed" })).toEqual(["done", "done", "failed", "pending", "pending", "pending", "pending"]);
    expect(stepStates({ progress: 100, status: "ok" })).toEqual(Array(7).fill("done"));
  });

  it("what is pending in an open migration, depending on whether the nodes are online", () => {
    const off = () => false;
    const on = () => true;
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true, sourcePending: true, targetStarted: true }), names, off))
      .toBe("The migration failed and is being rolled back: still pending: delete the half-made copy on “Garage” when it reconnects; then, start the server again on “Home”.");
    expect(pendingText(mig({ phase: "rolling_back", sourcePending: true }), names, off)).toMatch(/start the server again on “Home” when it reconnects/);
    // Online: not “when it reconnects”, but the reason and that it is retried.
    const online = pendingText(mig({ phase: "rolling_back", sourcePending: true, pendingError: "Start the source again: busy" }), names, on)!;
    expect(online).toMatch(/retried every 30 s.*busy/);
    expect(online).not.toMatch(/when it reconnects/);
    // I2: only a target that never started needs cleaning up: the server is already in use on the source.
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true }), names, off)).toMatch(/can already be used on “Home”/);
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true, targetStarted: true }), names, off)).not.toMatch(/can already be used/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true }), names, off)).toMatch(/Migrated to “Garage”.*remove the server from node “Home”.*x\.migrated.*when it reconnects/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true, deleteSource: true }), names, off)).toMatch(/deleting its data/);
    expect(pendingText(mig({ phase: "committed", targetConfirmPending: true }), names, on)).toMatch(/confirm the migration on “Garage”.*retried/);
    expect(pendingText(mig({ phase: "done" }), names, on)).toBeNull();
    expect(pendingText(mig({ phase: "running" }), names, on)).toBeNull();
    // Closed or with a definitive rejection: what has to be resolved by hand is noted.
    expect(pendingText(mig({ phase: "done", pendingError: "Remove the source: version 3; not retried: check x" }), names, on)).toMatch(/resolve by hand.*version 3/);
    expect(pendingText(mig({ phase: "failed", pendingError: "Closed by hand: something" }), names, on)).toMatch(/Closed by hand/);
  });

  it("manual close: only of an open migration with no step in progress; the text says what is left undone", () => {
    expect(canCloseMigration(mig({ phase: "rolling_back", targetPending: true }), undefined)).toBe(true);
    expect(canCloseMigration(mig({ phase: "committed", sourcePending: true }), undefined)).toBe(true);
    expect(canCloseMigration(mig({ phase: "committed", sourcePending: true }), job({}))).toBe(false);
    expect(canCloseMigration(mig({ phase: "running" }), undefined)).toBe(false);
    expect(canCloseMigration(mig({ phase: "done" }), undefined)).toBe(false);
    expect(canCloseMigration(null, undefined)).toBe(false);
    const t = closeMigrationText(mig({ phase: "rolling_back", targetPending: true, sourcePending: true }), names);
    expect(t).toMatch(/will stop retrying/);
    expect(t).toMatch(/“Garage”/);
    expect(t).toMatch(/is not started again on “Home”/);
  });

  it("the proposal carries the typed port (m8)", () => {
    expect(proposalPath("s/1", "b", undefined)).toBe("/api/servers/s%2F1/migration/proposal?targetNodeId=b");
    expect(proposalPath("s1", "b", 25570)).toBe("/api/servers/s1/migration/proposal?targetNodeId=b&port=25570");
  });

  it("the form only has something to lose if something was chosen (m9)", () => {
    expect(migrateFormDirty("", "", false)).toBe(false);
    expect(migrateFormDirty("b", "", false)).toBe(true);
    expect(migrateFormDirty("", "25570", false)).toBe(true);
    expect(migrateFormDirty("", "", true)).toBe(true);
  });

  it("refreshes the server on entering step 7 (commit) and on finishing (m6)", () => {
    const at = (progress: number, status: JobDto["status"] = "running") => [job({ id: "j", progress, status })];
    let st = migrationSync(null, at(40));
    expect(st).toEqual({ refresh: false, next: { id: "j", step: 3 } });
    st = migrationSync(st.next, at(83));
    expect(st.refresh).toBe(false);
    st = migrationSync(st.next, at(95));
    expect(st).toEqual({ refresh: true, next: { id: "j", step: 7 } });
    st = migrationSync(st.next, at(97));
    expect(st.refresh).toBe(false); // already refreshed on entering the step
    st = migrationSync(st.next, at(100, "ok"));
    expect(st).toEqual({ refresh: true, next: null });
    expect(migrationSync({ id: "j", step: 3 }, undefined)).toEqual({ refresh: false, next: { id: "j", step: 3 } }); // loading
    expect(migrationSync(null, at(95)).refresh).toBe(false); // when the page opens already at step 7: the normal load brings it
  });

  it("confirmation text", () => {
    const t = confirmText({ serverName: "Survival", slug: "survival", source: "Home", target: "Garage", port: 25566, deleteSource: false, running: true });
    expect(t).toMatch(/will be stopped on “Home”/);
    expect(t).toMatch(/port 25566/);
    expect(t).toMatch(/stay running/);
    expect(t).toMatch(/survival\.migrated/);
    expect(t).toMatch(/is started again/);
    const del = confirmText({ serverName: "Survival", slug: "survival", source: "Home", target: "Garage", port: 25565, deleteSource: true, running: false });
    expect(del).toMatch(/will be DELETED/);
    expect(del).toMatch(/stopped again/);
  });

  it("confirmation text of an imported server: adds the notice of which container is deleted on the source (Plans 6 and 7)", () => {
    const base = { serverName: "Survival", slug: "survival", source: "Home", target: "Garage", port: 25565, deleteSource: false, running: true };
    expect(confirmText({ ...base, imported: null })).toBe(confirmText(base));
    const t = confirmText({ ...base, imported: "IMPORTED NOTICE" });
    expect(t.startsWith(confirmText(base))).toBe(true);
    expect(t).toMatch(/IMPORTED NOTICE$/);
  });

  it("plan-8: a server with a hostname warns that DNS has to point at the target node", () => {
    expect(routerDnsNote(undefined, "Home", "Garage")).toBeNull();
    expect(routerDnsNote({ enabled: false, hostname: "survival.lan" }, "Home", "Garage")).toBeNull();
    expect(routerDnsNote({ enabled: true, hostname: "survival.lan" }, "Home", "Garage")).toBe(
      "After migrating, the hostname “survival.lan” has to resolve to the IP of “Garage” (and its router has to be enabled): " +
      "otherwise, players will keep reaching the router of “Home”, which will no longer have this server.");
    expect(routerDnsNote({ enabled: true, hostname: "survival.lan" }, "Home", undefined)).toMatch(/to the IP of the target node \(and its router/);
    const base = { serverName: "Survival", slug: "survival", source: "Home", target: "Garage", port: 25565, deleteSource: false, running: true };
    expect(confirmText({ ...base, dns: null })).toBe(confirmText(base));
    expect(confirmText({ ...base, imported: "IMPORTED", dns: "DNS" })).toMatch(/IMPORTED DNS$/);
  });

  it("detects the end of the migration in progress", () => {
    expect(migrationFinished(null, [job({ status: "ok" })])).toBe(false);
    expect(migrationFinished("j", [job({ status: "running" })])).toBe(false);
    expect(migrationFinished("j", [job({ status: "ok" })])).toBe(true);
    expect(migrationFinished("j", [])).toBe(true);
    expect(migrationFinished("j", undefined)).toBe(false);
  });

  it("job labels", () => {
    expect(jobTypeLabel("migrate")).toBe("Migration");
    expect(jobTypeLabel("migrate_in")).toBe("Receiving migration");
  });
});
