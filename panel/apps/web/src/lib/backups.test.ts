import { describe, expect, it } from "vitest";
import { ApiError, type BackupDto, type JobDto } from "./api";
import { backupsSchema } from "@mcsm/shared";
import { backupActions, backupDownloadUrl, keepIdempotencyKey, parseRetention, resyncSchedule, deleteDialogText, formatBackupDate, formToSchedule, presetFor, restoreDialogText, scheduleSummary, scheduleToForm, templateScheduleNote, toggleBusyReason, scheduleDirty, scheduleLeaveWarning } from "./backups";

const base: BackupDto = {
  id: "b1", serverId: "s1", nodeId: "n1", filename: "x.tar.zst", sizeBytes: 1, sha256: "", specVersion: 1,
  trigger: "manual", status: "ok", startedAt: "2026-10-12T10:00:00Z", finishedAt: null, kind: "archive",
};
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j", type: "backup", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "",
  payload: {}, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});

describe("backup schedule", () => {
  it("without a schedule it shows the disabled defaults", () => {
    expect(scheduleToForm(undefined)).toEqual({
      enabled: false, cron: "0 4 * * *", keepDays: "7", keepCount: "10", excludes: "logs\ncache\n*.tmp", onlyIfPlayersSince: true,
    });
  });
  it("recognizes the presets", () => {
    expect(presetFor("0 4 * * *")).toBe("daily");
    expect(presetFor(" 0 */6 * * * ")).toBe("6h");
    expect(presetFor("15 3 * * 1")).toBe("custom");
  });
  it("converts the form and cleans up the exclusions", () => {
    const r = formToSchedule({ enabled: true, cron: " * * * * * ", keepDays: "", keepCount: "3", excludes: " logs \n\n*.jar\n", onlyIfPlayersSince: false });
    expect(r).toEqual({ ok: true, value: { enabled: true, cron: "* * * * *", keepDays: 0, keepCount: 3, excludes: ["logs", "*.jar"], onlyIfPlayersSince: false } });
  });
  it("returns the error in English", () => {
    expect(formToSchedule({ ...scheduleToForm(undefined), enabled: true, cron: "0 4 * * MON" })).toEqual({ ok: false, error: 'Field "Day of week" is not valid: MON' });
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "seven" })).toMatchObject({ ok: false, error: expect.stringMatching(/integers/) });
    expect(formToSchedule({ ...scheduleToForm(undefined), excludes: "../world" })).toMatchObject({ ok: false });
  });
  it("rejects negative numbers or decimals", () => {
    expect(formToSchedule({ ...scheduleToForm(undefined), keepCount: "2.5" })).toMatchObject({ ok: false });
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "-1" })).toMatchObject({ ok: false });
  });
});

describe("button state", () => {
  it("the create button is disabled with the node down or a backup/restore job active", () => {
    expect(toggleBusyReason(true, undefined)).toBeNull();
    expect(toggleBusyReason(undefined, undefined)).toBeNull();
    expect(toggleBusyReason(false, undefined)).toMatch(/offline/);
    expect(toggleBusyReason(true, job({}))).toMatch(/in progress/);
  });
  it("restore only on archives and when not busy", () => {
    expect(backupActions(base, false, false)).toMatchObject({ restore: true, download: true, remove: true });
    expect(backupActions(base, true, false).restore).toBe(false);
    expect(backupActions({ ...base, kind: "directory" }, false, false)).toMatchObject({ restore: false, showDownload: false });
    expect(backupActions(base, false, true).remove).toBe(false);
    expect(backupActions(base, true, false).remove).toBe(false);
  });
  it("download: only correct .tar.zst backups and with the node online; encoded url", () => {
    expect(backupActions({ kind: "archive", status: "ok" }, true, false).download).toBe(true); // a job in progress does not prevent reading it
    expect(backupActions({ kind: "archive", status: "ok" }, false, true).download).toBe(false);
    expect(backupActions({ kind: "archive", status: "failed" }, false, false).download).toBe(false);
    expect(backupActions({ kind: "directory", status: "ok" }, false, false).download).toBe(false);
    expect(backupDownloadUrl("s/1", "b?2")).toBe("/api/servers/s%2F1/backups/b%3F2/download");
  });
  it("backups that are not ok cannot be restored", () => {
    expect(backupActions({ ...base, status: "failed" }, false, false).restore).toBe(false);
  });
});

describe("texts", () => {
  it("delete dialog distinguishes pre-restore data", () => {
    expect(deleteDialogText({ ...base, kind: "directory", filename: "data.pre-restore-1" }).title).toMatch(/before the restore/);
    expect(deleteDialogText(base).description).toContain("x.tar.zst");
  });
  it("formats the date and tolerates invalid values", () => {
    expect(formatBackupDate("no-date")).toBe("—");
    expect(formatBackupDate("2026-10-12T10:00:00Z")).not.toBe("—");
  });
});

describe("retention", () => {
  it("decimal integers only", () => {
    expect(parseRetention("")).toBe(0);
    expect(parseRetention(" 12 ")).toBe(12);
    for (const bad of ["1e2", "0x10", "-1", "2.5", "seven", "+3"]) expect(parseRetention(bad)).toBeNull();
    expect(formToSchedule({ ...scheduleToForm(undefined), keepDays: "1e2" })).toMatchObject({ ok: false });
  });
});

describe("form resync", () => {
  const a = scheduleToForm(undefined);
  const incoming = { ...a, keepDays: "30" };
  it("without unsaved changes it adopts the server's value", () => {
    expect(resyncSchedule(a, a, incoming)).toEqual({ form: incoming, base: incoming });
  });
  it("with unsaved changes it keeps what was edited", () => {
    const edited = { ...a, cron: "* * * * *" };
    expect(resyncSchedule(edited, a, incoming)).toEqual({ form: edited, base: incoming });
  });
  it("what was edited while saving survives the PATCH response", () => {
    const sent = { ...a, keepDays: "30" };
    const typedMeanwhile = { ...sent, keepCount: "5" };
    const saved = { ...sent };
    expect(resyncSchedule(typedMeanwhile, sent, saved)).toEqual({ form: typedMeanwhile, base: saved });
    expect(resyncSchedule(sent, sent, saved)).toEqual({ form: saved, base: saved });
  });
  it("after its own PATCH it is clean", () => {
    const edited = { ...a, keepDays: "30" };
    const r = resyncSchedule(edited, a, edited);
    expect(r.form).toEqual(edited);
    expect(resyncSchedule(r.form, r.base, { ...edited, keepCount: "1" }).form.keepCount).toBe("1");
  });
});

describe("idempotency key", () => {
  it("it is only kept if there was no response from the server", () => {
    expect(keepIdempotencyKey(new TypeError("Failed to fetch"))).toBe(true);
    expect(keepIdempotencyKey(new ApiError(0, "no connection"))).toBe(true);
    expect(keepIdempotencyKey(new ApiError(409, "busy"))).toBe(false);
    expect(keepIdempotencyKey(new ApiError(502, "agent"))).toBe(false);
    expect(keepIdempotencyKey(null)).toBe(false);
  });
});

describe("restore dialog", () => {
  it("talks about the desired state, not about whether the server was running (the agent starts according to the desired state)", () => {
    const t = restoreDialogText("Survival", "2026-10-12T10:00:00Z");
    expect(t).toContain("“Survival”");
    expect(t).toContain(formatBackupDate("2026-10-12T10:00:00Z"));
    expect(t).toContain("data.pre-restore-");
    expect(t).toMatch(/if the server should be running.*it will be started again/);
    expect(t).not.toMatch(/if it was running/);
  });
});

describe("scheduleSummary (templates and wizard, read-only)", () => {
  const b = (over: object) => backupsSchema.parse({ enabled: true, ...over });
  it("without a backups section there is nothing to show", () => {
    expect(scheduleSummary(undefined)).toBeNull();
  });
  it("one line: expression, the preset if it is one, and the retention", () => {
    expect(scheduleSummary(b({}))).toBe("0 4 * * * (every day at 4:00) · at most 10 backups and 7 days");
    expect(scheduleSummary(b({ cron: "30 2 * * 1", keepDays: 0 }))).toBe("30 2 * * 1 · at most 10 backups");
    expect(scheduleSummary(b({ keepCount: 0, keepDays: 30 }))).toBe("0 4 * * * (every day at 4:00) · at most 30 days");
    expect(scheduleSummary(b({ keepCount: 1, keepDays: 1 }))).toBe("0 4 * * * (every day at 4:00) · at most 1 backup and 1 day");
    expect(scheduleSummary(b({ keepCount: 0, keepDays: 0 }))).toBe("0 4 * * * (every day at 4:00) · no retention limit");
  });
  it("disabled", () => {
    expect(scheduleSummary(b({ enabled: false }))).toBe("disabled");
  });
});

describe("templateScheduleNote (“Save as template”)", () => {
  it("warns that the template takes the backup schedule with it", () => {
    expect(templateScheduleNote(backupsSchema.parse({ enabled: true }))).toBe(
      "Includes the backup schedule (0 4 * * * (every day at 4:00) · at most 10 backups and 7 days): servers created from the template inherit it.",
    );
    expect(templateScheduleNote(backupsSchema.parse({}))).toMatch(/^Includes the backup schedule \(disabled\)/);
  });
  it("without a schedule, nothing", () => {
    expect(templateScheduleNote(undefined)).toBeNull();
  });
});

describe("schedule guard", () => {
  it("dirty if any field changes; own notice", () => {
    const base = scheduleToForm(undefined);
    expect(scheduleDirty(base, { ...base })).toBe(false);
    expect(scheduleDirty({ ...base, cron: "0 5 * * *" }, base)).toBe(true);
    expect(scheduleLeaveWarning(false)).toBeNull();
    expect(scheduleLeaveWarning(true)?.title).toBe("Unsaved schedule");
  });
});
