import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { BackupTriggerName, JobDetailDto, JobDto, JobState, ServerMessage } from "./api";
import { mergeIntoCached } from "./live";

export interface JobsFilter { serverId?: string; status?: JobState | JobState[] }
/** `status` normalizado: estados en orden canónico separados por comas (`queued,running`). */
type NormalizedFilter = { serverId: string | null; status: string | null };
type JobMsg = Extract<ServerMessage, { type: "job" }>;
type BackupsMsg = Extract<ServerMessage, { type: "backups" }>;

export const JOB_STATUS_LABEL: Record<JobState, string> = {
  queued: "En cola", running: "En curso", ok: "Correcto", failed: "Fallido", cancelled: "Cancelado",
};
export const TRIGGER_LABEL: Record<BackupTriggerName, string> = {
  manual: "Manual", scheduled: "Programada", pre_migration: "Antes de migrar", pre_restore: "Antes de restaurar",
};
const JOB_TYPE_LABEL: Record<string, string> = {
  backup: "Copia de seguridad", restore: "Restauración", migrate: "Migración", migrate_in: "Recepción de migración",
};
const MAX_LIST = 200;

export const jobTypeLabel = (type: string): string => JOB_TYPE_LABEL[type] ?? type;
export const isActive = (j: Pick<JobDto, "status">): boolean => j.status === "queued" || j.status === "running";

/** Etiqueta del origen de una copia guardado en el payload del job (`trigger`), o null. */
export function jobTriggerLabel(j: Pick<JobDto, "payload">): string | null {
  const t = j.payload?.trigger;
  return typeof t === "string" && t in TRIGGER_LABEL ? TRIGGER_LABEL[t as BackupTriggerName] : null;
}

const STATE_ORDER: JobState[] = ["queued", "running", "ok", "failed", "cancelled"];
/** Lista de estados en orden canónico y sin repetidos, o null si no hay filtro. */
export function normalizeStatus(s: JobState | JobState[] | undefined): string | null {
  const list = s === undefined ? [] : Array.isArray(s) ? s : [s];
  const sorted = STATE_ORDER.filter((x) => list.includes(x));
  return sorted.length ? sorted.join(",") : null;
}
export const jobsKey = (f: JobsFilter = {}): QueryKey => ["jobs", { serverId: f.serverId ?? null, status: normalizeStatus(f.status) }];
export const jobKey = (id: string): QueryKey => ["job", id];
export const backupsKey = (serverId: string): QueryKey => ["backups", serverId];

const matches = (j: JobDto, f: NormalizedFilter) => (!f.serverId || j.serverId === f.serverId) && (!f.status || f.status.split(",").includes(j.status));

/** Un evento no debe pisar un estado terminal ni uno más reciente que ya tenemos (como hace el panel). */
const supersedes = (old: Pick<JobDto, "status" | "updatedAt">, next: Pick<JobDto, "updatedAt">) =>
  isActive(old) && old.updatedAt <= next.updatedAt;

/** Inserta o actualiza un job en una lista (más nuevos primero) respetando su filtro. */
export function upsertJob(list: JobDto[], job: JobDto, f: NormalizedFilter): JobDto[] {
  const existing = list.find((j) => j.id === job.id);
  if (existing && !supersedes(existing, job)) return list;
  const rest = list.filter((j) => j.id !== job.id);
  if (!matches(job, f)) return rest.length === list.length ? list : rest;
  return [...rest, job].sort(byCreatedDesc).slice(0, MAX_LIST);
}

const byCreatedDesc = (a: JobDto, b: JobDto) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** Fila desplegada de una lista de jobs y el filtro (clave de `jobsKey`) con el que se abrió. */
export interface OpenRow { id: string; filterKey: string }

/** Id de la fila abierta con el filtro actual: al cambiar el filtro (o de servidor) se pliega. */
export function openRowId(open: OpenRow | null, filterKey: string): string | null {
  return open && open.filterKey === filterKey ? open.id : null;
}

/**
 * Filas que muestra la lista: las del filtro y, si la fila abierta ya no está (su job terminó con el filtro
 * «En curso»), esa fila con su último estado conocido (`openJob`, el detalle) en su sitio por fecha, hasta que se
 * pliegue o cambie el filtro.
 */
export function withOpenRow(list: JobDto[], openId: string | null, openJob: JobDto | undefined): JobDto[] {
  if (!openId || !openJob || openJob.id !== openId || list.some((j) => j.id === openId)) return list;
  return [...list, openJob].sort(byCreatedDesc);
}

/** Mismo tope y marca que `capLog` del panel (jobs/service.ts). */
export const MAX_JOB_LOG = 256 * 1024;
export function capLog(log: string): string {
  if (log.length <= MAX_JOB_LOG) return log;
  const mark = "…(recortado)\n";
  return mark + log.slice(log.length - MAX_JOB_LOG + mark.length);
}

export function applyJobEvent(qc: QueryClient, msg: JobMsg): void {
  for (const [key, data] of qc.getQueriesData<JobDto[]>({ queryKey: ["jobs"] })) {
    if (!data) continue;
    const f = (key[1] ?? {}) as Partial<NormalizedFilter>;
    const filter = { serverId: f.serverId ?? null, status: f.status ?? null };
    if (upsertJob(data, msg.job, filter) === data) continue; // no le afecta: no cancelar su refetch
    mergeIntoCached<JobDto[]>(qc, key, (old) => upsertJob(old, msg.job, filter));
  }
  const detail = qc.getQueryData<JobDetailDto>(jobKey(msg.job.id));
  if (detail && supersedes(detail, msg.job)) {
    mergeIntoCached<JobDetailDto>(qc, jobKey(msg.job.id), (old) =>
      supersedes(old, msg.job)
        ? { ...old, ...msg.job, log: capLog(msg.log !== undefined ? msg.log : old.log + msg.logChunk) }
        : old);
  }
  if (!isActive(msg.job)) {
    void qc.invalidateQueries({ queryKey: jobKey(msg.job.id) }); // log final completo
    if (msg.job.serverId) void qc.invalidateQueries({ queryKey: backupsKey(msg.job.serverId) });
  }
}

export function applyBackupsEvent(qc: QueryClient, msg: BackupsMsg): void {
  void qc.invalidateQueries({ queryKey: backupsKey(msg.serverId) });
}

/** Subconjunto de `Realtime` que se usa aquí (facilita los tests). */
export interface JobsLiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

/** Conecta la caché con el topic `jobs`. Devuelve la función de limpieza. */
export function bindJobsLive(qc: QueryClient, live: JobsLiveSource): () => void {
  const offs = [
    live.subscribe("jobs", (m) => {
      if (m.type === "job") applyJobEvent(qc, m);
      else if (m.type === "backups") applyBackupsEvent(qc, m);
    }),
    // Durante la desconexión se pierden avisos: recargamos.
    live.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["job"] });
      void qc.invalidateQueries({ queryKey: ["backups"] });
    }),
  ];
  return () => offs.forEach((off) => off());
}

const bindings = new WeakMap<QueryClient, { count: number; off: () => void }>();

/** Como bindJobsLive pero con recuento: varias vistas montadas comparten una sola suscripción
 * (si no, cada trozo de log se añadiría varias veces al detalle). */
export function retainJobsLive(qc: QueryClient, live: JobsLiveSource): () => void {
  let b = bindings.get(qc);
  if (!b) {
    b = { count: 0, off: bindJobsLive(qc, live) };
    bindings.set(qc, b);
  }
  b.count++;
  const binding = b;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    binding.count--;
    if (binding.count === 0) {
      binding.off();
      bindings.delete(qc);
    }
  };
}

/** Opciones del filtro de la página Jobs (`status: null` = Todos). "En curso" incluye los que esperan en cola. */
export const JOB_FILTER_OPTIONS: { label: string; status: JobState[] | null }[] = [
  { label: "Todos", status: null }, { label: "En curso", status: ["queued", "running"] }, { label: "Correctos", status: ["ok"] }, { label: "Fallidos", status: ["failed"] },
];
export const jobsFilterFor = (status: JobState[] | null): JobsFilter => (status ? { status } : {});

/** Nombre del servidor de un job. Sin lista (cargando o con error) no se afirma que esté borrado. */
export function jobServerName(serverId: string, servers: { id: string; name: string }[] | undefined): string {
  if (!servers) return "…";
  return servers.find((s) => s.id === serverId)?.name ?? "(borrado)";
}

/** Hora de fin de un job, o null si no ha terminado o la fecha no es válida. */
export function formatFinishTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("es-ES");
}
