import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { MAX_CLOCK_SKEW_SECONDS, type MetricSeries, type NodeLiveSample } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";
import { topicOf } from "./ws";
import {
  aligned, applyNodeMetricsEvent, memAligned, bindNodeMetrics, entryFromSeries, formatCpu, formatTps, clampPct, hasData, isFresh, latestNodeSample, percent, totalText, usageTone, type NodeLiveEntry,
} from "./metrics";

const series = (over: Partial<MetricSeries> = {}): MetricSeries => {
  const n = 3;
  const nulls = () => new Array<number | null>(n).fill(null);
  return {
    range: "1h", step: 10, t: [100, 110, 120], cpuPct: nulls(), memBytes: nulls(), memLimitBytes: nulls(), netRxBytes: nulls(),
    netTxBytes: nulls(), diskBytes: nulls(), diskTotalBytes: nulls(), playersOnline: nulls(), playersMax: nulls(), tps: nulls(),
    pingMs: nulls(), ...over,
  };
};
const sample = (ts: number, cpuPct = 10): NodeLiveSample => ({ ts, cpuPct, memBytes: 1, memTotalBytes: 2, diskBytes: 3, diskTotalBytes: 4 });
const entry = (receivedAtMs: number, ts = 0, cpuPct = 10): NodeLiveEntry => ({ sample: sample(ts, cpuPct), receivedAt: receivedAtMs });
const cached = (qc: QueryClient, id = "n1") => qc.getQueryData<NodeLiveEntry | null>(["node-live", id]);

describe("series", () => {
  it("aligned pone t delante de las columnas pedidas, en orden", () => {
    const s = series({ cpuPct: [1, null, 3], memBytes: [4, 5, 6] });
    expect(aligned(s, ["memBytes", "cpuPct"])).toEqual([[100, 110, 120], [4, 5, 6], [1, null, 3]]);
  });
  it("memAligned trata el límite 0 (desconocido) como null: no hay línea «Límite»", () => {
    const s = series({ memBytes: [1, 2, 3], memLimitBytes: [0, 0, 0] });
    const a = memAligned(s);
    expect(a[2]).toEqual([null, null, null]);
    expect(hasData(a[2]!)).toBe(false);
    expect(memAligned(series({ memBytes: [1, 2, 3], memLimitBytes: [0, 8, null] }))[2]).toEqual([null, 8, null]);
  });
  it("hasData distingue una columna vacía", () => {
    expect(hasData([null, null])).toBe(false);
    expect(hasData([null, 0])).toBe(true);
  });
  it("latestNodeSample toma el último cubo con datos", () => {
    const s = series({ cpuPct: [5, 7, null], memBytes: [1, 2, null], memLimitBytes: [8, 8, null], diskBytes: [3, 4, null], diskTotalBytes: [9, 9, null] });
    expect(latestNodeSample(s)).toEqual({ ts: 110, cpuPct: 7, memBytes: 2, memTotalBytes: 8, diskBytes: 4, diskTotalBytes: 9 });
    expect(latestNodeSample(series())).toBeNull();
  });
  it("isFresh se mide con la hora de llegada local y caduca a los 60 s", () => {
    expect(isFresh(entry(1_000_000), 1_060_000)).toBe(true);
    expect(isFresh(entry(1_000_000), 1_061_000)).toBe(false);
    expect(isFresh(null, 0)).toBe(false);
  });
  it("isFresh ignora el ts del agente: un agente desfasado no deja la tarjeta caducada", () => {
    expect(isFresh(entry(1_000_000, 1_025), 1_005_000)).toBe(true); // ts = ahora + 25
    expect(isFresh(entry(1_000_000, 900), 1_005_000)).toBe(true); // agente atrasado
  });
  it("isFresh: navegador con el reloj 20 s atrasado respecto a la muestra REST sigue fresca", () => {
    // La muestra REST se fecha con su ts (1000 s); el navegador cree estar en 980 s (20 s atrasado).
    const e = entryFromSeries(series({ t: [980, 990, 1000], cpuPct: [1, 2, 3], memBytes: [1, 1, 1], memLimitBytes: [2, 2, 2], diskBytes: [1, 1, 1], diskTotalBytes: [2, 2, 2] }));
    expect(isFresh(e, 980_000)).toBe(true);
    expect(isFresh(e, (1000 - MAX_CLOCK_SKEW_SECONDS - 1) * 1000)).toBe(false); // más allá de la tolerancia compartida
    expect(entryFromSeries(series())).toBeNull();
  });
});

describe("formato", () => {
  it("percent acota a 0–100 y tolera total 0", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(1, 0)).toBeNull();
    expect(usageTone(percent(1, 0))).toBe("ok");
  });
  it("usageTone cambia a los 70 y 90 %", () => {
    expect([usageTone(69.9), usageTone(70), usageTone(89.9), usageTone(90)]).toEqual(["ok", "warn", "warn", "bad"]);
  });
  it("formatCpu y formatTps", () => {
    expect(formatCpu(152.4)).toBe("152 %");
    expect(formatTps(19.87)).toBe("19.9");
  });
});

describe("node_metrics en vivo", () => {
  const msg = (nodeId: string, s: NodeLiveSample): Extract<ServerMessage, { type: "node_metrics" }> => ({ type: "node_metrics", nodeId, sample: s });

  it("viaja por el topic nodes", () => {
    expect(topicOf(msg("n1", sample(1)))).toBe("nodes");
  });
  it("guarda la muestra con su hora de llegada local", () => {
    const qc = new QueryClient();
    qc.setQueryData(["node-live", "n1"], entry(1, 100, 1));
    applyNodeMetricsEvent(qc, msg("n1", sample(200, 50)), () => 5_000);
    expect(cached(qc)).toEqual({ sample: sample(200, 50), receivedAt: 5_000 });
  });
  it("tras corregir el reloj del agente hacia atrás, la muestra con ts menor que llegó después sustituye a la anterior", () => {
    const qc = new QueryClient();
    qc.setQueryData(["node-live", "n1"], entry(1_000, 1_030, 1));
    applyNodeMetricsEvent(qc, msg("n1", sample(1_000, 77)), () => 11_000);
    expect(cached(qc)?.sample.cpuPct).toBe(77);
    expect(cached(qc)?.receivedAt).toBe(11_000);
  });
  it("sin datos en caché porque la carga REST falló, el evento siembra la caché", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const obs = new QueryObserver(qc, { queryKey: ["node-live", "n1"], queryFn: () => Promise.reject(new Error("boom")), retry: false });
    const unsub = obs.subscribe(() => {});
    await vi.waitFor(() => expect(qc.getQueryState(["node-live", "n1"])?.status).toBe("error"));
    applyNodeMetricsEvent(qc, msg("n1", sample(300, 12)), () => 9_000);
    expect(cached(qc)).toEqual({ sample: sample(300, 12), receivedAt: 9_000 });
    expect(qc.getQueryState(["node-live", "n1"])?.status).toBe("success");
    unsub();
  });
  it("no crea entradas de caché para nodos sin datos", () => {
    const qc = new QueryClient();
    applyNodeMetricsEvent(qc, msg("n9", sample(1)));
    expect(qc.getQueryData(["node-live", "n9"])).toBeUndefined();
  });
  it("evento durante la carga inicial: no cancela y manda la respuesta REST", async () => {
    const qc = new QueryClient();
    let resolve!: (v: NodeLiveEntry) => void;
    const obs = new QueryObserver(qc, { queryKey: ["node-live", "n1"], queryFn: () => new Promise<NodeLiveEntry>((r) => { resolve = r; }) });
    const unsub = obs.subscribe(() => {});
    applyNodeMetricsEvent(qc, msg("n1", sample(500, 99)));
    resolve(entry(1, 490, 5));
    await vi.waitFor(() => expect(cached(qc)?.sample.cpuPct).toBe(5));
    unsub();
  });
  it("evento durante un refetch: cancela y la respuesta vieja no lo pisa", async () => {
    const qc = new QueryClient();
    const resolvers: ((v: NodeLiveEntry) => void)[] = [];
    const obs = new QueryObserver(qc, { queryKey: ["node-live", "n1"], queryFn: () => new Promise<NodeLiveEntry>((r) => { resolvers.push(r); }) });
    const unsub = obs.subscribe(() => {});
    resolvers[0]!(entry(1, 100, 1));
    await vi.waitFor(() => expect(qc.getQueryData(["node-live", "n1"])).toBeDefined());
    void obs.refetch();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    applyNodeMetricsEvent(qc, msg("n1", sample(500, 99)));
    resolvers[1]!(entry(1, 490, 5));
    await vi.waitFor(() => expect(cached(qc)?.sample.cpuPct).toBe(99));
    unsub();
  });
  it("bindNodeMetrics se suscribe a nodes, ignora otros mensajes e invalida al reconectar", () => {
    const qc = new QueryClient();
    const handlers: ((m: ServerMessage) => void)[] = [];
    const reconnects: (() => void)[] = [];
    const offSub = vi.fn();
    const offRec = vi.fn();
    const live: LiveSource = {
      subscribe: (topic, h) => { expect(topic).toBe("nodes"); handlers.push(h); return offSub; },
      onReconnect: (cb) => { reconnects.push(cb); return offRec; },
    };
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const off = bindNodeMetrics(qc, live);
    handlers[0]!({ type: "node", node: { id: "n1" } as never });
    expect(qc.getQueryData(["node-live", "n1"])).toBeUndefined();
    qc.setQueryData(["node-live", "n1"], entry(1, 1, 0));
    handlers[0]!(msg("n1", sample(5, 42)));
    expect(cached(qc)?.sample.cpuPct).toBe(42);
    reconnects[0]!();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["node-live"] });
    off();
    expect(offSub).toHaveBeenCalled();
    expect(offRec).toHaveBeenCalled();
  });
});

describe("uso de nodo", () => {
  it("clampPct acota a 0-100 y tolera no finitos", () => {
    expect(clampPct(-3)).toBe(0);
    expect(clampPct(42.5)).toBe(42.5);
    expect(clampPct(250)).toBe(100);
    expect(clampPct(Number.NaN)).toBe(0);
  });
  it("totalText: usado / total, o usado con total desconocido", () => {
    expect(totalText(1024, 2048)).toBe("1.0 KiB / 2.0 KiB");
    expect(totalText(1024, 0)).toBe("1.0 KiB (total desconocido)");
  });
});
