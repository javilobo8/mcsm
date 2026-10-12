import { MIGRATION_STEPS, OPEN_PHASES, migrationLeftovers, stepOfProgress, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput } from "@mcsm/shared";
import { apiPath, type JobDto, type NodeDto } from "./api";
import { isActive } from "./jobs";

export const migrationKey = (serverId: string) => ["migration", serverId] as const;
export const proposalKey = (serverId: string, targetNodeId: string, port?: number) => ["migration-proposal", serverId, targetNodeId, port ?? null] as const;

/** Ruta de la propuesta: con el puerto escrito, el panel comprueba ese y no propone otro (m8). */
export function proposalPath(serverId: string, targetNodeId: string, port: number | undefined): string {
  const q = new URLSearchParams({ targetNodeId });
  if (port !== undefined) q.set("port", String(port));
  return `${apiPath`/api/servers/${serverId}/migration/proposal`}?${q}`;
}

/** El formulario tiene algo que perder al cambiar de pestaña (m9): un destino, un puerto o «borrar origen» elegidos. */
export const migrateFormDirty = (targetId: string, portText: string, deleteSource: boolean): boolean =>
  targetId !== "" || portText.trim() !== "" || deleteSource;

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

/** «: motivo» del último fallo de un pendiente (pending_error lleva el nombre del pendiente delante), o "". */
function reason(m: MigrationDto, label: string): string {
  const prefix = `${label}: `;
  return m.pendingError?.startsWith(prefix) ? `: ${m.pendingError.slice(prefix.length)}` : "";
}

/**
 * Lo que queda pendiente de una migración, o null si no hay nada que contar. `online` dice si un nodo está conectado
 * (undefined = no se sabe): con el nodo conectado no se dice «cuando vuelva a conectar», sino que se reintenta y por qué.
 */
export function pendingText(m: MigrationDto, nodeName: (id: string) => string, online: (id: string) => boolean | undefined = () => undefined): string | null {
  const src = nodeName(m.sourceNodeId);
  const dst = nodeName(m.targetNodeId);
  const when = (nodeId: string, label: string) => online(nodeId) === false ? " cuando vuelva a conectar" : ` (se reintenta cada 30 s${reason(m, label)})`;
  if (m.phase === "rolling_back") {
    const parts: string[] = [];
    if (m.targetPending) parts.push(`borrar la copia a medias en «${dst}»${when(m.targetNodeId, "Limpiar el destino")}`);
    if (m.sourcePending) {
      parts.push(m.targetPending && m.targetStarted
        ? `después, volver a arrancar el servidor en «${src}»`
        : `volver a arrancar el servidor en «${src}»${when(m.sourceNodeId, "Volver a arrancar el origen")}`);
    }
    const usable = !m.sourcePending && !(m.targetPending && m.targetStarted) ? ` El servidor ya se puede usar en «${src}».` : "";
    return `La migración falló y se está deshaciendo: falta ${parts.join("; ")}.${usable}`;
  }
  if (m.phase === "committed") {
    const parts: string[] = [];
    if (m.sourcePending) {
      parts.push(`retirar el servidor del nodo «${src}» (${m.deleteSource ? "borrando sus datos" : `sus datos quedarán en ${m.sourceSlug}.migrated-…`})${when(m.sourceNodeId, "Retirar el origen")}`);
    }
    if (m.targetConfirmPending) parts.push(`confirmar la migración en «${dst}»${when(m.targetNodeId, "Confirmar en el destino")}`);
    return `Migrado a «${dst}». Falta ${parts.join("; ")}.`;
  }
  if (m.pendingError && (m.phase === "done" || m.phase === "failed")) return `Queda algo por resolver a mano: ${m.pendingError}`;
  return null;
}

/** Se puede cerrar a mano: abierta, sin pasos en curso (solo queda lo pendiente) y sin su job activo. */
export function canCloseMigration(m: MigrationDto | null | undefined, active: JobDto | undefined): boolean {
  return !!m && (m.phase === "rolling_back" || m.phase === "committed") && !active;
}

/** Texto del diálogo que confirma cerrar a mano una migración atascada. */
export function closeMigrationText(m: MigrationDto, nodeName: (id: string) => string): string {
  const left = migrationLeftovers(m, nodeName);
  return [
    "El panel dejará de reintentar lo que falta de esta migración y no enviará nada a los nodos.",
    left.length ? `Quedará sin hacer: ${left.join("; ")}.` : "No queda nada pendiente.",
    "Hazlo solo si un nodo no va a volver o si ya lo has resuelto a mano.",
  ].join(" ");
}

/** Texto del diálogo de confirmación. `imported`: aviso de un servidor importado (`serverImportView(s).retire`), al final. */
export function confirmText(o: {
  serverName: string; slug: string; source: string; target: string; port: number; deleteSource: boolean; running: boolean; imported?: string | null;
}): string {
  return [
    o.running ? `«${o.serverName}» se parará en «${o.source}» durante la migración.` : `«${o.serverName}» está parado en «${o.source}».`,
    "Se hará una copia de seguridad previa, se enviará al destino (comprobando su sha256) y se restaurará allí.",
    `En «${o.target}» usará el puerto ${o.port} y se arrancará para comprobar que funciona${o.running ? "; después seguirá en marcha" : "; después se volverá a parar"}.`,
    o.deleteSource
      ? `Al terminar se BORRARÁN sus datos y sus copias en «${o.source}».`
      : `Al terminar, sus datos y copias en «${o.source}» se conservarán en ${o.slug}.migrated-… (bórralos a mano cuando ya no los necesites).`,
    `Si algo falla, el servidor sigue en «${o.source}» con su mundo intacto${o.running ? " y se vuelve a arrancar" : ""}.`,
    ...(o.imported ? [o.imported] : []),
  ].join(" ");
}

/** ¿Acaba de terminar la migración que estaba en curso (`prevActiveId`)? Sirve para refrescar el servidor. */
export function migrationFinished(prevActiveId: string | null, jobs: JobDto[] | undefined): boolean {
  if (!prevActiveId || !jobs) return false;
  const j = jobs.find((x) => x.id === prevActiveId);
  return !j || !isActive(j);
}

/** Migración en curso que se sigue para refrescar el servidor: su job y el paso en el que va. */
export interface MigrationSyncState { id: string; step: number }

/**
 * Cuándo refrescar el servidor (puede haber cambiado de nodo): al entrar la migración en curso en el paso 7 (el panel
 * confirma el cambio de nodo justo al empezarlo, en el mismo turno: la recarga ya lo ve) y al terminar (m6). Sin lista
 * (cargando) no cambia nada.
 */
export function migrationSync(prev: MigrationSyncState | null, jobs: JobDto[] | undefined): { refresh: boolean; next: MigrationSyncState | null } {
  if (!jobs) return { refresh: false, next: prev };
  const active = activeMigrationJob(jobs);
  const next = active ? { id: active.id, step: stepOfProgress(active.progress) } : null;
  if (prev && prev.id !== next?.id) return { refresh: migrationFinished(prev.id, jobs), next };
  const entered7 = !!prev && !!next && prev.step < 7 && next.step === 7;
  return { refresh: entered7, next };
}
