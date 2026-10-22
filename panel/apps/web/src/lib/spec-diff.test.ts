import { describe, expect, it } from "vitest";
import { diffSpecs } from "./spec-diff";

describe("diffSpecs", () => {
  const before = {
    type: "PAPER", version: "1.21.4", memory: "4G", properties: { motd: "Hello", pvp: "true" }, env: {},
    ports: { game: 25565, extra: [] }, resources: { cpus: 0, memLimit: "" }, rconPassword: "secret",
  };
  it("without changes returns empty", () => {
    expect(diffSpecs(before, { ...before })).toEqual([]);
  });
  it("lists changes with English labels and never shows rconPassword", () => {
    const after = {
      ...before, type: "FABRIC", memory: "6G", properties: { motd: "Bye" },
      mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
      whitelist: { enabled: true, players: ["Lobo"] },
      ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
      rconPassword: "other",
    };
    const lines = diffSpecs(before, after);
    expect(lines).toEqual(expect.arrayContaining([
      { label: "Type", before: "PAPER", after: "FABRIC" },
      { label: "JVM memory", before: "4G", after: "6G" },
      { label: "Property motd", before: "Hello", after: "Bye" },
      { label: "Property pvp", before: "true", after: "—" },
      { label: "Modrinth mods", before: "—", after: "lithium" },
      { label: "Whitelist", before: "(not managed)", after: "enabled: Lobo" },
      { label: "Extra ports", before: "—", after: "19132→19132/udp (Geyser)" },
    ]));
    expect(JSON.stringify(lines)).not.toMatch(/secret|other/);
    expect(lines.find((l) => l.label === "CurseForge mods")).toBeUndefined();
  });
  it("readable modpack", () => {
    const lines = diffSpecs({ type: "PAPER" }, { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(lines).toContainEqual({ label: "Modpack", before: "—", after: "MODRINTH: cobblemon-fabric (fabric)" });
  });
  it("ops/whitelist from absent to empty (and the reverse) is an explicit change", () => {
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", ops: [] })).toEqual([
      { label: "Operators", before: "(not managed)", after: "empty — all will be revoked" },
    ]);
    expect(diffSpecs({ type: "PAPER", ops: [] }, { type: "PAPER" })).toEqual([
      { label: "Operators", before: "empty — all will be revoked", after: "(not managed)" },
    ]);
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: false, players: [] } })).toEqual([
      { label: "Whitelist", before: "(not managed)", after: "disabled" },
    ]);
  });
  it("whitelist enabled with an empty list warns that only ops can join", () => {
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: true, players: [] } })).toEqual([
      { label: "Whitelist", before: "(not managed)", after: "enabled and empty — nobody will be able to join except ops" },
    ]);
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: false, players: [] } })[0]?.after).toBe("disabled");
  });
  it("mods/plugins: going from absent to present (even if empty) is a change; equal to equal is not", () => {
    const empty = { modrinthProjects: [], curseforgeFiles: [], urls: [] };
    expect(diffSpecs({}, { mods: empty })).toEqual([{ label: "Mods (section)", before: "(not managed)", after: "managed by the panel" }]);
    expect(diffSpecs({ mods: empty }, { mods: empty })).toEqual([]);
    expect(diffSpecs({ plugins: { modrinthProjects: [], spigetResources: [], urls: [] } }, {}))
      .toEqual([{ label: "Plugins (section)", before: "managed by the panel", after: "(not managed)" }]);
  });

  it("published RCON port: absent reads as not published, auto as assigned on apply", () => {
    const base = { ports: { game: 25565, extra: [] } };
    expect(diffSpecs(base, { ports: { ...base.ports, rcon: 25580 } })).toEqual([{ label: "Published RCON port", before: "not published", after: "25580" }]);
    expect(diffSpecs(base, { ports: { ...base.ports, rcon: "auto" } })).toEqual([{ label: "Published RCON port", before: "not published", after: "assigned on apply" }]);
    expect(diffSpecs({ ports: { ...base.ports, rcon: 25580 } }, base)).toEqual([{ label: "Published RCON port", before: "25580", after: "not published" }]);
    expect(diffSpecs({ ports: { ...base.ports, rcon: 25580 } }, { ports: { ...base.ports, rcon: 25581 } })).toEqual([{ label: "Published RCON port", before: "25580", after: "25581" }]);
  });
});
