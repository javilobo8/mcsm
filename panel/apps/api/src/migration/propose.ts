import type { Spec } from "@mcsm/shared";

/** Margen mínimo libre tras escribir: el mismo que el agente (max(5 %, 256 MiB)). */
export const SPACE_MARGIN_MIN = 256 * 1024 * 1024;
export const requiredSpace = (n: number): number => n + Math.max(Math.floor(n * 0.05), SPACE_MARGIN_MIN);

export interface TargetServer { slug: string; spec: Spec }
export interface ProposalInput {
  slug: string; spec: Spec; targetServers: TargetServer[]; range: { from: number; to: number }; requestedPort?: number;
  /** Slugs ocupados en el destino sin servidor (p. ej. un origen con la retirada pendiente: su directorio sigue allí). */
  reservedSlugs?: Iterable<string>;
}
export type Proposal = { ok: true; slug: string; port: number; portChanged: boolean } | { ok: false; error: string };

/** Slug libre entre `taken`: el mismo o con sufijo -2, -3… (máx. 40 caracteres), como al crear un servidor. */
export function uniqueSlugAmong(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Slug y puerto de juego del servidor en el destino (spec §7: «puerto nuevo si colisiona»). El puerto pedido se
 * respeta si está libre; si no se pide, el actual si está libre y, si no, el primero libre del rango del panel. Los
 * puertos extra no se cambian solos: si chocan, error. Pura.
 */
export function proposeTarget(i: ProposalInput): Proposal {
  const used = new Set<number>();
  for (const s of i.targetServers) {
    used.add(s.spec.ports.game);
    for (const e of s.spec.ports.extra) used.add(e.host);
  }
  const clash = i.spec.ports.extra.find((e) => used.has(e.host));
  if (clash) {
    return { ok: false, error: `El puerto extra ${clash.host} (${clash.label || clash.proto}) ya lo usa otro servidor del nodo destino: cámbialo antes de migrar` };
  }
  const extras = new Set(i.spec.ports.extra.map((e) => e.host));
  let port: number | undefined;
  if (i.requestedPort !== undefined) {
    if (used.has(i.requestedPort) || extras.has(i.requestedPort)) return { ok: false, error: `El puerto ${i.requestedPort} ya está en uso en el nodo destino` };
    port = i.requestedPort;
  } else if (!used.has(i.spec.ports.game)) {
    port = i.spec.ports.game;
  } else {
    for (let p = i.range.from; p <= i.range.to && port === undefined; p++) if (!used.has(p) && !extras.has(p)) port = p;
    if (port === undefined) return { ok: false, error: `No quedan puertos libres entre ${i.range.from} y ${i.range.to} en el nodo destino` };
  }
  const slug = uniqueSlugAmong(i.slug, new Set([...i.targetServers.map((s) => s.slug), ...(i.reservedSlugs ?? [])]));
  return { ok: true, slug, port, portChanged: port !== i.spec.ports.game };
}

/** Nombre de la copia en el destino: el mismo con el slug del destino (el agente exige `<slug>-<ts>-<v>.tar.zst`). */
export function retargetFilename(filename: string, fromSlug: string, toSlug: string): string {
  if (!filename.startsWith(`${fromSlug}-`)) throw new Error(`La copia ${filename} no es del servidor ${fromSlug}`);
  return toSlug + filename.slice(fromSlug.length);
}
