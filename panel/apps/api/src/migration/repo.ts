import type { MigrationDto, MigrationPhase, Spec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { nowIso } from "../lib/time.js";
import type { ObservedDto } from "../servers/repo.js";

export interface MigrationRow {
  id: string; server_id: string; source_node_id: string; target_node_id: string; source_slug: string; target_slug: string;
  source_version: number; target_version: number; target_port: number; target_spec: string;
  was_running: number; delete_source: number; phase: MigrationPhase;
  /** El destino ya puede tener algo de esta migración (se envió MigrateReceive): deshacer exige MigrateAbort. */
  target_touched: number;
  /** El destino recibió la orden de arrancar: el origen no vuelve a arrancar hasta que el destino esté limpio. */
  target_started: number;
  /** rolling_back: falta arrancar el origen. committed: falta retirarlo. */
  source_pending: number;
  /** rolling_back: falta MigrateAbort en el destino. */
  target_pending: number;
  /** committed: falta MigrateConfirm en el destino. */
  target_confirm_pending: number;
  error: string | null;
  /** Último fallo de lo pendiente, o por qué se dejó de reintentar (rechazo definitivo o cierre manual). */
  pending_error: string | null;
  created_at: string; updated_at: string;
}

export type NewMigration = Pick<MigrationRow,
  "id" | "server_id" | "source_node_id" | "target_node_id" | "source_slug" | "target_slug" | "source_version" | "target_version" |
  "target_port" | "target_spec" | "was_running" | "delete_source">;
export type MigrationPatch = Partial<Pick<MigrationRow,
  "phase" | "target_touched" | "target_started" | "source_pending" | "target_pending" | "target_confirm_pending" | "error" | "pending_error">>;

const OPEN = "('running', 'rolling_back', 'committed')";
/**
 * Puede haber conflicto con lo que haga el usuario sobre el servidor: los pasos están en curso, o se deshace y falta
 * arrancar el origen (lo hace la migración) o limpiar una copia del destino que llegó a arrancar (el origen no debe
 * arrancar hasta entonces). Solo con la limpieza de un destino que nunca arrancó pendiente, el servidor ya es usable.
 */
const SERVER_BLOCKING = `(phase = 'running' OR (phase = 'rolling_back' AND (source_pending = 1 OR (target_started = 1 AND target_pending = 1))))`;
/** El destino puede tener algo de la migración: pasos en curso o limpieza pendiente. */
const TARGET_BUSY = `(phase = 'running' OR (phase = 'rolling_back' AND target_pending = 1))`;
const PATCHABLE = ["phase", "target_touched", "target_started", "source_pending", "target_pending", "target_confirm_pending", "error", "pending_error"] as const;
/** Fases tras el commit: el servidor ya es del destino. */
const CONFIRMED: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["committed", "done"]);
/** Fases a las que una migración confirmada no puede volver. */
const REVERTING: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["running", "rolling_back", "failed"]);

export function toMigrationDto(r: MigrationRow): MigrationDto {
  return {
    id: r.id, serverId: r.server_id, sourceNodeId: r.source_node_id, targetNodeId: r.target_node_id,
    sourceSlug: r.source_slug, targetSlug: r.target_slug, targetPort: r.target_port, targetVersion: r.target_version,
    wasRunning: r.was_running === 1, deleteSource: r.delete_source === 1, phase: r.phase,
    sourcePending: r.source_pending === 1, targetPending: r.target_pending === 1, targetStarted: r.target_started === 1,
    targetConfirmPending: r.target_confirm_pending === 1, error: r.error, pendingError: r.pending_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Puertos del host de una spec: el de juego y los extra. */
const specPorts = (spec: Spec): number[] => [spec.ports.game, ...spec.ports.extra.map((e) => e.host)];

export class MigrationsRepo {
  constructor(private db: Db) {}

  private one(sql: string, ...args: string[]): MigrationRow | null {
    return (this.db.prepare(sql).get(...args) as MigrationRow | undefined) ?? null;
  }

  insert(m: NewMigration): MigrationRow {
    const now = nowIso();
    this.db.prepare(`INSERT INTO migrations (id, server_id, source_node_id, target_node_id, source_slug, target_slug, source_version,
        target_version, target_port, target_spec, was_running, delete_source, phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(m.id, m.server_id, m.source_node_id, m.target_node_id, m.source_slug, m.target_slug, m.source_version,
        m.target_version, m.target_port, m.target_spec, m.was_running, m.delete_source, now, now);
    return this.get(m.id)!;
  }

  get(id: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE id = ?", id);
  }

  latestForServer(serverId: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE server_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", serverId);
  }

  openForServer(serverId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND phase IN ${OPEN} ORDER BY created_at DESC LIMIT 1`, serverId);
  }

  listOpen(): MigrationRow[] {
    return this.db.prepare(`SELECT * FROM migrations WHERE phase IN ${OPEN} ORDER BY created_at, id`).all() as unknown as MigrationRow[];
  }

  /**
   * Cambia campos de la migración. Una migración confirmada (committed o done) nunca vuelve atrás: el servidor ya
   * vive en el destino y deshacer (MigrateAbort) lo borraría. Pedirlo es un bug y lanza sin tocar nada.
   */
  update(id: string, patch: MigrationPatch): MigrationRow {
    if ((patch.phase !== undefined && REVERTING.has(patch.phase)) || patch.target_pending === 1) {
      const cur = this.get(id);
      if (cur && CONFIRMED.has(cur.phase)) throw new Error(`migración ${id} ya confirmada (${cur.phase}): no se puede deshacer`);
    }
    const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
    if (keys.length > 0) {
      this.db.prepare(`UPDATE migrations SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => patch[k] as string | number | null), nowIso(), id);
    }
    return this.get(id)!;
  }

  /** Bloquea las acciones del usuario sobre el servidor mientras pueden chocar con la migración (SERVER_BLOCKING). */
  blockingServer(serverId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND ${SERVER_BLOCKING} ORDER BY created_at DESC LIMIT 1`, serverId);
  }

  /** Bloquea crear servidores en el nodo: destino con algo de la migración, u origen con la retirada pendiente (su slug). */
  blockingNodeCreate(nodeId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE (target_node_id = ? AND ${TARGET_BUSY}) OR (source_node_id = ? AND phase = 'committed' AND source_pending = 1)
      ORDER BY created_at LIMIT 1`, nodeId, nodeId);
  }

  /**
   * Puertos del host que reservan en `nodeId` las migraciones hacia él que aún pueden tener (o tener pronto) allí su
   * copia: el puerto de juego y los extra de su spec en el destino. `checkPorts`/`allocatePort` los cuentan como
   * usados. Tras el commit ya no hace falta: la fila del servidor está en el nodo.
   */
  reservedPorts(nodeId: string, exceptServerId?: string): Set<number> {
    const rows = this.db.prepare(`SELECT server_id, target_spec FROM migrations WHERE target_node_id = ? AND ${TARGET_BUSY}`)
      .all(nodeId) as unknown as { server_id: string; target_spec: string }[];
    const out = new Set<number>();
    for (const r of rows) {
      if (r.server_id === exceptServerId) continue;
      for (const p of specPorts(JSON.parse(r.target_spec) as Spec)) out.add(p);
    }
    return out;
  }

  /** Bloquea borrar el nodo mientras una migración que lo usa está en curso (deshaciéndose, sí se puede). */
  blockingNodeDelete(nodeId: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE phase = 'running' AND (source_node_id = ? OR target_node_id = ?) ORDER BY created_at LIMIT 1", nodeId, nodeId);
  }

  /** SyncSpecs no retira de `nodeId` un servidor con una migración abierta que pasa por ese nodo. */
  protects(nodeId: string, serverId: string): boolean {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND phase IN ${OPEN} AND (source_node_id = ? OR target_node_id = ?) LIMIT 1`,
      serverId, nodeId, nodeId) !== null;
  }

  /**
   * Un paso falló: la migración pasa a deshacerse, con lo pendiente según lo que llegó a hacer, SOLO si sigue en
   * curso (`running`). Si ya se confirmó (el commit es una transacción que cambia la fase), devuelve null y no
   * cambia nada: tras el commit nunca se deshace (MigrateAbort borraría el servidor vivo en el destino).
   */
  startRollback(id: string, error: string): MigrationRow | null {
    const r = this.db.prepare(`UPDATE migrations SET phase = 'rolling_back', target_pending = target_touched, source_pending = was_running,
      error = ?, updated_at = ? WHERE id = ? AND phase = 'running'`).run(error, nowIso(), id);
    return Number(r.changes) === 1 ? this.get(id) : null;
  }

  /** Al arrancar el panel: lo que estaba en curso pasa a deshacerse, con lo pendiente según lo que llegó a hacer. */
  interruptRunning(message: string): MigrationRow[] {
    const rows = this.db.prepare("SELECT id FROM migrations WHERE phase = 'running' ORDER BY created_at").all() as unknown as { id: string }[];
    const now = nowIso();
    const stmt = this.db.prepare(`UPDATE migrations SET phase = 'rolling_back', target_pending = target_touched, source_pending = was_running,
      error = COALESCE(error, ?), updated_at = ? WHERE id = ? AND phase = 'running'`);
    for (const r of rows) stmt.run(message, now, r.id);
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * Confirma la migración en UNA transacción: la fila del servidor pasa al destino (nodo, slug, spec, versión, estado
   * deseado y último observado) solo si sigue en el origen con la versión del inicio, y la migración pasa a
   * `committed` con la retirada del origen y la confirmación en el destino pendientes. Devuelve false (sin cambiar nada) si la versión cambió, o el
   * slug o alguno de sus puertos ya está ocupado en el destino.
   */
  commit(m: MigrationRow, desired: "running" | "stopped", observed: ObservedDto | null): boolean {
    const now = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Los puertos del servidor en el destino siguen libres allí (otro servidor de ese nodo pudo cambiar los suyos).
      const mine = new Set(specPorts(JSON.parse(m.target_spec) as Spec));
      const others = this.db.prepare("SELECT spec FROM servers WHERE node_id = ? AND id != ?").all(m.target_node_id, m.server_id) as unknown as { spec: string }[];
      if (others.some((r) => specPorts(JSON.parse(r.spec) as Spec).some((p) => mine.has(p)))) {
        this.db.exec("ROLLBACK");
        return false;
      }
      // imported_from = NULL (Plan 6): en el destino el servidor ya no sigue a ningún contenedor original (sin `adopt`).
      const moved = this.db.prepare(`UPDATE servers SET node_id = ?, slug = ?, spec = ?, spec_version = ?, desired_state = ?,
          observed = ?, observed_spec_version = ?, observed_at = ?, updated_at = ?, imported_from = NULL
        WHERE id = ? AND node_id = ? AND spec_version = ?`)
        .run(m.target_node_id, m.target_slug, m.target_spec, m.target_version, desired,
          observed ? JSON.stringify(observed) : null, m.target_version, observed ? now : null, now,
          m.server_id, m.source_node_id, m.source_version);
      const done = this.db.prepare(`UPDATE migrations SET phase = 'committed', source_pending = 1, target_confirm_pending = 1, error = NULL,
          updated_at = ? WHERE id = ? AND phase = 'running'`)
        .run(now, m.id);
      if (Number(moved.changes) !== 1 || Number(done.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return false;
      throw e;
    }
  }
}
