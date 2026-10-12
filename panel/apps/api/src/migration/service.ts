import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import {
  formatZodError, MIGRATION_STEPS, migrationProposalQuerySchema, migrationRequestSchema, specSchema, stepMessage,
  type MigrationDto, type MigrationProposalDto, type MigrationStep, type Spec,
} from "@mcsm/shared";
import { realTimers, type Timers } from "../files/stream.js";
import type { JobDto } from "../jobs/repo.js";
import { HttpError } from "../lib/http.js";
import type { ObservedDto, ServerRow } from "../servers/repo.js";
import type { StagedFile } from "../transfers/staging.js";
import { errorText, isKnownError, StepError } from "./errors.js";
import { proposeTarget, type TargetServer } from "./propose.js";
import { toMigrationDto, type MigrationRow } from "./repo.js";
import { JobReporter, type Reporter } from "./report.js";
import {
  abortTarget, applyOnTarget, backupSource, DEFAULT_TIMINGS, pushToPanel, receiveOnTarget, restartSource, retireSource,
  startAndVerify, stopSource, stopTarget, type MigrationTimings, type StepDeps,
} from "./steps.js";

/** Cada cuánto se reintenta lo pendiente (deshacer, retirar el origen), además de tras cada Hello. */
export const PENDING_EVERY_MS = 30_000;
export const INTERRUPTED = "interrumpido: el panel se reinició durante la migración";
/** La migración desapareció mientras se deshacía: se borró uno de sus nodos (sus filas caen en cascada). */
const GONE = "Se borró uno de los nodos durante la migración: el servidor sigue en su nodo de origen, quizá parado (arráncalo a mano)";

interface Plan {
  target: { id: string; name: string }; slug: string; port: number; portChanged: boolean; currentPort: number; spec: Spec;
}

const silent = (log: (line: string) => void): Reporter => ({ step: () => {}, within: () => {}, message: () => {}, log });

/**
 * Migración entre nodos (spec §7 MigrationService): job `migrate` de 7 pasos, orquestado aquí, sobre la tabla
 * `migrations` (estado duradero: qué falta deshacer o retirar si el panel se reinicia o un nodo cae).
 */
export class MigrationService {
  /** Temporizadores de las esperas (los tests ponen ManualTimers). */
  timers: Timers = realTimers;
  timings: MigrationTimings = { ...DEFAULT_TIMINGS };
  /** Migraciones con trabajo en curso en este proceso (pasos o pendientes): nunca dos tareas a la vez sobre una. */
  private busy = new Set<string>();
  private tick: NodeJS.Timeout | undefined;

  constructor(private app: FastifyInstance) {}

  start(): void {
    // Tras el Hello de un nodo, lo pendiente con él (las peticiones esperan solas al Ack de SyncSpecs).
    this.app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case === "hello") void this.runPending(nodeId);
    });
  }

  /** Al arrancar el panel: lo que estaba en curso pasa a deshacerse; lo pendiente se reintenta cada 30 s. */
  async recover(): Promise<void> {
    const rows = this.app.migrations.interruptRunning(INTERRUPTED);
    if (rows.length > 0) this.app.log.warn({ count: rows.length }, "migraciones interrumpidas por el reinicio del panel: se deshacen");
    if (!this.tick) {
      this.tick = setInterval(() => void this.runPending(), PENDING_EVERY_MS);
      this.tick.unref();
    }
    await this.runPending();
  }

  close(): void {
    clearInterval(this.tick);
    this.tick = undefined;
  }

  latest(serverId: string): { migration: MigrationDto | null } {
    this.requireServer(serverId);
    const m = this.app.migrations.latestForServer(serverId);
    return { migration: m ? toMigrationDto(m) : null };
  }

  proposal(serverId: string, query: unknown): MigrationProposalDto {
    const q = migrationProposalQuerySchema.parse(query);
    const p = this.plan(this.requireServer(serverId), q.targetNodeId, q.port);
    return { targetNodeId: p.target.id, slug: p.slug, port: p.port, currentPort: p.currentPort, portChanged: p.portChanged };
  }

  /** Valida y lanza la migración. Devuelve el job (202); el avance va por el topic `jobs`. */
  begin(serverId: string, body: unknown): JobDto {
    const input = migrationRequestSchema.parse(body);
    const row = this.requireServer(serverId);
    const p = this.plan(row, input.targetNodeId, input.port);
    const sourceName = this.nodeName(row.node_id);
    if (!this.app.agents.get(row.node_id)) throw new HttpError(409, `El nodo origen «${sourceName}» está desconectado`);
    if (!this.app.agents.get(p.target.id)) throw new HttpError(409, `El nodo destino «${p.target.name}» está desconectado`);
    // Sin await entre las comprobaciones y el insert: dos peticiones a la vez no lanzan dos migraciones.
    const wasRunning = row.desired_state === "running";
    const job = this.app.jobs.create({
      type: "migrate", serverId, nodeId: row.node_id, status: "running", message: stepMessage(1, "preparando"),
      payload: { targetNodeId: p.target.id, targetNodeName: p.target.name, sourceNodeName: sourceName, slug: p.slug, port: p.port, deleteSource: input.deleteSource, wasRunning },
    });
    this.app.migrations.insert({
      id: job.id, server_id: serverId, source_node_id: row.node_id, target_node_id: p.target.id, source_slug: row.slug, target_slug: p.slug,
      source_version: row.spec_version, target_version: row.spec_version + 1, target_port: p.port, target_spec: JSON.stringify(p.spec),
      was_running: wasRunning ? 1 : 0, delete_source: input.deleteSource ? 1 : 0,
    });
    void this.run(job.id);
    return job;
  }

  /** Reintenta lo pendiente (de un nodo, o de todos): deshacer o retirar el origen. */
  async runPending(nodeId?: string): Promise<void> {
    for (const m of this.app.migrations.listOpen()) {
      if (m.phase === "running" || this.busy.has(m.id)) continue;
      if (nodeId && m.source_node_id !== nodeId && m.target_node_id !== nodeId) continue;
      this.busy.add(m.id);
      try {
        await this.settle(m.id, (line) => this.app.log.info({ migrationId: m.id, serverId: m.server_id }, line));
      } catch (e) {
        this.app.log.warn({ err: e, migrationId: m.id }, "fallo reintentando lo pendiente de una migración");
      } finally {
        this.busy.delete(m.id);
      }
    }
  }

  // Internos

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    return row;
  }

  private nodeName(id: string): string {
    return this.app.nodes.get(id)?.name ?? "otro nodo";
  }

  private deps(report: Reporter): StepDeps {
    return { app: this.app, timers: this.timers, timings: this.timings, report };
  }

  /** Comprueba que se puede migrar y calcula slug, puerto y spec en el destino. Lanza HttpError. */
  private plan(row: ServerRow, targetNodeId: string, port?: number): Plan {
    if (targetNodeId === row.node_id) throw new HttpError(400, "El servidor ya está en ese nodo");
    const target = this.app.nodes.get(targetNodeId);
    if (!target) throw new HttpError(404, "Nodo destino no encontrado");
    const open = this.app.migrations.openForServer(row.id);
    if (open) throw new HttpError(409, this.openMessage(open));
    const spec = JSON.parse(row.spec) as Spec;
    // dataPath (Plan 6): los datos están fuera de DATA_ROOT y el agente no puede copiarlos ni restaurarlos.
    if ((spec as unknown as Record<string, unknown>).dataPath) {
      throw new HttpError(409, `Los datos de «${row.name}» están fuera de DATA_ROOT (dataPath, servidor importado) y el agente no puede copiarlos: muévelos a <DATA_ROOT>/${row.slug}/data del nodo y quita dataPath antes de migrarlo`);
    }
    const targetServers: TargetServer[] = this.app.servers.list(targetNodeId).map((r) => ({ slug: r.slug, spec: JSON.parse(r.spec) as Spec }));
    // Lo que ya reservan otras migraciones sin confirmar hacia ese nodo y, si el nodo es el origen de una migración
    // confirmada con la retirada pendiente, su slug: <DATA_ROOT>/<slug> sigue allí hasta MigrateRetire, que lo
    // aparta sin spec (sus puertos no: ese servidor está parado y ya vive en otro nodo).
    const reservedSlugs: string[] = [];
    for (const m of this.app.migrations.listOpen()) {
      if (m.target_node_id === targetNodeId && m.phase !== "committed" && m.server_id !== row.id) {
        targetServers.push({ slug: m.target_slug, spec: JSON.parse(m.target_spec) as Spec });
      }
      if (m.source_node_id === targetNodeId && m.phase === "committed") reservedSlugs.push(m.source_slug);
    }
    const p = proposeTarget({ slug: row.slug, spec, targetServers, reservedSlugs, range: this.app.config.gamePortRange, requestedPort: port });
    if (!p.ok) throw new HttpError(409, p.error);
    const parsed = specSchema.safeParse({ ...spec, ports: { ...spec.ports, game: p.port } });
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return { target: { id: target.id, name: target.name }, slug: p.slug, port: p.port, portChanged: p.portChanged, currentPort: spec.ports.game, spec: parsed.data };
  }

  private openMessage(m: MigrationRow): string {
    if (m.phase === "running") return "Ya hay una migración en curso de este servidor";
    if (m.phase === "rolling_back") {
      const parts = [m.target_pending ? `limpiar «${this.nodeName(m.target_node_id)}»` : "", m.source_pending ? `arrancar en «${this.nodeName(m.source_node_id)}»` : ""].filter(Boolean);
      return `Se está deshaciendo una migración anterior (pendiente: ${parts.join(" y ")}); espera a que vuelvan los nodos`;
    }
    return `La migración anterior aún tiene que retirar el servidor del nodo «${this.nodeName(m.source_node_id)}»; espera a que vuelva a conectar`;
  }

  private async run(id: string): Promise<void> {
    this.busy.add(id);
    const report = new JobReporter(this.app.jobs, id);
    const d = this.deps(report);
    let step: MigrationStep = 1;
    let staged: StagedFile | null = null;
    try {
      try {
        const m = this.app.migrations.get(id)!;
        report.step(1, m.was_running ? "parando el servidor" : "comprobando que está parado");
        await stopSource(d, m);
        step = 2;
        report.step(2, "pidiendo la copia al nodo origen");
        const made = await backupSource(d, m);
        step = 3;
        report.step(3, made.filename);
        const pushed = await pushToPanel(d, m, made);
        staged = pushed.staged;
        step = 4;
        report.step(4, `enviando la copia a «${this.nodeName(m.target_node_id)}»`);
        await receiveOnTarget(d, m, pushed, made);
        await this.app.staging.remove(pushed.staged);
        staged = null;
        step = 5;
        report.step(5, `slug ${m.target_slug}, puerto ${m.target_port}, versión ${m.target_version}`);
        await applyOnTarget(d, m);
        step = 6;
        report.step(6, "arrancando");
        let observed: ObservedDto | null = await startAndVerify(d, m);
        if (!m.was_running) {
          report.within(6, 0.9, "estaba parado: se vuelve a parar");
          await stopTarget(d, m);
          observed = null; // el próximo ServerObserved del destino lo rellena
        }
        step = 7;
        report.step(7, "confirmando el cambio de nodo");
        this.commit(id, observed);
        // Desde aquí el servidor vive en el destino: nada de lo que siga puede deshacer (ver rollback).
        this.afterCommit(id, observed);
      } catch (e) {
        if (staged) await this.app.staging.remove(staged).catch(() => {});
        await this.rollback(id, step, e, report);
        return;
      }
      await this.finishCommitted(id, report);
    } catch (e) {
      // Ni rollback ni finishCommitted deberían lanzar; si pasa, que no quede un rechazo sin manejar.
      this.app.log.error({ err: e, migrationId: id }, "fallo inesperado gestionando una migración");
    } finally {
      this.busy.delete(id);
    }
  }

  /** Commit: la fila pasa al destino en una transacción (si la versión no cambió). Lanza StepError si no se pudo. */
  private commit(id: string, observed: ObservedDto | null): void {
    const m = this.app.migrations.get(id)!;
    if (!this.app.migrations.commit(m, m.was_running ? "running" : "stopped", observed)) {
      throw new StepError("No se pudo confirmar: la configuración del servidor cambió durante la migración, o su slug o su puerto dejaron de estar libres en el destino");
    }
  }

  /**
   * Tras el commit: aviso del último observado e inventario de copias del destino (da de alta la copia pre_migration
   * recibida; las del origen se dan por borradas). Nunca lanza: un fallo aquí no puede deshacer una migración ya
   * confirmada.
   */
  private afterCommit(id: string, observed: ObservedDto | null): void {
    const m = this.app.migrations.get(id);
    if (!m) return;
    try {
      if (observed) this.app.events.emit("observed", m.server_id, observed);
      void Promise.resolve(this.app.backupsService.sync(m.target_node_id)).catch((e: unknown) => this.app.log.warn({ err: e, migrationId: id }, "inventario de copias del destino fallido tras la migración"));
    } catch (e) {
      this.app.log.error({ err: e, migrationId: id }, "fallo tras confirmar una migración (no se deshace)");
    }
  }

  private async finishCommitted(id: string, report: Reporter): Promise<void> {
    report.within(7, 0.5, "retirando el servidor del nodo origen");
    const m = await this.settle(id, (line) => report.log(line));
    if (!m) {
      this.app.jobs.finish(id, "ok", "Migración completada; se borró el nodo origen antes de retirar el servidor de allí");
      return;
    }
    const name = this.app.servers.get(m.server_id)?.name ?? "El servidor";
    const where = `«${name}» está en «${this.nodeName(m.target_node_id)}», puerto ${m.target_port}`;
    const kept = m.delete_source ? "sus datos se borrarán" : `sus datos quedarán en ${m.source_slug}.migrated-…`;
    this.app.jobs.finish(id, "ok", m.phase === "done"
      ? `Migración completada: ${where}`
      : `Migración completada: ${where}. El nodo «${this.nodeName(m.source_node_id)}» no respondió: el servidor se retirará de allí (${kept}) cuando vuelva a conectar`);
  }

  private async rollback(id: string, step: MigrationStep, err: unknown, report: Reporter): Promise<void> {
    const msg = errorText(err);
    if (!isKnownError(err)) this.app.log.error({ err, migrationId: id }, "fallo inesperado en una migración");
    // Solo se deshace lo que sigue en curso: si ya se confirmó, el servidor vive en el destino y deshacer lo borraría.
    if (!this.app.migrations.startRollback(id, `Paso ${step}: ${msg}`)) {
      const cur = this.app.migrations.get(id);
      if (cur && (cur.phase === "committed" || cur.phase === "done")) {
        this.app.log.error({ err, migrationId: id }, "fallo tras confirmar una migración: no se deshace");
        await this.finishCommitted(id, report);
        return;
      }
      this.app.jobs.finish(id, "failed", `Paso ${step}/7 (${MIGRATION_STEPS[step - 1]}): ${msg}. La migración ya no existe (¿se borró un nodo?): revisa el servidor en su nodo de origen`);
      return;
    }
    report.log(`ERROR en el paso ${step}: ${msg}`);
    report.message(step, "deshaciendo la migración");
    const m = await this.settle(id, (line) => report.log(line));
    this.app.jobs.finish(id, "failed", `Paso ${step}/7 (${MIGRATION_STEPS[step - 1]}): ${msg}. ${m ? this.originText(m) : GONE}`);
  }

  private originText(m: MigrationRow): string {
    const src = this.nodeName(m.source_node_id);
    const dst = this.nodeName(m.target_node_id);
    if (m.phase === "failed") {
      return m.was_running ? `El servidor sigue en «${src}» con su mundo intacto y se ha vuelto a arrancar` : `El servidor sigue en «${src}» con su mundo intacto (parado, como estaba)`;
    }
    if (m.source_pending && m.target_pending && m.target_started) {
      return `El servidor sigue en «${src}» con su mundo intacto, pero parado: se arrancará cuando «${dst}» vuelva y se haya retirado la copia de allí (para no tener dos servidores vivos con el mismo mundo)`;
    }
    const parts: string[] = [];
    if (m.target_pending) parts.push(`la copia a medias de «${dst}» se borrará cuando vuelva a conectar`);
    if (m.source_pending) parts.push(`se volverá a arrancar cuando «${src}» vuelva a conectar`);
    return `El servidor sigue en «${src}» con su mundo intacto; ${parts.join("; ")}`;
  }

  /**
   * Intenta lo pendiente de una migración que se deshace o ya se confirmó y devuelve la fila resultante. Deshacer:
   * primero el destino (MigrateAbort) y después el origen; si el destino llegó a arrancarse y no se ha podido
   * limpiar, el origen NO se arranca (nunca dos servidores vivos con el mismo mundo). Confirmada: MigrateRetire.
   */
  private async settle(id: string, log: (line: string) => void): Promise<MigrationRow | null> {
    const repo = this.app.migrations;
    const d = this.deps(silent(log));
    // Tras cada espera se relee la fila: borrar un nodo borra sus migraciones en cascada (escapatoria).
    let m = repo.get(id);
    if (m?.phase === "rolling_back") {
      if (m.target_pending) {
        try {
          await abortTarget(d, m);
          m = repo.get(id) && repo.update(id, { target_pending: 0 });
          if (m) log(`Destino limpio: se borró lo que la migración dejó en «${this.nodeName(m.target_node_id)}»`);
        } catch (e) {
          log(`No se pudo limpiar el destino: ${errorText(e)} (se reintentará)`);
          m = repo.get(id);
        }
      }
      // Nunca dos servidores vivos con el mismo mundo: si el destino llegó a arrancar y no está limpio, el origen espera.
      if (m && m.source_pending && !(m.target_started && m.target_pending)) {
        try {
          await restartSource(d, m);
          m = repo.get(id) && repo.update(id, { source_pending: 0 });
          if (m) log(`Servidor arrancado de nuevo en «${this.nodeName(m.source_node_id)}»`);
        } catch (e) {
          log(`No se pudo volver a arrancar el servidor en el origen: ${errorText(e)} (se reintentará)`);
          m = repo.get(id);
        }
      }
      if (m && !m.target_pending && !m.source_pending) m = repo.update(id, { phase: "failed" });
    } else if (m?.phase === "committed") {
      try {
        await retireSource(d, m);
        m = repo.get(id) && repo.update(id, { source_pending: 0, phase: "done" });
        if (m) log(`Servidor retirado de «${this.nodeName(m.source_node_id)}» (${m.delete_source ? "datos borrados" : `datos en ${m.source_slug}.migrated-…`})`);
      } catch (e) {
        log(`No se pudo retirar el servidor del origen: ${errorText(e)} (se reintentará)`);
        m = repo.get(id);
      }
    }
    return m;
  }
}
