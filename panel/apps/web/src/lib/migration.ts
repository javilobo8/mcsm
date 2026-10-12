import { MIGRATION_STEPS, OPEN_PHASES, stepOfProgress, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput } from "@mcsm/shared";
import type { JobDto, NodeDto } from "./api";
import { isActive } from "./jobs";

export const migrationKey = (serverId: string) => ["migration", serverId] as const;
export const proposalKey = (serverId: string, targetNodeId: string) => ["migration-proposal", serverId, targetNodeId] as const;

export interface TargetOption { id: string; label: string; disabled: boolean }

/** Nodos a los que se puede migrar: todos menos el actual; los desconectados aparecen deshabilitados. */
export function targetOptions(nodes: NodeDto[] | undefined, currentNodeId: string): TargetOption[] {
  return (nodes ?? []).filter((n) => n.id !== currentNodeId).map((n) => ({
    id: n.id, label: n.status === "online" ? n.name : `${n.name} (desconectado)`, disabled: n.status !== "online",
  }));
}

/** Job de migración en curso del servidor (la lista viene de los más nuevos a los más antiguos). */
export const activeMigrationJob = (jobs: JobDto[] | undefined): JobDto | undefined => jobs?.find((j) => j.type === "migrate" && isActive(j));
/** Último job de migración del servidor, terminado o no. */
export const lastMigrationJob = (jobs: JobDto[] | undefined): JobDto | undefined => jobs?.find((j) => j.type === "migrate");

/** "" = el puerto que propone el panel; un número 1-65535; null si no es un puerto. */
export function parsePortInput(s: string): number | undefined | null {
  const t = s.trim();
  if (t === "") return undefined;
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

export function migrationBody(targetNodeId: string, port: number | undefined, deleteSource: boolean): MigrationRequestInput {
  return port === undefined ? { targetNodeId, deleteSource } : { targetNodeId, port, deleteSource };
}

/** Texto bajo el campo del puerto. */
export function portHint(p: MigrationProposalDto | undefined, typed: number | undefined | null): string {
  if (typed === null) return "Escribe un puerto entre 1 y 65535, o déjalo vacío para usar el propuesto.";
  if (typed !== undefined) return `Se usará el puerto ${typed}.`;
  if (!p) return "Elige primero el nodo destino.";
  return p.portChanged
    ? `Propuesto: ${p.port} (el ${p.currentPort} está ocupado en el destino). Escribe otro para cambiarlo.`
    : `Propuesto: ${p.port}, el mismo que ahora. Escribe otro para cambiarlo.`;
}

/** Por qué no se puede migrar ahora (null = se puede). */
export function migrateBlockedReason(o: {
  sourceOnline: boolean | undefined; active: JobDto | undefined; migration: MigrationDto | null | undefined;
  target: TargetOption | undefined; portInvalid: boolean; proposalError: string | null;
}): string | null {
  if (o.active) return "Ya hay una migración en curso";
  if (o.migration && OPEN_PHASES.has(o.migration.phase)) return "La migración anterior aún tiene pasos pendientes";
  if (o.sourceOnline === false) return "El nodo actual está desconectado";
  if (!o.target) return "Elige el nodo destino";
  if (o.target.disabled) return "El nodo destino está desconectado";
  if (o.portInvalid) return "El puerto debe ser un número entre 1 y 65535";
  if (o.proposalError) return o.proposalError;
  return null;
}

export type StepState = "done" | "current" | "failed" | "pending";

/** Estado de cada uno de los 7 pasos según el job: el paso en curso sale de su progreso. */
export function stepStates(job: Pick<JobDto, "progress" | "status">): StepState[] {
  const cur = job.status === "ok" ? MIGRATION_STEPS.length + 1 : stepOfProgress(job.progress);
  const failed = job.status === "failed" || job.status === "cancelled";
  return MIGRATION_STEPS.map((_, i) => {
    const n = i + 1;
    if (n < cur) return "done";
    if (n === cur) return failed ? "failed" : "current";
    return "pending";
  });
}

/** Lo que queda pendiente de una migración abierta, o null si no hay nada que contar. */
export function pendingText(m: MigrationDto, nodeName: (id: string) => string): string | null {
  const src = nodeName(m.sourceNodeId);
  const dst = nodeName(m.targetNodeId);
  if (m.phase === "rolling_back") {
    const parts: string[] = [];
    if (m.targetPending) parts.push(`borrar la copia a medias en «${dst}» cuando vuelva a conectar`);
    if (m.sourcePending) parts.push(m.targetPending ? `después, volver a arrancar el servidor en «${src}»` : `volver a arrancar el servidor en «${src}» cuando vuelva a conectar`);
    return `La migración falló y se está deshaciendo: falta ${parts.join("; ")}.`;
  }
  if (m.phase === "committed") {
    return `Migrado a «${dst}». Falta retirar el servidor del nodo «${src}» (${m.deleteSource ? "borrando sus datos" : `sus datos quedarán en ${m.sourceSlug}.migrated-…`}) cuando vuelva a conectar.`;
  }
  return null;
}

/** Texto del diálogo de confirmación. */
export function confirmText(o: { serverName: string; slug: string; source: string; target: string; port: number; deleteSource: boolean; running: boolean }): string {
  return [
    o.running ? `«${o.serverName}» se parará en «${o.source}» durante la migración.` : `«${o.serverName}» está parado en «${o.source}».`,
    "Se hará una copia de seguridad previa, se enviará al destino (comprobando su sha256) y se restaurará allí.",
    `En «${o.target}» usará el puerto ${o.port} y se arrancará para comprobar que funciona${o.running ? "; después seguirá en marcha" : "; después se volverá a parar"}.`,
    o.deleteSource
      ? `Al terminar se BORRARÁN sus datos y sus copias en «${o.source}».`
      : `Al terminar, sus datos y copias en «${o.source}» se conservarán en ${o.slug}.migrated-… (bórralos a mano cuando ya no los necesites).`,
    `Si algo falla, el servidor sigue en «${o.source}» con su mundo intacto${o.running ? " y se vuelve a arrancar" : ""}.`,
  ].join(" ");
}

/** ¿Acaba de terminar la migración que estaba en curso (`prevActiveId`)? Sirve para refrescar el servidor. */
export function migrationFinished(prevActiveId: string | null, jobs: JobDto[] | undefined): boolean {
  if (!prevActiveId || !jobs) return false;
  const j = jobs.find((x) => x.id === prevActiveId);
  return !j || !isActive(j);
}
