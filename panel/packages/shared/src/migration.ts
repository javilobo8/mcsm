import { z } from "zod";

/** Body of POST /api/servers/:id/migration. */
export const migrationRequestSchema = z.object({
  targetNodeId: z.string().min(1, "Choose the target node"),
  /** Game port on the target. Without it, the panel proposes one: the current one if free there. */
  port: z.number().int().min(1).max(65535).optional(),
  /** When finished, delete <DATA_ROOT>/<slug> from the source. Otherwise it is kept as <DATA_ROOT>/<slug>.migrated-<ts>. */
  deleteSource: z.boolean().default(false),
});
export type MigrationRequest = z.infer<typeof migrationRequestSchema>;
export type MigrationRequestInput = z.input<typeof migrationRequestSchema>;

/** Query of GET /api/servers/:id/migration/proposal. */
export const migrationProposalQuerySchema = z.object({
  targetNodeId: z.string().min(1, "Choose the target node"),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

/**
 * running: steps in progress. rolling_back: failed and something remains to undo (target or starting the source).
 * committed: the server is already on the target and the source still has to be removed. done and failed: closed.
 */
export type MigrationPhase = "running" | "rolling_back" | "committed" | "done" | "failed";
/** Phases with pending work: the server has an open migration. */
export const OPEN_PHASES: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["running", "rolling_back", "committed"]);

export interface MigrationDto {
  id: string; serverId: string; sourceNodeId: string; targetNodeId: string; sourceSlug: string; targetSlug: string;
  targetPort: number; targetVersion: number; wasRunning: boolean; deleteSource: boolean; phase: MigrationPhase;
  /** rolling_back: the source still has to be started. committed: it still has to be removed. */
  sourcePending: boolean;
  /** rolling_back: what the migration left on the target still has to be deleted. */
  targetPending: boolean;
  /** The target received the start command: the source does not start until the target is cleaned. */
  targetStarted: boolean;
  /** committed: the migration still has to be confirmed on the target (MigrateConfirm). */
  targetConfirmPending: boolean;
  /** Why the step failed. */
  error: string | null;
  /** Last failure of what is pending (undo, confirm, remove) or why retrying stopped. */
  pendingError: string | null;
  createdAt: string; updatedAt: string;
}

export interface MigrationProposalDto { targetNodeId: string; slug: string; port: number; currentPort: number; portChanged: boolean }

/** The 7 visible steps of the migration job (spec §7), in order. */
export const MIGRATION_STEPS = [
  "Stop the server on the source",
  "Pre-migration backup (before migrating)",
  "Upload the backup to the panel",
  "Send the backup to the target and restore it",
  "Create the server on the target",
  "Start and check on the target",
  "Confirm and remove the source",
] as const;
export type MigrationStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Progress range [from, to) of each step: the job advances within its step's range. */
export const MIGRATION_PROGRESS: readonly (readonly [number, number])[] = [[0, 5], [5, 30], [30, 50], [50, 80], [80, 83], [83, 95], [95, 100]];

/** Job progress with step `step` done to `fraction` (0-1). Integer and always below the next step. */
export function stepProgress(step: MigrationStep, fraction = 0): number {
  const [from, to] = MIGRATION_PROGRESS[step - 1]!;
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.min(to - 1, Math.floor(from + (to - from) * f));
}

/** Step a migration job is in according to its progress. */
export function stepOfProgress(progress: number): MigrationStep {
  let step = 1;
  for (let i = 0; i < MIGRATION_PROGRESS.length; i++) if (progress >= MIGRATION_PROGRESS[i]![0]) step = i + 1;
  return step as MigrationStep;
}

/** Job message: “Step 3/7 · Upload the backup to the panel: detail”. */
export function stepMessage(step: MigrationStep, detail = ""): string {
  return `Step ${step}/7 · ${MIGRATION_STEPS[step - 1]}${detail ? `: ${detail}` : ""}`;
}

/**
 * What closing an open migration by hand (rolling_back or committed) would leave undone: one sentence per pending item,
 * for the confirmation dialog and the note left on the migration. Empty if nothing remains.
 */
export function migrationLeftovers(m: Pick<MigrationDto, "phase" | "sourceNodeId" | "targetNodeId" | "sourceSlug" | "targetSlug" | "sourcePending" | "targetPending" | "targetConfirmPending">, nodeName: (id: string) => string): string[] {
  const src = nodeName(m.sourceNodeId);
  const dst = nodeName(m.targetNodeId);
  const out: string[] = [];
  if (m.phase === "rolling_back") {
    if (m.targetPending) out.push(`the half-made copy on “${dst}” is not deleted: if it was created, delete ${m.targetSlug} by hand in its DATA_ROOT (and its container, if still running)`);
    if (m.sourcePending) out.push(`the server is not started again on “${src}”: start it yourself once you have checked “${dst}”`);
  } else if (m.phase === "committed") {
    if (m.sourcePending) out.push(`the server is not removed from “${src}”: ${m.sourceSlug} is still in its DATA_ROOT (set it aside or delete it by hand before creating another server there with that slug)`);
    if (m.targetConfirmPending) out.push(`the migration is not confirmed on “${dst}”: do not restore the panel database to a copy from before this migration`);
  }
  return out;
}
