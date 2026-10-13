import type { EventEmitter } from "node:events";
import type { MetricBatch } from "@mcsm/proto";
import { MAX_CLOCK_SKEW_SECONDS, type MetricRange, type MetricSeries, type NodeLiveSample } from "@mcsm/shared";
import type { MetricRow, MetricScope, MetricsRepo } from "./repo.js";

/** Retención del histórico: 7 días (spec §4). */
export const RETENTION_SECONDS = 7 * 86_400;
/** Cada cuánto se purga lo que excede la retención. */
export const PURGE_EVERY_MS = 3_600_000;

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

  private offsets = new Map<string, number>(); // desfase fijo (s) de cada nodo con el reloj fuera de tolerancia

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  /**
   * Ventana de 10 s del lote. Con el reloj del agente razonable (±MAX_CLOCK_SKEW_SECONDS), la suya. Si no, la del
   * agente más un desfase FIJO por nodo, calculado con el primer lote desfasado para que caiga en la ventana actual
   * del panel: así el retraso variable de llegada no junta dos lotes en la misma ventana ni deja huecos (m-3 del
   * Plan 2). Si el nodo corrige su reloj o el desfase deja de cuadrar (±45 s), se recalcula.
   */
  slotOf(nodeId: string, agentTs: number): number {
    const now = this.nowSec();
    if (!Number.isFinite(agentTs)) return now - (now % 10);
    if (Math.abs(agentTs - now) <= MAX_CLOCK_SKEW_SECONDS) {
      this.offsets.delete(nodeId);
      return agentTs - (agentTs % 10);
    }
    let offset = this.offsets.get(nodeId);
    if (offset === undefined || Math.abs(agentTs + offset - now) > MAX_CLOCK_SKEW_SECONDS) {
      offset = now - (now % 10) - agentTs;
      this.offsets.set(nodeId, offset);
    }
    const ts = agentTs + offset;
    return ts - (ts % 10);
  }

  /** Olvida lo que se guarda en memoria de un nodo borrado (su desfase de reloj). */
  forgetNode(nodeId: string): void {
    this.offsets.delete(nodeId);
  }

  /** Guarda un MetricBatch del agente. Devuelve cuántas filas escribió. */
  ingest(nodeId: string, batch: MetricBatch): number {
    const ts = this.slotOf(nodeId, Number(batch.tsUnix));
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
      try {
        this.deps.events.emit("node_metrics", nodeId, sample);
      } catch (e) {
        // Un listener que lanza no debe romper la ingesta: las filas ya están guardadas.
        this.deps.log?.warn({ err: e }, "fallo en un listener de node_metrics");
      }
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
    return { ...this.deps.repo.series(scope, scopeId, range, this.nowSec()), now: this.nowSec() };
  }

  private safePurge() {
    try {
      this.purge();
    } catch (e) {
      this.deps.log?.warn({ err: e }, "fallo purgando métricas antiguas");
    }
  }
}
