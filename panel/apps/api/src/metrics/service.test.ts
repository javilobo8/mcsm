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

const T0 = 1_760_000_000; // multiple of 10
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
  it("stores host and servers of the node, and discards foreign or unknown servers", () => {
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
    expect(s.tps.at(-1)).toBeNull(); // no TPS (not Paper or not measured)
    const node = svc.series("node", "n1", "1h");
    expect(node.memLimitBytes.at(-1)).toBe(16 * 1024 ** 3);
    expect(node.diskTotalBytes.at(-1)).toBe(500);
  });

  it("without a ping there are no players, latency or TPS (null, not 0)", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { mcOnline: false, playersOnline: 0, tps: 20 })] }));
    const s = svc.series("server", "s1", "1h");
    expect(s.cpuPct.at(-1)).toBe(25.5);
    expect(s.playersOnline.at(-1)).toBeNull();
    expect(s.pingMs.at(-1)).toBeNull();
    expect(s.tps.at(-1)).toBeNull();
  });

  it("stores the TPS if present, including 0", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { tps: 0 }), server("s2", { tps: 19.87 })] }));
    expect(svc.series("server", "s1", "1h").tps.at(-1)).toBe(0);
    expect(svc.series("server", "s2", "1h").tps.at(-1)).toBe(19.87);
  });

  it("rounds to 10 s and uses the panel's time if the node's clock is skewed", () => {
    svc.ingest("n1", batch(T0 + 7, { servers: [server("s1")] })); // → T0
    svc.ingest("n1", batch(T0 + 3_600, { servers: [server("s2")] })); // node 1 h ahead → T0
    svc.ingest("n1", batch(0, { servers: [server("s2", { cpuPct: 50 })] })); // clock at zero → T0, replaces
    const s1 = svc.series("server", "s1", "1h");
    const s2 = svc.series("server", "s2", "1h");
    expect(s1.t.at(-1)).toBe(T0);
    expect(s1.cpuPct.at(-1)).toBe(25.5);
    expect(s2.cpuPct.at(-1)).toBe(50);
    expect(repo.count("server", "s2")).toBe(1);
  });

  it("accepts the agent's ts up to MAX_CLOCK_SKEW_SECONDS in the future (45 s) and no further", () => {
    const now = T0 + 5; // the panel is at T0 + 5 (see the service's nowSec)
    expect(svc.slotOf("n1", now + 40)).toBe(T0 + 40);
    expect(svc.slotOf("n1", now + 50)).toBe(T0);
  });

  it("with the node's clock skewed, the variable arrival delay does not put two batches in one window", () => {
    const agentT = T0 - 7_200; // node 2 h behind (multiple of 10)
    nowMs = (T0 + 8) * 1000;
    expect(svc.slotOf("n1", agentT)).toBe(T0);
    nowMs = (T0 + 21) * 1000; // the second batch arrives late
    expect(svc.slotOf("n1", agentT + 10)).toBe(T0 + 10);
    nowMs = (T0 + 28) * 1000; // and the third early: with the panel's time both would fall in T0 + 20
    expect(svc.slotOf("n1", agentT + 20)).toBe(T0 + 20);
    expect(svc.slotOf("n2", T0 + 20)).toBe(T0 + 20); // each node with its own skew
    nowMs = (T0 + 31) * 1000; // the node corrects its clock
    expect(svc.slotOf("n1", T0 + 30)).toBe(T0 + 30);
  });

  it("forgetNode forgets the node's skew (deleted): the next skewed batch recomputes it", () => {
    nowMs = (T0 + 5) * 1000;
    expect(svc.slotOf("n1", T0 + 1_000)).toBe(T0); // fixed skew -1000
    expect(svc.slotOf("n2", T0 + 2_000)).toBe(T0);
    svc.forgetNode("n1");
    // With the earlier skew it would fall in T0 + 30 (within tolerance); once forgotten, it is recomputed to -1030.
    expect(svc.slotOf("n1", T0 + 1_030)).toBe(T0);
    expect(svc.slotOf("n2", T0 + 2_030)).toBe(T0 + 30); // the other node's stays
  });

  it("the series carries the panel's time", () => {
    expect(svc.series("server", "s1", "1h").now).toBe(T0 + 5);
  });

  it("a non-finite CPU (faulty agent) is stored as 0", () => {
    svc.ingest("n1", batch(T0, { servers: [server("s1", { cpuPct: Number.NaN })] }));
    expect(svc.series("server", "s1", "1h").cpuPct.at(-1)).toBe(0);
  });

  it("emits node_metrics with the host sample", () => {
    const seen: unknown[] = [];
    events.on("node_metrics", (nodeId, sample) => seen.push({ nodeId, sample }));
    svc.ingest("n1", batch(T0, { servers: [server("s1")] })); // no host: does not emit
    svc.ingest("n1", batch(T0 + 10, { host: { cpuPct: 40, memUsedBytes: 1n, memTotalBytes: 2n, diskUsedBytes: 3n, diskTotalBytes: 4n } }));
    expect(seen).toEqual([{ nodeId: "n1", sample: { ts: T0 + 10, cpuPct: 40, memBytes: 1, memTotalBytes: 2, diskBytes: 3, diskTotalBytes: 4 } }]);
  });
});

describe("Plan 2 acceptance criteria", () => {
  it("a server running for 2 minutes gives ≥ 10 points on the 1 h chart", () => {
    for (let i = 0; i < 12; i++) {
      nowMs = (T0 + i * 10 + 5) * 1000;
      svc.ingest("n1", batch(T0 + i * 10, { servers: [server("s1")] }));
    }
    const s = svc.series("server", "s1", "1h");
    expect(s.cpuPct.filter((v) => v !== null).length).toBeGreaterThanOrEqual(10);
    expect(s.playersOnline.filter((v) => v !== null).length).toBeGreaterThanOrEqual(10);
  });

  it("the table does not exceed ~70k rows per server per week (8 days of samples with duplicates and hourly purge)", () => {
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
        if (k % 60 === 0) insert(ts); // resends in the same window (reconnection)
      }
      nowMs = (T0 + (h + 1) * 3_600) * 1000;
      scheduled[0]!.fn(); // hourly purge
    }
    const rows = repo.count("server", "s1");
    expect(rows).toBeLessThanOrEqual(RETENTION_SECONDS / 10 + 360);
    expect(rows).toBeLessThan(70_000);
    expect(rows).toBeGreaterThanOrEqual(RETENTION_SECONDS / 10); // does not over-purge: 7 full days
    svc.stop();
    expect(scheduled).toHaveLength(0);
  });

  it("start purges on startup whatever exceeds 7 days", () => {
    repo.insertMany([
      { scope: "node", scopeId: "n1", ts: T0 - RETENTION_SECONDS - 10, cpuPct: 1, memBytes: null, memLimitBytes: null, netRxBytes: null, netTxBytes: null, diskBytes: null, diskTotalBytes: null, playersOnline: null, playersMax: null, tps: null, pingMs: null },
      { scope: "node", scopeId: "n1", ts: T0 - 10, cpuPct: 1, memBytes: null, memLimitBytes: null, netRxBytes: null, netTxBytes: null, diskBytes: null, diskTotalBytes: null, playersOnline: null, playersMax: null, tps: null, pingMs: null },
    ]);
    svc.start();
    expect(repo.count("node", "n1")).toBe(1);
    svc.stop();
  });
});
