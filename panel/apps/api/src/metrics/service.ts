import type { EventEmitter } from "node:events";
import type { MetricBatch } from "@mcsm/proto";
import type { MetricRange, MetricSeries, NodeLiveSample } from "@mcsm/shared";
import type { MetricRow, MetricScope, MetricsRepo } from "./repo.js";

/** Retención del histórico: 7 días (spec §4). */
export const RETENTION_SECONDS = 7 * 86_400;
/** Cada cuánto se purga lo que excede la retención. */
export const PURGE_EVERY_MS = 3_600_000;
/** Si el reloj del nodo difiere más que esto del panel, el lote se fecha con la hora del panel. */
export const MAX_SKEW_SECONDS = 30;

type Cancel = () => void;

export interface MetricsDeps {
  repo: MetricsRepo;
  /** Ids de los servidores del nodo: las muestras de servidores ajenos o borrados se descartan. */
  serverIdsOf: (nodeId: string) => Set<string>;
  /** Recibe `node_metrics` (nodeId, NodeLiveSample) en cada lote con datos del host. */
  events: EventEmitter;
  /** Reloj en ms (inyectable en tests). */
  now?: () => number;
  /** Repite `fn` cada `ms` y devuelve la función que lo cancela (inyectable en tests). */
  every?: (fn: () => void, ms: number) => Cancel;
  log?: { warn(obj: object, msg: string): void };
}

const defaultEvery = (fn: () => void, ms: number): Cancel => {
  const t = setInterval(fn, ms);
  t.unref();
  return () => clearInterval(t);
};

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Ingesta por lotes, purga horaria y agregación en consulta (spec §7 `MetricsService`). */
export class MetricsService {
  private stopPurge: Cancel | null = null;
  private now: () => number;

  constructor(private deps: MetricsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Ventana de 10 s del lote: la del agente si su reloj es razonable; si no, la del panel. */
  slotOf(agentTs: number): number {
    const now = this.nowSec();
    const ts = Number.isFinite(agentTs) && Math.abs(agentTs - now) <= MAX_SKEW_SECONDS ? agentTs : now;
    return ts - (ts % 10);
  }

  /** Guarda un MetricBatch del agente. Devuelve cuántas filas escribió. */
  ingest(nodeId: string, batch: MetricBatch): number {
    const ts = this.slotOf(Number(batch.tsUnix));
    const rows: MetricRow[] = [];
    const h = batch.host;
    if (h) {
      rows.push({
        scope: "node", scopeId: nodeId, ts, cpuPct: finite(h.cpuPct),
        memBytes: Number(h.memUsedBytes), memLimitBytes: Number(h.memTotalBytes), netRxBytes: null, netTxBytes: null,
        diskBytes: Number(h.diskUsedBytes), diskTotalBytes: Number(h.diskTotalBytes),
        playersOnline: null, playersMax: null, tps: null, pingMs: null,
      });
    }
    if (batch.servers.length > 0) {
      const mine = this.deps.serverIdsOf(nodeId);
      for (const s of batch.servers) {
        if (!mine.has(s.serverId)) continue;
        const online = s.mcOnline;
        rows.push({
          scope: "server", scopeId: s.serverId, ts, cpuPct: finite(s.cpuPct),
          memBytes: Number(s.memBytes), memLimitBytes: Number(s.memLimitBytes),
          netRxBytes: Number(s.netRxBytes), netTxBytes: Number(s.netTxBytes), diskBytes: null, diskTotalBytes: null,
          playersOnline: online ? s.playersOnline : null, playersMax: online ? s.playersMax : null,
          pingMs: online ? s.pingMs : null,
          tps: online && s.tps !== undefined && Number.isFinite(s.tps) ? s.tps : null,
        });
      }
    }
    this.deps.repo.insertMany(rows);
    if (h) {
      const sample: NodeLiveSample = {
        ts, cpuPct: finite(h.cpuPct), memBytes: Number(h.memUsedBytes), memTotalBytes: Number(h.memTotalBytes),
        diskBytes: Number(h.diskUsedBytes), diskTotalBytes: Number(h.diskTotalBytes),
      };
      this.deps.events.emit("node_metrics", nodeId, sample);
    }
    return rows.length;
  }

  /** Borra lo que excede la retención. Devuelve cuántas filas borró. */
  purge(): number {
    return this.deps.repo.deleteOlderThan(this.nowSec() - RETENTION_SECONDS);
  }

  /** Purga ahora y después cada hora. */
  start(): void {
    if (this.stopPurge) return;
    this.safePurge();
    this.stopPurge = (this.deps.every ?? defaultEvery)(() => this.safePurge(), PURGE_EVERY_MS);
  }

  stop(): void {
    this.stopPurge?.();
    this.stopPurge = null;
  }

  series(scope: MetricScope, scopeId: string, range: MetricRange): MetricSeries {
    return this.deps.repo.series(scope, scopeId, range, this.nowSec());
  }

  private safePurge() {
    try {
      this.purge();
    } catch (e) {
      this.deps.log?.warn({ err: e }, "fallo purgando métricas antiguas");
    }
  }
}
