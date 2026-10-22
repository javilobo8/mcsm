import type { TemplateSpec } from "@mcsm/shared";
import { apiPath } from "./api";
import type { EditableSpec } from "./spec-edit";
import { typeLabel } from "./spec-catalog";
import { scheduleSummary } from "./backups";
import { buildLabel } from "./versions";

export interface WizardTarget { nodeId: string; name: string; port?: number; start: boolean }

/** Creation request: from a template (the panel copies its spec) or from scratch (spec of step 1). */
export function createRequest(source: { templateId: string } | { spec: EditableSpec }, t: WizardTarget): { url: string; body: Record<string, unknown> } {
  const desiredState = t.start ? "running" : "stopped";
  if ("templateId" in source) {
    return { url: apiPath`/api/templates/${source.templateId}/servers`, body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, ...(t.port ? { port: t.port } : {}) } };
  }
  // PATCH/POST replace `ports` whole: carry `rcon` through or it would be dropped.
  const { rcon } = source.spec.ports;
  const ports = { ...(t.port ? { game: t.port } : {}), extra: source.spec.ports.extra, ...(rcon !== undefined ? { rcon } : {}) };
  return { url: "/api/servers", body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, spec: { ...source.spec, ports } } };
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Readable summary of a spec for the "Review" step. */
export function summarizeSpec(spec: TemplateSpec | EditableSpec): { label: string; value: string }[] {
  const mods = spec.mods ? spec.mods.modrinthProjects.length + spec.mods.curseforgeFiles.length + spec.mods.urls.length : 0;
  const plugins = spec.plugins ? spec.plugins.modrinthProjects.length + spec.plugins.spigetResources.length + spec.plugins.urls.length : 0;
  const lines = [
    { label: "Type", value: typeLabel(spec.type) },
    { label: "Minecraft version", value: spec.version },
    // plan-10: `build` is missing in old templates.
    ...(spec.build ? [{ label: buildLabel(spec.type) ?? "Build", value: spec.build }] : []),
    { label: "Java", value: spec.imageTag },
    { label: "Memory", value: spec.memory + (spec.resources.memLimit ? ` (limit ${spec.resources.memLimit})` : "") },
  ];
  if (spec.modpack) lines.push({ label: "Modpack", value: spec.modpack.slugOrUrl + (spec.modpack.versionId ? ` @ ${spec.modpack.versionId}` : "") });
  if (mods) lines.push({ label: "Mods", value: count(mods, "mod", "mods") });
  if (plugins) lines.push({ label: "Plugins", value: count(plugins, "plugin", "plugins") });
  if (spec.whitelist) lines.push({ label: "Whitelist", value: spec.whitelist.enabled ? count(spec.whitelist.players.length, "player", "players") : "disabled" });
  if (spec.ops?.length) lines.push({ label: "Operators", value: spec.ops.join(", ") });
  const props = Object.keys(spec.properties).length;
  if (props) lines.push({ label: "Properties", value: count(props, "property set", "properties set") });
  const backups = scheduleSummary(spec.backups);
  if (backups) lines.push({ label: "Scheduled backups", value: backups });
  return lines;
}

/** Search of `/servers/new`: `?template=<id>` (anything else is discarded). */
export function parseNewServerSearch(s: Record<string, unknown>): { template?: string } {
  return typeof s.template === "string" && s.template ? { template: s.template } : {};
}

export const SCRATCH = "scratch";

export interface StepContext {
  /** `"scratch"` or the id of the chosen template. */
  source: string;
  /** The chosen template exists and is loaded (only matters if `source` is not scratch). */
  templateLoaded: boolean;
  /** First error of `validateSpec` (from scratch only). */
  specError: string | null;
  /** Current field errors of the step 1 form. */
  fieldErrors: Readonly<Record<string, string>>;
  nodeId: string;
  name: string;
  port: string;
}

export function parsePort(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

/** Reason why step 1 or 2 cannot be left (null = it can). Shown with aria-describedby. */
export function stepBlock(step: 1 | 2, c: StepContext): string | null {
  const scratch = c.source === SCRATCH;
  if (!scratch && !c.templateLoaded) return "The chosen template is not available (was it deleted?)";
  if (step === 1) {
    if (!scratch) return null;
    const n = Object.keys(c.fieldErrors).length;
    if (n > 0) return `Fix ${n} ${n === 1 ? "field with an error" : "fields with errors"} before continuing`;
    return c.specError;
  }
  if (!c.nodeId) return "Choose a node";
  if (!c.name.trim()) return "Enter a name";
  const p = parsePort(c.port);
  if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) return "The port must be a number between 1 and 65535";
  return null;
}

/**
 * What is created when “Create server” is pressed. If the chosen template no longer exists (deleted while the
 * wizard was being filled in and the list reloaded), null: it NEVER falls back to creating “from scratch” with the
 * default spec, which is not what the user reviewed.
 */
export function creationSource(source: string, tpl: { id: string } | undefined, spec: EditableSpec): { templateId: string } | { spec: EditableSpec } | null {
  if (source === SCRATCH) return { spec };
  return tpl ? { templateId: tpl.id } : null;
}

/** Step where the creation failure is shown: 409 (slug or port in use) is fixed in step 2. */
export function createErrorStep(status: number | undefined): 2 | 3 {
  return status === 409 ? 2 : 3;
}
