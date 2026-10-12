import { describe, expect, it } from "vitest";
import {
  MIGRATION_PROGRESS, MIGRATION_STEPS, OPEN_PHASES, migrationProposalQuerySchema, migrationRequestSchema, stepMessage, stepOfProgress, stepProgress,
  type MigrationStep,
} from "./migration.js";

describe("migración", () => {
  it("la petición: nodo obligatorio, puerto opcional y válido, «borrar origen» por defecto desactivado", () => {
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

  it("7 pasos con tramos de progreso contiguos de 0 a 100", () => {
    expect(MIGRATION_STEPS).toHaveLength(7);
    expect(MIGRATION_PROGRESS).toHaveLength(7);
    expect(MIGRATION_PROGRESS[0]![0]).toBe(0);
    expect(MIGRATION_PROGRESS[6]![1]).toBe(100);
    for (let i = 1; i < 7; i++) expect(MIGRATION_PROGRESS[i]![0]).toBe(MIGRATION_PROGRESS[i - 1]![1]);
  });

  it("stepProgress se queda dentro del tramo de su paso y stepOfProgress lo recupera", () => {
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
    expect(stepMessage(3, "subiendo")).toBe("Paso 3/7 · Subir la copia al panel: subiendo");
    expect(stepMessage(1)).toBe("Paso 1/7 · Parar el servidor en el origen");
  });
});
