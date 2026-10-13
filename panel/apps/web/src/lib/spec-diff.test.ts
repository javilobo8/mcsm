import { describe, expect, it } from "vitest";
import { diffSpecs } from "./spec-diff";

describe("diffSpecs", () => {
  const before = {
    type: "PAPER", version: "1.21.4", memory: "4G", properties: { motd: "Hola", pvp: "true" }, env: {},
    ports: { game: 25565, extra: [] }, resources: { cpus: 0, memLimit: "" }, rconPassword: "secreto",
  };
  it("sin cambios devuelve vacío", () => {
    expect(diffSpecs(before, { ...before })).toEqual([]);
  });
  it("lista cambios con etiquetas en castellano y nunca muestra rconPassword", () => {
    const after = {
      ...before, type: "FABRIC", memory: "6G", properties: { motd: "Adiós" },
      mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
      whitelist: { enabled: true, players: ["Lobo"] },
      ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
      rconPassword: "otro",
    };
    const lines = diffSpecs(before, after);
    expect(lines).toEqual(expect.arrayContaining([
      { label: "Tipo", before: "PAPER", after: "FABRIC" },
      { label: "Memoria JVM", before: "4G", after: "6G" },
      { label: "Propiedad motd", before: "Hola", after: "Adiós" },
      { label: "Propiedad pvp", before: "true", after: "—" },
      { label: "Mods de Modrinth", before: "—", after: "lithium" },
      { label: "Whitelist", before: "(sin gestionar)", after: "activada: Lobo" },
      { label: "Puertos extra", before: "—", after: "19132→19132/udp (Geyser)" },
    ]));
    expect(JSON.stringify(lines)).not.toMatch(/secreto|otro/);
    expect(lines.find((l) => l.label === "Mods de CurseForge")).toBeUndefined();
  });
  it("modpack legible", () => {
    const lines = diffSpecs({ type: "PAPER" }, { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(lines).toContainEqual({ label: "Modpack", before: "—", after: "MODRINTH: cobblemon-fabric (fabric)" });
  });
  it("ops/whitelist de ausente a vacío (y al revés) es un cambio explícito", () => {
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", ops: [] })).toEqual([
      { label: "Operadores", before: "(sin gestionar)", after: "vacía — se revocarán todos" },
    ]);
    expect(diffSpecs({ type: "PAPER", ops: [] }, { type: "PAPER" })).toEqual([
      { label: "Operadores", before: "vacía — se revocarán todos", after: "(sin gestionar)" },
    ]);
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: false, players: [] } })).toEqual([
      { label: "Whitelist", before: "(sin gestionar)", after: "desactivada" },
    ]);
  });
  it("whitelist activada con lista vacía avisa de que solo entran los ops", () => {
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: true, players: [] } })).toEqual([
      { label: "Whitelist", before: "(sin gestionar)", after: "activada y vacía — nadie podrá entrar salvo los ops" },
    ]);
    expect(diffSpecs({ type: "PAPER" }, { type: "PAPER", whitelist: { enabled: false, players: [] } })[0]?.after).toBe("desactivada");
  });
  it("mods/plugins: pasar de ausente a presente (aunque vacía) es un cambio; igual a igual no", () => {
    const empty = { modrinthProjects: [], curseforgeFiles: [], urls: [] };
    expect(diffSpecs({}, { mods: empty })).toEqual([{ label: "Mods (sección)", before: "(sin gestionar)", after: "gestionada por el panel" }]);
    expect(diffSpecs({ mods: empty }, { mods: empty })).toEqual([]);
    expect(diffSpecs({ plugins: { modrinthProjects: [], spigetResources: [], urls: [] } }, {}))
      .toEqual([{ label: "Plugins (sección)", before: "gestionada por el panel", after: "(sin gestionar)" }]);
  });
});
