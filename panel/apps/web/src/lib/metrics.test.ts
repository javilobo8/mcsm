import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { MetricSeries, NodeLiveSample } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";
import { topicOf } from "./ws";
import {
  aligned, applyNodeMetricsEvent, bindNodeMetrics, formatCpu, formatTps, hasData, isFresh, latestNodeSample, percent, usageTone,
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

describe("series", () => {
  it("aligned pone t delante de las columnas pedidas, en orden", () => {
    const s = series({ cpuPct: [1, null, 3], memBytes: [4, 5, 6] });
    expect(aligned(s, ["memBytes", "cpuPct"])).toEqual([[100, 110, 120], [4, 5, 6], [1, null, 3]]);
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
  it("isFresh caduca a los 60 s", () => {
    expect(isFresh(sample(1000), 1_060_000)).toBe(true);
    expect(isFresh(sample(1000), 1_061_000)).toBe(false);
    expect(isFresh(null, 0)).toBe(false);
  });
});

describe("formato", () => {
  it("percent acota a 0–100 y tolera total 0", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(1, 0)).toBe(0);
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
  it("guarda la última muestra y no la pisa con una más antigua", () => {
    const qc = new QueryClient();
    applyNodeMetricsEvent(qc, msg("n1", sample(200, 50)));
    applyNodeMetricsEvent(qc, msg("n1", sample(190, 10)));
    expect(qc.getQueryData<NodeLiveSample>(["node-live", "n1"])?.cpuPct).toBe(50);
    applyNodeMetricsEvent(qc, msg("n1", sample(210, 60)));
    expect(qc.getQueryData<NodeLiveSample>(["node-live", "n1"])?.cpuPct).toBe(60);
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
    handlers[0]!(msg("n1", sample(5, 42)));
    expect(qc.getQueryData<NodeLiveSample>(["node-live", "n1"])?.cpuPct).toBe(42);
    reconnects[0]!();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["node-live"] });
    off();
    expect(offSub).toHaveBeenCalled();
    expect(offRec).toHaveBeenCalled();
  });
});
