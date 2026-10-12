import { describe, expect, it } from "vitest";
import type { MigrationDto } from "@mcsm/shared";
import type { JobDto, NodeDto } from "./api";
import { jobTypeLabel } from "./jobs";
import {
  activeMigrationJob, confirmText, lastMigrationJob, migrateBlockedReason, migrationBody, migrationFinished, parsePortInput, pendingText, portHint, stepStates, targetOptions,
} from "./migration";

const node = (id: string, name: string, status: "online" | "offline" = "online"): NodeDto => ({
  id, name, dataRoot: "/srv/minecraft", status, agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "",
});
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j", type: "migrate", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "", payload: {},
  createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});
const mig = (over: Partial<MigrationDto>): MigrationDto => ({
  id: "m", serverId: "s1", sourceNodeId: "a", targetNodeId: "b", sourceSlug: "x", targetSlug: "x", targetPort: 25565, targetVersion: 2,
  wasRunning: true, deleteSource: false, phase: "done", sourcePending: false, targetPending: false, error: null, createdAt: "", updatedAt: "", ...over,
});
const names = (id: string) => ({ a: "Casa", b: "Garaje" })[id] ?? "?";

describe("migración en la web", () => {
  it("nodos destino: todos menos el actual; los desconectados, deshabilitados", () => {
    expect(targetOptions([node("a", "Casa"), node("b", "Garaje"), node("c", "Ático", "offline")], "a")).toEqual([
      { id: "b", label: "Garaje", disabled: false },
      { id: "c", label: "Ático (desconectado)", disabled: true },
    ]);
    expect(targetOptions(undefined, "a")).toEqual([]);
  });

  it("job activo y último job de migración", () => {
    const jobs = [job({ id: "x", type: "backup" }), job({ id: "y", status: "ok" }), job({ id: "z", status: "failed" })];
    expect(activeMigrationJob(jobs)).toBeUndefined();
    expect(lastMigrationJob(jobs)?.id).toBe("y");
    expect(activeMigrationJob([job({ id: "w", status: "running" }), ...jobs])?.id).toBe("w");
  });

  it("puerto: vacío = el propuesto; número válido; lo demás no vale", () => {
    expect(parsePortInput("")).toBeUndefined();
    expect(parsePortInput(" 25570 ")).toBe(25570);
    for (const bad of ["0", "70000", "25 565", "1e3", "abc", "-1"]) expect(parsePortInput(bad)).toBeNull();
    expect(migrationBody("b", undefined, false)).toEqual({ targetNodeId: "b", deleteSource: false });
    expect(migrationBody("b", 25570, true)).toEqual({ targetNodeId: "b", port: 25570, deleteSource: true });
  });

  it("pista del puerto", () => {
    expect(portHint(undefined, undefined)).toMatch(/Elige primero/);
    expect(portHint({ targetNodeId: "b", slug: "x", port: 25566, currentPort: 25565, portChanged: true }, undefined)).toMatch(/Propuesto: 25566 \(el 25565 está ocupado/);
    expect(portHint({ targetNodeId: "b", slug: "x", port: 25565, currentPort: 25565, portChanged: false }, undefined)).toMatch(/el mismo que ahora/);
    expect(portHint(undefined, 25570)).toBe("Se usará el puerto 25570.");
    expect(portHint(undefined, null)).toMatch(/entre 1 y 65535/);
  });

  it("motivos para no dejar migrar", () => {
    const ok = { sourceOnline: true, active: undefined, migration: null, target: { id: "b", label: "B", disabled: false }, portInvalid: false, proposalError: null };
    expect(migrateBlockedReason(ok)).toBeNull();
    expect(migrateBlockedReason({ ...ok, active: job({}) })).toMatch(/en curso/);
    expect(migrateBlockedReason({ ...ok, migration: mig({ phase: "rolling_back" }) })).toMatch(/pendientes/);
    expect(migrateBlockedReason({ ...ok, migration: mig({ phase: "failed" }) })).toBeNull();
    expect(migrateBlockedReason({ ...ok, sourceOnline: false })).toMatch(/desconectado/);
    expect(migrateBlockedReason({ ...ok, target: undefined })).toMatch(/Elige/);
    expect(migrateBlockedReason({ ...ok, target: { id: "b", label: "B", disabled: true } })).toMatch(/destino está desconectado/);
    expect(migrateBlockedReason({ ...ok, portInvalid: true })).toMatch(/puerto/);
    expect(migrateBlockedReason({ ...ok, proposalError: "El puerto extra 19132 ya lo usa otro" })).toMatch(/19132/);
  });

  it("estado de los 7 pasos según el job", () => {
    expect(stepStates({ progress: 0, status: "running" })).toEqual(["current", "pending", "pending", "pending", "pending", "pending", "pending"]);
    expect(stepStates({ progress: 40, status: "failed" })).toEqual(["done", "done", "failed", "pending", "pending", "pending", "pending"]);
    expect(stepStates({ progress: 100, status: "ok" })).toEqual(Array(7).fill("done"));
  });

  it("lo pendiente de una migración abierta", () => {
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true, sourcePending: true }), names))
      .toBe("La migración falló y se está deshaciendo: falta borrar la copia a medias en «Garaje» cuando vuelva a conectar; después, volver a arrancar el servidor en «Casa».");
    expect(pendingText(mig({ phase: "rolling_back", sourcePending: true }), names)).toMatch(/volver a arrancar el servidor en «Casa» cuando vuelva a conectar/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true }), names)).toMatch(/Migrado a «Garaje».*retirar el servidor del nodo «Casa».*x\.migrated/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true, deleteSource: true }), names)).toMatch(/borrando sus datos/);
    expect(pendingText(mig({ phase: "done" }), names)).toBeNull();
    expect(pendingText(mig({ phase: "running" }), names)).toBeNull();
  });

  it("texto de confirmación", () => {
    const t = confirmText({ serverName: "Survival", slug: "survival", source: "Casa", target: "Garaje", port: 25566, deleteSource: false, running: true });
    expect(t).toMatch(/se parará en «Casa»/);
    expect(t).toMatch(/puerto 25566/);
    expect(t).toMatch(/seguirá en marcha/);
    expect(t).toMatch(/survival\.migrated/);
    expect(t).toMatch(/se vuelve a arrancar/);
    const del = confirmText({ serverName: "Survival", slug: "survival", source: "Casa", target: "Garaje", port: 25565, deleteSource: true, running: false });
    expect(del).toMatch(/se BORRARÁN/);
    expect(del).toMatch(/se volverá a parar/);
  });

  it("detecta el final de la migración en curso", () => {
    expect(migrationFinished(null, [job({ status: "ok" })])).toBe(false);
    expect(migrationFinished("j", [job({ status: "running" })])).toBe(false);
    expect(migrationFinished("j", [job({ status: "ok" })])).toBe(true);
    expect(migrationFinished("j", [])).toBe(true);
    expect(migrationFinished("j", undefined)).toBe(false);
  });

  it("etiquetas de los jobs", () => {
    expect(jobTypeLabel("migrate")).toBe("Migración");
    expect(jobTypeLabel("migrate_in")).toBe("Recepción de migración");
  });
});
