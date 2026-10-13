import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupsSchema, cronError, DEFAULT_BACKUP_EXCLUDES } from "./backups.js";
import { specSchema } from "./spec.js";

const cases = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/cron-cases.json", import.meta.url), "utf8")) as { valid: string[]; invalid: string[] };
const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("cronError (same criterion as the agent)", () => {
  it.each(cases.valid)("accepts %j", (e) => expect(cronError(e)).toBeNull());
  it.each(cases.invalid)("rejects %j", (e) => expect(cronError(e)).not.toBeNull());
  it("explains the field in English", () => {
    expect(cronError("0 4 * * MON")).toBe('Field "Day of week" is not valid: MON');
    expect(cronError("0 25 * * *")).toBe("Hour out of range (0-23)");
  });
});

describe("backupsSchema", () => {
  it("fills in the default values", () => {
    expect(backupsSchema.parse({})).toEqual({
      enabled: false, cron: "0 4 * * *", keepDays: 7, keepCount: 10, excludes: [...DEFAULT_BACKUP_EXCLUDES], onlyIfPlayersSince: true,
    });
  });
  it("requires a valid cron if enabled", () => {
    const r = backupsSchema.safeParse({ enabled: true, cron: "every day" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["cron"]);
  });
  it("allows an empty cron if disabled", () => {
    expect(backupsSchema.safeParse({ enabled: false, cron: "" }).success).toBe(true);
  });
  it.each(["/etc", "../world", "[abc]", "", "a\\b"])("rejects the exclusion %j", (p) => {
    expect(backupsSchema.safeParse({ excludes: [p] }).success).toBe(false);
  });
  it("accepts exclusions with a path and wildcards", () => {
    expect(backupsSchema.parse({ excludes: ["world/session.lock", "*.jar"] }).excludes).toEqual(["world/session.lock", "*.jar"]);
  });
  it("limits the retention", () => {
    expect(backupsSchema.safeParse({ keepDays: -1 }).success).toBe(false);
    expect(backupsSchema.safeParse({ keepCount: 1001 }).success).toBe(false);
    expect(backupsSchema.safeParse({ keepCount: 1.5 }).success).toBe(false);
  });
});

describe("spec with backups", () => {
  it("the section is optional: the fixture without backups does not change", () => {
    expect(specSchema.parse(fixture)).toEqual({ ...fixture, build: "" });
  });
  it("validates the section if present and fills in its default values", () => {
    expect(specSchema.safeParse({ ...fixture, backups: { enabled: true, cron: "0 4 * * MON" } }).success).toBe(false);
    const ok = specSchema.parse({ ...fixture, backups: { enabled: true, cron: "*/30 * * * *" } });
    expect(ok.backups).toMatchObject({ enabled: true, cron: "*/30 * * * *", keepCount: 10 });
  });
});
