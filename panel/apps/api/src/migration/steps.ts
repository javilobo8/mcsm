import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { pipeline, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { BackupTrigger, PowerActionType } from "@mcsm/proto";
import { AgentError, type AgentConn } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { IDLE_TIMEOUT_MS, idleGuard, type Timers } from "../files/stream.js";
import { newId } from "../lib/ids.js";
import { toServerSpecMessage, type ObservedDto, type ServerRow } from "../servers/repo.js";
import type { StagedFile } from "../transfers/staging.js";
import { errorText, StepError } from "./errors.js";
import { requiredSpace, retargetFilename } from "./propose.js";
import type { MigrationRow } from "./repo.js";
import type { Reporter } from "./report.js";
import { onAgentMessage, waitJob, waitObserved } from "./wait.js";

export interface MigrationTimings {
  /** Lo que se espera a que el servidor quede sano en el destino (spec §7: 5 min). */
  verifyTimeoutMs: number;
  /** Sin avances de un sub-job del agente (copia, recepción) durante este tiempo, se da por muerto. */
  jobIdleMs: number;
  /** Intentos de la recepción en el destino (la copia sigue en el staging entre intentos). */
  receiveAttempts: number;
  /** Espacio libre en bytes del sistema de ficheros de dir. */
  freeSpace: (dir: string) => Promise<number>;
}

export const DEFAULT_TIMINGS: MigrationTimings = {
  verifyTimeoutMs: 5 * 60_000,
  jobIdleMs: 30 * 60_000,
  receiveAttempts: 2,
  freeSpace: async (dir) => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  },
};

export interface StepDeps { app: FastifyInstance; timers: Timers; timings: MigrationTimings; report: Reporter }
export interface BackupMade { filename: string; sizeBytes: number; sha256: string }
export interface Pushed { staged: StagedFile; dataBytes: number }

/**
 * Plazo para que el destino reclame la copia (GET /agent/transfer). La recepción espera uno de los 2 huecos de
 * copia/restauración del nodo ANTES de descargar («En cola…»): con el plazo de 60 s de Archivos, dos copias
 * programadas a la vez en el destino harían fallar la migración sin motivo. El mismo orden que jobIdleMs.
 */
export const MIGRATION_CLAIM_TTL_MS = 30 * 60_000;

/** Sin plazo total (máximo de setTimeout): una transferencia que avanza dura lo que haga falta (como en Archivos). */
const NO_DEADLINE_MS = 2 ** 31 - 1;
/** Retirar o deshacer puede borrar un mundo entero en un disco lento. */
const LONG_MS = 5 * 60_000;

export const stagingId = (migrationId: string): string => `mig-${migrationId}`;

const isDoubtful = (e: unknown): boolean =>
  e instanceof AgentError && (e.code === AgentErrorCode.Disconnected || e.code === AgentErrorCode.Timeout);

function fmtBytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(n / 1024 ** 2)} MiB`;
}

function connOf(app: FastifyInstance, nodeId: string): AgentConn {
  const conn = app.agents.get(nodeId);
  if (!conn) throw new StepError(`El nodo «${app.nodes.get(nodeId)?.name ?? nodeId}» está desconectado`);
  return conn;
}

/**
 * La fila tal y como queda en el destino, para `toServerSpecMessage`: otro nodo, slug, spec y versión, y sin
 * `imported_from` (Plan 6): un servidor migrado ya no sigue a ningún contenedor original (sin `adopt`).
 */
export function targetRow(row: ServerRow, m: MigrationRow, desired: "running" | "stopped"): ServerRow {
  const out = { ...row, node_id: m.target_node_id, slug: m.target_slug, spec: m.target_spec, spec_version: m.target_version, desired_state: desired } as ServerRow & { imported_from?: unknown };
  if ("imported_from" in out) out.imported_from = null;
  return out;
}

/** Paso 1. Para el servidor en el origen y deja `stopped` como estado deseado en el agente y en la fila. */
export async function stopSource(d: StepDeps, m: MigrationRow): Promise<void> {
  try {
    await d.app.serversService.power(m.server_id, "stop");
  } catch (e) {
    throw new StepError(`No se pudo parar el servidor en el origen: ${errorText(e)}`);
  }
  d.report.log(m.was_running ? "Servidor parado en el origen" : "El servidor ya estaba parado en el origen");
}

/**
 * Paso 2. Copia `pre_migration` en el origen (BackupNow) como sub-job `backup`; su avance se refleja en el job. El
 * fichero, su tamaño y su sha256 salen del BackupCreated con el mismo job_id, que el agente encola antes del final del
 * job (misma cola FIFO): cuando el job termina bien, el aviso ya ha llegado.
 */
export async function backupSource(d: StepDeps, m: MigrationRow): Promise<BackupMade> {
  const { app } = d;
  const conn = connOf(app, m.source_node_id);
  const jobId = newId();
  app.jobs.create({
    id: jobId, type: "backup", serverId: m.server_id, nodeId: m.source_node_id, status: "running",
    message: "Solicitando la copia previa a la migración", payload: { trigger: "pre_migration", migrationId: m.id },
  });
  let made: BackupMade | null = null;
  const offCreated = onAgentMessage(app.agents, (nodeId, env) => {
    if (nodeId !== m.source_node_id || env.body.case !== "backupCreated" || env.body.value.jobId !== jobId) return;
    const b = env.body.value.backup;
    if (b && b.serverId === m.server_id) made = { filename: b.filename, sizeBytes: Number(b.sizeBytes), sha256: b.sha256 };
  });
  const wait = waitJob(app, jobId, {
    idleMs: d.timings.jobIdleMs, timers: d.timers, idleMessage: "La copia previa lleva demasiado tiempo sin avanzar",
    onProgress: (j) => d.report.within(2, j.progress / 100, j.message || "copiando"),
  });
  try {
    try {
      await conn.request({ case: "backupNow", value: { serverId: m.server_id, jobId, trigger: BackupTrigger.PRE_MIGRATION } }, 30_000);
    } catch (e) {
      if (!isDoubtful(e)) {
        app.jobs.finish(jobId, "failed", errorText(e));
        throw new StepError(`El nodo origen no pudo hacer la copia: ${errorText(e)}`);
      }
      d.report.log("El nodo origen aún no ha confirmado la copia; se espera a que informe");
    }
    const job = await wait.promise;
    if (job.status !== "ok") throw new StepError(`La copia previa falló: ${job.message}`);
    const got = made as BackupMade | null;
    if (!got) throw new StepError("La copia se hizo pero el panel no recibió su aviso (BackupCreated): vuelve a intentarlo");
    if (!got.sha256) throw new StepError("La copia no tiene sha256: no se migra sin poder comprobarla");
    d.report.log(`Copia ${got.filename}: ${fmtBytes(got.sizeBytes)}, sha256 ${got.sha256}`);
    return got;
  } finally {
    offCreated();
    wait.cancel();
  }
}

/**
 * Paso 3. El origen sube la copia (BackupPush → PUT /agent/transfer) al staging del panel. Se comprueba antes el
 * espacio del panel y, al llegar, el tamaño exacto y el sha256 (frente al BackupCreated y al BackupPushResult). Si algo
 * falla, no queda nada en el staging.
 */
export async function pushToPanel(d: StepDeps, m: MigrationRow, made: BackupMade): Promise<Pushed> {
  const { app } = d;
  const free = await d.timings.freeSpace(app.config.dataDir).catch(() => null);
  if (free !== null && free < requiredSpace(made.sizeBytes)) {
    throw new StepError(`No hay espacio en el panel para la copia: hacen falta ${fmtBytes(requiredSpace(made.sizeBytes))} y quedan ${fmtBytes(free)} libres`);
  }
  const conn = connOf(app, m.source_node_id);
  const t = app.transfers.inbound(m.source_node_id);
  const req = conn.request({ case: "backupPush", value: { serverId: m.server_id, filename: made.filename, transferId: t.id } }, NO_DEADLINE_MS);
  req.catch(() => {});
  let staged: StagedFile | null = null;
  try {
    const incoming = await Promise.race([
      t.incoming,
      req.then((): never => { throw new StepError("El nodo origen terminó sin enviar la copia"); }),
    ]);
    if (incoming.size !== null && incoming.size !== made.sizeBytes) {
      throw new StepError(`El nodo origen envía ${incoming.size} bytes y la copia mide ${made.sizeBytes}`);
    }
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        d.report.within(3, received / Math.max(made.sizeBytes, 1), `subiendo (${fmtBytes(received)} de ${fmtBytes(made.sizeBytes)})`);
        cb(null, chunk);
      },
    });
    const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
      t.cancel("el nodo origen dejó de enviar la copia");
      return new StepError("El nodo origen dejó de enviar la copia");
    }, d.timers);
    const src = pipeline(incoming.stream, guard, meter, () => { /* el resultado lo ve save */ });
    staged = await app.staging.save(stagingId(m.id), src, { maxBytes: made.sizeBytes });
    const res = await req;
    if (res.body.case !== "backupPushResult") throw new StepError("Respuesta inesperada del nodo origen");
    const digest = hash.digest("hex");
    if (staged.size !== made.sizeBytes || digest !== made.sha256 || res.body.value.sha256 !== made.sha256) {
      throw new StepError(`La copia llegó al panel dañada: sha256 ${digest}, esperado ${made.sha256}`);
    }
    d.report.log(`Copia en el panel: ${fmtBytes(staged.size)}, sha256 verificado`);
    return { staged, dataBytes: Number(res.body.value.dataBytes) };
  } catch (e) {
    t.cancel("migración fallida");
    if (staged) await app.staging.remove(staged).catch(() => {});
    throw e;
  }
}

/**
 * Paso 4. El destino recibe la copia desde el staging (MigrateReceive → GET /agent/transfer) y la restaura, como
 * sub-job `migrate_in`. `target_touched` se marca ANTES de pedirlo: a partir de aquí, deshacer exige MigrateAbort. Un
 * fallo del job (o una orden sin respuesta) se reintenta una vez tras limpiar el intento anterior; un rechazo
 * explícito del agente (exists, too_large…) no.
 */
export async function receiveOnTarget(d: StepDeps, m: MigrationRow, pushed: Pushed, made: BackupMade): Promise<void> {
  const { app } = d;
  app.migrations.update(m.id, { target_touched: 1 });
  const filename = retargetFilename(made.filename, m.source_slug, m.target_slug);
  let last = "";
  for (let attempt = 1; attempt <= d.timings.receiveAttempts; attempt++) {
    if (attempt > 1) {
      d.report.log(`Reintentando la recepción en el destino (intento ${attempt} de ${d.timings.receiveAttempts})`);
      // El agente atiende cada mensaje en su goroutine: sin el Ack de la limpieza, un MigrateAbort aún pendiente
      // podría ejecutarse después de la nueva recepción y borrarla. Si no se confirma, no se reintenta (deshacer
      // seguirá intentando la limpieza).
      try {
        await abortTarget(d, m);
      } catch (e) {
        throw new StepError(`La recepción en el destino falló (${last}) y no se pudo limpiar el intento anterior: ${errorText(e)}`);
      }
    }
    const conn = connOf(app, m.target_node_id);
    const jobId = newId();
    app.jobs.create({
      id: jobId, type: "migrate_in", serverId: m.server_id, nodeId: m.target_node_id, status: "running",
      message: "Solicitando la recepción de la copia", payload: { migrationId: m.id },
    });
    const out = app.transfers.outbound(m.target_node_id, app.staging.source(pushed.staged, { removeAfter: false }), { claimTtlMs: MIGRATION_CLAIM_TTL_MS });
    out.done.catch(() => {});
    const wait = waitJob(app, jobId, {
      idleMs: d.timings.jobIdleMs, timers: d.timers, idleMessage: "La recepción en el destino lleva demasiado tiempo sin avanzar",
      onProgress: (j) => d.report.within(4, j.progress / 100, j.message || "recibiendo"),
    });
    try {
      try {
        await conn.request({ case: "migrateReceive", value: {
          serverId: m.server_id, slug: m.target_slug, jobId, migrationId: m.id, transferId: out.id, filename,
          sizeBytes: BigInt(made.sizeBytes), sha256: made.sha256, dataBytes: BigInt(pushed.dataBytes),
        } }, 30_000);
      } catch (e) {
        app.jobs.finish(jobId, "failed", errorText(e));
        if (!isDoubtful(e)) throw new StepError(`El nodo destino rechazó la copia: ${errorText(e)}`);
        last = errorText(e);
        continue;
      }
      const job = await wait.promise;
      if (job.status === "ok") {
        d.report.log("Copia recibida, verificada (sha256) y restaurada en el destino");
        return;
      }
      last = job.message;
    } finally {
      out.cancel("recepción terminada"); // sin efecto si ya terminó
      wait.cancel();
    }
  }
  throw new StepError(`La recepción en el destino falló: ${last}`);
}

/** Paso 5. El destino guarda la spec (slug y puerto del destino, versión +1) con el servidor parado. */
export async function applyOnTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  const row = d.app.servers.get(m.server_id);
  if (!row) throw new StepError("El servidor ya no existe en el panel");
  const conn = connOf(d.app, m.target_node_id);
  try {
    await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(targetRow(row, m, "stopped"), d.app.curseforge.get()) } }, 120_000);
  } catch (e) {
    throw new StepError(`El nodo destino no pudo crear el servidor: ${errorText(e)}`);
  }
  d.report.log(`Servidor creado en el destino (slug ${m.target_slug}, puerto ${m.target_port}, versión ${m.target_version})`);
}

/**
 * Paso 6. Arranca en el destino y espera a que quede sano (como mucho `verifyTimeoutMs`). `target_started` se marca
 * ANTES de la orden: si algo falla desde aquí, el origen no se rearranca hasta haber retirado la copia del destino.
 */
export async function startAndVerify(d: StepDeps, m: MigrationRow): Promise<ObservedDto> {
  d.app.migrations.update(m.id, { target_started: 1 });
  const conn = connOf(d.app, m.target_node_id);
  const w = waitObserved(d.app.agents, m.target_node_id, m.server_id, {
    timeoutMs: d.timings.verifyTimeoutMs, timers: d.timers,
    onObserved: (o) => d.report.within(6, 0.5, `estado ${o.state}${o.health ? `, healthcheck ${o.health}` : ""}`),
  });
  try {
    await conn.request({ case: "powerAction", value: { serverId: m.server_id, action: PowerActionType.START } }, 90_000);
  } catch (e) {
    w.cancel();
    throw new StepError(`El servidor no arrancó en el destino: ${errorText(e)}`);
  }
  d.report.within(6, 0.2, `esperando a que arranque y responda (máx. ${Math.round(d.timings.verifyTimeoutMs / 60_000)} min)`);
  const o = await w.promise;
  d.report.log(`El servidor responde en el destino (${o.health === "healthy" ? "healthcheck sano" : "ping correcto"})`);
  return o;
}

/** Paso 6 (si estaba parado). Lo vuelve a parar en el destino tras comprobarlo. */
export async function stopTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  try {
    await connOf(d.app, m.target_node_id).request({ case: "powerAction", value: { serverId: m.server_id, action: PowerActionType.STOP } }, 90_000);
  } catch (e) {
    throw new StepError(`No se pudo volver a parar el servidor en el destino: ${errorText(e)}`);
  }
}

/** Paso 7 (tras el commit). Retira el servidor del origen: <slug>.migrated-<ts> o borrado con «borrar origen». */
export async function retireSource(d: StepDeps, m: MigrationRow): Promise<void> {
  await connOf(d.app, m.source_node_id).request({ case: "migrateRetire", value: {
    serverId: m.server_id, slug: m.source_slug, migrationId: m.id, deleteData: m.delete_source === 1,
  } }, LONG_MS);
}

/**
 * Deshacer: borra del destino la spec, el contenedor y el directorio marcado de esta migración. NUNCA tras el commit:
 * el marcador se queda en el directorio del destino y el agente no sabe del commit, así que un MigrateAbort tardío
 * borraría el servidor vivo. La fase se lee de la tabla justo antes de enviar (el commit la cambia en su transacción
 * y una migración confirmada no vuelve atrás, ver MigrationsRepo.update).
 */
export async function abortTarget(d: StepDeps, m: MigrationRow): Promise<void> {
  const cur = d.app.migrations.get(m.id);
  if (!cur || (cur.phase !== "running" && cur.phase !== "rolling_back")) {
    throw new StepError(`La migración ya está ${cur ? "confirmada o cerrada" : "borrada"}: no se deshace nada en el destino`);
  }
  await connOf(d.app, m.target_node_id).request({ case: "migrateAbort", value: { serverId: m.server_id, slug: m.target_slug, migrationId: m.id } }, LONG_MS);
}

/** Deshacer: vuelve a arrancar el servidor en el origen (estado deseado `running` en el agente y en la fila). */
export async function restartSource(d: StepDeps, m: MigrationRow): Promise<void> {
  await d.app.serversService.power(m.server_id, "start");
}
