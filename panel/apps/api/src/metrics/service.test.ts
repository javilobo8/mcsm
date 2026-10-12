import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  HostMetricSampleSchema, MetricBatchSchema, ServerMetricSampleSchema,
  type HostMetricSample, type MetricBatch, type ServerMetricSample,
} from "@mcsm/proto";
import { openDb } from "../db/db.js";
import { MetricsRepo } from "./repo.js";
import { MetricsService, PURGE_EVERY_MS, RETENTION_SECONDS } from "./service.js";

const T0 = 1_760_000_000; // múltiplo de 10
let nowMs: number;
let repo: MetricsRepo;
let events: EventEmitter;
let svc: MetricsService;
let scheduled: { fn: () => void; ms: number }[];

type Fields<T> = Partial<Omit<T, "$typeName" | "$unknown">>;

const batch = (tsUnix: number, init: { host?: Fields<HostMetricSample>; servers?: ServerMetricSample[] } = {}): MetricBatch =>
  create(MetricBatchSchema, {
    tsUnix: BigInt(tsUnix),
    host: init.host ? create(HostMetricSampleSchema, init.host) : undefined,
    servers: init.servers ?? [],
  });

const server = (serverId: string, extra: Fields<ServerMetricSample> = {}): ServerMetricSample =>
  create(ServerMetricSampleSchema, {
    serverId, cpuPct: 25.5, memBytes: 2n << 30n, memLimitBytes: 5n << 30n, netRxBytes: 100n, netTxBytes: 200n,
    mcOnline: true, playersOnline: 3, playersMax: 20, pingMs: 4, ...extra,
  });

beforeEach(() => {
  nowMs = (T0 + 5) * 1000;
  repo = new MetricsRepo(openDb(":memory:"));
  events = new EventEmitter();
  scheduled = [];
  svc = new MetricsService({
    repo, events, now: () => nowMs,
    serverIdsOf: (nodeId) => new Set(nodeId === "n1" ? ["s1", "s2"] : ["s9"]),
    every: (fn, ms) => { scheduled.push({ fn, ms }); return () => { scheduled = scheduled.filter((s) => s.fn !== fn); }; },
  });
});

describe("MetricsService.ingest", () => {
  it("guarda host y servidores del nodo, y descarta servidores ajenos o desconocidos", () => {
    const n = svc.ingest("n1", batch(T0, {
      host: { cpuPct: 12.5, memUsedBytes: 6n << 30n, memTotalBytes: 16n << 30n, diskUsedBytes: 100n, diskTotalBytes: 500n },
      servers: [server("s1"), server("s9"), server("borrado")],
    }));
    expect(n).toBe(2);
    expect(repo.count("node", "n1")).toBe(1);
    expect(repo.count("server", "s1")).toBe(1);
    expect(repo.count("server", "s9")).toBe(0);
    const s = svc.series("server", "s1", "1h");
    expect(s.cpuPct.at(-1)).toBe(25.5);
    expect(s.memBytes.at(-1)).toBe(2 * 1024 ** 3);
    expect(s.playersOnline.at(-1)).toBe(3);
    expect(s.tps.at(-1)).toBeNull(); // sin TPS (no es Paper o no se midió)
    const node = svc.series("node", "n1", "1h");
    expect(node.memLimitBytes.at(-1)).toBe(16 * 1024 ** 3);
    expect(node.diskTotalBytes.at(-1)).toBe(500);
  });

  it("sin ping no hay jugadores, latencia ni TPS (null, no 0)", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { mcOnline: false, playersOnline: 0, tps: 20 })] }));
    const s = svc.series("server", "s1", "1h");
    expect(s.cpuPct.at(-1)).toBe(25.5);
    expect(s.playersOnline.at(-1)).toBeNull();
    expect(s.pingMs.at(-1)).toBeNull();
    expect(s.tps.at(-1)).toBeNull();
  });

  it("guarda el TPS si viene, incluido 0", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { tps: 0 }), server("s2", { tps: 19.87 })] }));
    expect(svc.series("server", "s1", "1h").tps.at(-1)).toBe(0);
    expect(svc.series("server", "s2", "1h").tps.at(-1)).toBe(19.87);
  });

  it("redondea a 10 s y usa la hora del panel si el reloj del nodo está desfasado", () => {
    svc.ingest("n1", batch(T0 + 7, { servers: [server("s1")] })); // → T0
    svc.ingest("n1", batch(T0 + 3_600, { servers: [server("s2")] })); // nodo 1 h adelantado → T0
    svc.ingest("n1", batch(0, { servers: [server("s2", { cpuPct: 50 })] })); // reloj a cero → T0, reemplaza
    const s1 = svc.series("server", "s1", "1h");
    const s2 = svc.series("server", "s2", "1h");
    expect(s1.t.at(-1)).toBe(T0);
    expect(s1.cpuPct.at(-1)).toBe(25.5);
    expect(s2.cpuPct.at(-1)).toBe(50);
    expect(repo.count("server", "s2")).toBe(1);
  });

  it("un CPU no finito (agente defectuoso) se guarda como 0", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { cpuPct: Number.NaN })] }));
    expect(svc.series("server", "s1", "1h").cpuPct.at(-1)).toBe(0);
  });

  it("emite node_metrics con la muestra del host", () => {
    const seen: unknown[] = [];
    events.on("node_metrics", (nodeId, sample) => seen.push({ nodeId, sample }));
    svc.ingest("n1", batch(T0, { servers: [server("s1")] })); // sin host: no emite
    svc.ingest("n1", batch(T0 + 10, { host: { cpuPct: 40, memUsedBytes: 1n, memTotalBytes: 2n, diskUsedBytes: 3n, diskTotalBytes: 4n } }));
    expect(seen).toEqual([{ nodeId: "n1", sample: { ts: T0 + 10, cpuPct: 40, memBytes: 1, memTotalBytes: 2, diskBytes: 3, diskTotalBytes: 4 } }]);
  });
});

describe("criterios de aceptación del Plan 2", () => {
  it("un servidor en marcha 2 minutos da ≥ 10 puntos en la gráfica de 1 h", () => {
    for (let i = 0; i < 12; i++) {
      nowMs = (T0 + i * 10 + 5) * 1000;
      svc.ingest("n1", batch(T0 + i * 10, { servers: [server("s1")] }));
    }
    const s = svc.series("server", "s1", "1h");
    expect(s.cpuPct.filter((v) => v !== null).length).toBeGreaterThanOrEqual(10);
    expect(s.playersOnline.filter((v) => v !== null).length).toBeGreaterThanOrEqual(10);
  });

  it("la tabla no supera ~70k filas por servidor y semana (8 días de muestras con duplicados y purga horaria)", () => {
    svc.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(PURGE_EVERY_MS);
    const insert = (ts: number) => repo.insertMany([
      { scope: "server", scopeId: "s1", ts, cpuPct: 1, memBytes: 1, memLimitBytes: 1, netRxBytes: 0, netTxBytes: 0, diskBytes: null, diskTotalBytes: null, playersOnline: 0, playersMax: 20, tps: null, pingMs: 1 },
    ]);
    const hours = 8 * 24;
    for (let h = 0; h < hours; h++) {
      for (let k = 0; k < 360; k++) {
        const ts = T0 + h * 3_600 + k * 10;
        insert(ts);
        if (k % 60 === 0) insert(ts); // reenvíos en la misma ventana (reconexión)
      }
      nowMs = (T0 + (h + 1) * 3_600) * 1000;
      scheduled[0]!.fn(); // purga horaria
    }
    const rows = repo.count("server", "s1");
    expect(rows).toBeLessThanOrEqual(RETENTION_SECONDS / 10 + 360);
    expect(rows).toBeLessThan(70_000);
    expect(rows).toBeGreaterThanOrEqual(RETENTION_SECONDS / 10); // no purga de más: 7 días completos
    svc.stop();
    expect(scheduled).toHaveLength(0);
  });

  it("start purga al arrancar lo que excede los 7 días", () => {
    repo.insertMany([
      { scope: "node", scopeId: "n1", ts: T0 - RETENTION_SECONDS - 10, cpuPct: 1, memBytes: null, memLimitBytes: null, netRxBytes: null, netTxBytes: null, diskBytes: null, diskTotalBytes: null, playersOnline: null, playersMax: null, tps: null, pingMs: null },
      { scope: "node", scopeId: "n1", ts: T0 - 10, cpuPct: 1, memBytes: null, memLimitBytes: null, netRxBytes: null, netTxBytes: null, diskBytes: null, diskTotalBytes: null, playersOnline: null, playersMax: null, tps: null, pingMs: null },
    ]);
    svc.start();
    expect(repo.count("node", "n1")).toBe(1);
    svc.stop();
  });
});
