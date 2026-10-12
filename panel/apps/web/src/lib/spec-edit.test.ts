import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import {
  buildSpecPatch, editableFromTemplate, editableSpec, kvToText, listToText, parseKv, parseList, replaceOtherProperties,
  setProperty, splitProperties, validateSpec, withType, parseLines, validateListItems, typeChangeNotice,
} from "./spec-edit";
import { PROPERTY_DEFS, typeKind } from "./spec-catalog";

describe("listas y clave=valor", () => {
  it("parseList acepta líneas y comas, quita vacíos y espacios", () => {
    expect(parseList(" lithium\nsodium, ferritecore:beta\n\n")).toEqual(["lithium", "sodium", "ferritecore:beta"]);
    expect(listToText(["a", "b"])).toBe("a\nb");
    expect(listToText(undefined)).toBe("");
  });
  it("parseKv ignora comentarios y rechaza líneas sin =", () => {
    expect(parseKv("# hola\nmotd=Mi = servidor\n max-players = 10 ")).toEqual({ motd: "Mi = servidor", "max-players": "10" });
    expect(() => parseKv("motd")).toThrow(/clave=valor/);
    expect(kvToText({ a: "1", b: "2" })).toBe("a=1\nb=2");
  });
});

describe("propiedades", () => {
  it("separa las tipadas, fija/quita una y sustituye las otras", () => {
    const props = { motd: "x", "max-players": "5", "custom-x": "1" };
    expect(splitProperties(props)).toEqual({ typed: { motd: "x", "max-players": "5" }, other: { "custom-x": "1" } });
    expect(setProperty(props, "motd", "")).toEqual({ "max-players": "5", "custom-x": "1" });
    expect(setProperty(props, "pvp", "false")).toMatchObject({ pvp: "false" });
    expect(replaceOtherProperties(props, { "other-y": "2" })).toEqual({ motd: "x", "max-players": "5", "other-y": "2" });
  });
  it("el catálogo tiene ~20 propiedades y tipos conocidos", () => {
    expect(PROPERTY_DEFS.length).toBeGreaterThanOrEqual(20);
    expect(typeKind("FABRIC")).toBe("mods");
    expect(typeKind("AUTO_CURSEFORGE")).toBe("modpack");
    expect(typeKind("MOHIST")).toBe("other");
  });
});

describe("withType", () => {
  it("un tipo de modpack crea la sección modpack y uno normal la quita", () => {
    const base = defaultSpecInput();
    const mp = withType(base, "MODRINTH");
    expect(mp.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "", versionId: "", loader: "" });
    const cf = withType({ ...mp, modpack: { ...mp.modpack!, slugOrUrl: "pack", loader: "fabric" } }, "AUTO_CURSEFORGE");
    expect(cf.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "", versionId: "", loader: "" }); // no se arrastra el slug entre plataformas
    const paper = withType(cf, "PAPER");
    expect(paper).not.toHaveProperty("modpack");
    expect(paper.type).toBe("PAPER");
  });
});

describe("buildSpecPatch", () => {
  const original = { type: "PAPER", memory: "4G", properties: { motd: "a" }, whitelist: { enabled: true, players: ["Lobo"] }, backups: { cron: "0 4 * * *" }, rconPassword: "x" };
  it("solo envía lo que cambió y null para lo quitado; nunca toca claves que no edita", () => {
    const edited = { type: "PAPER", memory: "6G", properties: { motd: "a" } };
    expect(buildSpecPatch(original, edited)).toEqual({ memory: "6G", whitelist: null });
  });
  it("partiendo de editableSpec no hay cambios espurios", () => {
    expect(buildSpecPatch(original, { ...editableSpec(original), memory: "6G" })).toEqual({ memory: "6G" });
  });
  it("nunca manda null para secciones obligatorias; [] se envía como sección vacía", () => {
    expect(buildSpecPatch({ type: "PAPER", memory: "4G", ops: ["a"] }, { type: "PAPER", ops: [] })).toEqual({ ops: [] });
    expect(buildSpecPatch({ type: "PAPER", memory: "4G", resources: { cpus: 0, memLimit: "" } }, { type: "PAPER" })).toEqual({});
  });
  it("el orden de las claves no cuenta como cambio", () => {
    expect(buildSpecPatch({ properties: { a: "1", b: "2" } }, { properties: { b: "2", a: "1" } })).toEqual({});
  });
});

describe("validateSpec", () => {
  it("devuelve el error con la ruta del campo", () => {
    expect(validateSpec(withType(defaultSpecInput(), "MODRINTH"), "server")).toMatch(/^modpack\.slugOrUrl: /);
    expect(validateSpec(defaultSpecInput(), "server")).toBeNull();
  });
  it("en plantillas ignora los puertos", () => {
    const t = editableFromTemplate(templateSpecSchema.parse({ type: "PAPER" }));
    expect(t.ports).toEqual({ extra: [] });
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "template")).toBeNull();
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "server")).toMatch(/ports\.game/);
  });
});

describe("parseLines y validateListItems", () => {
  it("parseLines no trocea por comas", () => {
    expect(parseLines("a,b\n  c \n\n")).toEqual(["a,b", "c"]);
  });
  it("detecta espacios, comas y URLs no http", () => {
    expect(validateListItems("entry", ["lithium", "ferritecore:beta"])).toBeNull();
    expect(validateListItems("entry", ["lithium sodium"])).toMatch(/lithium sodium/);
    expect(validateListItems("entry", ["a,b"])).not.toBeNull();
    expect(validateListItems("url", ["https://x.org/a.jar"])).toBeNull();
    expect(validateListItems("url", ["ftp://x/a.jar"])).not.toBeNull();
    expect(validateListItems("digits", ["28140", "abc"])).toMatch(/abc/);
  });
});

describe("typeChangeNotice", () => {
  const withMp = withType(defaultSpecInput(), "MODRINTH");
  const filled = { ...withMp, modpack: { ...withMp.modpack!, slugOrUrl: "cobblemon" } };
  it("avisa al descartar, crear o reiniciar el modpack y calla si no hay efecto", () => {
    expect(typeChangeNotice(filled, "PAPER")).toMatch(/descarta.*cobblemon/);
    expect(typeChangeNotice(defaultSpecInput(), "MODRINTH")).toMatch(/crea una sección Modpack vacía/);
    expect(typeChangeNotice(filled, "AUTO_CURSEFORGE")).toMatch(/vacía el modpack actual/);
    expect(typeChangeNotice(defaultSpecInput(), "FABRIC")).toBeNull();
    expect(typeChangeNotice(filled, "MODRINTH")).toBeNull();
  });
});
