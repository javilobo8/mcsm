import { describe, expect, it } from "vitest";
import { specChanged, blurVersionAction, ageText, buildLabel, buildOptions, freeTextOption, hasUnstableBuilds, hasVersionList, startsUnstable, versionOptions } from "./versions";

const LIST = [
  { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false },
  { id: "1.21.11", stable: true }, { id: "1.21.4", stable: true }, { id: "25w14a", stable: false },
];

describe("versionOptions", () => {
  it("sin buscar: especiales del tipo y estables; las de prueba solo con el interruptor", () => {
    expect(versionOptions("VANILLA", LIST, { query: "", showUnstable: false })).toEqual({
      specials: [{ id: "LATEST", label: "LATEST — la última estable" }, { id: "SNAPSHOT", label: "SNAPSHOT — la última snapshot" }],
      stable: ["26.3", "1.21.11", "1.21.4"], unstable: [], hidden: 0, freeText: null,
    });
    expect(versionOptions("PAPER", LIST, { query: "", showUnstable: true })).toMatchObject({
      specials: [{ id: "LATEST" }], unstable: ["26.4-snapshot-3", "26.3-rc-3", "25w14a"],
    });
  });
  it("al buscar entran también las de prueba, y lo escrito que no está como «Usar»", () => {
    expect(versionOptions("PAPER", LIST, { query: "26.3", showUnstable: false })).toMatchObject({ specials: [], stable: ["26.3"], unstable: ["26.3-rc-3"], freeText: null });
    expect(versionOptions("PAPER", LIST, { query: " 1.8.9 ", showUnstable: false })).toMatchObject({ stable: [], unstable: [], freeText: "1.8.9" });
  });
  it("como mucho MAX_OPTIONS por grupo; el resto se cuenta", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `1.0.${i}`, stable: true }));
    const o = versionOptions("PAPER", many, { query: "", showUnstable: false });
    expect(o.stable).toHaveLength(200);
    expect(o.hidden).toBe(50);
  });
});

describe("freeTextOption", () => {
  it("solo versiones válidas que no estén en la lista ni sean LATEST/SNAPSHOT", () => {
    expect(freeTextOption("1.8.9", LIST)).toBe("1.8.9");
    expect(freeTextOption("26.3", LIST)).toBeNull();
    expect(freeTextOption("latest", LIST)).toBeNull();
    expect(freeTextOption("Snapshot", LIST)).toBeNull();
    expect(freeTextOption("1 2", LIST)).toBeNull();
    expect(freeTextOption("../x", LIST)).toBeNull();
    expect(freeTextOption("", LIST)).toBeNull();
  });
});

describe("selector de build", () => {
  it("etiqueta por tipo; null si no admite build", () => {
    expect(buildLabel("FABRIC")).toBe("Versión del loader de Fabric");
    expect(buildLabel("PAPER")).toBe("Build de Paper");
    expect(buildLabel("VANILLA")).toBeNull();
    expect(hasUnstableBuilds("NEOFORGE")).toBe(true);
    expect(hasUnstableBuilds("PAPER")).toBe(false);
  });
  it("estables por defecto, la recomendada marcada y la actual siempre presente", () => {
    const builds = [
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26-beta", stable: false, recommended: false },
      { id: "47.4.0", stable: true, recommended: true },
    ];
    expect(buildOptions(builds, "", false)).toEqual([{ value: "47.4.27", label: "47.4.27" }, { value: "47.4.0", label: "47.4.0 (recomendada)" }]);
    expect(buildOptions(builds, "", true).map((o) => o.label)).toContain("47.4.26-beta (beta)");
    expect(buildOptions(builds, "40.0.1", false)[0]).toEqual({ value: "40.0.1", label: "40.0.1" });
    expect(buildOptions(builds, "47.4.26-beta", false).map((o) => o.value)).toContain("47.4.26-beta");
  });
});

describe("otros", () => {
  it("hasVersionList / startsUnstable / ageText", () => {
    expect(hasVersionList("FORGE")).toBe(true);
    expect(hasVersionList("MODRINTH")).toBe(false);
    expect(startsUnstable("26.4-snapshot-3")).toBe(true);
    expect(startsUnstable("1.21.4")).toBe(false);
    expect(startsUnstable("LATEST")).toBe(false);
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ageText("2026-10-13T11:45:00Z", now)).toBe("hace 15 min");
    expect(ageText("2026-10-13T10:00:00Z", now)).toBe("hace 2 h");
    expect(ageText("2026-10-10T12:00:00Z", now)).toBe("hace 3 días");
  });
});

describe("blurVersionAction / specChanged", () => {
  it("sin cambios: nada; solo espacios: recortar; cambio real: aplicar", () => {
    expect(blurVersionAction("1.20.1", "1.20.1")).toBe("none");
    expect(blurVersionAction("1.20.1", " 1.20.1 ")).toBe("trim");
    expect(blurVersionAction("1.20.1", "1.21.4")).toBe("apply");
    expect(blurVersionAction("1.20.1", "1.21.4 ")).toBe("apply");
  });
  it("specChanged compara versión, Java y build (build ausente = vacío)", () => {
    const a = { version: "1", imageTag: "java21" };
    expect(specChanged(a, { ...a })).toBe(false);
    expect(specChanged(a, { ...a, build: "" })).toBe(false);
    expect(specChanged(a, { ...a, build: "7" })).toBe(true);
    expect(specChanged(a, { ...a, version: "2" })).toBe(true);
    expect(specChanged(a, { ...a, imageTag: "java17" })).toBe(true);
  });
});
