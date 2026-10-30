import {
  CONTENT_LISTS, formatContentEntry, type ContentDependencyDto, type ContentListKey, type ContentTarget, type ContentVersionDto,
  type ResolveResultDto,
} from "@mcsm/shared";
import { HttpError } from "../lib/http.js";

/** Most projects one resolution may add (selections + dependencies). */
export const MAX_RESOLVED = 200;

export interface ResolveDeps {
  version(versionId: string): Promise<ContentVersionDto | null>;
  /** pickLatest(compatible versions, null). */
  latest(projectId: string): Promise<ContentVersionDto | null>;
  /** Falls back to the id. */
  name(projectId: string): Promise<string>;
}

export interface ResolveInput {
  list: ContentListKey;
  selections: { projectId: string; versionId: string }[];
  /** projectId → pinned version and its dependencies (same platform, all lists). */
  present: Map<string, { versionId: string | null; dependencies: ContentDependencyDto[] }>;
  inPack: Set<string>;
  target: ContentTarget;
}

/**
 * The version runs on the target: it lists the game version and shares a loader with it. A version that lists no
 * loader (CurseForge plugins only list game versions) fits any loader; a target without loaders accepts any.
 */
export function compatibleWith(v: Pick<ContentVersionDto, "gameVersions" | "loaders">, target: ContentTarget): boolean {
  if (!v.gameVersions.includes(target.gameVersion)) return false;
  if (target.loaders.length === 0 || v.loaders.length === 0) return true;
  return v.loaders.some((l) => target.loaders.includes(l));
}

interface Chosen { projectId: string; versionId: string; selected: boolean; requiredBy: string[] }

/**
 * What adding `selections` to `list` brings with it (breadth-first; order = selections, then discovery): required
 * dependencies pinned to a compatible version, optional ones to offer, what the modpack already brings, conflicts and
 * what cannot be resolved. Cycles end because each project is chosen once.
 */
export async function resolveSelection(input: ResolveInput, deps: ResolveDeps): Promise<ResolveResultDto> {
  const { platform } = CONTENT_LISTS[input.list];
  const names = new Map<string, Promise<string>>();
  const name = (pid: string) => {
    let n = names.get(pid);
    if (!n) { n = deps.name(pid); names.set(pid, n); }
    return n;
  };

  const chosen = new Map<string, Chosen>();
  const queue: ContentVersionDto[] = [];
  const optional = new Map<string, string[]>();
  const inPack = new Map<string, string>();
  const conflicts = new Set<string>();
  const unresolved: string[] = [];
  const failed = new Set<string>();
  const choose = (c: Chosen, v: ContentVersionDto) => {
    chosen.set(c.projectId, c);
    queue.push(v);
    if (chosen.size > MAX_RESOLVED) throw new HttpError(400, `Too many dependencies to resolve (max. ${MAX_RESOLVED})`);
  };
  const addOnce = (xs: string[], x: string) => { if (!xs.includes(x)) xs.push(x); };

  for (const sel of input.selections) {
    if (chosen.has(sel.projectId)) continue;
    const v = await deps.version(sel.versionId);
    if (!v || v.projectId !== sel.projectId) {
      unresolved.push(`${sel.projectId}: version ${sel.versionId} not found`);
      continue;
    }
    choose({ projectId: sel.projectId, versionId: v.versionId, selected: true, requiredBy: [] }, v);
  }

  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!;
    const dependant = await name(v.projectId);
    for (const dep of v.dependencies) {
      const pid = dep.projectId ?? (dep.versionId ? (await deps.version(dep.versionId))?.projectId ?? null : null);
      if (!pid || pid === v.projectId) continue;
      const known = input.present.has(pid) || chosen.has(pid) || input.inPack.has(pid);
      if (dep.type === "required") {
        const c = chosen.get(pid);
        if (c) addOnce(c.requiredBy, dependant);
        else if (input.present.has(pid)) continue;
        else if (input.inPack.has(pid)) { if (!inPack.has(pid)) inPack.set(pid, await name(pid)); }
        else if (!failed.has(pid)) {
          let next: ContentVersionDto | null = null;
          if (dep.versionId) {
            const pinned = await deps.version(dep.versionId);
            if (pinned && pinned.projectId === pid && compatibleWith(pinned, input.target)) next = pinned;
          }
          next ??= await deps.latest(pid);
          if (!next) {
            failed.add(pid);
            const where = [input.target.loaders.join("/"), input.target.gameVersion].filter((s) => s !== "").join(" ");
            unresolved.push(`${await name(pid)} (required by ${dependant}) has no version for ${where}`);
          } else {
            choose({ projectId: pid, versionId: next.versionId, selected: false, requiredBy: [dependant] }, next);
          }
        }
      } else if (dep.type === "optional") {
        if (!known) {
          const by = optional.get(pid) ?? [];
          optional.set(pid, by);
          addOnce(by, dependant);
        }
      } else if (dep.type === "incompatible") {
        if (known) conflicts.add(`${dependant} is incompatible with ${await name(pid)}`);
      }
    }
  }

  // Installed projects that declare a new one incompatible.
  for (const [pid, p] of input.present) {
    for (const dep of p.dependencies) {
      if (dep.type === "incompatible" && dep.projectId && chosen.has(dep.projectId) && dep.projectId !== pid) {
        conflicts.add(`${await name(pid)} is incompatible with ${await name(dep.projectId)}`);
      }
    }
  }

  const add = [];
  for (const c of chosen.values()) {
    add.push({
      list: input.list, projectId: c.projectId, versionId: c.versionId, entry: formatContentEntry(platform, c.projectId, c.versionId),
      name: await name(c.projectId), selected: c.selected, requiredBy: c.requiredBy,
    });
  }
  const optionalOut = [];
  for (const [pid, requiredBy] of optional) {
    if (!chosen.has(pid) && !input.inPack.has(pid)) optionalOut.push({ projectId: pid, name: await name(pid), requiredBy });
  }
  return {
    add,
    optional: optionalOut,
    inPack: [...inPack].map(([projectId, n]) => ({ projectId, name: n })),
    conflicts: [...conflicts],
    unresolved,
  };
}
