import { describe, expect, it } from "vitest";
import type { MetricSeries } from "@mcsm/shared";
import type { NodeDto } from "./api";
import { hostLabel, nodeChartsData, rotationNote } from "./node-detail";

const node = (over: Partial<NodeDto> = {}): NodeDto => ({
  id: "n1", name: "nas", dataRoot: "/srv/minecraft", status: "online", agentVersion: "0.9.0", dockerVersion: "29.7.2",
  hostInfo: { hostname: "torre", os: "linux", arch: "amd64", cpus: 8 }, lastSeenAt: null, createdAt: "", tokenRotationPending: false, ...over,
});

describe("detalle de nodo", () => {
  it("series de CPU, memoria (usada y total) y disco (usado y total)", () => {
    const nulls = () => [null, null];
    const s = {
      range: "1h", step: 10, t: [10, 20], cpuPct: [5, 6], memBytes: [1, 2], memLimitBytes: [8, 8], diskBytes: [3, 4], diskTotalBytes: [9, 9],
      netRxBytes: nulls(), netTxBytes: nulls(), playersOnline: nulls(), playersMax: nulls(), tps: nulls(), pingMs: nulls(),
    } as MetricSeries;
    const d = nodeChartsData(s);
    expect(d.cpu).toEqual([[10, 20], [5, 6]]);
    expect(d.mem).toEqual([[10, 20], [1, 2], [8, 8]]);
    expect(d.disk).toEqual([[10, 20], [3, 4], [9, 9]]);
  });

  it("aviso de rotación pendiente y etiqueta del host", () => {
    expect(rotationNote(node())).toBeNull();
    expect(rotationNote(node({ tokenRotationPending: true }))).toMatch(/aún no se ha conectado con el token nuevo/);
    expect(hostLabel(node())).toBe("torre · linux/amd64 · 8 CPU");
    expect(hostLabel(node({ hostInfo: null }))).toBe("—");
  });
});
