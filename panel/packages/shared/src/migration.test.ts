import { describe, expect, it } from "vitest";
import {
  MIGRATION_PROGRESS, MIGRATION_STEPS, OPEN_PHASES, migrationLeftovers, migrationProposalQuerySchema, migrationRequestSchema, stepMessage, stepOfProgress, stepProgress,
  type MigrationStep,
} from "./migration.js";

describe("migration", () => {
  it("the request: node required, port optional and valid, “delete source” disabled by default", () => {
    expect(migrationRequestSchema.parse({ targetNodeId: "n" })).toEqual({ targetNodeId: "n", deleteSource: false });
    expect(migrationRequestSchema.parse({ targetNodeId: "n", port: 25570, deleteSource: true })).toEqual({ targetNodeId: "n", port: 25570, deleteSource: true });
    expect(migrationRequestSchema.safeParse({ targetNodeId: "" }).success).toBe(false);
    expect(migrationRequestSchema.safeParse({ targetNodeId: "n", port: 70000 }).success).toBe(false);
    expect(migrationRequestSchema.safeParse({ targetNodeId: "n", port: 25565.5 }).success).toBe(false);
    expect(migrationProposalQuerySchema.parse({ targetNodeId: "n", port: "25570" }).port).toBe(25570);
    expect(migrationProposalQuerySchema.parse({ targetNodeId: "n" }).port).toBeUndefined();
  });

  it("fases abiertas", () => {
    expect([...OPEN_PHASES].sort()).toEqual(["committed", "rolling_back", "running"]);
  });

  it("7 steps with contiguous progress ranges from 0 to 100", () => {
    expect(MIGRATION_STEPS).toHaveLength(7);
    expect(MIGRATION_PROGRESS).toHaveLength(7);
    expect(MIGRATION_PROGRESS[0]![0]).toBe(0);
    expect(MIGRATION_PROGRESS[6]![1]).toBe(100);
    for (let i = 1; i < 7; i++) expect(MIGRATION_PROGRESS[i]![0]).toBe(MIGRATION_PROGRESS[i - 1]![1]);
  });

  it("stepProgress stays within its step's range and stepOfProgress recovers it", () => {
    for (let s = 1; s <= 7; s++) {
      const step = s as MigrationStep;
      for (const f of [0, 0.5, 0.99, 1, 7, -3, Number.NaN]) expect(stepOfProgress(stepProgress(step, f))).toBe(step);
    }
    expect(stepProgress(3, 0.5)).toBe(40);
    expect(stepProgress(2)).toBe(5);
    expect(stepProgress(2, 1)).toBe(29);
    expect(stepOfProgress(100)).toBe(7);
    expect(stepOfProgress(0)).toBe(1);
  });

  it("stepMessage", () => {
    expect(stepMessage(3, "uploading")).toBe("Step 3/7 · Upload the backup to the panel: uploading");
    expect(stepMessage(1)).toBe("Step 1/7 · Stop the server on the source");
  });

  it("migrationLeftovers: what is left undone when closing by hand", () => {
    const names = (id: string) => ({ a: "Casa", b: "Garaje" })[id] ?? "?";
    const base = { sourceNodeId: "a", targetNodeId: "b", sourceSlug: "uno", targetSlug: "uno-2", sourcePending: false, targetPending: false, targetConfirmPending: false };
    expect(migrationLeftovers({ ...base, phase: "rolling_back", targetPending: true, sourcePending: true }, names)).toEqual([
      expect.stringMatching(/“Garaje”.*uno-2/),
      expect.stringMatching(/is not started again on “Casa”/),
    ]);
    expect(migrationLeftovers({ ...base, phase: "committed", sourcePending: true, targetConfirmPending: true }, names)).toEqual([
      expect.stringMatching(/is not removed from “Casa”.*uno is still/),
      expect.stringMatching(/is not confirmed on “Garaje”/),
    ]);
    expect(migrationLeftovers({ ...base, phase: "done" }, names)).toEqual([]);
  });
});
