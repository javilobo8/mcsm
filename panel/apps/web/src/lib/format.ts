export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log2(n) / 10), u.length - 1);
  return `${(n / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
export function formatUptime(startedAtUnix: number): string {
  if (!startedAtUnix) return "—";
  let s = Math.max(0, Math.floor(Date.now() / 1000) - startedAtUnix);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function stateLabel(o: { state: string; health: string; error: string } | null, desired: string): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (!o) return { text: "No data", tone: "muted" };
  if (o.error) return { text: "Error", tone: "bad" };
  if (o.state === "running") return o.health === "starting" ? { text: "Starting", tone: "warn" } : o.health === "unhealthy" ? { text: "Unhealthy", tone: "bad" } : { text: "Running", tone: "ok" };
  if (o.state === "missing") return { text: desired === "running" ? "Creating…" : "Not created", tone: "muted" };
  if (o.state === "restarting") return { text: "Restarting", tone: "warn" };
  return { text: "Stopped", tone: "muted" };
}

/** State to show: with the node down the last observed is stale. `undefined` = node still unknown. */
export function displayState(o: { state: string; health: string; error: string } | null, desired: string, nodeOnline: boolean | undefined) {
  if (nodeOnline === false) return { text: "Node offline", tone: "muted" as const };
  return stateLabel(o, desired);
}
/** The API answers 409 to power actions with the node offline. */
export const canPower = (nodeOnline: boolean | undefined): boolean => nodeOnline !== false;
