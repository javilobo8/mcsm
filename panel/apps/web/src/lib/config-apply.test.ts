import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { configLeaveWarning, isStale, planApply } from "./config-apply";

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
