export interface DiffLine { label: string; before: string; after: string }

const NONE = "—";
const UNMANAGED = "(not managed)";
const MANAGED = "managed by the panel";
// Optional sections: absent = the panel does not manage them; empty is a real change.
const OPTIONAL_LABELS = new Set(["Operators", "Whitelist", "Mods (section)", "Plugins (section)"]);

const TOP_LABELS: Record<string, string> = {
  type: "Type", version: "Minecraft version", build: "Build / loader", imageTag: "Java (image)", memory: "JVM memory",
  restartPolicy: "Restart policy", modpack: "Modpack", whitelist: "Whitelist", ops: "Operators",
  router: "Router (mc-router)", mods: "Mods (section)", plugins: "Plugins (section)",
};
const NESTED_LABELS: Record<string, string> = {
  "resources.cpus": "CPU limit", "resources.memLimit": "Container RAM limit",
  "ports.game": "Game port", "ports.extra": "Extra ports",
  "mods.modrinthProjects": "Modrinth mods", "mods.curseforgeFiles": "CurseForge mods", "mods.urls": "Mods by URL",
  "plugins.modrinthProjects": "Modrinth plugins", "plugins.spigetResources": "Spiget plugins", "plugins.urls": "Plugins by URL",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function show(v: unknown): string {
  if (v === undefined || v === null || v === "") return NONE;
  if (Array.isArray(v)) return v.length ? v.map((x) => (isObj(x) ? JSON.stringify(x) : String(x))).join(", ") : NONE;
  if (isObj(v)) return JSON.stringify(v);
  return String(v);
}

function showModpack(v: unknown): string {
  if (!isObj(v)) return NONE;
  const ver = v.versionId ? ` @ ${String(v.versionId)}` : "";
  const loader = v.loader ? ` (${String(v.loader)})` : "";
  return `${String(v.platform)}: ${String(v.slugOrUrl)}${ver}${loader}`;
}

function showWhitelist(v: unknown): string {
  if (!isObj(v)) return NONE;
  const players = Array.isArray(v.players) && v.players.length ? `: ${v.players.join(", ")}` : "";
  // Enabled and empty: the agent syncs whitelist.json to [] and only ops (who skip it) can join.
  if (v.enabled && !players) return "enabled and empty — nobody will be able to join except ops";
  return `${v.enabled ? "enabled" : "disabled"}${players}`;
}

function showPorts(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return NONE;
  return v.map((p: Obj) => `${String(p.host)}→${String(p.container)}/${String(p.proto)}${p.label ? ` (${String(p.label)})` : ""}`).join(", ");
}

function showRouter(v: unknown): string {
  if (!isObj(v)) return NONE;
  const host = v.hostname ? String(v.hostname) : "";
  if (v.enabled) return `entry via ${host}`;
  return host ? `disabled (${host})` : NONE;
}

/** Flattens a spec to `label → text` to compare it line by line. */
function flatten(spec: Obj): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(spec)) {
    if (k === "rconPassword" || v === undefined) continue;
    if (k === "properties" && isObj(v)) for (const [pk, pv] of Object.entries(v)) out.set(`Property ${pk}`, show(pv));
    else if (k === "env" && isObj(v)) for (const [ek, ev] of Object.entries(v)) out.set(`Variable ${ek}`, show(ev));
    else if (k === "modpack") out.set(TOP_LABELS.modpack!, showModpack(v));
    else if (k === "ops") out.set(TOP_LABELS.ops!, Array.isArray(v) && v.length === 0 ? "empty — all will be revoked" : show(v));
    else if (k === "whitelist") out.set(TOP_LABELS.whitelist!, showWhitelist(v));
    else if (k === "router") out.set(TOP_LABELS.router!, showRouter(v));
    else if ((k === "resources" || k === "ports" || k === "mods" || k === "plugins") && isObj(v)) {
      if (k === "mods" || k === "plugins") out.set(TOP_LABELS[k]!, MANAGED); // plan-9: the section itself (absent ≠ present)
      for (const [sk, sv] of Object.entries(v)) {
        const path = `${k}.${sk}`;
        out.set(NESTED_LABELS[path] ?? path, path === "ports.extra" ? showPorts(sv) : show(sv));
      }
    } else out.set(TOP_LABELS[k] ?? k, show(v));
  }
  return out;
}

/** Changes between two specs, in the order they appear; empty if they are equivalent. */
export function diffSpecs(before: Obj, after: Obj): DiffLine[] {
  const a = flatten(before);
  const b = flatten(after);
  const labels = [...new Set([...a.keys(), ...b.keys()])];
  const lines: DiffLine[] = [];
  for (const label of labels) {
    const missing = OPTIONAL_LABELS.has(label) ? UNMANAGED : NONE;
    const x = a.get(label) ?? missing;
    const y = b.get(label) ?? missing;
    if (x !== y) lines.push({ label, before: x, after: y });
  }
  return lines;
}
