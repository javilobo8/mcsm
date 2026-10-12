import { describe, expect, it } from "vitest";
import { ApiError, type BackupDto, type JobDto } from "./api";
import { backupActions, keepIdempotencyKey, parseRetention, resyncSchedule, deleteDialogText, formatBackupDate, formToSchedule, presetFor, scheduleToForm, toggleBusyReason } from "./backups";

const base: BackupDto = {
  id: "b1", serverId: "s1", nodeId: "n1", filename: "x.tar.zst", sizeBytes: 1, sha256: "", specVersion: 1,
  trigger: "manual", status: "ok", startedAt: "2026-10-12T10:00:00Z", finishedAt: null, kind: "archive",
};
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j", type: "backup", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "",
  payload: {}, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});

describe("programación de copias", () => {
  it("sin programación muestra los valores por defecto desactivados", () => {
    expect(scheduleToForm(undefined)).toEqual({
      enabled: false, cron: "0 4 * * *", keepDays: "7", keepCount: "10", excludes: "logs\ncache\n*.tmp", onlyIfPlayersSince: true,
    });
  });
  it("reconoce los presets", () => {
    expect(presetFor("0 4 * * *")).toBe("daily");
    expect(presetFor(" 0 */6 * * * ")).toBe("6h");
    expect(presetFor("15 3 * * 1")).toBe("custom");
  });
  it("convierte el formulario y limpia las exclusiones", () => {
    const r = formToSchedule({ enabled: true, cron: " * * * * * ", keepDays: "", keepCount: "3", excludes: " logs \n\n*.jar\n", onlyIfPlayersSince: false });
    expect(r).toEqual({ ok: true, value: { enabled: true, cron: "* * * * *", keepDays: 0, keepCount: 3, excludes: ["logs", "*.jar"], onlyIfPlayersSince: false } });
  });
  it("devuelve el error en castellano", () => {
    expect(formToSchedule({ ...scheduleToForm(undefined), enabled: true, cron: "0 4 * * MON" })).toEqual({ ok: false, error: 'Campo "Día de la semana" no válido: MON' });
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "siete" })).toMatchObject({ ok: false, error: expect.stringMatching(/enteros/) });
    expect(formToSchedule({ ...scheduleToForm(undefined), excludes: "../world" })).toMatchObject({ ok: false });
  });
  it("rechaza números negativos o decimales", () => {
    expect(formToSchedule({ ...scheduleToForm(undefined), keepCount: "2.5" })).toMatchObject({ ok: false });
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "-1" })).toMatchObject({ ok: false });
  });
});

describe("estado de los botones", () => {
  it("el botón de crear se bloquea con nodo caído o job de copia/restauración activo", () => {
    expect(toggleBusyReason(true, undefined)).toBeNull();
    expect(toggleBusyReason(undefined, undefined)).toBeNull();
    expect(toggleBusyReason(false, undefined)).toMatch(/desconectado/);
    expect(toggleBusyReason(true, job({}))).toMatch(/en curso/);
  });
  it("restaurar solo en archivos y sin ocupado; descargar siempre deshabilitado", () => {
    expect(backupActions(base, false, false)).toMatchObject({ restore: true, download: false, remove: true });
    expect(backupActions(base, true, false).restore).toBe(false);
    expect(backupActions({ ...base, kind: "directory" }, false, false)).toMatchObject({ restore: false, showDownload: false });
    expect(backupActions(base, false, true).remove).toBe(false);
    expect(backupActions(base, true, false).remove).toBe(false);
  });
  it("las copias que no están ok no se restauran", () => {
    expect(backupActions({ ...base, status: "failed" }, false, false).restore).toBe(false);
  });
});

describe("textos", () => {
  it("diálogo de borrado distingue datos pre-restore", () => {
    expect(deleteDialogText({ ...base, kind: "directory", filename: "data.pre-restore-1" }).title).toMatch(/anteriores/);
    expect(deleteDialogText(base).description).toContain("x.tar.zst");
  });
  it("formatea la fecha y tolera valores inválidos", () => {
    expect(formatBackupDate("no-fecha")).toBe("—");
    expect(formatBackupDate("2026-10-12T10:00:00Z")).not.toBe("—");
  });
});

describe("retención", () => {
  it("solo enteros decimales", () => {
    expect(parseRetention("")).toBe(0);
    expect(parseRetention(" 12 ")).toBe(12);
    for (const bad of ["1e2", "0x10", "-1", "2.5", "siete", "+3"]) expect(parseRetention(bad)).toBeNull();
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "1e2" })).toMatchObject({ ok: false });
  });
});

describe("resincronización del formulario", () => {
  const a = scheduleToForm(undefined);
  const incoming = { ...a, keepDays: "30" };
  it("sin cambios sin guardar adopta lo del servidor", () => {
    expect(resyncSchedule(a, a, incoming)).toEqual({ form: incoming, base: incoming });
  });
  it("con cambios sin guardar conserva lo editado", () => {
    const edited = { ...a, cron: "* * * * *" };
    expect(resyncSchedule(edited, a, incoming)).toEqual({ form: edited, base: incoming });
  });
  it("tras el PATCH propio queda limpio", () => {
    const edited = { ...a, keepDays: "30" };
    const r = resyncSchedule(edited, a, edited);
    expect(r.form).toEqual(edited);
    expect(resyncSchedule(r.form, r.base, { ...edited, keepCount: "1" }).form.keepCount).toBe("1");
  });
});

describe("clave de idempotencia", () => {
  it("solo se conserva si no hubo respuesta del servidor", () => {
    expect(keepIdempotencyKey(new TypeError("Failed to fetch"))).toBe(true);
    expect(keepIdempotencyKey(new ApiError(0, "sin conexión"))).toBe(true);
    expect(keepIdempotencyKey(new ApiError(409, "busy"))).toBe(false);
    expect(keepIdempotencyKey(new ApiError(502, "agente"))).toBe(false);
    expect(keepIdempotencyKey(null)).toBe(false);
  });
});
