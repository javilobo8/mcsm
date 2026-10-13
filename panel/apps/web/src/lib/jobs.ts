import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { BackupTriggerName, JobDetailDto, JobDto, JobState, ServerMessage } from "./api";
import { mergeIntoCached } from "./live";

export interface JobsFilter { serverId?: string; status?: JobState | JobState[] }
/** Normalized `status`: statuses in canonical order separated by commas (`queued,running`). */
type NormalizedFilter = { serverId: string | null; status: string | null };
type JobMsg = Extract<ServerMessage, { type: "job" }>;
type BackupsMsg = Extract<ServerMessage, { type: "backups" }>;

export const JOB_STATUS_LABEL: Record<JobState, string> = {
  queued: "Queued", running: "Running", ok: "Successful", failed: "Failed", cancelled: "Cancelled",
};
export const TRIGGER_LABEL: Record<BackupTriggerName, string> = {
  manual: "Manual", scheduled: "Scheduled", pre_migration: "Before migrating", pre_restore: "Before restoring",
};
const JOB_TYPE_LABEL: Record<string, string> = {
  backup: "Backup", restore: "Restore", migrate: "Migration", migrate_in: "Receiving migration",
};
const MAX_LIST = 200;

export const jobTypeLabel = (type: string): string => JOB_TYPE_LABEL[type] ?? type;
export const isActive = (j: Pick<JobDto, "status">): boolean => j.status === "queued" || j.status === "running";

/** Label of a backup's origin stored in the job payload (`trigger`), or null. */
export function jobTriggerLabel(j: Pick<JobDto, "payload">): string | null {
  const t = j.payload?.trigger;
  return typeof t === "string" && t in TRIGGER_LABEL ? TRIGGER_LABEL[t as BackupTriggerName] : null;
}

const STATE_ORDER: JobState[] = ["queued", "running", "ok", "failed", "cancelled"];
/** List of statuses in canonical order and without repeats, or null if there is no filter. */
export function normalizeStatus(s: JobState | JobState[] | undefined): string | null {
  const list = s === undefined ? [] : Array.isArray(s) ? s : [s];
  const sorted = STATE_ORDER.filter((x) => list.includes(x));
  return sorted.length ? sorted.join(",") : null;
}
export const jobsKey = (f: JobsFilter = {}): QueryKey => ["jobs", { serverId: f.serverId ?? null, status: normalizeStatus(f.status) }];
export const jobKey = (id: string): QueryKey => ["job", id];
export const backupsKey = (serverId: string): QueryKey => ["backups", serverId];

const matches = (j: JobDto, f: NormalizedFilter) => (!f.serverId || j.serverId === f.serverId) && (!f.status || f.status.split(",").includes(j.status));

/** An event must not overwrite a terminal status nor a more recent one that we already have (as the panel does). */
const supersedes = (old: Pick<JobDto, "status" | "updatedAt">, next: Pick<JobDto, "updatedAt">) =>
  isActive(old) && old.updatedAt <= next.updatedAt;

/** Inserts or updates a job in a list (newest first) respecting its filter. */
export function upsertJob(list: JobDto[], job: JobDto, f: NormalizedFilter): JobDto[] {
  const existing = list.find((j) => j.id === job.id);
  if (existing && !supersedes(existing, job)) return list;
  const rest = list.filter((j) => j.id !== job.id);
  if (!matches(job, f)) return rest.length === list.length ? list : rest;
  return [...rest, job].sort(byCreatedDesc).slice(0, MAX_LIST);
}

const byCreatedDesc = (a: JobDto, b: JobDto) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** Expanded row of a jobs list and the filter (`jobsKey` key) it was opened with. */
export interface OpenRow { id: string; filterKey: string }

/** Id of the open row with the current filter: when the filter (or server) changes it collapses. */
export function openRowId(open: OpenRow | null, filterKey: string): string | null {
  return open && open.filterKey === filterKey ? open.id : null;
}

/**
 * Rows shown by the list: those of the filter and, if the open row is no longer there (its job ended with the
 * “Running” filter), that row with its latest known status (`openJob`, the detail) in its place by date, until it is
 * collapsed or the filter changes.
 */
export function withOpenRow(list: JobDto[], openId: string | null, openJob: JobDto | undefined): JobDto[] {
  if (!openId || !openJob || openJob.id !== openId || list.some((j) => j.id === openId)) return list;
  return [...list, openJob].sort(byCreatedDesc);
}

/** Same cap and marker as the panel's `capLog` (jobs/service.ts). */
export const MAX_JOB_LOG = 256 * 1024;
export function capLog(log: string): string {
  if (log.length <= MAX_JOB_LOG) return log;
  const mark = "…(trimmed)\n";
  return mark + log.slice(log.length - MAX_JOB_LOG + mark.length);
}

export function applyJobEvent(qc: QueryClient, msg: JobMsg): void {
  for (const [key, data] of qc.getQueriesData<JobDto[]>({ queryKey: ["jobs"] })) {
    if (!data) continue;
    const f = (key[1] ?? {}) as Partial<NormalizedFilter>;
    const filter = { serverId: f.serverId ?? null, status: f.status ?? null };
    if (upsertJob(data, msg.job, filter) === data) continue; // it does not affect it: do not cancel its refetch
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
    void qc.invalidateQueries({ queryKey: jobKey(msg.job.id) }); // full final log
    if (msg.job.serverId) void qc.invalidateQueries({ queryKey: backupsKey(msg.job.serverId) });
  }
}

export function applyBackupsEvent(qc: QueryClient, msg: BackupsMsg): void {
  void qc.invalidateQueries({ queryKey: backupsKey(msg.serverId) });
}

/** Subset of `Realtime` used here (makes testing easier). */
export interface JobsLiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

/** Connects the cache to the `jobs` topic. Returns the cleanup function. */
export function bindJobsLive(qc: QueryClient, live: JobsLiveSource): () => void {
  const offs = [
    live.subscribe("jobs", (m) => {
      if (m.type === "job") applyJobEvent(qc, m);
      else if (m.type === "backups") applyBackupsEvent(qc, m);
    }),
    // Notices are lost during the disconnection: we reload.
    live.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["job"] });
      void qc.invalidateQueries({ queryKey: ["backups"] });
    }),
  ];
  return () => offs.forEach((off) => off());
}

const bindings = new WeakMap<QueryClient, { count: number; off: () => void }>();

/** Like bindJobsLive but with a count: several mounted views share a single subscription
 * (otherwise each log chunk would be appended to the detail several times). */
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

/** Options of the Jobs page filter (`status: null` = All). "Running" includes those waiting in the queue. */
export const JOB_FILTER_OPTIONS: { label: string; status: JobState[] | null }[] = [
  { label: "All", status: null }, { label: "Running", status: ["queued", "running"] }, { label: "Successful", status: ["ok"] }, { label: "Failed", status: ["failed"] },
];
export const jobsFilterFor = (status: JobState[] | null): JobsFilter => (status ? { status } : {});

/** Name of a job's server. Without a list (loading or with an error) it is not asserted to be deleted. */
export function jobServerName(serverId: string, servers: { id: string; name: string }[] | undefined): string {
  if (!servers) return "…";
  return servers.find((s) => s.id === serverId)?.name ?? "(deleted)";
}

/** End time of a job, or null if it has not ended or the date is not valid. */
export function formatFinishTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("en-GB");
}
