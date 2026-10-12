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

describe("validadores de Propiedades, Avanzado y Recursos", () => {
  it("propiedades: rechaza las reservadas y nombres inválidos", async () => {
    const { validateExtraProperties } = await import("./spec-edit");
    expect(validateExtraProperties({ "spawn-npcs": "true" })).toBeNull();
    for (const k of ["server-port", "enable-rcon", "rcon.port", "rcon.password"]) expect(validateExtraProperties({ [k]: "1" })).toContain(k);
    expect(validateExtraProperties({ "Bad Key": "1" })).toContain("Bad Key");
    // Una clave con campo tipado no se acepta en "Otras": si no, se movería y vaciaría el textarea al teclear.
    expect(validateExtraProperties({ motd: "x" })).toContain("campo");
  });
  it("env: rechaza reservadas, CF_API_KEY con mensaje propio y nombres inválidos", async () => {
    const { validateEnv } = await import("./spec-edit");
    expect(validateEnv({ USE_AIKAR_FLAGS: "true" })).toBeNull();
    expect(validateEnv({ MEMORY: "4G" })).toContain("MEMORY");
    expect(validateEnv({ RCON_PORT: "1" })).toContain("RCON_PORT");
    expect(validateEnv({ CF_API_KEY: "x" })).toContain("aparte");
    expect(validateEnv({ "1BAD": "x" })).toContain("1BAD");
  });
  it("memoria: formato y límite >= memoria", async () => {
    const { validateMemory, validateMemLimit } = await import("./spec-edit");
    expect(validateMemory("4G")).toBeNull();
    for (const bad of ["", "0G", "04G", "4", "4GB", "-1G", "4 G"]) expect(validateMemory(bad)).not.toBeNull();
    expect(validateMemLimit("", "4G")).toBeNull();
    expect(validateMemLimit("5G", "4G")).toBeNull();
    expect(validateMemLimit("2G", "4G")).not.toBeNull();
    expect(validateMemLimit("3x", "4G")).not.toBeNull();
  });
  it("ListItemKind player valida nombres y UUID", () => {
    expect(validateListItems("player", ["Lobo", "069a79f4-44e9-4726-a5be-fca90e38aaf5"])).toBeNull();
    expect(validateListItems("player", ["no valido!"])).toContain("no valido!");
  });
  it("puertos extra: RCON 25575 y rangos", async () => {
    const { validateExtraPorts } = await import("./spec-edit");
    expect(validateExtraPorts([{ host: 19132, container: 19132, proto: "udp", label: "" }])).toBeNull();
    expect(validateExtraPorts([{ host: 30000, container: 25575, proto: "tcp", label: "" }])).toContain("25575");
    expect(validateExtraPorts([{ host: 0, container: 1, proto: "tcp", label: "" }])).toContain("#1");
  });
});

describe("resincronización de campos numéricos", () => {
  it("eco y ediciones en curso no se pisan", async () => {
    const { shouldResyncNumber: r, parseNumberText } = await import("./spec-edit");
    expect(parseNumberText("0.")).toBe(0);
    expect(parseNumberText("0,5")).toBe(0.5);
    expect(parseNumberText("x")).toBeNaN(); // inválido no es vacío
    expect(parseNumberText("  ")).toBeUndefined();
    expect(r({ text: "0", incoming: 0, emitted: 0 })).toBe(false);
    expect(r({ text: "0.", incoming: 0, emitted: 0 })).toBe(false);
    expect(r({ text: "0.5", incoming: 0.5, emitted: 0.5 })).toBe(false);
    // CPUs: 0 se guarda pero el prop vuelve undefined; no es un cambio remoto
    expect(r({ text: "0", incoming: undefined, emitted: 0, zeroIsEmpty: true })).toBe(false);
    expect(r({ text: "0.", incoming: undefined, emitted: 0, zeroIsEmpty: true })).toBe(false);
    // sin zeroIsEmpty, undefined frente a 0 sí es distinto (el texto "0" vale 0)
    expect(r({ text: "0", incoming: undefined, emitted: 0 })).toBe(true);
    // reemplazo remoto real
    expect(r({ text: "4", incoming: 8, emitted: 4 })).toBe(true);
    expect(r({ text: "4", incoming: undefined, emitted: 4 })).toBe(true);
    // texto inválido en pantalla + reemplazo remoto (recargar, descartar) a vacío o a otro valor: se resincroniza
    expect(r({ text: "x", incoming: undefined, emitted: 4 })).toBe(true);
    expect(r({ text: "x", incoming: 8, emitted: 4 })).toBe(true);
    expect(r({ text: "x", incoming: undefined, emitted: 4, zeroIsEmpty: true })).toBe(true);
    // …pero no si el padre solo repite lo último emitido
    expect(r({ text: "x", incoming: 4, emitted: 4 })).toBe(false);
  });
});

describe("lectura de un NumberField", () => {
  it("enteros: vacío, válido, decimales, basura y rango", async () => {
    const { readNumberField: read } = await import("./spec-edit");
    const o = { label: "Jugadores", integer: true, min: 1, max: 10 };
    expect(read("", o)).toEqual({ ok: true, value: undefined });
    expect(read(" 7 ", o)).toEqual({ ok: true, value: 7 });
    for (const bad of ["1.5", "5.", "x", "0x10", "1e3", "-1", "0", "11"]) expect(read(bad, o), bad).toEqual({ ok: false, error: "Jugadores: debe ser un número entero entre 1 y 10" });
  });
  it("decimales: los estados intermedios al teclear (0. y 0,) son válidos, sin error transitorio", async () => {
    const { readNumberField: read } = await import("./spec-edit");
    const o = { label: "CPUs", integer: false, min: 0, max: 256 };
    expect(read("0.", o)).toEqual({ ok: true, value: 0 });
    expect(read("0,", o)).toEqual({ ok: true, value: 0 });
    expect(read("0.5", o)).toEqual({ ok: true, value: 0.5 });
    expect(read("1,25", o)).toEqual({ ok: true, value: 1.25 });
    for (const bad of [".", ",", "1.2.3", "-1", "300", "x"]) expect(read(bad, o).ok, bad).toBe(false);
  });
});

describe("Jugadores frente al env libre", () => {
  it("con la sección presente, OPS/OPS_FILE y WHITELIST/WHITELIST_FILE/ENABLE_WHITELIST del env son error de la sección", async () => {
    const { playersEnvErrors } = await import("./spec-edit");
    const base = defaultSpecInput();
    expect(playersEnvErrors({ ...base, env: { OPS: "Lobo,Pepe", ENABLE_WHITELIST: "false" } })).toEqual({ "sf-ops-env": null, "sf-whitelist-env": null });
    const both = playersEnvErrors({ ...base, ops: ["Lobo"], whitelist: { enabled: true, players: [] }, env: { OPS: "Lobo,Pepe", OPS_FILE: "x", ENABLE_WHITELIST: "false", EXISTING_OPS_FILE: "MERGE" } });
    expect(both["sf-ops-env"]).toMatch(/OPS[\s\S]*OPS_FILE/);
    expect(both["sf-ops-env"]).not.toMatch(/EXISTING/);
    expect(both["sf-whitelist-env"]).toMatch(/ENABLE_WHITELIST/);
  });
  it("los ids son errores calculados de la pestaña Jugadores (no se purgan por no estar en el DOM)", async () => {
    const { VIRTUAL_ERROR_IDS } = await import("./form-errors");
    const { tabOfField } = await import("@/components/spec-form/spec-form");
    for (const id of ["sf-ops-env", "sf-whitelist-env"]) {
      expect(VIRTUAL_ERROR_IDS.has(id)).toBe(true);
      expect(tabOfField(id)).toBe("players");
    }
  });
});
