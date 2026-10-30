import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { meta } from "./content-fixtures.test-util";
import { backupFirstNotice, backupFirstOutcome, backupReason, compatUnavailableNote, COMPAT_UNAVAILABLE, configLeaveWarning, contentFindings, isStale, patchBody, planApply, type PendingApply } from "./config-apply";

const base = { ...defaultSpecInput(), ports: { game: 25565, extra: [] } };

describe("planApply", () => {
  it("without changes returns an error", () => {
    expect(planApply("A", base, "A", base)).toEqual({ ok: false, error: "There are no changes to apply" });
  });
  it("name only: no spec and no recreation", () => {
    const r = planApply("A", base, " B ", base);
    expect(r).toMatchObject({ ok: true, pending: { name: "B", spec: undefined, recreate: false } });
    if (r.ok) expect(r.pending.changes).toEqual([{ label: "Name", before: "A", after: "B" }]);
  });
  it("empty name is an error", () => {
    expect(planApply("A", base, "  ", base)).toEqual({ ok: false, error: "The name cannot be empty" });
  });
  it("spec: minimal PATCH, diff and recreation; does not send ports if they do not change", () => {
    const r = planApply("A", base, "A", { ...base, memory: "6G" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pending.spec).toEqual({ memory: "6G" });
    expect(r.pending.recreate).toBe(true);
    expect(r.pending.changes.map((c) => c.label)).toEqual(["JVM memory"]);
  });
  it("removing an optional section sends null; required ones never", () => {
    const withOps = { ...base, ops: ["Lobo"] };
    const { ops: _o, ...without } = withOps;
    const r = planApply("A", withOps, "A", without as typeof base);
    expect(r.ok && r.pending.spec).toEqual({ ops: null });
  });
  it("empty game port when editing = kept: neither an “N → —” diff nor a ports PATCH", () => {
    const edited = { ...base, ports: { extra: [] } };
    expect(planApply("A", base, "A", edited)).toEqual({ ok: false, error: "There are no changes to apply" });
    const withExtra = { ...base, ports: { extra: [{ host: 19132, container: 19132, proto: "udp" as const, label: "" }] } };
    const r = planApply("A", base, "A", withExtra);
    expect(r.ok && r.pending.spec).toEqual({ ports: { game: 25565, extra: withExtra.ports.extra } });
    expect(r.ok && r.pending.changes.map((c) => c.label)).toEqual(["Extra ports"]);
  });
  it("clearing the RCON port of a server that already publishes = kept: no diff and no recreation", () => {
    const published = { ...base, ports: { game: 25565, extra: [], rcon: 25580 } };
    expect(planApply("A", published, "A", { ...published, ports: { ...published.ports, rcon: "auto" } }))
      .toEqual({ ok: false, error: "There are no changes to apply" });
    const r = planApply("A", published, "B", { ...published, ports: { ...published.ports, rcon: "auto" } });
    expect(r.ok && r.pending.recreate).toBe(false);
  });
  it("enabling the whitelist with an empty list warns in the diff", () => {
    const r = planApply("A", base, "A", { ...base, whitelist: { enabled: true, players: [] } });
    expect(r.ok && r.pending.changes).toEqual([{ label: "Whitelist", before: "(not managed)", after: expect.stringMatching(/nobody will be able to join except ops/) }]);
  });
  it("mods from absent to present and empty is an applicable change (the agent syncs the lists)", () => {
    const r = planApply("A", base, "A", { ...base, mods: { modrinthProjects: [], curseforgeFiles: [], urls: [] } });
    expect(r).toMatchObject({ ok: true, pending: { recreate: true, changes: [{ label: "Mods (section)", before: "(not managed)", after: "managed by the panel" }] } });
  });
});

describe("isStale", () => {
  it("only if the server is ahead of the base (after applying the base is ahead: it is not “changed elsewhere”)", () => {
    expect(isStale(3, 3)).toBe(false);
    expect(isStale(4, 3)).toBe(true);
    expect(isStale(3, 4)).toBe(false);
  });
});

describe("configLeaveWarning", () => {
  it("with unsaved changes it protects leaving (tab, navigation and browser close)", () => {
    expect(configLeaveWarning(true)).toEqual({
      title: "Unsaved changes",
      description: "There are unsaved changes in the configuration. If you leave, they will be lost.",
      confirmLabel: "Leave and discard",
    });
  });
  it("without changes there is nothing to protect", () => {
    expect(configLeaveWarning(false)).toBeNull();
  });
});

describe("back up first (plan 11)", () => {
  const pending: PendingApply = { spec: { mods: { modrinthProjects: [], curseforgeFiles: [], urls: [] } }, changes: [], recreate: true };
  it("adds backupFirst only when asked", () => {
    expect(patchBody(pending, false)).toEqual({ spec: pending.spec });
    expect(patchBody(pending, true)).toEqual({ spec: pending.spec, backupFirst: true });
    expect(patchBody({ ...pending, name: "B" }, false)).toEqual({ name: "B", spec: pending.spec });
  });
  it("never asks for a backup when only the name changes", () => {
    expect(patchBody({ name: "B", changes: [], recreate: false }, true)).toEqual({ name: "B" });
  });
  it("follows the chained job", () => {
    expect(backupFirstOutcome(undefined)).toEqual({ state: "waiting" });
    expect(backupFirstOutcome({ status: "queued", message: "" })).toEqual({ state: "waiting" });
    expect(backupFirstOutcome({ status: "running", message: "Waiting for the backup before applying the change" })).toEqual({ state: "waiting" });
    expect(backupFirstOutcome({ status: "ok", message: "Backup done; change applied (v3)" })).toEqual({ state: "applied" });
    expect(backupFirstOutcome({ status: "failed", message: "The backup failed: the change was not applied" })).toEqual({ state: "failed", message: "The backup failed: the change was not applied" });
  });
  it("a cancelled or silent failure still explains that nothing was applied", () => {
    expect(backupFirstOutcome({ status: "cancelled", message: "" })).toEqual({ state: "failed", message: "The backup did not finish: the change was not applied" });
    expect(backupFirstOutcome({ status: "failed", message: "" })).toEqual({ state: "failed", message: "The backup did not finish: the change was not applied" });
  });
  it("says the compatibility check could not run without blocking", () => {
    expect(COMPAT_UNAVAILABLE).toBe("The compatibility check could not run (content sources unreachable or no CurseForge key). You can still apply.");
  });
});

describe("contentFindings", () => {
  it("checks each kind against its own target and flags floating versions", () => {
    const spec = {
      ...base, type: "PAPER", version: "1.21.4",
      plugins: { modrinthProjects: ["LUCKPERM:v0000001"], spigetResources: [], urls: [] },
      datapacks: { modrinthProjects: ["TERRALIT:v0000001"] },
    };
    const metas = [
      meta({ raw: "LUCKPERM:v0000001", list: "plugins.modrinthProjects", name: "LuckPerms", gameVersions: ["1.21.4"], loaders: ["paper"] }),
      meta({ raw: "TERRALIT:v0000001", list: "datapacks.modrinthProjects", name: "Terralith", gameVersions: ["1.21.1"], loaders: ["datapack"] }),
    ];
    expect(contentFindings(spec, metas, null)).toEqual([{ list: "datapacks.modrinthProjects", entry: "TERRALIT:v0000001", name: "Terralith", problem: "incompatible" }]);
    expect(contentFindings({ ...spec, version: "LATEST" }, metas, null).map((f) => f.problem)).toEqual(["floating", "floating"]);
  });
});

describe("backupReason", () => {
  const withMods = { ...base, mods: { modrinthProjects: ["AANobbMI:Yp8wLY1P", "gvQqBUqZ:Lh3m2kR1"], curseforgeFiles: [], urls: [] } };
  it("explains why a backup is offered", () => {
    expect(backupReason(withMods, { ...withMods, mods: undefined }, "none")).toBe("It removes 2 content entries from a server with a world.");
    expect(backupReason(withMods, { ...withMods, mods: { ...withMods.mods, modrinthProjects: ["gvQqBUqZ:Lh3m2kR1"] } }, "none")).toBe("It removes 1 content entry from a server with a world.");
    expect(backupReason(base, base, "uninstall")).toBe("It uninstalls the modpack.");
    expect(backupReason(base, base, "switch")).toBe("It switches to another modpack.");
    expect(backupReason(base, base, "downgrade")).toBe("It moves the modpack to an older version.");
    expect(backupReason(base, base, "unknown")).toBe("It changes the modpack's version.");
    expect(backupReason(base, base, "upgrade")).toBeNull();
  });
});

describe("compatUnavailableNote", () => {
  it("names the entries that could not be checked and why; nothing when everything was checked", () => {
    expect(compatUnavailableNote([], false)).toBeNull();
    expect(compatUnavailableNote([], true)).toBe(COMPAT_UNAVAILABLE);
    expect(compatUnavailableNote([{ list: "mods.curseforgeFiles", entry: "238222:5101366", reason: "no_key" }], false))
      .toBe("The compatibility check could not run for 238222:5101366 (no CurseForge key). You can still apply.");
    expect(compatUnavailableNote([
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", reason: "source" },
      { list: "mods.curseforgeFiles", entry: "1:2", reason: "no_key" },
    ], false)).toBe("The compatibility check could not run for AANobbMI:Yp8wLY1P, 1:2 (content sources unreachable or no CurseForge key). You can still apply.");
    expect(compatUnavailableNote([{ list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", reason: "source" }], true)).toBe(COMPAT_UNAVAILABLE);
  });
});

describe("backupFirstNotice", () => {
  it("tells the outcome of the chained job outside the dialog, in its tone", () => {
    expect(backupFirstNotice({ state: "waiting" }, null)).toBeNull();
    expect(backupFirstNotice({ state: "applied" }, 8)).toEqual({ tone: "ok", text: "Backed up and saved (v8). The agent will recreate the container if needed." });
    expect(backupFirstNotice({ state: "applied" }, null)).toEqual({ tone: "ok", text: "Backed up and saved. The agent will recreate the container if needed." });
    expect(backupFirstNotice({ state: "failed", message: "The backup failed: the change was not applied" }, null))
      .toEqual({ tone: "bad", text: "The backup failed: the change was not applied. Your changes are still in the form: review them and apply again." });
  });
});
