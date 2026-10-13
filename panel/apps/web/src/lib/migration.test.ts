import { describe, expect, it } from "vitest";
import type { MigrationDto } from "@mcsm/shared";
import type { JobDto, NodeDto } from "./api";
import { jobTypeLabel } from "./jobs";
import {
  activeMigrationJob, canCloseMigration, closeMigrationText, confirmText, lastMigrationJob, migrateBlockedReason, migrateFormDirty, migrationBody, migrationFinished,
  migrationSync, parsePortInput, pendingText, portHint, proposalPath, routerDnsNote, stepStates, targetOptions,
} from "./migration";

const node = (id: string, name: string, status: "online" | "offline" = "online"): NodeDto => ({
  id, name, dataRoot: "/srv/minecraft", status, agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "", tokenRotationPending: false,
});
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j", type: "migrate", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "", payload: {},
  createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});
const mig = (over: Partial<MigrationDto>): MigrationDto => ({
  id: "m", serverId: "s1", sourceNodeId: "a", targetNodeId: "b", sourceSlug: "x", targetSlug: "x", targetPort: 25565, targetVersion: 2,
  wasRunning: true, deleteSource: false, phase: "done", sourcePending: false, targetPending: false, targetStarted: false, targetConfirmPending: false,
  error: null, pendingError: null, createdAt: "", updatedAt: "", ...over,
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

  it("lo pendiente de una migración abierta, según si los nodos están conectados", () => {
    const off = () => false;
    const on = () => true;
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true, sourcePending: true, targetStarted: true }), names, off))
      .toBe("La migración falló y se está deshaciendo: falta borrar la copia a medias en «Garaje» cuando vuelva a conectar; después, volver a arrancar el servidor en «Casa».");
    expect(pendingText(mig({ phase: "rolling_back", sourcePending: true }), names, off)).toMatch(/volver a arrancar el servidor en «Casa» cuando vuelva a conectar/);
    // Conectado: no «cuando vuelva a conectar», sino el motivo y que se reintenta.
    const online = pendingText(mig({ phase: "rolling_back", sourcePending: true, pendingError: "Volver a arrancar el origen: ocupado" }), names, on)!;
    expect(online).toMatch(/se reintenta cada 30 s.*ocupado/);
    expect(online).not.toMatch(/vuelva a conectar/);
    // I2: solo falta limpiar un destino que nunca arrancó: el servidor ya se usa en el origen.
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true }), names, off)).toMatch(/ya se puede usar en «Casa»/);
    expect(pendingText(mig({ phase: "rolling_back", targetPending: true, targetStarted: true }), names, off)).not.toMatch(/ya se puede usar/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true }), names, off)).toMatch(/Migrado a «Garaje».*retirar el servidor del nodo «Casa».*x\.migrated.*cuando vuelva a conectar/);
    expect(pendingText(mig({ phase: "committed", sourcePending: true, deleteSource: true }), names, off)).toMatch(/borrando sus datos/);
    expect(pendingText(mig({ phase: "committed", targetConfirmPending: true }), names, on)).toMatch(/confirmar la migración en «Garaje».*se reintenta/);
    expect(pendingText(mig({ phase: "done" }), names, on)).toBeNull();
    expect(pendingText(mig({ phase: "running" }), names, on)).toBeNull();
    // Cerrada o con un rechazo definitivo: queda anotado lo que hay que resolver a mano.
    expect(pendingText(mig({ phase: "done", pendingError: "Retirar el origen: versión 3; no se reintenta: revisa x" }), names, on)).toMatch(/resolver a mano.*versión 3/);
    expect(pendingText(mig({ phase: "failed", pendingError: "Cerrada a mano: algo" }), names, on)).toMatch(/Cerrada a mano/);
  });

  it("cierre manual: solo de una migración abierta sin pasos en curso; el texto dice lo que queda sin hacer", () => {
    expect(canCloseMigration(mig({ phase: "rolling_back", targetPending: true }), undefined)).toBe(true);
    expect(canCloseMigration(mig({ phase: "committed", sourcePending: true }), undefined)).toBe(true);
    expect(canCloseMigration(mig({ phase: "committed", sourcePending: true }), job({}))).toBe(false);
    expect(canCloseMigration(mig({ phase: "running" }), undefined)).toBe(false);
    expect(canCloseMigration(mig({ phase: "done" }), undefined)).toBe(false);
    expect(canCloseMigration(null, undefined)).toBe(false);
    const t = closeMigrationText(mig({ phase: "rolling_back", targetPending: true, sourcePending: true }), names);
    expect(t).toMatch(/dejará de reintentar/);
    expect(t).toMatch(/“Garaje”/);
    expect(t).toMatch(/is not started again on “Casa”/);
  });

  it("la propuesta lleva el puerto escrito (m8)", () => {
    expect(proposalPath("s/1", "b", undefined)).toBe("/api/servers/s%2F1/migration/proposal?targetNodeId=b");
    expect(proposalPath("s1", "b", 25570)).toBe("/api/servers/s1/migration/proposal?targetNodeId=b&port=25570");
  });

  it("el formulario solo tiene algo que perder si se eligió algo (m9)", () => {
    expect(migrateFormDirty("", "", false)).toBe(false);
    expect(migrateFormDirty("b", "", false)).toBe(true);
    expect(migrateFormDirty("", "25570", false)).toBe(true);
    expect(migrateFormDirty("", "", true)).toBe(true);
  });

  it("refresca el servidor al entrar en el paso 7 (commit) y al terminar (m6)", () => {
    const at = (progress: number, status: JobDto["status"] = "running") => [job({ id: "j", progress, status })];
    let st = migrationSync(null, at(40));
    expect(st).toEqual({ refresh: false, next: { id: "j", step: 3 } });
    st = migrationSync(st.next, at(83));
    expect(st.refresh).toBe(false);
    st = migrationSync(st.next, at(95));
    expect(st).toEqual({ refresh: true, next: { id: "j", step: 7 } });
    st = migrationSync(st.next, at(97));
    expect(st.refresh).toBe(false); // ya refrescado al entrar en el paso
    st = migrationSync(st.next, at(100, "ok"));
    expect(st).toEqual({ refresh: true, next: null });
    expect(migrationSync({ id: "j", step: 3 }, undefined)).toEqual({ refresh: false, next: { id: "j", step: 3 } }); // cargando
    expect(migrationSync(null, at(95)).refresh).toBe(false); // al abrir la página ya en el paso 7: lo trae la carga normal
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

  it("texto de confirmación de un importado: añade el aviso de qué contenedor se elimina en el origen (Planes 6 y 7)", () => {
    const base = { serverName: "Survival", slug: "survival", source: "Casa", target: "Garaje", port: 25565, deleteSource: false, running: true };
    expect(confirmText({ ...base, imported: null })).toBe(confirmText(base));
    const t = confirmText({ ...base, imported: "AVISO DEL IMPORTADO" });
    expect(t.startsWith(confirmText(base))).toBe(true);
    expect(t).toMatch(/AVISO DEL IMPORTADO$/);
  });

  it("plan-8: un servidor con hostname avisa de que el DNS tiene que apuntar al nodo destino", () => {
    expect(routerDnsNote(undefined, "Casa", "Garaje")).toBeNull();
    expect(routerDnsNote({ enabled: false, hostname: "survival.lan" }, "Casa", "Garaje")).toBeNull();
    expect(routerDnsNote({ enabled: true, hostname: "survival.lan" }, "Casa", "Garaje")).toBe(
      "Tras migrar, el hostname «survival.lan» tiene que resolver a la IP de «Garaje» (y su router tiene que estar activo): " +
      "si no, los jugadores seguirán llegando al router de «Casa», que ya no tendrá este servidor.");
    expect(routerDnsNote({ enabled: true, hostname: "survival.lan" }, "Casa", undefined)).toMatch(/a la IP del nodo destino \(y su router/);
    const base = { serverName: "Survival", slug: "survival", source: "Casa", target: "Garaje", port: 25565, deleteSource: false, running: true };
    expect(confirmText({ ...base, dns: null })).toBe(confirmText(base));
    expect(confirmText({ ...base, imported: "IMPORTADO", dns: "DNS" })).toMatch(/IMPORTADO DNS$/);
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
