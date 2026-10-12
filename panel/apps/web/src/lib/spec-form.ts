import { specInputSchema, type SpecInput } from "@mcsm/shared";

export type KV = Record<string, string>;
export type FormSpec = SpecInput & { ports: { game?: number }; rconPassword?: string };

export const kvToText = (o: KV): string => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");

export function textToKv(t: string): KV {
  const out: KV = {};
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Línea inválida: "${line}" (usa clave=valor)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export interface FormValues {
  type: string; version: string; imageTag: string; memory: string; port: string; restartPolicy: string;
  cpus: string; memLimit: string; properties: string; env: string;
}

export function valuesFromSpec(s: FormSpec): FormValues {
  return {
    type: s.type, version: s.version, imageTag: s.imageTag, memory: s.memory, port: String(s.ports.game ?? ""),
    restartPolicy: s.restartPolicy, cpus: s.resources.cpus ? String(s.resources.cpus) : "", memLimit: s.resources.memLimit,
    properties: kvToText(s.properties), env: kvToText(s.env),
  };
}

/**
 * Construye la spec COMPLETA a enviar: parte de la spec original (el PATCH la reemplaza entera,
 * los campos omitidos volverían a sus defaults) y sobreescribe solo lo que edita el formulario.
 * Lanza Error con mensaje en castellano si no es válida.
 */
export function buildSpec(base: FormSpec, v: FormValues): SpecInput {
  const port = Number(v.port);
  const cpus = v.cpus.trim() === "" ? 0 : Number(v.cpus);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("El puerto debe ser un entero entre 1 y 65535");
  if (!Number.isFinite(cpus) || cpus < 0) throw new Error("El límite de CPUs debe ser un número ≥ 0");
  const { rconPassword: _omit, ...rest } = base;
  void _omit;
  const candidate = {
    ...rest,
    type: v.type.trim(), version: v.version.trim(), imageTag: v.imageTag, memory: v.memory.trim(), restartPolicy: v.restartPolicy,
    ports: { ...rest.ports, game: port },
    resources: { ...rest.resources, cpus, memLimit: v.memLimit.trim() },
    properties: textToKv(v.properties), env: textToKv(v.env),
  };
  const res = specInputSchema.safeParse(candidate);
  if (!res.success) throw new Error(res.error.issues[0]?.message ?? "Configuración inválida");
  return res.data;
}

export interface Change { path: string; before: string; after: string }

const show = (x: unknown): string => (x === undefined || x === "" ? "(vacío)" : typeof x === "string" ? x : JSON.stringify(x));

function walk(a: unknown, b: unknown, path: string, out: Change[]) {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: show(a), after: show(b) });
}

/** Diferencias entre dos specs, ignorando rconPassword. */
export function diffSpec(before: FormSpec, after: FormSpec): Change[] {
  const strip = ({ rconPassword: _r, ...r }: FormSpec) => (void _r, r);
  const out: Change[] = [];
  walk(strip(before), strip(after), "", out);
  return out;
}
