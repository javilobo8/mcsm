import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupsSchema, cronError, DEFAULT_BACKUP_EXCLUDES } from "./backups.js";
import { specSchema } from "./spec.js";

const cases = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/cron-cases.json", import.meta.url), "utf8")) as { valid: string[]; invalid: string[] };
const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("cronError (mismo criterio que el agente)", () => {
  it.each(cases.valid)("acepta %j", (e) => expect(cronError(e)).toBeNull());
  it.each(cases.invalid)("rechaza %j", (e) => expect(cronError(e)).not.toBeNull());
  it("explica el campo en castellano", () => {
    expect(cronError("0 4 * * MON")).toBe('Campo "Día de la semana" no válido: MON');
    expect(cronError("0 25 * * *")).toBe("Hora fuera de rango (0-23)");
  });
});

describe("backupsSchema", () => {
  it("rellena los valores por defecto", () => {
    expect(backupsSchema.parse({})).toEqual({
      enabled: false, cron: "0 4 * * *", keepDays: 7, keepCount: 10, excludes: [...DEFAULT_BACKUP_EXCLUDES], onlyIfPlayersSince: true,
    });
  });
  it("exige un cron válido si está activado", () => {
    const r = backupsSchema.safeParse({ enabled: true, cron: "cada día" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["cron"]);
  });
  it("admite cron vacío si está desactivado", () => {
    expect(backupsSchema.safeParse({ enabled: false, cron: "" }).success).toBe(true);
  });
  it.each(["/etc", "../world", "[abc]", "", "a\\b"])("rechaza la exclusión %j", (p) => {
    expect(backupsSchema.safeParse({ excludes: [p] }).success).toBe(false);
  });
  it("acepta exclusiones con ruta y comodines", () => {
    expect(backupsSchema.parse({ excludes: ["world/session.lock", "*.jar"] }).excludes).toEqual(["world/session.lock", "*.jar"]);
  });
  it("limita la retención", () => {
    expect(backupsSchema.safeParse({ keepDays: -1 }).success).toBe(false);
    expect(backupsSchema.safeParse({ keepCount: 1001 }).success).toBe(false);
    expect(backupsSchema.safeParse({ keepCount: 1.5 }).success).toBe(false);
  });
});

describe("spec con backups", () => {
  it("la sección es opcional: la fixture sin backups no cambia", () => {
    expect(specSchema.parse(fixture)).toEqual(fixture);
  });
  it("valida la sección si viene y rellena sus valores por defecto", () => {
    expect(specSchema.safeParse({ ...fixture, backups: { enabled: true, cron: "0 4 * * MON" } }).success).toBe(false);
    const ok = specSchema.parse({ ...fixture, backups: { enabled: true, cron: "*/30 * * * *" } });
    expect(ok.backups).toMatchObject({ enabled: true, cron: "*/30 * * * *", keepCount: 10 });
  });
});
