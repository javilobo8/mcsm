import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { editableFromTemplate } from "./spec-edit";
import { templateCreateBody, templatePatchBody, templateSaveBlock } from "./template-edit";

describe("templateSaveBlock", () => {
  it("exige nombre", () => {
    expect(templateSaveBlock("  ", {})).toBe("El nombre es obligatorio");
  });
  it("bloquea mientras haya errores de campo y dice cuántos", () => {
    expect(templateSaveBlock("a", { "sf-memory": "mal" })).toBe("Corrige 1 campo con error antes de guardar");
    expect(templateSaveBlock("a", { x: "1", y: "2" })).toBe("Corrige 2 campos con error antes de guardar");
  });
  it("sin bloqueo si todo está bien", () => {
    expect(templateSaveBlock("a", {})).toBeNull();
  });
});

describe("cuerpos de plantilla", () => {
  const base = defaultSpecInput();
  it("crear: recorta y no envía ports", () => {
    const b = templateCreateBody(" n ", " d ", { ...base, ports: { extra: [{ container: 1, host: 2, proto: "tcp", label: "x" }] } });
    expect(b.name).toBe("n");
    expect(b.description).toBe("d");
    expect("ports" in b.spec).toBe(false);
  });
  it("editar: solo envía lo cambiado y null para borrar opcionales", () => {
    const orig = { ...base, memory: "2G", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const tpl = editableFromTemplate((({ ports: _p, ...r }) => r)(orig));
    const edited = { ...tpl, memory: "4G" };
    delete (edited as { mods?: unknown }).mods;
    const b = templatePatchBody({ ...tpl }, edited, "n", "");
    expect(b.spec).toEqual({ memory: "4G", mods: null });
    expect(b.spec).not.toHaveProperty("ports");
  });
});
