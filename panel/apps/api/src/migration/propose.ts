import { specHostPorts, type Spec } from "@mcsm/shared";

/** Minimum free margin after writing: the same as the agent's (max(5 %, 256 MiB)). */
export const SPACE_MARGIN_MIN = 256 * 1024 * 1024;
export const requiredSpace = (n: number): number => n + Math.max(Math.floor(n * 0.05), SPACE_MARGIN_MIN);

export interface TargetServer { slug: string; spec: Spec }
export interface ProposalInput {
  slug: string; spec: Spec; targetServers: TargetServer[]; range: { from: number; to: number }; requestedPort?: number;
  /** Slugs taken on the target without a server (e.g. a source with the removal pending: its directory is still there). */
  reservedSlugs?: Iterable<string>;
  /** plan-8: host port of the active router (mc-router) on the target; null or absent without a router. */
  routerPort?: number | null;
}
/** `rconPort`: the RCON host port on the target (null if the server does not publish it); `rconChanged` if it differs from the source's. */
export type Proposal =
  | { ok: true; slug: string; port: number; portChanged: boolean; rconPort: number | null; rconChanged: boolean }
  | { ok: false; error: string };

/** Free slug among `taken`: the same or with suffix -2, -3… (max. 40 characters), as when creating a server. */
export function uniqueSlugAmong(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Slug and game port of the server on the target (spec §7: “new port if it collides”). The requested port is
 * respected if free; if none is requested, the current one if free and, if not, the first free one in the panel's range. Extra
 * ports are not changed on their own: if they clash, error. The target router's port (plan-8) counts as used. Pure.
 */
export function proposeTarget(i: ProposalInput): Proposal {
  const used = new Set<number>();
  for (const s of i.targetServers) {
    for (const p of specHostPorts(s.spec)) used.add(p);
  }
  const router = i.routerPort ?? null;
  const onRouter = i.spec.ports.extra.find((e) => e.host === router);
  if (onRouter) {
    return { ok: false, error: `Extra port ${onRouter.host} (${onRouter.label || onRouter.proto}) is used by the target node's router (mc-router): change it before migrating` };
  }
  const clash = i.spec.ports.extra.find((e) => used.has(e.host));
  if (clash) {
    return { ok: false, error: `Extra port ${clash.host} (${clash.label || clash.proto}) is already used by another server on the target node: change it before migrating` };
  }
  const extras = new Set(i.spec.ports.extra.map((e) => e.host));
  let port: number | undefined;
  if (router !== null) used.add(router); // after checking the extras: the clash with the router has its own message
  if (i.requestedPort !== undefined) {
    if (i.requestedPort === router) return { ok: false, error: `Port ${router} is used by the target node's router (mc-router)` };
    if (used.has(i.requestedPort) || extras.has(i.requestedPort)) return { ok: false, error: `Port ${i.requestedPort} is already in use on the target node` };
    port = i.requestedPort;
  } else if (!used.has(i.spec.ports.game)) {
    port = i.spec.ports.game;
  } else {
    // Skips the server's own RCON port while it is free on the target, so it does not have to move.
    const rcon = i.spec.ports.rcon;
    const free = (p: number) => !used.has(p) && !extras.has(p);
    for (let p = i.range.from; p <= i.range.to && port === undefined; p++) if (free(p) && p !== rcon) port = p;
    if (port === undefined && rcon !== undefined && free(rcon)) port = rcon;
    if (port === undefined) return { ok: false, error: `No free ports left between ${i.range.from} and ${i.range.to} on the target node` };
  }
  // RCON: kept if free on the target (and not the game port chosen there); otherwise the first free port of the range.
  let rconPort: number | null = i.spec.ports.rcon ?? null;
  if (rconPort !== null && (used.has(rconPort) || rconPort === port)) {
    rconPort = null;
    for (let p = i.range.from; p <= i.range.to && rconPort === null; p++) if (!used.has(p) && !extras.has(p) && p !== port) rconPort = p;
    if (rconPort === null) return { ok: false, error: `No free ports left between ${i.range.from} and ${i.range.to} for the RCON port on the target node` };
  }
  const slug = uniqueSlugAmong(i.slug, new Set([...i.targetServers.map((s) => s.slug), ...(i.reservedSlugs ?? [])]));
  return { ok: true, slug, port, portChanged: port !== i.spec.ports.game, rconPort, rconChanged: rconPort !== (i.spec.ports.rcon ?? null) };
}

/** Name of the backup on the target: the same with the target's slug (the agent requires `<slug>-<ts>-<v>.tar.zst`). */
export function retargetFilename(filename: string, fromSlug: string, toSlug: string): string {
  if (!filename.startsWith(`${fromSlug}-`)) throw new Error(`The backup ${filename} does not belong to server ${fromSlug}`);
  return toSlug + filename.slice(fromSlug.length);
}
