import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { editableFromTemplate } from "./spec-edit";
import { REMOVE_SCHEDULE_PATCH, templateCreateBody, templatePatchBody, templateSaveBlock } from "./template-edit";

describe("templateSaveBlock", () => {
  it("requires a name", () => {
    expect(templateSaveBlock("  ", {})).toBe("The name is required");
  });
  it("blocks while there are field errors and says how many", () => {
    expect(templateSaveBlock("a", { "sf-memory": "bad" })).toBe("Fix 1 field with an error before saving");
    expect(templateSaveBlock("a", { x: "1", y: "2" })).toBe("Fix 2 fields with errors before saving");
  });
  it("no block if everything is fine", () => {
    expect(templateSaveBlock("a", {})).toBeNull();
  });
});

describe("template bodies", () => {
  const base = defaultSpecInput();
  it("create: trims and does not send ports", () => {
    const b = templateCreateBody(" n ", " d ", { ...base, ports: { extra: [{ container: 1, host: 2, proto: "tcp", label: "x" }] } });
    expect(b.name).toBe("n");
    expect(b.description).toBe("d");
    expect("ports" in b.spec).toBe(false);
  });
  it("edit: only sends what changed and null to remove optionals", () => {
    const orig = { ...base, memory: "2G", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const tpl = editableFromTemplate((({ ports: _p, ...r }) => r)(orig));
    const edited = { ...tpl, memory: "4G" };
    delete (edited as { mods?: unknown }).mods;
    const b = templatePatchBody({ ...tpl }, edited, "n", "");
    expect(b.spec).toEqual({ memory: "4G", mods: null });
    expect(b.spec).not.toHaveProperty("ports");
  });
});

it("removing a template's schedule is a PATCH with backups: null", () => {
  expect(REMOVE_SCHEDULE_PATCH).toEqual({ spec: { backups: null } });
});
