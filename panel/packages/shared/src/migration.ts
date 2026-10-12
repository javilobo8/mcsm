import { z } from "zod";

/** Cuerpo de POST /api/servers/:id/migration. */
export const migrationRequestSchema = z.object({
  targetNodeId: z.string().min(1, "Elige el nodo destino"),
  /** Puerto de juego en el destino. Sin él, el panel propone uno: el actual si está libre allí. */
  port: z.number().int().min(1).max(65535).optional(),
  /** Al terminar, borrar <DATA_ROOT>/<slug> del origen. Si no, se conserva como <DATA_ROOT>/<slug>.migrated-<ts>. */
  deleteSource: z.boolean().default(false),
});
export type MigrationRequest = z.infer<typeof migrationRequestSchema>;
export type MigrationRequestInput = z.input<typeof migrationRequestSchema>;

/** Query de GET /api/servers/:id/migration/proposal. */
export const migrationProposalQuerySchema = z.object({
  targetNodeId: z.string().min(1, "Elige el nodo destino"),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

/**
 * running: pasos en curso. rolling_back: falló y queda algo por deshacer (destino o arrancar el origen).
 * committed: el servidor ya está en el destino y falta retirar el origen. done y failed: cerradas.
 */
export type MigrationPhase = "running" | "rolling_back" | "committed" | "done" | "failed";
/** Fases con trabajo pendiente: el servidor tiene una migración abierta. */
export const OPEN_PHASES: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["running", "rolling_back", "committed"]);

export interface MigrationDto {
  id: string; serverId: string; sourceNodeId: string; targetNodeId: string; sourceSlug: string; targetSlug: string;
  targetPort: number; targetVersion: number; wasRunning: boolean; deleteSource: boolean; phase: MigrationPhase;
  sourcePending: boolean; targetPending: boolean; error: string | null; createdAt: string; updatedAt: string;
}

export interface MigrationProposalDto { targetNodeId: string; slug: string; port: number; currentPort: number; portChanged: boolean }

/** Los 7 pasos visibles del job de migración (spec §7), en orden. */
export const MIGRATION_STEPS = [
  "Parar el servidor en el origen",
  "Copia de seguridad previa (antes de migrar)",
  "Subir la copia al panel",
  "Enviar la copia al destino y restaurarla",
  "Crear el servidor en el destino",
  "Arrancar y comprobar en el destino",
  "Confirmar y retirar el origen",
] as const;
export type MigrationStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Tramo de progreso [desde, hasta) de cada paso: el job avanza dentro del tramo de su paso. */
export const MIGRATION_PROGRESS: readonly (readonly [number, number])[] = [[0, 5], [5, 30], [30, 50], [50, 80], [80, 83], [83, 95], [95, 100]];

/** Progreso del job con el paso `step` hecho en `fraction` (0-1). Entero y siempre por debajo del paso siguiente. */
export function stepProgress(step: MigrationStep, fraction = 0): number {
  const [from, to] = MIGRATION_PROGRESS[step - 1]!;
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.min(to - 1, Math.floor(from + (to - from) * f));
}

/** Paso en el que está un job de migración según su progreso. */
export function stepOfProgress(progress: number): MigrationStep {
  let step = 1;
  for (let i = 0; i < MIGRATION_PROGRESS.length; i++) if (progress >= MIGRATION_PROGRESS[i]![0]) step = i + 1;
  return step as MigrationStep;
}

/** Mensaje del job: «Paso 3/7 · Subir la copia al panel: detalle». */
export function stepMessage(step: MigrationStep, detail = ""): string {
  return `Paso ${step}/7 · ${MIGRATION_STEPS[step - 1]}${detail ? `: ${detail}` : ""}`;
}
