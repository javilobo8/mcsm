import type { TemplateSpec } from "@mcsm/shared";
import { apiPath } from "./api";
import type { EditableSpec } from "./spec-edit";
import { typeLabel } from "./spec-catalog";
import { scheduleSummary } from "./backups";

export interface WizardTarget { nodeId: string; name: string; port?: number; start: boolean }

/** Petición de creación: desde plantilla (el panel copia su spec) o desde cero (spec del paso 1). */
export function createRequest(source: { templateId: string } | { spec: EditableSpec }, t: WizardTarget): { url: string; body: Record<string, unknown> } {
  const desiredState = t.start ? "running" : "stopped";
  if ("templateId" in source) {
    return { url: apiPath`/api/templates/${source.templateId}/servers`, body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, ...(t.port ? { port: t.port } : {}) } };
  }
  const ports = t.port ? { game: t.port, extra: source.spec.ports.extra } : { extra: source.spec.ports.extra };
  return { url: "/api/servers", body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, spec: { ...source.spec, ports } } };
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Resumen legible de una spec para el paso "Revisar". */
export function summarizeSpec(spec: TemplateSpec | EditableSpec): { label: string; value: string }[] {
  const mods = spec.mods ? spec.mods.modrinthProjects.length + spec.mods.curseforgeFiles.length + spec.mods.urls.length : 0;
  const plugins = spec.plugins ? spec.plugins.modrinthProjects.length + spec.plugins.spigetResources.length + spec.plugins.urls.length : 0;
  const lines = [
    { label: "Tipo", value: typeLabel(spec.type) },
    { label: "Versión de Minecraft", value: spec.version },
    { label: "Java", value: spec.imageTag },
    { label: "Memoria", value: spec.memory + (spec.resources.memLimit ? ` (límite ${spec.resources.memLimit})` : "") },
  ];
  if (spec.modpack) lines.push({ label: "Modpack", value: spec.modpack.slugOrUrl + (spec.modpack.versionId ? ` @ ${spec.modpack.versionId}` : "") });
  if (mods) lines.push({ label: "Mods", value: count(mods, "mod", "mods") });
  if (plugins) lines.push({ label: "Plugins", value: count(plugins, "plugin", "plugins") });
  if (spec.whitelist) lines.push({ label: "Whitelist", value: spec.whitelist.enabled ? count(spec.whitelist.players.length, "jugador", "jugadores") : "desactivada" });
  if (spec.ops?.length) lines.push({ label: "Operadores", value: spec.ops.join(", ") });
  const props = Object.keys(spec.properties).length;
  if (props) lines.push({ label: "Propiedades", value: count(props, "propiedad fijada", "propiedades fijadas") });
  const backups = scheduleSummary(spec.backups);
  if (backups) lines.push({ label: "Copias automáticas", value: backups });
  return lines;
}

/** Búsqueda de `/servers/new`: `?template=<id>` (cualquier otra cosa se descarta). */
export function parseNewServerSearch(s: Record<string, unknown>): { template?: string } {
  return typeof s.template === "string" && s.template ? { template: s.template } : {};
}

export const SCRATCH = "scratch";

export interface StepContext {
  /** `"scratch"` o el id de la plantilla elegida. */
  source: string;
  /** La plantilla elegida existe y está cargada (solo importa si `source` no es scratch). */
  templateLoaded: boolean;
  /** Primer error de `validateSpec` (solo desde cero). */
  specError: string | null;
  /** Errores de campo vigentes del formulario del paso 1. */
  fieldErrors: Readonly<Record<string, string>>;
  nodeId: string;
  name: string;
  port: string;
}

export function parsePort(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

/** Motivo por el que no se puede salir del paso 1 o 2 (null = se puede). Se muestra con aria-describedby. */
export function stepBlock(step: 1 | 2, c: StepContext): string | null {
  const scratch = c.source === SCRATCH;
  if (!scratch && !c.templateLoaded) return "La plantilla elegida no está disponible (¿se ha borrado?)";
  if (step === 1) {
    if (!scratch) return null;
    const n = Object.keys(c.fieldErrors).length;
    if (n > 0) return `Corrige ${n} ${n === 1 ? "campo con error" : "campos con error"} antes de continuar`;
    return c.specError;
  }
  if (!c.nodeId) return "Elige un nodo";
  if (!c.name.trim()) return "Escribe un nombre";
  const p = parsePort(c.port);
  if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) return "El puerto debe ser un número entre 1 y 65535";
  return null;
}

/**
 * Qué se crea al pulsar «Crear servidor». Si la plantilla elegida ya no existe (borrada mientras se
 * rellenaba el asistente y la lista se recargó), null: NUNCA se cae a crear «desde cero» con la spec
 * por defecto, que no es lo que el usuario revisó.
 */
export function creationSource(source: string, tpl: { id: string } | undefined, spec: EditableSpec): { templateId: string } | { spec: EditableSpec } | null {
  if (source === SCRATCH) return { spec };
  return tpl ? { templateId: tpl.id } : null;
}

/** Paso donde se muestra el fallo de creación: 409 (slug o puerto en uso) se corrige en el paso 2. */
export function createErrorStep(status: number | undefined): 2 | 3 {
  return status === 409 ? 2 : 3;
}
