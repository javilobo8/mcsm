import type { MetricSeries } from "@mcsm/shared";
import type { NodeDto } from "./api";
import { aligned, memAligned, type Aligned } from "./metrics";

/** Node chart series: host CPU, used/total memory and used/total DATA_ROOT disk. */
export function nodeChartsData(s: MetricSeries): { cpu: Aligned; mem: Aligned; disk: Aligned } {
  return { cpu: aligned(s, ["cpuPct"]), mem: memAligned(s), disk: aligned(s, ["diskBytes", "diskTotalBytes"]) };
}

export function rotationNote(n: NodeDto): string | null {
  return n.tokenRotationPending
    ? "Rotation pending: the agent has not yet connected with the new token (the previous one stays valid until then)."
    : null;
}

export function hostLabel(n: NodeDto): string {
  const h = n.hostInfo;
  if (!h?.hostname) return "—";
  return `${h.hostname} · ${h.os ?? "?"}/${h.arch ?? "?"}${h.cpus ? ` · ${h.cpus} CPU` : ""}`;
}
