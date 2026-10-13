import type { MetricSeries } from "@mcsm/shared";
import type { NodeDto } from "./api";
import { aligned, memAligned, type Aligned } from "./metrics";

/** Series de las gráficas del nodo: CPU del host, memoria usada/total y disco de DATA_ROOT usado/total. */
export function nodeChartsData(s: MetricSeries): { cpu: Aligned; mem: Aligned; disk: Aligned } {
  return { cpu: aligned(s, ["cpuPct"]), mem: memAligned(s), disk: aligned(s, ["diskBytes", "diskTotalBytes"]) };
}

export function rotationNote(n: NodeDto): string | null {
  return n.tokenRotationPending
    ? "Rotación pendiente: el agente aún no se ha conectado con el token nuevo (el anterior sigue valiendo hasta entonces)."
    : null;
}

export function hostLabel(n: NodeDto): string {
  const h = n.hostInfo;
  if (!h?.hostname) return "—";
  return `${h.hostname} · ${h.os ?? "?"}/${h.arch ?? "?"}${h.cpus ? ` · ${h.cpus} CPU` : ""}`;
}
