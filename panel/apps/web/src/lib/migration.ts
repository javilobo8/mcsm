import { MIGRATION_STEPS, OPEN_PHASES, migrationLeftovers, stepOfProgress, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput, type Spec } from "@mcsm/shared";
import { apiPath, type JobDto, type NodeDto } from "./api";
import { isActive } from "./jobs";

export const migrationKey = (serverId: string) => ["migration", serverId] as const;
export const proposalKey = (serverId: string, targetNodeId: string, port?: number) => ["migration-proposal", serverId, targetNodeId, port ?? null] as const;

/** Proposal route: with the port typed in, the panel checks that one and does not propose another (m8). */
export function proposalPath(serverId: string, targetNodeId: string, port: number | undefined): string {
  const q = new URLSearchParams({ targetNodeId });
  if (port !== undefined) q.set("port", String(port));
  return `${apiPath`/api/servers/${serverId}/migration/proposal`}?${q}`;
}

/** The form has something to lose when switching tabs (m9): a chosen target, port or “delete source”. */
export const migrateFormDirty = (targetId: string, portText: string, deleteSource: boolean): boolean =>
  targetId !== "" || portText.trim() !== "" || deleteSource;

export interface TargetOption { id: string; label: string; disabled: boolean }

/** Nodes that can be migrated to: all except the current one; offline ones appear disabled. */
export function targetOptions(nodes: NodeDto[] | undefined, currentNodeId: string): TargetOption[] {
  return (nodes ?? []).filter((n) => n.id !== currentNodeId).map((n) => ({
    id: n.id, label: n.status === "online" ? n.name : `${n.name} (offline)`, disabled: n.status !== "online",
  }));
}

/** The server's migration job in progress (the list comes from newest to oldest). */
export const activeMigrationJob = (jobs: JobDto[] | undefined): JobDto | undefined => jobs?.find((j) => j.type === "migrate" && isActive(j));
/** The server's latest migration job, finished or not. */
export const lastMigrationJob = (jobs: JobDto[] | undefined): JobDto | undefined => jobs?.find((j) => j.type === "migrate");

/** "" = the port the panel proposes; a number 1-65535; null if it is not a port. */
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

/** Text under the port field. */
export function portHint(p: MigrationProposalDto | undefined, typed: number | undefined | null): string {
  if (typed === null) return "Enter a port between 1 and 65535, or leave it empty to use the proposed one.";
  if (typed !== undefined) return `Port ${typed} will be used.`;
  if (!p) return "Choose the target node first.";
  return p.portChanged
    ? `Proposed: ${p.port} (${p.currentPort} is busy on the target). Enter another to change it.`
    : `Proposed: ${p.port}, the same as now. Enter another to change it.`;
}

/** Why it cannot be migrated now (null = it can). */
/** Line about the RCON port on the target, or null when the server does not publish RCON. */
export function rconProposalText(p: MigrationProposalDto | undefined): string | null {
  if (!p || p.rconPort === null) return null;
  return p.rconChanged
    ? `RCON port on the target: ${p.rconPort} (the current one is taken there).`
    : `RCON port on the target: ${p.rconPort}, the same as now.`;
}

export function migrateBlockedReason(o: {
  sourceOnline: boolean | undefined; active: JobDto | undefined; migration: MigrationDto | null | undefined;
  target: TargetOption | undefined; portInvalid: boolean; proposalError: string | null;
}): string | null {
  if (o.active) return "A migration is already in progress";
  if (o.migration && OPEN_PHASES.has(o.migration.phase)) return "The previous migration still has pending steps";
  if (o.sourceOnline === false) return "The current node is offline";
  if (!o.target) return "Choose the target node";
  if (o.target.disabled) return "The target node is offline";
  if (o.portInvalid) return "The port must be a number between 1 and 65535";
  if (o.proposalError) return o.proposalError;
  return null;
}

export type StepState = "done" | "current" | "failed" | "pending";

/** Status of each of the 7 steps according to the job: the current step comes from its progress. */
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

/** ": reason" of the last failure of a pending item (pending_error carries the pending item's name first), or "". */
function reason(m: MigrationDto, label: string): string {
  const prefix = `${label}: `;
  return m.pendingError?.startsWith(prefix) ? `: ${m.pendingError.slice(prefix.length)}` : "";
}

/**
 * What is left pending of a migration, or null if there is nothing to report. `online` says whether a node is online
 * (undefined = unknown): with the node online it does not say “when it reconnects”, but that it is retried and why.
 */
export function pendingText(m: MigrationDto, nodeName: (id: string) => string, online: (id: string) => boolean | undefined = () => undefined): string | null {
  const src = nodeName(m.sourceNodeId);
  const dst = nodeName(m.targetNodeId);
  const when = (nodeId: string, label: string) => online(nodeId) === false ? " when it reconnects" : ` (retried every 30 s${reason(m, label)})`;
  if (m.phase === "rolling_back") {
    const parts: string[] = [];
    if (m.targetPending) parts.push(`delete the half-made copy on “${dst}”${when(m.targetNodeId, "Clean up the target")}`);
    if (m.sourcePending) {
      parts.push(m.targetPending && m.targetStarted
        ? `then, start the server again on “${src}”`
        : `start the server again on “${src}”${when(m.sourceNodeId, "Start the source again")}`);
    }
    const usable = !m.sourcePending && !(m.targetPending && m.targetStarted) ? ` The server can already be used on “${src}”.` : "";
    return `The migration failed and is being rolled back: still pending: ${parts.join("; ")}.${usable}`;
  }
  if (m.phase === "committed") {
    const parts: string[] = [];
    if (m.sourcePending) {
      parts.push(`remove the server from node “${src}” (${m.deleteSource ? "deleting its data" : `its data will stay in ${m.sourceSlug}.migrated-…`})${when(m.sourceNodeId, "Remove the source")}`);
    }
    if (m.targetConfirmPending) parts.push(`confirm the migration on “${dst}”${when(m.targetNodeId, "Confirm on the target")}`);
    return `Migrated to “${dst}”. Still pending: ${parts.join("; ")}.`;
  }
  if (m.pendingError && (m.phase === "done" || m.phase === "failed")) return `Something is left to resolve by hand: ${m.pendingError}`;
  return null;
}

/** Can be closed by hand: open, with no step in progress (only what is pending remains) and without its active job. */
export function canCloseMigration(m: MigrationDto | null | undefined, active: JobDto | undefined): boolean {
  return !!m && (m.phase === "rolling_back" || m.phase === "committed") && !active;
}

/** Text of the dialog that confirms closing a stuck migration by hand. */
export function closeMigrationText(m: MigrationDto, nodeName: (id: string) => string): string {
  const left = migrationLeftovers(m, nodeName);
  return [
    "The panel will stop retrying what is left of this migration and will not send anything to the nodes.",
    left.length ? `Left undone: ${left.join("; ")}.` : "Nothing is pending.",
    "Do it only if a node is not coming back or if you have already resolved it by hand.",
  ].join(" ");
}

/** Text of the confirmation dialog. `imported`: notice of an imported server (`serverImportView(s).retire`), at the end. */
/**
 * Plan 8: notice for a server with a hostname (router enabled). Its DNS points at the source node: after migrating it has to
 * point at the target, which also needs its router enabled. null if the server does not use the router.
 */
export function routerDnsNote(router: Spec["router"], source: string, target: string | undefined): string | null {
  if (!router?.enabled) return null;
  const dst = target ? `of “${target}”` : "of the target node";
  return `After migrating, the hostname “${router.hostname}” has to resolve to the IP ${dst} (and its router has to be enabled): ` +
    `otherwise, players will keep reaching the router of “${source}”, which will no longer have this server.`;
}

export function confirmText(o: {
  serverName: string; slug: string; source: string; target: string; port: number; deleteSource: boolean; running: boolean; imported?: string | null;
  dns?: string | null; rcon?: string | null;
}): string {
  return [
    o.running ? `“${o.serverName}” will be stopped on “${o.source}” during the migration.` : `“${o.serverName}” is stopped on “${o.source}”.`,
    "A backup will be made first, sent to the target (checking its sha256) and restored there.",
    ...(o.rcon ? [o.rcon] : []),
    `On “${o.target}” it will use port ${o.port} and be started to check that it works${o.running ? "; afterwards it will stay running" : "; afterwards it will be stopped again"}.`,
    o.deleteSource
      ? `When it finishes, its data and backups on “${o.source}” will be DELETED.`
      : `When it finishes, its data and backups on “${o.source}” will be kept in ${o.slug}.migrated-… (delete them by hand when you no longer need them).`,
    `If anything fails, the server stays on “${o.source}” with its world intact${o.running ? " and is started again" : ""}.`,
    ...(o.imported ? [o.imported] : []),
    ...(o.dns ? [o.dns] : []),
  ].join(" ");
}

/** Has the migration that was in progress (`prevActiveId`) just finished? Used to refresh the server. */
export function migrationFinished(prevActiveId: string | null, jobs: JobDto[] | undefined): boolean {
  if (!prevActiveId || !jobs) return false;
  const j = jobs.find((x) => x.id === prevActiveId);
  return !j || !isActive(j);
}

/** Migration in progress that is followed to refresh the server: its job and the step it is at. */
export interface MigrationSyncState { id: string; step: number }

/**
 * When to refresh the server (it may have changed node): when the migration in progress enters step 7 (the panel
 * confirms the node change right at its start, in the same turn: the reload already sees it) and when it ends (m6). Without a list
 * (loading) nothing changes.
 */
export function migrationSync(prev: MigrationSyncState | null, jobs: JobDto[] | undefined): { refresh: boolean; next: MigrationSyncState | null } {
  if (!jobs) return { refresh: false, next: prev };
  const active = activeMigrationJob(jobs);
  const next = active ? { id: active.id, step: stepOfProgress(active.progress) } : null;
  if (prev && prev.id !== next?.id) return { refresh: migrationFinished(prev.id, jobs), next };
  const entered7 = !!prev && !!next && prev.step < 7 && next.step === 7;
  return { refresh: entered7, next };
}
