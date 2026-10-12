export interface DiffLine { label: string; before: string; after: string }

const NONE = "—";
const UNMANAGED = "(sin gestionar)";
// Secciones opcionales: ausente = el panel no las gestiona; vacía es un cambio real.
const OPTIONAL_LABELS = new Set(["Operadores", "Whitelist"]);

const TOP_LABELS: Record<string, string> = {
  type: "Tipo", version: "Versión de Minecraft", imageTag: "Java (imagen)", memory: "Memoria JVM",
  restartPolicy: "Política de reinicio", modpack: "Modpack", whitelist: "Whitelist", ops: "Operadores",
  router: "Router (mc-router)",
};
const NESTED_LABELS: Record<string, string> = {
  "resources.cpus": "Límite de CPUs", "resources.memLimit": "Límite de RAM del contenedor",
  "ports.game": "Puerto de juego", "ports.extra": "Puertos extra",
  "mods.modrinthProjects": "Mods de Modrinth", "mods.curseforgeFiles": "Mods de CurseForge", "mods.urls": "Mods por URL",
  "plugins.modrinthProjects": "Plugins de Modrinth", "plugins.spigetResources": "Plugins de Spiget", "plugins.urls": "Plugins por URL",
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
  // Activada y vacía: el agente sincroniza whitelist.json a [] y solo los ops (que se la saltan) pueden entrar.
  if (v.enabled && !players) return "activada y vacía — nadie podrá entrar salvo los ops";
  return `${v.enabled ? "activada" : "desactivada"}${players}`;
}

function showPorts(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return NONE;
  return v.map((p: Obj) => `${String(p.host)}→${String(p.container)}/${String(p.proto)}${p.label ? ` (${String(p.label)})` : ""}`).join(", ");
}

function showRouter(v: unknown): string {
  if (!isObj(v)) return NONE;
  const host = v.hostname ? String(v.hostname) : "";
  if (v.enabled) return `entrada por ${host}`;
  return host ? `desactivado (${host})` : NONE;
}

/** Aplana una spec a `etiqueta → texto` para compararla línea a línea. */
function flatten(spec: Obj): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(spec)) {
    if (k === "rconPassword" || v === undefined) continue;
    if (k === "properties" && isObj(v)) for (const [pk, pv] of Object.entries(v)) out.set(`Propiedad ${pk}`, show(pv));
    else if (k === "env" && isObj(v)) for (const [ek, ev] of Object.entries(v)) out.set(`Variable ${ek}`, show(ev));
    else if (k === "modpack") out.set(TOP_LABELS.modpack!, showModpack(v));
    else if (k === "ops") out.set(TOP_LABELS.ops!, Array.isArray(v) && v.length === 0 ? "vacía — se revocarán todos" : show(v));
    else if (k === "whitelist") out.set(TOP_LABELS.whitelist!, showWhitelist(v));
    else if (k === "router") out.set(TOP_LABELS.router!, showRouter(v));
    else if ((k === "resources" || k === "ports" || k === "mods" || k === "plugins") && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        const path = `${k}.${sk}`;
        out.set(NESTED_LABELS[path] ?? path, path === "ports.extra" ? showPorts(sv) : show(sv));
      }
    } else out.set(TOP_LABELS[k] ?? k, show(v));
  }
  return out;
}

/** Cambios entre dos specs, en el orden en que aparecen; vacío si son equivalentes. */
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
