# Plan 10 — Minecraft version and build/loader selector

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When creating or editing a server (or a template), the Minecraft version is chosen from a list depending on the type, and optionally the build/loader, with the Java adjusted automatically.

**Architecture:** The spec gains a `build` field (empty = the latest) that the agent translates to the itzg variable of each type (`PAPER_BUILD`, `FABRIC_LOADER_VERSION`…). The panel's API queries the official sources (Mojang, PaperMC Fill v3, Purpur, Spigot, Fabric, Quilt, Forge, NeoForge) with an in-memory cache and exposes `GET /api/versions/:type` and `GET /api/versions/:type/:version/builds`. The web replaces the version field with a combobox (shadcn `command` + `popover`) and adds a build selector.

**Tech Stack:** Go 1.27 (agent), TypeScript strict + zod 4 (shared), Fastify 5 (API), React 19 + TanStack Query + shadcn (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-version-selector-design.md` (extends §4.1 and §8 of `2026-10-12-mc-server-manager-design.md`).

## Global Constraints

- UI and error messages in Spanish; identifiers in English. Conventional commits in Spanish, small, with `Co-Authored-By: Claude <your model> <noreply@anthropic.com>` (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 depending on who writes). Never `git push`, never `--no-verify`, never rewrite history.
- TDD: failing test → minimal code → passing test → commit. Clean test output.
- Tests without network: no real `fetch` nor `setTimeout`/`time.Sleep` to synchronise (clock, `fetch` and timers injectable; `ManualTimers` from `panel/apps/api/test/manual-timers.ts`).
- Regex and `build` rules identical in Go and zod, with the shared fixture `proto/fixtures/build-cases.json`: `""` or `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`; only with type PAPER, FOLIA, PURPUR, FABRIC, QUILT, FORGE, NEOFORGE; never with version `LATEST`/`SNAPSHOT` (case-insensitive); with a value, the variable it generates cannot be in `env`.
- `build` mapping: PAPER→`PAPER_BUILD`, FOLIA→`FOLIABUILD` (no underscore), PURPUR→`PURPUR_BUILD`, FABRIC→`FABRIC_LOADER_VERSION`, QUILT→`QUILT_LOADER_VERSION`, FORGE→`FORGE_VERSION`, NEOFORGE→`NEOFORGE_VERSION`.
- `TestHashGolden` stays at `09ff6e5490b40677`: with an empty `build` nothing is emitted (`json:"build,omitempty"`).
- Cache: lists 1 h, builds 15 min, timeout 10 s, response ≤ 8 MiB, ≤ 256 entries (LRU), `User-Agent: mc-server-manager (self-hosted)`, HTTPS only to the source hosts.
- Only `STABLE` builds of Paper/Folia (experimental ones would require `PAPER_CHANNEL`/`FOLIA_CHANNEL`, out of scope).
- Web: API routes built with `apiPath`; shadcn with `pnpm dlx shadcn@3.8.5` (never `@latest`); vitest on node without jsdom (logic in pure functions with tests, components with SSR render).
- Machine Docker: there is PRODUCTION (`mcsm-panel-1`, `mcsm-agent`, network `mcsm`, volumes `mcsm_*`, ports 8080 and 25565–25600). The E2E only creates `mcsm-test-*` resources; compare `docker ps -a`/`network ls`/`volume ls` before and after.
- Toolchain: `eval "$(mise env)"` at the root before `go`/`buf`.

## Review Focus

1. **Specs and templates without `build`** (the API returns the stored JSON as is, so in the web `spec.build` may be `undefined`): changing version or saving must not invent a `build: ""` change in the diff nor break anything. → Test in Task 7 (`withVersion` over a spec without `build` + `buildSpecPatch`).
2. **A source answers 200 with something unexpected** (HTML error page, JSON with another shape): it must end in a 502 with a message in English or in the stored list with `stale`, never in a 500. → Tests in Task 3 (unexpected shape → `UpstreamError`) and Task 4 (foreign HTML/JSON → 502).
3. **Version with path characters in the builds URL** (`..%2F..`, `%00`, spaces, > 64): 400 without touching the network, never interpolated into the source URL. → Tests in Task 4 and Task 5.
4. **Updating the agent does not recreate containers** and an old agent ignores `build` without failing (`json.Unmarshal` without `DisallowUnknownFields`). → Test in Task 2 (hash with empty `build`).
5. **Custom image** (e.g. `java21-graalvm` of an imported server) when choosing a version that asks for another Java: the tag is not overwritten; only a warning is shown if it is not enough. → Test in Task 7.

## Execution order

Branch `feat/plan-10` from `master`. Task 1 first (shared contract). Then two lanes in parallel, each in its own worktree under `.worktrees/` with disjoint files (at most 2 agents):

- Lane A: Task 2 (Go) → Tasks 3–6 (API).
- Lane B: Tasks 7–8 (web).

When both finish, they are merged into `feat/plan-10` and Task 9 is done (E2E, documentation and full verification). One `task-reviewer` per lane batch and a joint final review.

## File map

| File | Responsibility |
|---|---|
| `panel/packages/shared/src/versions.ts` (new) | `BUILD_ENV`, `BUILD_RE`, `buildError`/`buildCheck`, `compareVersions`, `isStableVersion`, `minJavaTag`, `javaMajor`, DTOs |
| `panel/packages/shared/src/spec.ts` | `build` field in `baseFields` and `buildCheck` in `specChecks` |
| `proto/fixtures/build-cases.json` (new) | shared `build` cases Go/zod |
| `agent/internal/spec/build.go` (new) | `Spec.Build`: validation and environment variable |
| `agent/internal/spec/spec.go` | `Build` field, calls in `Validate` and `envList` |
| `panel/apps/api/src/versions/sources.ts` (new) | adapters per type (URL + parsing with zod) |
| `panel/apps/api/src/versions/catalog.ts` (new) | `VersionCatalog`: cache, deduplication, timeout, limits, 400/502 |
| `panel/apps/api/src/versions/routes.ts` (new) | `/api/versions/…` routes |
| `panel/apps/api/src/app.ts` | `AppOptions.versions`, decoration `app.versions`, route registration |
| `panel/apps/api/src/import/propose.ts`, `service.ts` | `env` → `build` on import; `build` editable |
| `panel/apps/web/src/components/ui/{command,popover}.tsx` (new, shadcn) | combobox primitives |
| `panel/apps/web/src/lib/versions.ts` (new) | combobox and build selector options (pure) |
| `panel/apps/web/src/lib/spec-edit.ts` | `withVersion`, `withType` empties `build`, `FORM_KEYS` |
| `panel/apps/web/src/hooks/use-versions.ts` (new) | `useVersions`, `useBuilds` |
| `panel/apps/web/src/components/spec-form/{version-picker,build-picker}.tsx` (new) | version combobox and build selector |
| `panel/apps/web/src/components/spec-form/version-section.tsx` | integrates both, adjusted Java, Spigot warning |
| `panel/apps/web/src/lib/{wizard,spec-diff}.ts` | build in the summary and in the diff |
| `panel/apps/e2e/tests/10-server.spec.ts` | the wizard uses the combobox |

---

### Task 1: Shared contract — `versions.ts` and the `build` field in the spec

**Files:**
- Create: `panel/packages/shared/src/versions.ts`
- Create: `panel/packages/shared/src/versions.test.ts`
- Create: `proto/fixtures/build-cases.json`
- Modify: `panel/packages/shared/src/spec.ts` (import, `baseFields`, `specChecks`)
- Modify: `panel/packages/shared/src/index.ts`

**Interfaces:**
- Produces (from `@mcsm/shared`):
  - `VERSION_LIST_TYPES: readonly ["VANILLA","PAPER","FOLIA","PURPUR","SPIGOT","FABRIC","QUILT","FORGE","NEOFORGE"]`, `type VersionListType`
  - `BUILD_ENV: Readonly<Record<string, string>>`, `buildEnvFor(type: string): string | undefined`
  - `BUILD_RE`, `VERSION_QUERY_RE` (the same regex), `BUILD_MESSAGES.{invalid, type(t), floating, env(k)}`
  - `isFloatingVersion(v: string): boolean`, `isStableVersion(v: string): boolean`
  - `buildError(s: {type; version; build; env}): {path: string[]; message: string} | null`, `buildCheck(s, ctx)`
  - `compareVersions(a: string, b: string): number` (> 0 if `a` is newer)
  - `minJavaTag(version: string): "java8" | "java17" | "java21" | "java25" | null`, `javaMajor(tag: string): number | null`
  - `interface VersionEntry { id: string; stable: boolean }`, `interface BuildEntry { id: string; stable: boolean; recommended: boolean }`
  - `interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }`
  - `interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }`
  - `Spec`/`SpecInput`/`TemplateSpec` with `build: string` (default `""`).

- [ ] **Step 1: Create the shared fixture**

`proto/fixtures/build-cases.json`:

```json
[
  { "name": "empty on any type", "type": "VANILLA", "version": "LATEST", "build": "", "ok": true },
  { "name": "Paper with numeric build", "type": "PAPER", "version": "1.20.1", "build": "178", "ok": true },
  { "name": "Folia", "type": "FOLIA", "version": "1.21.11", "build": "12", "ok": true },
  { "name": "Purpur", "type": "PURPUR", "version": "26.2", "build": "2633", "ok": true },
  { "name": "Fabric loader", "type": "FABRIC", "version": "26.3", "build": "0.19.5", "ok": true },
  { "name": "Quilt beta loader", "type": "QUILT", "version": "26.3", "build": "0.20.0-beta.9", "ok": true },
  { "name": "Forge", "type": "FORGE", "version": "1.20.1", "build": "47.4.27", "ok": true },
  { "name": "NeoForge beta", "type": "NEOFORGE", "version": "26.3", "build": "26.3.0.75-beta", "ok": true },
  { "name": "build with +", "type": "FABRIC", "version": "1.21.4", "build": "0.16.0+local", "ok": true },
  { "name": "64 characters", "type": "FORGE", "version": "1.20.1", "build": "a123456789012345678901234567890123456789012345678901234567890123", "ok": true },
  { "name": "65 characters", "type": "FORGE", "version": "1.20.1", "build": "a1234567890123456789012345678901234567890123456789012345678901234", "ok": false },
  { "name": "Vanilla does not allow build", "type": "VANILLA", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "Spigot does not allow build", "type": "SPIGOT", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "unknown type", "type": "BUKKIT", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "with LATEST", "type": "PAPER", "version": "LATEST", "build": "178", "ok": false },
  { "name": "with snapshot in lowercase", "type": "FABRIC", "version": "snapshot", "build": "0.19.5", "ok": false },
  { "name": "starts with a dot", "type": "PAPER", "version": "1.20.1", "build": ".1", "ok": false },
  { "name": "space", "type": "PAPER", "version": "1.20.1", "build": "1 2", "ok": false },
  { "name": "slash", "type": "PAPER", "version": "1.20.1", "build": "1/2", "ok": false },
  { "name": "newline at the end", "type": "PAPER", "version": "1.20.1", "build": "1\n", "ok": false },
  { "name": "non-ASCII", "type": "PAPER", "version": "1.20.1", "build": "1é", "ok": false },
  { "name": "env with the variable it generates", "type": "PAPER", "version": "1.20.1", "build": "178", "env": { "PAPER_BUILD": "100" }, "ok": false },
  { "name": "env with the variable without build", "type": "PAPER", "version": "1.20.1", "build": "", "env": { "PAPER_BUILD": "100" }, "ok": true },
  { "name": "env with the variable of another type", "type": "FABRIC", "version": "1.21.4", "build": "0.19.5", "env": { "PAPER_BUILD": "100" }, "ok": true },
  { "name": "Folia generates FOLIABUILD", "type": "FOLIA", "version": "1.21.11", "build": "12", "env": { "FOLIABUILD": "1" }, "ok": false }
]
```

- [ ] **Step 2: Write the failing tests**

`panel/packages/shared/src/versions.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { BUILD_ENV, buildError, compareVersions, isFloatingVersion, isStableVersion, javaMajor, minJavaTag } from "./versions.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("build-cases.json") as { name: string; type: string; version: string; build: string; env?: Record<string, string>; ok: boolean }[];

describe("shared cases with the Go agent (proto/fixtures/build-cases.json)", () => {
  it("the fixture has cases", () => expect(cases.length).toBeGreaterThanOrEqual(20));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, type: c.type, version: c.version, build: c.build, env: c.env ?? base.env });
    expect(r.success).toBe(c.ok);
  });
});

describe("build in the spec", () => {
  it("empty by default; travels in templates; null in a PATCH is 400", () => {
    expect(specInputSchema.parse({}).build).toBe("");
    expect(templateSpecSchema.parse({ type: "PAPER", version: "1.20.1", build: "178" }).build).toBe("178");
    expect(specPatchNullError({ build: null })).toMatch(/build/);
  });
  it("the errors point to the field and explain the reason", () => {
    expect(buildError({ type: "VANILLA", version: "1.21.4", build: "1", env: {} })).toEqual({ path: ["build"], message: expect.stringMatching(/VANILLA does not allow/) });
    expect(buildError({ type: "PAPER", version: "latest", build: "1", env: {} })?.message).toMatch(/specific version/);
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "1", env: { PAPER_BUILD: "2" } }))
      .toEqual({ path: ["env", "PAPER_BUILD"], message: expect.stringMatching(/Remove the PAPER_BUILD variable/) });
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "", env: { PAPER_BUILD: "2" } })).toBeNull();
  });
  it("each type with build has its itzg variable (Folia without underscore)", () => {
    expect(BUILD_ENV).toEqual({
      PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD", FABRIC: "FABRIC_LOADER_VERSION",
      QUILT: "QUILT_LOADER_VERSION", FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
    });
  });
});

describe("compareVersions", () => {
  const newestFirst = (xs: string[]) => [...xs].sort((a, b) => compareVersions(b, a));
  it("by numeric components; the year comes before 1.x and the release before its pre-release", () => {
    expect(newestFirst(["1.21.9", "1.21.10", "26.1", "1.21", "26.1.2", "1.21.11-rc3", "1.21.11"]))
      .toEqual(["26.1.2", "26.1", "1.21.11", "1.21.11-rc3", "1.21.10", "1.21.9", "1.21"]);
  });
  it("pre-releases among themselves and long builds", () => {
    expect(newestFirst(["0.20.0-beta.9", "0.24.0", "0.20.0-beta.10", "0.25.0-beta.1"])).toEqual(["0.25.0-beta.1", "0.24.0", "0.20.0-beta.10", "0.20.0-beta.9"]);
    expect(newestFirst(["26.3.0.9", "26.3.0.76", "26.3.0.75-beta"])).toEqual(["26.3.0.76", "26.3.0.75-beta", "26.3.0.9"]);
    expect(newestFirst(["1.7.10_pre4", "1.7.10", "1.8"])).toEqual(["1.8", "1.7.10", "1.7.10_pre4"]);
    expect(compareVersions("1.21", "1.21.0")).toBe(0);
  });
});

describe("minJavaTag and related", () => {
  it.each([
    ["LATEST", "java25"], ["snapshot", "java25"], ["26.3", "java25"], ["26.4-snapshot-3", "java25"], ["26.3-rc-3", "java25"],
    ["1.21.11", "java21"], ["1.21", "java21"], ["1.20.5", "java21"], ["1.20.5-pre1", "java21"],
    ["1.20.4", "java17"], ["1.18.2", "java17"], ["1.17", "java17"],
    ["1.16.5", "java8"], ["1.12.2", "java8"], ["1.7.10", "java8"],
    ["24w14a", "java21"], ["24w13a", "java17"], ["21w19a", "java17"], ["21w18a", "java8"],
    ["25w14craftmine", null], ["b1.7.3", null], ["", null],
  ] as const)("%s → %s", (v, tag) => expect(minJavaTag(v)).toBe(tag));
  it("javaMajor reads the number from the tag", () => {
    expect(javaMajor("java21-graalvm")).toBe(21);
    expect(javaMajor("java8")).toBe(8);
    expect(javaMajor("latest")).toBeNull();
  });
  it("stable = digits and dots only; LATEST/SNAPSHOT are floating", () => {
    expect(isStableVersion("1.21.11")).toBe(true);
    expect(isStableVersion("1.21.11-rc3")).toBe(false);
    expect(isStableVersion("25w14a")).toBe(false);
    expect(isFloatingVersion("Latest")).toBe(true);
    expect(isFloatingVersion("1.21")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm --filter @mcsm/shared exec vitest run src/versions.test.ts`
Expected: FAIL (`Cannot find module './versions.js'`).

- [ ] **Step 4: Implement `versions.ts`**

`panel/packages/shared/src/versions.ts`:

```ts
import type { z } from "zod";

/**
 * Version selector (plan 10, spec docs/superpowers/specs/2026-10-13-version-selector-design.md):
 * types with a version list, the spec's `build` field and its itzg variable, version comparison and
 * minimum Java. The `build` rules mirror agent/internal/spec/build.go; the cases in
 * proto/fixtures/build-cases.json are tested on both sides.
 */

/** Types with a Minecraft version list (modpacks and unknown ones use free text). */
export const VERSION_LIST_TYPES = ["VANILLA", "PAPER", "FOLIA", "PURPUR", "SPIGOT", "FABRIC", "QUILT", "FORGE", "NEOFORGE"] as const;
export type VersionListType = (typeof VERSION_LIST_TYPES)[number];

/** itzg variable that `build` generates depending on the type; only these types allow build. Folia: FOLIABUILD (scripts/start-deployFolia). */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD",
  FABRIC: "FABRIC_LOADER_VERSION", QUILT: "QUILT_LOADER_VERSION",
  FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
};
export const buildEnvFor = (type: string): string | undefined => (Object.hasOwn(BUILD_ENV, type) ? BUILD_ENV[type] : undefined);

/** Build/loader: ASCII without spaces or slashes, max. 64. The version requested from the API uses the same grammar. */
export const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const VERSION_QUERY_RE = BUILD_RE;

/** LATEST / SNAPSHOT (case-insensitive): itzg picks the version at startup. */
export const isFloatingVersion = (v: string): boolean => /^(latest|snapshot)$/i.test(v);

/** Stable = digits and dots only (1.21.11, 26.3). Pre-releases, rc and snapshots are not. */
export const isStableVersion = (v: string): boolean => /^\d+(\.\d+)*$/.test(v);

export const BUILD_MESSAGES = {
  invalid: "Invalid build: letters, digits and . _ + - (max. 64; starts with a letter or digit)",
  type: (type: string) => `The type ${type} does not allow setting the build (only Paper, Folia, Purpur, Fabric, Quilt, Forge and NeoForge)`,
  floating: "To set the build choose a specific Minecraft version (not LATEST or SNAPSHOT)",
  env: (key: string) => `Remove the variable ${key} from the environment variables (Advanced): the Build field sets it`,
};

/** First reason why `build` is not valid in this spec (with the field path); null if it is valid or empty. */
export function buildError(s: { type: string; version: string; build: string; env: Record<string, string> }): { path: string[]; message: string } | null {
  if (s.build === "") return null;
  if (!BUILD_RE.test(s.build)) return { path: ["build"], message: BUILD_MESSAGES.invalid };
  const key = buildEnvFor(s.type);
  if (!key) return { path: ["build"], message: BUILD_MESSAGES.type(s.type) };
  if (isFloatingVersion(s.version)) return { path: ["build"], message: BUILD_MESSAGES.floating };
  // The free env wins over what is generated: with a pinned build, its variable in env would silently override it.
  if (Object.hasOwn(s.env, key)) return { path: ["env", key], message: BUILD_MESSAGES.env(key) };
  return null;
}

export function buildCheck(s: Parameters<typeof buildError>[0], ctx: z.RefinementCtx) {
  const e = buildError(s);
  if (e) ctx.addIssue({ code: "custom", path: e.path, message: e.message });
}

function splitPre(v: string): [string, string] {
  const i = v.search(/[-_+]/);
  return i < 0 ? [v, ""] : [v.slice(0, i), v.slice(i + 1)];
}

function compareTokens(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "0";
    const y = b[i] ?? "0";
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    const c = nx && ny ? Number(x) - Number(y) : nx ? 1 : ny ? -1 : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Compares versions: > 0 if `a` is newer (1.21.10 > 1.21.9; 26.1 > 1.21.11; a release > its pre-release). */
export function compareVersions(a: string, b: string): number {
  const [aBase, aPre] = splitPre(a);
  const [bBase, bPre] = splitPre(b);
  const c = compareTokens(aBase.split("."), bBase.split("."));
  if (c !== 0) return c;
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return compareTokens(aPre.split(/[.\-_+]/), bPre.split(/[.\-_+]/));
}

/**
 * itzg image tag with the minimum Java that the Minecraft version requires; null if it is not recognised.
 * 26.x → 25; 1.20.5–1.21.x → 21; 1.17–1.20.4 → 17; earlier → 8. Old AAwSSl snapshots:
 * ≥ 24w14a → 21, ≥ 21w19a → 17. LATEST/SNAPSHOT → 25 (the latest).
 */
export function minJavaTag(version: string): "java8" | "java17" | "java21" | "java25" | null {
  const v = version.trim();
  if (isFloatingVersion(v)) return "java25";
  const old = /^(\d{2})w(\d{2})[a-z]$/.exec(v);
  if (old) {
    const n = Number(old[1]) * 100 + Number(old[2]);
    return n >= 2414 ? "java21" : n >= 2119 ? "java17" : "java8";
  }
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-_+].*)?$/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major >= 26) return "java25";
  if (major !== 1) return null;
  if (minor < 17) return "java8";
  if (minor < 20 || (minor === 20 && patch <= 4)) return "java17";
  return "java21";
}

/** Java number of an itzg tag ("java21-graalvm" → 21); null if it does not start with javaNN. */
export function javaMajor(tag: string): number | null {
  const m = /^java(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
}

export interface VersionEntry { id: string; stable: boolean }
export interface BuildEntry { id: string; stable: boolean; recommended: boolean }
export interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }
export interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }
```

- [ ] **Step 5: Add `build` to the spec**

In `panel/packages/shared/src/spec.ts`:

1. Next to the imports: `import { buildCheck } from "./versions.js";`
2. At the end of `baseFields` (after `// ── plan-9 ──`):

```ts
  // ── plan-9 ──
  // ── plan-10 ──
  build: z.string().default(""),
};
```

3. `specChecks` becomes:

```ts
function specChecks(
  s: Parameters<typeof memLimitCheck>[0] & Parameters<typeof contentCheck>[0] & Parameters<typeof limitsCheck>[0] & Parameters<typeof buildCheck>[0],
  ctx: z.RefinementCtx,
) {
  memLimitCheck(s, ctx);
  // ── plan-3 ──
  contentCheck(s, ctx);
  limitsCheck(s, ctx);
  // ── plan-10 ──
  buildCheck(s, ctx);
}
```

In `panel/packages/shared/src/index.ts` add `export * from "./versions.js";`.

- [ ] **Step 6: Run it and see it pass**

Run: `pnpm --filter @mcsm/shared exec vitest run src/versions.test.ts`
Expected: PASS.

- [ ] **Step 7: Fix the typed fixtures that now require `build`**

`Spec`, `SpecInput` and `TemplateSpec` now have `build: string`. Run: `pnpm typecheck && pnpm test`.
For each failure whose only cause is the new key (spec literals in tests, e.g. the `spec` of
`server-config-form.test.tsx`, or a `toEqual` over a full spec), add `build: ""` to the literal.
Do not change logic; if a failure is not of this kind, stop and report it (NEEDS_CONTEXT).
Expected after the fix: clean typecheck and all tests green.

- [ ] **Step 8: Commit**

```bash
git add proto/fixtures/build-cases.json panel/packages/shared/src/versions.ts panel/packages/shared/src/versions.test.ts panel/packages/shared/src/spec.ts panel/packages/shared/src/index.ts
git add -u panel   # only the test literals from Step 7
git commit -m "feat(shared): build field in the spec, compareVersions and minJavaTag"
```

---

### Task 2: Agent — `Spec.Build` and its environment variable

**Files:**
- Create: `agent/internal/spec/build.go`
- Create: `agent/internal/spec/build_test.go`
- Modify: `agent/internal/spec/spec.go` (field in `Spec`, `Validate`, `envList`)

**Interfaces:**
- Consumes: `proto/fixtures/build-cases.json` (Task 1).
- Produces: `Spec.Build string` (`json:"build,omitempty"`), `buildEnvKeys map[string]string`, `(Spec).validateBuild() error`, `(Spec).buildEnvVars(m map[string]string)`.
  Note: `content_test.go` already defines the test function `buildEnv(t, s)`; the map is called `buildEnvKeys` so that it does not clash.

- [ ] **Step 1: Write the failing tests**

`agent/internal/spec/build_test.go`:

```go
package spec

import (
	"encoding/json"
	"os"
	"testing"
)

func TestBuildCasesSharedWithZod(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("build-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string            `json:"name"`
		Type    string            `json:"type"`
		Version string            `json:"version"`
		Build   string            `json:"build"`
		Env     map[string]string `json:"env"`
		OK      bool              `json:"ok"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20 {
		t.Fatalf("only %d cases: truncated fixture?", len(cases))
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Type, s.Version, s.Build = c.Type, c.Version, c.Build
		if c.Env != nil {
			s.Env = c.Env
		}
		if err := s.Validate(); (err == nil) != c.OK {
			t.Errorf("%s: Validate() = %v; expected ok %v", c.Name, err, c.OK)
		}
	}
}

func TestBuildEnvByType(t *testing.T) {
	want := map[string]string{
		"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
		"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
		"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
	}
	if len(buildEnvKeys) != len(want) {
		t.Fatalf("buildEnvKeys = %v", buildEnvKeys)
	}
	for typ, key := range want {
		s := loadFixture(t)
		s.Type, s.Build = typ, "42"
		env := buildEnv(t, s)
		if env[key] != "42" {
			t.Errorf("%s: %s = %q, want 42", typ, key, env[key])
		}
		for _, other := range buildEnvKeys {
			if _, ok := env[other]; ok && other != key {
				t.Errorf("%s: must not emit %s", typ, other)
			}
		}
	}
}

// Without build nothing is emitted: updating the agent recreates no container.
func TestBuildEmptyKeepsHash(t *testing.T) {
	s := loadFixture(t)
	if s.Build != "" {
		t.Fatal("the fixture must not have a build")
	}
	if h := hashOfSpec(t, s); h != "09ff6e5490b40677" {
		t.Fatalf("the hash of a spec without build changed: %s", h)
	}
	env := buildEnv(t, s)
	for _, k := range buildEnvKeys {
		if _, ok := env[k]; ok {
			t.Errorf("without build %s is not emitted", k)
		}
	}
	s.Build = "178"
	if hashOfSpec(t, s) == "09ff6e5490b40677" {
		t.Error("a pinned build changes the environment and must change the hash")
	}
}

// A panel without the field (or an old agent) does not break the JSON.
func TestBuildAbsentFromJSON(t *testing.T) {
	s, err := Parse([]byte(`{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"4G","ports":{"game":25565,"extra":[]},"restartPolicy":"unless-stopped","rconPassword":"s3cretpassw0rd"}`))
	if err != nil || s.Build != "" {
		t.Fatalf("Parse without build: %v, %q", err, s.Build)
	}
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["build"]; ok {
		t.Error("empty build is not serialised (omitempty)")
	}
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `eval "$(mise env)" && (cd agent && go test ./internal/spec/ -run 'TestBuild' )`
Expected: compile FAIL (`s.Build undefined`, `buildEnvKeys undefined`).

- [ ] **Step 3: Implement**

`agent/internal/spec/build.go`:

```go
package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// Build field (plan 10): build of the server or version of the loader. Empty = the latest (itzg
// picks it): nothing is emitted and the hash does not change. Mirror of panel/packages/shared/src/versions.ts;
// shared cases in proto/fixtures/build-cases.json.

// buildEnvKeys is the itzg variable that build generates depending on the type. Folia uses FOLIABUILD (no
// underscore; itzg's scripts/start-deployFolia).
var buildEnvKeys = map[string]string{
	"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
	"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
	"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
}

// Same regex as BUILD_RE in the panel.
var buildRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

func isFloatingVersion(v string) bool {
	return strings.EqualFold(v, "LATEST") || strings.EqualFold(v, "SNAPSHOT")
}

func (s Spec) validateBuild() error {
	if s.Build == "" {
		return nil
	}
	if !buildRe.MatchString(s.Build) {
		return fmt.Errorf("spec: invalid build (letters, digits and . _ + -; max. 64; starts with a letter or digit)")
	}
	key, ok := buildEnvKeys[s.Type]
	if !ok {
		return fmt.Errorf("spec: type %s does not allow setting the build (only Paper, Folia, Purpur, Fabric, Quilt, Forge and NeoForge)", s.Type)
	}
	if isFloatingVersion(s.Version) {
		return fmt.Errorf("spec: to set the build choose a specific Minecraft version (not LATEST or SNAPSHOT)")
	}
	// The free env wins over what is generated: it would silently override the build.
	if _, ok := s.Env[key]; ok {
		return fmt.Errorf("spec: remove the variable %s from the environment variables (Advanced): the Build field sets it", key)
	}
	return nil
}

// buildEnvVars adds the build variable to the generated environment, if there is one.
func (s Spec) buildEnvVars(m map[string]string) {
	if s.Build == "" {
		return
	}
	if key, ok := buildEnvKeys[s.Type]; ok {
		m[key] = s.Build
	}
}
```

In `agent/internal/spec/spec.go`:

1. In `type Spec struct`, after `// ── plan-9 ──`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	// Build: build or loader version (PAPER_BUILD, FABRIC_LOADER_VERSION…). Empty = the latest:
	// it does not enter the environment and the hash does not change.
	Build string `json:"build,omitempty"`
}
```

2. In `Validate`, after `// ── plan-9 ──` and before `return nil`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	if err := s.validateBuild(); err != nil {
		return err
	}
	return nil
```

3. In `envList`, after `// ── plan-9 ──` and before the loop over `s.Env`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	s.buildEnvVars(m)
	for k, v := range s.Env {
```

- [ ] **Step 4: Run it and see it pass**

Run: `eval "$(mise env)" && (cd agent && go vet ./... && go test ./internal/spec/ && go test -race ./...)`
Expected: PASS (including `TestHashGolden` and `TestContentHash` untouched).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/spec/build.go agent/internal/spec/build_test.go agent/internal/spec/spec.go
git commit -m "feat(agent): spec build field translated to each type's itzg variable"
```

---

### Task 3: API — version source adapters

**Files:**
- Create: `panel/apps/api/src/versions/sources.ts`
- Create: `panel/apps/api/src/versions/sources.test.ts`

**Interfaces:**
- Consumes: `compareVersions`, `isStableVersion`, `VersionEntry`, `BuildEntry`, `VersionListType` from `@mcsm/shared`.
- Produces:
  - `class UpstreamError extends Error { status: number | null }`
  - `interface GetOptions { kind?: "json" | "text"; ttl?: "list" | "builds" }`, `type Get = (url: string, opts?: GetOptions) => Promise<unknown>`
  - `interface Source { label: string; versions(get: Get): Promise<VersionEntry[]>; builds?(get: Get, version: string): Promise<BuildEntry[]> }`
  - `SOURCES: Readonly<Record<VersionListType, Source>>`, `allowedSource(url: string): boolean`, `forgeBuildId(full, mc)`, `neoforgeMcVersion(v)`.

The fixtures are inline in the test: small documents with the exact shape of the real responses (checked on 2026-10-13; the fields that the parsing ignores are trimmed).

- [ ] **Step 1: Write the failing tests**

`panel/apps/api/src/versions/sources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCES, UpstreamError, allowedSource, forgeBuildId, neoforgeMcVersion, type Get, type GetOptions } from "./sources.js";

/** Fake `get`: returns each URL's document and records what was asked. */
function fakeGet(docs: Record<string, unknown>) {
  const asked: ({ url: string } & GetOptions)[] = [];
  const get: Get = async (url, opts = {}) => {
    asked.push({ url, ...opts });
    if (!Object.hasOwn(docs, url)) throw new Error(`unexpected URL: ${url}`);
    return docs[url];
  };
  return { get, asked };
}

const MOJANG = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FILL = "https://fill.papermc.io/v3/projects";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const FORGE_META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const FORGE_PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

describe("Vanilla (Mojang)", () => {
  it("releases and snapshots in the source's order; without old_alpha/old_beta", async () => {
    const { get } = fakeGet({ [MOJANG]: {
      latest: { release: "26.3", snapshot: "26.4-snapshot-3" },
      versions: [
        { id: "26.4-snapshot-3", type: "snapshot", url: "https://piston-meta.mojang.com/v1/packages/x/26.4-snapshot-3.json", releaseTime: "2026-10-06T12:54:26+00:00" },
        { id: "26.3", type: "release" }, { id: "1.21.11", type: "release" }, { id: "25w14a", type: "snapshot" }, { id: "b1.7.3", type: "old_beta" },
      ],
    } });
    expect(await SOURCES.VANILLA.versions(get)).toEqual([
      { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "1.21.11", stable: true }, { id: "25w14a", stable: false },
    ]);
    expect(SOURCES.VANILLA.builds).toBeUndefined();
  });
});

describe("Paper and Folia (Fill v3)", () => {
  it("flattens the families and sorts from newest to oldest", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: {
      project: { id: "paper", name: "Paper" },
      versions: { "26.3": ["26.3", "26.3-rc-3"], "1.21": ["1.21.11", "1.21.11-rc3", "1.21.10", "1.21"], "1.20": ["1.20.6", "1.20.1"] },
    } });
    expect(await SOURCES.PAPER.versions(get)).toEqual([
      { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false }, { id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false },
      { id: "1.21.10", stable: true }, { id: "1.21", stable: true }, { id: "1.20.6", stable: true }, { id: "1.20.1", stable: true },
    ]);
  });
  it("builds: only STABLE, with the builds cache", async () => {
    const url = `${FILL}/paper/versions/1.20.1/builds`;
    const { get, asked } = fakeGet({ [url]: [
      { id: 177, time: "2026-10-01T00:00:00Z", channel: "BETA", commits: [], downloads: {} },
      { id: 178, time: "2026-10-12T20:42:19Z", channel: "STABLE", commits: [], downloads: {} },
      { id: 176, time: "2026-09-30T00:00:00Z", channel: "STABLE", commits: [], downloads: {} },
    ] });
    expect(await SOURCES.PAPER.builds!(get, "1.20.1")).toEqual([
      { id: "178", stable: true, recommended: false }, { id: "176", stable: true, recommended: false },
    ]);
    expect(asked).toEqual([{ url, ttl: "builds" }]);
  });
  it("Folia uses its own project", async () => {
    const { get } = fakeGet({ [`${FILL}/folia`]: { project: { id: "folia" }, versions: { "1.21": ["1.21.11"] } } });
    expect(await SOURCES.FOLIA.versions(get)).toEqual([{ id: "1.21.11", stable: true }]);
  });
  it("the version is encoded when building the URL", async () => {
    const { get, asked } = fakeGet({ [`${FILL}/paper/versions/1.21%2B1/builds`]: [] });
    await SOURCES.PAPER.builds!(get, "1.21+1");
    expect(asked[0]!.url).toBe(`${FILL}/paper/versions/1.21%2B1/builds`);
  });
  it("a response with another shape is an UpstreamError (not a 500)", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: "<html>maintenance</html>" });
    await expect(SOURCES.PAPER.versions(get)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("Purpur", () => {
  it("versions and builds from newest to oldest", async () => {
    const { get } = fakeGet({
      [PURPUR]: { project: "purpur", metadata: { current: "26.2" }, versions: ["1.14.1", "1.21.11", "26.1.2", "26.2"] },
      [`${PURPUR}/26.2`]: { project: "purpur", version: "26.2", builds: { latest: "2633", all: ["2593", "2600", "2633"] } },
    });
    expect((await SOURCES.PURPUR.versions(get)).map((v) => v.id)).toEqual(["26.2", "26.1.2", "1.21.11", "1.14.1"]);
    expect(await SOURCES.PURPUR.builds!(get, "26.2")).toEqual([
      { id: "2633", stable: true, recommended: false }, { id: "2600", stable: true, recommended: false }, { id: "2593", stable: true, recommended: false },
    ]);
  });
});

describe("Spigot (BuildTools index)", () => {
  it("only version names, no duplicates or loose builds", async () => {
    const html = `<html><head><title>Index of /versions/</title></head><body><pre>
<a href="latest.json">latest.json</a>    15-Sep-2026 15:15   534
<a href="1.8.json">1.8.json</a>   16-Apr-2015 22:00   479
<a href="1.21.11.json">1.21.11.json</a>
<a href="26.1.json">26.1.json</a>
<a href="3000.json">3000.json</a>
<a href="1.21.11.json">1.21.11.json</a>
</pre></body></html>`;
    const { get, asked } = fakeGet({ "https://hub.spigotmc.org/versions/": html });
    expect(await SOURCES.SPIGOT.versions(get)).toEqual([{ id: "26.1", stable: true }, { id: "1.21.11", stable: true }, { id: "1.8", stable: true }]);
    expect(asked[0]).toMatchObject({ kind: "text" });
    expect(SOURCES.SPIGOT.builds).toBeUndefined();
  });
});

describe("Fabric and Quilt", () => {
  it("Fabric: versions and loaders with their stable flag", async () => {
    const { get } = fakeGet({
      "https://meta.fabricmc.net/v2/versions/game": [{ version: "26.4-snapshot-3", stable: false }, { version: "26.3", stable: true }],
      "https://meta.fabricmc.net/v2/versions/loader/26.3": [
        { loader: { separator: ".", build: 5, maven: "net.fabricmc:fabric-loader:0.19.5", version: "0.19.5", stable: true }, intermediary: {}, launcherMeta: {} },
        { loader: { version: "0.19.4", stable: false }, intermediary: {}, launcherMeta: {} },
      ],
    });
    expect(await SOURCES.FABRIC.versions(get)).toEqual([{ id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }]);
    expect(await SOURCES.FABRIC.builds!(get, "26.3")).toEqual([
      { id: "0.19.5", stable: true, recommended: false }, { id: "0.19.4", stable: false, recommended: false },
    ]);
  });
  it("Quilt: the loaders arrive unsorted; beta = with suffix", async () => {
    const { get } = fakeGet({
      "https://meta.quiltmc.org/v3/versions/loader/26.3": [
        { loader: { version: "0.20.0-beta.9" } }, { loader: { version: "0.24.0" } }, { loader: { version: "0.20.0-beta.10" } },
      ],
    });
    expect(await SOURCES.QUILT.builds!(get, "26.3")).toEqual([
      { id: "0.24.0", stable: true, recommended: false }, { id: "0.20.0-beta.10", stable: false, recommended: false }, { id: "0.20.0-beta.9", stable: false, recommended: false },
    ]);
  });
});

describe("Forge", () => {
  const docs = {
    [FORGE_META]: {
      "1.7.10_pre4": ["1.7.10_pre4-10.12.2.1149-prerelease"],
      "1.7.10": ["1.7.10-10.13.4.1566-1.7.10", "1.7.10-10.13.4.1614-1.7.10"],
      "1.20.1": ["1.20.1-47.4.26", "1.20.1-47.4.27", "1.20.1-47.4.0"],
      "26.3": ["26.3-66.0.0", "26.3-66.0.11"],
    },
    [FORGE_PROMOS]: { homepage: "https://files.minecraftforge.net/net/minecraftforge/forge/", promos: { "1.20.1-latest": "47.4.27", "1.20.1-recommended": "47.4.0" } },
  };
  it("MC versions = keys of the metadata", async () => {
    expect(await SOURCES.FORGE.versions(fakeGet(docs).get)).toEqual([
      { id: "26.3", stable: true }, { id: "1.20.1", stable: true }, { id: "1.7.10", stable: true }, { id: "1.7.10_pre4", stable: false },
    ]);
  });
  it("builds without the version prefix, with the recommended one marked", async () => {
    expect(await SOURCES.FORGE.builds!(fakeGet(docs).get, "1.20.1")).toEqual([
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26", stable: true, recommended: false }, { id: "47.4.0", stable: true, recommended: true },
    ]);
    expect(await SOURCES.FORGE.builds!(fakeGet(docs).get, "1.12.2")).toEqual([]);
    expect(forgeBuildId("1.7.10-10.13.4.1614-1.7.10", "1.7.10")).toBe("10.13.4.1614");
  });
});

describe("NeoForge", () => {
  const docs = { [NEOFORGE]: { isSnapshot: false, versions: [
    "0.25w14craftmine.3-beta", "20.2.3-beta", "20.4.237", "21.0.167", "21.1.77", "21.1.228", "26.1.0.0-alpha", "26.1.2.5", "26.3.0.75-beta", "26.3.0.76",
  ] } };
  it("MC version deduced", () => {
    expect(["26.3.0.76", "26.1.2.5", "21.0.167", "21.1.77", "20.2.3-beta", "0.25w14craftmine.3-beta", "19.1.2", "26.1"].map(neoforgeMcVersion))
      .toEqual(["26.3", "26.1.2", "1.21", "1.21.1", "1.20.2", null, null, null]);
  });
  it("unique versions and builds filtered by version", async () => {
    expect((await SOURCES.NEOFORGE.versions(fakeGet(docs).get)).map((v) => v.id)).toEqual(["26.3", "26.1.2", "26.1", "1.21.1", "1.21", "1.20.4", "1.20.2"]);
    expect(await SOURCES.NEOFORGE.builds!(fakeGet(docs).get, "1.21.1")).toEqual([
      { id: "21.1.228", stable: true, recommended: false }, { id: "21.1.77", stable: true, recommended: false },
    ]);
    expect(await SOURCES.NEOFORGE.builds!(fakeGet(docs).get, "26.3")).toEqual([
      { id: "26.3.0.76", stable: true, recommended: false }, { id: "26.3.0.75-beta", stable: false, recommended: false },
    ]);
  });
});

describe("allowedSource", () => {
  it("only HTTPS and only the sources' hosts", () => {
    expect(allowedSource(`${PURPUR}/26.2`)).toBe(true);
    expect(allowedSource(FORGE_PROMOS)).toBe(true);
    expect(allowedSource("http://api.purpurmc.org/v2/purpur")).toBe(false);
    expect(allowedSource("https://evil.example/v2/purpur")).toBe(false);
    expect(allowedSource("not a url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/sources.test.ts`
Expected: FAIL (`Cannot find module './sources.js'`).

- [ ] **Step 3: Implement**

`panel/apps/api/src/versions/sources.ts`:

```ts
import { z } from "zod";
import { compareVersions, isStableVersion, type BuildEntry, type VersionEntry, type VersionListType } from "@mcsm/shared";

/**
 * Official version sources (spec 2026-10-13-version-selector-design.md §2). Each adapter requests
 * its documents with `get` (the VersionCatalog adds cache, timeout and limits) and normalises them to
 * lists from newest to oldest. A response with an unexpected shape throws UpstreamError (→ 502 or the
 * stored list), never a 500.
 */

export class UpstreamError extends Error {
  /** `status`: HTTP status of the source, or null (network, timeout, size, unexpected shape). */
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface GetOptions { kind?: "json" | "text"; ttl?: "list" | "builds" }
export type Get = (url: string, opts?: GetOptions) => Promise<unknown>;

export interface Source {
  /** Name for messages ("Could not fetch the version list of Paper"). */
  label: string;
  versions(get: Get): Promise<VersionEntry[]>;
  builds?(get: Get, version: string): Promise<BuildEntry[]>;
}

const MOJANG = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FILL = "https://fill.papermc.io/v3/projects";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const SPIGOT = "https://hub.spigotmc.org/versions/";
const FABRIC = "https://meta.fabricmc.net/v2/versions";
const QUILT = "https://meta.quiltmc.org/v3/versions";
const FORGE_META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const FORGE_PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

const HOSTS = new Set([MOJANG, FILL, PURPUR, SPIGOT, FABRIC, QUILT, FORGE_META, NEOFORGE].map((u) => new URL(u).host));

/** Only HTTPS and only the sources' hosts (the catalog checks it before each download). */
export function allowedSource(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOSTS.has(u.host);
  } catch {
    return false;
  }
}

function parse<T extends z.ZodType>(schema: T, doc: unknown, label: string): z.infer<T> {
  const r = schema.safeParse(doc);
  if (!r.success) throw new UpstreamError(null, `unexpected response from ${label}`);
  return r.data;
}

const newestFirst = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => compareVersions(b.id, a.id));
const unique = (xs: string[]): string[] => [...new Set(xs)];
const enc = encodeURIComponent;
const asVersions = (ids: string[]): VersionEntry[] => newestFirst(unique(ids).map((id) => ({ id, stable: isStableVersion(id) })));
const build = (id: string, stable = true, recommended = false): BuildEntry => ({ id, stable, recommended });

const metaGame = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const versionsDoc = z.object({ versions: z.array(z.string()) });

// Mojang, Fabric and Quilt already come from newest to oldest and mix snapshots with names that
// compareVersions does not sort (25w14a): their order is kept.
const vanilla: Source = {
  label: "Minecraft",
  async versions(get) {
    const doc = parse(z.object({ versions: z.array(z.object({ id: z.string(), type: z.string() })) }), await get(MOJANG), "Minecraft");
    return doc.versions.filter((v) => v.type === "release" || v.type === "snapshot").map((v) => ({ id: v.id, stable: v.type === "release" }));
  },
};

function fill(project: "paper" | "folia", label: string): Source {
  return {
    label,
    async versions(get) {
      const doc = parse(z.object({ versions: z.record(z.string(), z.array(z.string())) }), await get(`${FILL}/${project}`), label);
      return asVersions(Object.values(doc.versions).flat());
    },
    async builds(get, version) {
      const doc = parse(z.array(z.object({ id: z.number().int(), channel: z.string() })),
        await get(`${FILL}/${project}/versions/${enc(version)}/builds`, { ttl: "builds" }), label);
      // Only STABLE: an experimental build would require PAPER_CHANNEL/FOLIA_CHANNEL=experimental.
      return doc.filter((b) => b.channel === "STABLE").sort((a, b) => b.id - a.id).map((b) => build(String(b.id)));
    },
  };
}

const purpur: Source = {
  label: "Purpur",
  async versions(get) {
    return asVersions(parse(versionsDoc, await get(PURPUR), "Purpur").versions);
  },
  async builds(get, version) {
    const doc = parse(z.object({ builds: z.object({ all: z.array(z.string()) }) }), await get(`${PURPUR}/${enc(version)}`, { ttl: "builds" }), "Purpur");
    return newestFirst(unique(doc.builds.all).map((id) => build(id)));
  },
};

const spigot: Source = {
  label: "Spigot",
  async versions(get) {
    const html = await get(SPIGOT, { kind: "text" });
    if (typeof html !== "string") throw new UpstreamError(null, "unexpected response from Spigot");
    // BuildTools index: <version>.json; loose numbers (3000.json) are internal builds.
    return asVersions([...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map((m) => m[1]!));
  },
};

const fabric: Source = {
  label: "Fabric",
  async versions(get) {
    return parse(metaGame, await get(`${FABRIC}/game`), "Fabric").map((g) => ({ id: g.version, stable: g.stable }));
  },
  async builds(get, version) {
    const doc = parse(z.array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) })),
      await get(`${FABRIC}/loader/${enc(version)}`, { ttl: "builds" }), "Fabric");
    return doc.map((l) => build(l.loader.version, l.loader.stable));
  },
};

const quilt: Source = {
  label: "Quilt",
  async versions(get) {
    return parse(metaGame, await get(`${QUILT}/game`), "Quilt").map((g) => ({ id: g.version, stable: g.stable }));
  },
  async builds(get, version) {
    const doc = parse(z.array(z.object({ loader: z.object({ version: z.string() }) })), await get(`${QUILT}/loader/${enc(version)}`, { ttl: "builds" }), "Quilt");
    return newestFirst(unique(doc.map((l) => l.loader.version)).map((id) => build(id, isStableVersion(id))));
  },
};

/** "1.20.1-47.4.27" → "47.4.27"; the old ones ("1.7.10-10.13.4.1614-1.7.10") repeat the version at the end. */
export function forgeBuildId(full: string, mc: string): string {
  let id = full.startsWith(`${mc}-`) ? full.slice(mc.length + 1) : full;
  if (id.endsWith(`-${mc}`)) id = id.slice(0, -(mc.length + 1));
  return id;
}

const forgeMeta = z.record(z.string(), z.array(z.string()));
const forge: Source = {
  label: "Forge",
  async versions(get) {
    return asVersions(Object.keys(parse(forgeMeta, await get(FORGE_META), "Forge")));
  },
  async builds(get, version) {
    const meta = parse(forgeMeta, await get(FORGE_META), "Forge");
    const promos = parse(z.object({ promos: z.record(z.string(), z.string()) }), await get(FORGE_PROMOS, { ttl: "builds" }), "Forge").promos;
    const recommended = promos[`${version}-recommended`];
    const ids = Object.hasOwn(meta, version) ? (meta[version] ?? []) : [];
    return newestFirst(unique(ids.map((full) => forgeBuildId(full, version))).map((id) => build(id, true, id === recommended)));
  },
};

/**
 * Minecraft version of a NeoForge version (the part before the first "-"): major ≥ 26 → 26.3.0.76 = 26.3,
 * 26.1.2.5 = 26.1.2; major 20–25 → 21.0.167 = 1.21, 21.1.77 = 1.21.1. Other forms → null.
 */
export function neoforgeMcVersion(v: string): string | null {
  const p = (v.split("-")[0] ?? "").split(".");
  if (!p.every((x) => /^\d+$/.test(x))) return null;
  const major = Number(p[0]);
  if (major >= 26 && p.length === 4) return p[2] === "0" ? `${p[0]}.${p[1]}` : `${p[0]}.${p[1]}.${p[2]}`;
  if (major >= 20 && major <= 25 && p.length === 3) return p[1] === "0" ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
  return null;
}

const neoforge: Source = {
  label: "NeoForge",
  async versions(get) {
    const all = parse(versionsDoc, await get(NEOFORGE), "NeoForge").versions;
    return asVersions(all.map(neoforgeMcVersion).filter((v): v is string => v !== null));
  },
  async builds(get, version) {
    const all = parse(versionsDoc, await get(NEOFORGE), "NeoForge").versions;
    return newestFirst(all.filter((v) => neoforgeMcVersion(v) === version).map((id) => build(id, !id.includes("-"))));
  },
};

export const SOURCES: Readonly<Record<VersionListType, Source>> = {
  VANILLA: vanilla, PAPER: fill("paper", "Paper"), FOLIA: fill("folia", "Folia"), PURPUR: purpur, SPIGOT: spigot,
  FABRIC: fabric, QUILT: quilt, FORGE: forge, NEOFORGE: neoforge,
};
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/sources.test.ts && pnpm --filter @mcsm/api typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/sources.ts panel/apps/api/src/versions/sources.test.ts
git commit -m "feat(panel): adapters for the official version and build sources

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — `VersionCatalog` (cache, deduplication, timeout and errors)

**Files:**
- Create: `panel/apps/api/src/versions/catalog.ts`
- Create: `panel/apps/api/src/versions/catalog.test.ts`

**Interfaces:**
- Consumes: `SOURCES`, `UpstreamError`, `allowedSource`, `Get`, `Source` (Task 3); `Timers`, `realTimers` (`src/files/stream.ts`); `HttpError` (`src/lib/http.ts`); `BUILD_MESSAGES`, `VERSION_LIST_TYPES`, `VERSION_QUERY_RE`, DTOs (Task 1).
- Produces:
  - `LIST_TTL_MS`, `BUILDS_TTL_MS`, `FETCH_TIMEOUT_MS`, `MAX_BODY_BYTES`, `MAX_ENTRIES`, `USER_AGENT`
  - `type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>`
  - `interface CatalogOptions { fetch?; now?: () => number; timers?: Timers; onError?: (url: string, err: unknown) => void }`
  - `class VersionCatalog { versions(type: string): Promise<VersionListDto>; builds(type: string, version: string): Promise<BuildListDto> }` — throws `HttpError` 400/502.

- [ ] **Step 1: Write the failing tests**

`panel/apps/api/src/versions/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { BUILDS_TTL_MS, FETCH_TIMEOUT_MS, LIST_TTL_MS, MAX_BODY_BYTES, MAX_ENTRIES, VersionCatalog, type FetchFn } from "./catalog.js";

const PURPUR = "https://api.purpurmc.org/v2/purpur";
const purpurDoc = (versions: string[]) => JSON.stringify({ project: "purpur", versions });
const buildsDoc = (all: string[]) => JSON.stringify({ builds: { all } });
type Init = Parameters<FetchFn>[1];

/** Fake fetch: queued responses per URL; records each call. */
function fakeFetch() {
  const calls: ({ url: string } & Init)[] = [];
  const routes = new Map<string, ((init: Init) => Promise<Response>)[]>();
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift();
    return next ? next(init) : Promise.reject(new TypeError(`no network for ${url}`));
  };
  const reply = (url: string, body: string | ((init: Init) => Promise<Response>), status = 200) => {
    const q = routes.get(url) ?? [];
    q.push(typeof body === "function" ? body : () => Promise.resolve(new Response(body, { status })));
    routes.set(url, q);
  };
  return { fetch, calls, reply };
}

function setup() {
  let now = Date.parse("2026-10-13T10:00:00Z");
  const f = fakeFetch();
  const timers = new ManualTimers();
  const errors: string[] = [];
  const catalog = new VersionCatalog({ fetch: f.fetch, now: () => now, timers, onError: (url) => errors.push(url) });
  return { catalog, ...f, timers, errors, advance: (ms: number) => { now += ms; } };
}

describe("VersionCatalog", () => {
  it("keeps the list for 1 h and requests it again when it expires", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["1.21.11", "26.2"]));
    expect(await t.catalog.versions("PURPUR")).toEqual({
      type: "PURPUR", versions: [{ id: "26.2", stable: true }, { id: "1.21.11", stable: true }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
    expect(t.calls[0]!.headers["user-agent"]).toBe("mc-server-manager (self-hosted)");
    expect(t.timers.pending).toBe(0);
    t.advance(LIST_TTL_MS - 1);
    await t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    t.reply(PURPUR, purpurDoc(["26.3"]));
    t.advance(1);
    expect((await t.catalog.versions("PURPUR")).versions).toEqual([{ id: "26.3", stable: true }]);
    expect(t.calls).toHaveLength(2);
  });

  it("if the source fails it serves the stored copy with stale; with nothing stored, a 502 in English", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["26.2"]));
    await t.catalog.versions("PURPUR");
    t.advance(LIST_TTL_MS);
    t.reply(PURPUR, "down", 503);
    expect(await t.catalog.versions("PURPUR")).toMatchObject({ stale: true, fetchedAt: "2026-10-13T10:00:00.000Z", versions: [{ id: "26.2", stable: true }] });
    expect(t.errors).toEqual([PURPUR]);

    const t2 = setup();
    t2.reply(PURPUR, "down", 503);
    await expect(t2.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502, message: "Could not fetch the version list of Purpur" });
  });

  it("a 200 that is not the expected JSON is a 502, not a 500", async () => {
    const t = setup();
    t.reply(PURPUR, "<html>maintenance</html>");
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    t.reply(PURPUR, JSON.stringify({ otra: "forma" }));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("two simultaneous queries share the download", async () => {
    const t = setup();
    let release!: (r: Response) => void;
    t.reply(PURPUR, () => new Promise<Response>((r) => { release = r; }));
    const p1 = t.catalog.versions("PURPUR");
    const p2 = t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    release(new Response(purpurDoc(["26.2"])));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.versions).toEqual(b.versions);
    expect(t.calls).toHaveLength(1);
  });

  it("10 s timeout: aborts the download and responds 502", async () => {
    const t = setup();
    t.reply(PURPUR, (init) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
    }));
    const p = t.catalog.versions("PURPUR");
    expect(t.timers.pending).toBe(1);
    t.timers.advance(FETCH_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ status: 502 });
    expect(t.timers.pending).toBe(0);
  });

  it("a response over 8 MiB is a 502", async () => {
    const t = setup();
    t.reply(PURPUR, "x".repeat(MAX_BODY_BYTES + 1));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("builds: 15 min cache; a 4xx from the source is an empty list", async () => {
    const t = setup();
    const url = `${PURPUR}/26.2`;
    t.reply(url, buildsDoc(["2600", "2633"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds).toEqual([
      { id: "2633", stable: true, recommended: false }, { id: "2600", stable: true, recommended: false },
    ]);
    t.advance(BUILDS_TTL_MS);
    t.reply(url, buildsDoc(["2634"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds[0]!.id).toBe("2634");
    t.reply(`${PURPUR}/9.9.9`, JSON.stringify({ error: "version not found" }), 404);
    expect(await t.catalog.builds("PURPUR", "9.9.9")).toMatchObject({ type: "PURPUR", version: "9.9.9", builds: [], stale: false });
  });

  it("types without a list, types without build and invalid versions: 400 without touching the network", async () => {
    const t = setup();
    await expect(t.catalog.versions("MODRINTH")).rejects.toMatchObject({ status: 400, message: "Type has no version list" });
    await expect(t.catalog.versions("__proto__")).rejects.toMatchObject({ status: 400 });
    await expect(t.catalog.builds("VANILLA", "1.21.4")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/VANILLA does not allow/) });
    for (const v of ["../../etc", "1.21 ", "\u0000", "a".repeat(65), ""]) {
      await expect(t.catalog.builds("PAPER", v)).rejects.toMatchObject({ status: 400, message: "Invalid version" });
    }
    expect(t.calls).toHaveLength(0);
  });

  it(`at most ${MAX_ENTRIES} entries: the least used one is discarded`, async () => {
    const t = setup();
    const url = (i: number) => `${PURPUR}/1.0.${i}`;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      t.reply(url(i), buildsDoc([String(i)]));
      await t.catalog.builds("PURPUR", `1.0.${i}`);
    }
    await t.catalog.builds("PURPUR", "1.0.0"); // use: it becomes the most recent
    t.reply(url(MAX_ENTRIES), buildsDoc(["x"]));
    await t.catalog.builds("PURPUR", `1.0.${MAX_ENTRIES}`); // discards 1.0.1
    const before = t.calls.length;
    await t.catalog.builds("PURPUR", "1.0.0");
    expect(t.calls).toHaveLength(before);
    t.reply(url(1), buildsDoc(["1"]));
    await t.catalog.builds("PURPUR", "1.0.1");
    expect(t.calls).toHaveLength(before + 1);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/catalog.test.ts`
Expected: FAIL (`Cannot find module './catalog.js'`).

- [ ] **Step 3: Implement**

`panel/apps/api/src/versions/catalog.ts`:

```ts
import { BUILD_MESSAGES, VERSION_LIST_TYPES, VERSION_QUERY_RE, type BuildListDto, type VersionListDto, type VersionListType } from "@mcsm/shared";
import { realTimers, type Timers } from "../files/stream.js";
import { HttpError } from "../lib/http.js";
import { SOURCES, UpstreamError, allowedSource, type Get, type Source } from "./sources.js";

export const LIST_TTL_MS = 60 * 60_000;
export const BUILDS_TTL_MS = 15 * 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 256;
/** Fill v3 (PaperMC) asks for a User-Agent that identifies the client. */
export const USER_AGENT = "mc-server-manager (self-hosted)";

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface CatalogOptions {
  fetch?: FetchFn;
  now?: () => number;
  timers?: Timers;
  /** A source failure (also when the stored copy is served): for the log. */
  onError?: (url: string, err: unknown) => void;
}

interface Entry { doc: unknown; fetchedAt: number; expiresAt: number }

/**
 * Version lists and builds from the official sources with an in-memory cache per source URL (spec
 * 2026-10-13-version-selector-design.md §4): lists 1 h, builds 15 min, at most MAX_ENTRIES
 * entries (the least used one is discarded). Simultaneous queries to one URL share the download. If
 * the source fails the stored copy is served with `stale: true`; with nothing stored, 502.
 */
export class VersionCatalog {
  private readonly cache = new Map<string, Entry>(); // insertion order: from least to most used
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly onError: ((url: string, err: unknown) => void) | undefined;

  constructor(opts: CatalogOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.onError = opts.onError;
  }

  async versions(type: string): Promise<VersionListDto> {
    const src = this.source(type);
    const run = this.run();
    try {
      const versions = await src.versions(run.get);
      return { type, versions, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      throw unavailable(src, e);
    }
  }

  async builds(type: string, version: string): Promise<BuildListDto> {
    const src = this.source(type);
    if (!src.builds) throw new HttpError(400, BUILD_MESSAGES.type(type));
    if (!VERSION_QUERY_RE.test(version)) throw new HttpError(400, "Invalid version");
    const run = this.run();
    try {
      const builds = await src.builds(run.get, version);
      return { type, version, builds, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      // The source does not know that version (404; Fabric answers 400): there are no builds to choose from.
      if (e instanceof UpstreamError && e.status !== null && e.status >= 400 && e.status < 500) {
        return { type, version, builds: [], fetchedAt: new Date(this.now()).toISOString(), stale: false };
      }
      throw unavailable(src, e);
    }
  }

  private source(type: string): Source {
    if (!(VERSION_LIST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Type has no version list");
    return SOURCES[type as VersionListType];
  }

  /** `get` for a query: notes whether anything came from an expired stored copy, and the oldest download used. */
  private run() {
    let stale = false;
    let oldest = Number.POSITIVE_INFINITY;
    const get: Get = async (url, opts = {}) => {
      const r = await this.cached(url, opts.kind ?? "json", opts.ttl === "builds" ? BUILDS_TTL_MS : LIST_TTL_MS);
      stale ||= r.stale;
      oldest = Math.min(oldest, r.entry.fetchedAt);
      return r.entry.doc;
    };
    return {
      get,
      stale: () => stale,
      fetchedAt: () => new Date(Number.isFinite(oldest) ? oldest : this.now()).toISOString(),
    };
  }

  private async cached(url: string, kind: "json" | "text", ttl: number): Promise<{ entry: Entry; stale: boolean }> {
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > this.now()) {
      this.touch(url, hit);
      return { entry: hit, stale: false };
    }
    try {
      return { entry: await this.shared(url, kind, ttl), stale: false };
    } catch (e) {
      this.onError?.(url, e);
      const old = this.cache.get(url);
      if (!old) throw e;
      this.touch(url, old);
      return { entry: old, stale: true };
    }
  }

  private shared(url: string, kind: "json" | "text", ttl: number): Promise<Entry> {
    let p = this.inflight.get(url);
    if (!p) {
      p = this.download(url, kind)
        .then((doc) => {
          const at = this.now();
          const entry: Entry = { doc, fetchedAt: at, expiresAt: at + ttl };
          this.touch(url, entry);
          return entry;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  /** Puts it as the most used and discards the least used ones above the limit. */
  private touch(url: string, entry: Entry): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async download(url: string, kind: "json" | "text"): Promise<unknown> {
    if (!allowedSource(url)) throw new UpstreamError(null, "source not allowed");
    const ctrl = new AbortController();
    const cancel = this.timers.set(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, accept: kind === "json" ? "application/json" : "text/html" },
      });
      if (!res.ok) throw new UpstreamError(res.status, `HTTP ${res.status}`);
      const text = await readCapped(res, MAX_BODY_BYTES);
      if (kind === "text") return text;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new UpstreamError(null, "invalid JSON");
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(null, ctrl.signal.aborted ? "timeout" : "network error");
    } finally {
      cancel();
    }
  }
}

function unavailable(src: Source, e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(502, `Could not fetch the version list of ${src.label}`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new UpstreamError(null, "response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new UpstreamError(null, "response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/ && pnpm --filter @mcsm/api typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/catalog.ts panel/apps/api/src/versions/catalog.test.ts
git commit -m "feat(panel): version catalog with cache, shared download, timeout and limits"
```

---

### Task 5: API — `/api/versions` routes and registration in `buildApp`

**Files:**
- Create: `panel/apps/api/src/versions/routes.ts`
- Create: `panel/apps/api/src/versions/routes.test.ts`
- Modify: `panel/apps/api/src/app.ts` (imports, `AppOptions`, registration after `settingsRoutes`)

**Interfaces:**
- Consumes: `VersionCatalog`, `FetchFn` (Task 4); `ManualTimers`.
- Produces: `GET /api/versions/:type` → `VersionListDto`; `GET /api/versions/:type/:version/builds` → `BuildListDto`; `AppOptions.versions?: VersionCatalog`; `app.versions`.

- [ ] **Step 1: Write the failing tests**

`panel/apps/api/src/versions/routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { ManualTimers } from "../../test/manual-timers.js";
import { VersionCatalog, type FetchFn } from "./catalog.js";

const FILL = "https://fill.papermc.io/v3/projects/paper";
let app: FastifyInstance;
let cookie: string;
let calls: string[];
let responses: Map<string, () => Response>;

beforeEach(async () => {
  calls = [];
  responses = new Map();
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const r = responses.get(url);
    if (!r) throw new TypeError("no network");
    return r();
  };
  app = await buildApp({
    db: openDb(":memory:"),
    versions: new VersionCatalog({ fetch, now: () => Date.parse("2026-10-13T10:00:00Z"), timers: new ManualTimers() }),
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

const get = (url: string, withCookie = true) => app.inject({ method: "GET", url, headers: withCookie ? { cookie } : {} });

describe("/api/versions", () => {
  it("requires a session", async () => {
    expect((await get("/api/versions/PAPER", false)).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("Paper version list", async () => {
    responses.set(FILL, () => new Response(JSON.stringify({ project: { id: "paper" }, versions: { "1.21": ["1.21.11", "1.21.11-rc3"] } })));
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: "PAPER", versions: [{ id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
  });

  it("Paper builds: only stable", async () => {
    responses.set(`${FILL}/versions/1.20.1/builds`, () => new Response(JSON.stringify([
      { id: 178, channel: "STABLE" }, { id: 177, channel: "BETA" },
    ])));
    const res = await get("/api/versions/PAPER/1.20.1/builds");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "PAPER", version: "1.20.1", builds: [{ id: "178", stable: true, recommended: false }] });
  });

  it("400 for types without a list, types without build and invalid versions, without touching the network", async () => {
    expect((await get("/api/versions/MODRINTH")).json()).toEqual({ error: "Type has no version list" });
    expect((await get("/api/versions/VANILLA/1.21.4/builds")).statusCode).toBe(400);
    for (const v of ["..%2F..%2Fetc", "1.21%20", "%00", "a".repeat(65)]) {
      expect((await get(`/api/versions/PAPER/${v}/builds`)).statusCode, v).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("source down with nothing stored: 502 with message", async () => {
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Could not fetch the version list of Paper" });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/routes.test.ts`
Expected: FAIL (`Cannot find module './routes.js'` or `versions` does not exist in `AppOptions`).

- [ ] **Step 3: Implement**

`panel/apps/api/src/versions/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { VersionCatalog } from "./catalog.js";

/**
 * Minecraft version lists and builds/loaders per type (plan 10). The panel serves them because the CSP
 * (connect-src 'self') does not let the browser query the sources. They go through the session guard.
 */
export async function versionRoutes(app: FastifyInstance) {
  app.get<{ Params: { type: string } }>("/api/versions/:type", async (req) => app.versions.versions(req.params.type));
  app.get<{ Params: { type: string; version: string } }>("/api/versions/:type/:version/builds", async (req) =>
    app.versions.builds(req.params.type, req.params.version));
}

declare module "fastify" {
  interface FastifyInstance {
    versions: VersionCatalog;
  }
}
```

In `panel/apps/api/src/app.ts`:

1. Imports (next to the others):

```ts
import { VersionCatalog } from "./versions/catalog.js";
import { versionRoutes } from "./versions/routes.js";
```

2. `AppOptions`:

```ts
/** `logger`: true in production; tests may pass pino options (e.g. a `stream` to capture the logs). */
export interface AppOptions {
  db: Db;
  logger?: FastifyServerOptions["logger"];
  config?: Partial<Config>;
  /** plan-10: version catalog (tests inject one with a fake fetch; they never touch the network). */
  versions?: VersionCatalog;
}
```

3. After `await app.register(settingsRoutes);` (block `// ── plan-9 ──`) and before `if (cfg.webDist)`:

```ts
  // ── plan-10 ──
  app.decorate("versions", opts.versions ?? new VersionCatalog({
    onError: (url, err) => app.log.warn({ url, err }, "could not query a version source"),
  }));
  await app.register(versionRoutes);
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/ && pnpm --filter @mcsm/api typecheck && pnpm --filter @mcsm/api test`
Expected: PASS; the rest of the API suite stays green (no other test calls `/api/versions`).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/routes.ts panel/apps/api/src/versions/routes.test.ts panel/apps/api/src/app.ts
git commit -m "feat(panel): /api/versions routes with the version catalog"
```

---

### Task 6: Import — the type's build variable moves to `build`

**Files:**
- Modify: `panel/apps/api/src/import/propose.ts` (after memory, before “Modpack”; and the `raw` object)
- Modify: `panel/apps/api/src/import/service.ts` (`EDITABLE_KEYS`)
- Test: `panel/apps/api/src/import/propose.test.ts`

**Interfaces:**
- Consumes: `BUILD_RE`, `buildEnvFor`, `isFloatingVersion` (Task 1).
- Produces: `proposeImport(...).spec.build` with the variable's value if it is valid; `build` editable on import.

- [ ] **Step 1: Write the failing test**

Add to the `describe("proposeImport", …)` of `panel/apps/api/src/import/propose.test.ts`:

```ts
  it("plan-10: the type's build variable moves to build (same environment); if it is not valid, it stays in env", () => {
    const fabric = proposeImport(cand({ env: env({ TYPE: "FABRIC", FABRIC_LOADER_VERSION: "0.16.9", PAPER_BUILD: "100" }) }), ctx());
    expect(fabric.specError).toBeNull();
    expect(fabric.spec.build).toBe("0.16.9");
    expect(fabric.spec.env).not.toHaveProperty("FABRIC_LOADER_VERSION");
    expect(fabric.spec.env).toHaveProperty("PAPER_BUILD", "100");

    const latest = proposeImport(cand({ env: env({ VERSION: "LATEST", PAPER_BUILD: "100" }) }), ctx());
    expect(latest.spec.build).toBe("");
    expect(latest.spec.env).toHaveProperty("PAPER_BUILD", "100");

    const spaced = proposeImport(cand({ env: env({ PAPER_BUILD: " 100" }) }), ctx());
    expect(spaced.spec.build).toBe("");
    expect(spaced.spec.env).toHaveProperty("PAPER_BUILD", " 100");

    expect(proposeImport(cand({ env: env({ TYPE: "FOLIA", FOLIABUILD: "12" }) }), ctx()).spec.build).toBe("12");
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @mcsm/api exec vitest run src/import/propose.test.ts`
Expected: FAIL (`build` is `""` in the Fabric case).

- [ ] **Step 3: Implement**

In `panel/apps/api/src/import/propose.ts`, add `BUILD_RE`, `buildEnvFor` and `isFloatingVersion` to the import from `@mcsm/shared` and, right after the `memory` block (before `// Modpack.`):

```ts
  // plan-10: the type's build variable moves to the build field only if it is valid as it is (same
  // environment, same hash); with LATEST/SNAPSHOT or a value that does not meet BUILD_RE it stays in env.
  let build = "";
  const buildKey = buildEnvFor(type);
  const buildRaw = buildKey === undefined ? undefined : env[buildKey];
  if (buildKey !== undefined && buildRaw !== undefined && BUILD_RE.test(buildRaw) && !isFloatingVersion(version)) {
    build = buildRaw;
    delete env[buildKey];
  }
```

and in the `raw` object:

```ts
  const raw = {
    imageTag: imageTag(c.image, warn), type, version, build, memory, properties, env: passEnv,
```

In `panel/apps/api/src/import/service.ts`, `EDITABLE_KEYS`:

```ts
const EDITABLE_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "build", // plan-10
] as const;
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @mcsm/api exec vitest run src/import/ && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/import/propose.ts panel/apps/api/src/import/service.ts panel/apps/api/src/import/propose.test.ts
git commit -m "feat(panel): import moves the type's build variable to the build field"
```

---

### Task 7: Web — shadcn components and pure logic (options, `withVersion`)

**Files:**
- Create (shadcn): `panel/apps/web/src/components/ui/command.tsx`, `panel/apps/web/src/components/ui/popover.tsx`
- Create: `panel/apps/web/src/lib/versions.ts`, `panel/apps/web/src/lib/versions.test.ts`
- Modify: `panel/apps/web/src/lib/spec-edit.ts` (`FORM_KEYS`, `withType`, new `withVersion`)
- Test: `panel/apps/web/src/lib/spec-edit.test.ts`

**Interfaces:**
- Consumes: `VERSION_LIST_TYPES`, `VERSION_QUERY_RE`, `isFloatingVersion`, `isStableVersion`, `minJavaTag`, `javaMajor`, `VersionEntry`, `BuildEntry` (Task 1); `JAVA_TAGS` (`lib/spec-catalog.ts`).
- Produces:
  - `lib/versions.ts`: `MAX_OPTIONS = 200`, `hasVersionList(type)`, `specialVersions(type)`, `versionOptions(type, list, {query, showUnstable}) → { specials: {id,label}[]; stable: string[]; unstable: string[]; hidden: number; freeText: string | null }`, `freeTextOption(query, list)`, `startsUnstable(version)`, `buildLabel(type): string | null`, `hasUnstableBuilds(type)`, `buildOptions(list, current, showUnstable) → {value,label}[]`, `ageText(fetchedAt, now)`.
  - `spec-edit.ts`: `withVersion(spec, version) → { spec: EditableSpec; notice: string | null }`; `withType` empties `build` when the type changes; `FORM_KEYS` includes `"build"`.

- [ ] **Step 1: Add the shadcn components**

Run: `cd panel/apps/web && pnpm dlx shadcn@3.8.5 add command popover --yes`
If it asks to overwrite files that already exist (`dialog.tsx`, `button.tsx`…), answer no.
Check with `git status` that only `components/ui/command.tsx`, `components/ui/popover.tsx`,
`package.json` (adds `cmdk`) and `pnpm-lock.yaml` change; if it touched another file in `components/ui/`,
`git checkout -- <file>`. Then: `pnpm --filter @mcsm/web typecheck` (Expected: clean).

- [ ] **Step 2: Write the failing tests**

`panel/apps/web/src/lib/versions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ageText, buildLabel, buildOptions, freeTextOption, hasUnstableBuilds, hasVersionList, startsUnstable, versionOptions } from "./versions";

const LIST = [
  { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false },
  { id: "1.21.11", stable: true }, { id: "1.21.4", stable: true }, { id: "25w14a", stable: false },
];

describe("versionOptions", () => {
  it("without searching: the type's specials and the stable ones; the test ones only with the switch", () => {
    expect(versionOptions("VANILLA", LIST, { query: "", showUnstable: false })).toEqual({
      specials: [{ id: "LATEST", label: "LATEST — the latest stable" }, { id: "SNAPSHOT", label: "SNAPSHOT — the latest snapshot" }],
      stable: ["26.3", "1.21.11", "1.21.4"], unstable: [], hidden: 0, freeText: null,
    });
    expect(versionOptions("PAPER", LIST, { query: "", showUnstable: true })).toMatchObject({
      specials: [{ id: "LATEST" }], unstable: ["26.4-snapshot-3", "26.3-rc-3", "25w14a"],
    });
  });
  it("when searching the test ones also come in, and what is typed that is not there as “Use”", () => {
    expect(versionOptions("PAPER", LIST, { query: "26.3", showUnstable: false })).toMatchObject({ specials: [], stable: ["26.3"], unstable: ["26.3-rc-3"], freeText: null });
    expect(versionOptions("PAPER", LIST, { query: " 1.8.9 ", showUnstable: false })).toMatchObject({ stable: [], unstable: [], freeText: "1.8.9" });
  });
  it("at most MAX_OPTIONS per group; the rest is counted", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `1.0.${i}`, stable: true }));
    const o = versionOptions("PAPER", many, { query: "", showUnstable: false });
    expect(o.stable).toHaveLength(200);
    expect(o.hidden).toBe(50);
  });
});

describe("freeTextOption", () => {
  it("only valid versions that are not in the list nor LATEST/SNAPSHOT", () => {
    expect(freeTextOption("1.8.9", LIST)).toBe("1.8.9");
    expect(freeTextOption("26.3", LIST)).toBeNull();
    expect(freeTextOption("latest", LIST)).toBeNull();
    expect(freeTextOption("Snapshot", LIST)).toBeNull();
    expect(freeTextOption("1 2", LIST)).toBeNull();
    expect(freeTextOption("../x", LIST)).toBeNull();
    expect(freeTextOption("", LIST)).toBeNull();
  });
});

describe("build selector", () => {
  it("label per type; null if it does not allow build", () => {
    expect(buildLabel("FABRIC")).toBe("Fabric loader version");
    expect(buildLabel("PAPER")).toBe("Paper build");
    expect(buildLabel("VANILLA")).toBeNull();
    expect(hasUnstableBuilds("NEOFORGE")).toBe(true);
    expect(hasUnstableBuilds("PAPER")).toBe(false);
  });
  it("stable by default, the recommended one marked and the current one always present", () => {
    const builds = [
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26-beta", stable: false, recommended: false },
      { id: "47.4.0", stable: true, recommended: true },
    ];
    expect(buildOptions(builds, "", false)).toEqual([{ value: "47.4.27", label: "47.4.27" }, { value: "47.4.0", label: "47.4.0 (recommended)" }]);
    expect(buildOptions(builds, "", true).map((o) => o.label)).toContain("47.4.26-beta (beta)");
    expect(buildOptions(builds, "40.0.1", false)[0]).toEqual({ value: "40.0.1", label: "40.0.1" });
    expect(buildOptions(builds, "47.4.26-beta", false).map((o) => o.value)).toContain("47.4.26-beta");
  });
});

describe("others", () => {
  it("hasVersionList / startsUnstable / ageText", () => {
    expect(hasVersionList("FORGE")).toBe(true);
    expect(hasVersionList("MODRINTH")).toBe(false);
    expect(startsUnstable("26.4-snapshot-3")).toBe(true);
    expect(startsUnstable("1.21.4")).toBe(false);
    expect(startsUnstable("LATEST")).toBe(false);
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ageText("2026-10-13T11:45:00Z", now)).toBe("15 min ago");
    expect(ageText("2026-10-13T10:00:00Z", now)).toBe("2 h ago");
    expect(ageText("2026-10-10T12:00:00Z", now)).toBe("3 days ago");
  });
});
```

Add to `panel/apps/web/src/lib/spec-edit.test.ts` (import `withVersion`, `withType`, `buildSpecPatch` and `type EditableSpec` from `./spec-edit`, and `defaultSpecInput` from `@mcsm/shared` if they are not already imported):

```ts
describe("withVersion (plan 10)", () => {
  const base: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", imageTag: "java21", build: "178" };
  it("empties the build when the version changes and adjusts the Java from the catalog", () => {
    const r = withVersion(base, "26.3");
    expect(r.spec).toMatchObject({ version: "26.3", build: "", imageTag: "java25" });
    expect(r.notice).toBe("Java set to java25 (the one 26.3 requires)");
    expect(withVersion(base, "1.12.2").spec.imageTag).toBe("java8");
    expect(withVersion({ ...base, imageTag: "latest" }, "1.20.1").spec.imageTag).toBe("java17");
  });
  it("same Java: no notice; unrecognised version: does not touch the Java", () => {
    expect(withVersion(base, "1.21.11")).toMatchObject({ notice: null, spec: { imageTag: "java21", build: "" } });
    expect(withVersion(base, "25w14craftmine")).toMatchObject({ notice: null, spec: { imageTag: "java21" } });
  });
  it("a custom tag is not overwritten; it only warns if it is not enough", () => {
    const custom = { ...base, imageTag: "java21-graalvm" };
    expect(withVersion(custom, "26.3")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: "The image java21-graalvm is not enough for 26.3: it needs Java 25" });
    expect(withVersion(custom, "1.20.1")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: null });
  });
  it("an old spec without build does not gain the key (no phantom diff)", () => {
    const { build: _build, ...old } = base;
    const r = withVersion(old as EditableSpec, "1.21.11");
    expect(r.spec).not.toHaveProperty("build");
    expect(buildSpecPatch(old, r.spec)).toEqual({ version: "1.21.11" });
  });
  it("withType empties the build only when the type changes", () => {
    expect(withType(base, "FABRIC").build).toBe("");
    expect(withType(base, "PAPER").build).toBe("178");
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm --filter @mcsm/web exec vitest run src/lib/versions.test.ts src/lib/spec-edit.test.ts`
Expected: FAIL (`Cannot find module './versions'`, `withVersion is not a function`).

- [ ] **Step 4: Implement `lib/versions.ts`**

`panel/apps/web/src/lib/versions.ts`:

```ts
import { VERSION_LIST_TYPES, VERSION_QUERY_RE, isFloatingVersion, isStableVersion, type BuildEntry, type VersionEntry } from "@mcsm/shared";

/** Logic of the version combobox and the build selector (plan 10). Pure: tested without DOM. */

const SPECIALS = [
  { id: "LATEST", label: "LATEST — the latest stable" },
  { id: "SNAPSHOT", label: "SNAPSHOT — the latest snapshot" },
] as const;
const SNAPSHOT_TYPES = new Set(["VANILLA", "FABRIC", "QUILT"]);
/** At most this many options per group (the rest is reached by typing). */
export const MAX_OPTIONS = 200;

export const hasVersionList = (type: string): boolean => (VERSION_LIST_TYPES as readonly string[]).includes(type);

/** LATEST always; SNAPSHOT only where itzg can resolve it. */
export function specialVersions(type: string): { id: string; label: string }[] {
  return SPECIALS.filter((s) => s.id === "LATEST" || SNAPSHOT_TYPES.has(type));
}

export interface VersionOptions {
  specials: { id: string; label: string }[];
  stable: string[];
  unstable: string[];
  /** Matches not shown because of the MAX_OPTIONS limit. */
  hidden: number;
  /** What is typed, for “Use “x””, or null. */
  freeText: string | null;
}

/** Combobox options: filters by what is typed; the test ones only with the switch or when searching. */
export function versionOptions(type: string, list: readonly VersionEntry[], o: { query: string; showUnstable: boolean }): VersionOptions {
  const q = o.query.trim().toLowerCase();
  const match = (s: string) => q === "" || s.toLowerCase().includes(q);
  const specials = specialVersions(type).filter((s) => match(s.id) || match(s.label));
  const stableAll = list.filter((v) => v.stable && match(v.id)).map((v) => v.id);
  const unstableAll = o.showUnstable || q !== "" ? list.filter((v) => !v.stable && match(v.id)).map((v) => v.id) : [];
  const stable = stableAll.slice(0, MAX_OPTIONS);
  const unstable = unstableAll.slice(0, MAX_OPTIONS);
  return {
    specials, stable, unstable,
    hidden: stableAll.length - stable.length + unstableAll.length - unstable.length,
    freeText: freeTextOption(o.query, list),
  };
}

/** What is typed as the “Use “x”” option: a valid version that is not in the list nor LATEST/SNAPSHOT. */
export function freeTextOption(query: string, list: readonly VersionEntry[]): string | null {
  const v = query.trim();
  if (!VERSION_QUERY_RE.test(v) || isFloatingVersion(v) || list.some((e) => e.id === v)) return null;
  return v;
}

/** Open with “Show test versions” on? Yes if the current version is neither stable nor special. */
export const startsUnstable = (version: string): boolean => version !== "" && !isStableVersion(version) && !isFloatingVersion(version);

const BUILD_LABELS: Record<string, string> = {
  PAPER: "Paper build", FOLIA: "Folia build", PURPUR: "Purpur build",
  FABRIC: "Fabric loader version", QUILT: "Quilt loader version",
  FORGE: "Forge version", NEOFORGE: "NeoForge version",
};
export const buildLabel = (type: string): string | null => (Object.hasOwn(BUILD_LABELS, type) ? (BUILD_LABELS[type] ?? null) : null);

/** Types whose sources publish beta builds (Paper/Folia/Purpur/Forge only list stable ones). */
export const hasUnstableBuilds = (type: string): boolean => type === "FABRIC" || type === "QUILT" || type === "NEOFORGE";

/** Build selector options: betas only with the switch; the current one always, even if it is no longer in the list. */
export function buildOptions(list: readonly BuildEntry[], current: string, showUnstable: boolean): { value: string; label: string }[] {
  const out = list
    .filter((b) => b.stable || showUnstable || b.id === current)
    .map((b) => ({ value: b.id, label: `${b.id}${b.recommended ? " (recommended)" : ""}${b.stable ? "" : " (beta)"}` }));
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

/** “15 min ago”, “2 h ago”, “3 days ago” for the outdated-list notice. */
export function ageText(fetchedAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
```

- [ ] **Step 5: Implement `withVersion` and adjust `withType` and `FORM_KEYS`**

In `panel/apps/web/src/lib/spec-edit.ts`:

1. Add `javaMajor` and `minJavaTag` to the import from `@mcsm/shared`, and `JAVA_TAGS` to the one from `./spec-catalog`:
   `import { JAVA_TAGS, PROPERTY_DEFS, TYPED_PROPERTY_KEYS } from "./spec-catalog";`
2. `FORM_KEYS`:

```ts
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "router", // plan-8
  "build", // plan-10
] as const;
```

3. Replace the whole `withType` with:

```ts
/** Changes the type keeping the modpack consistent (modpack type ⇔ modpack section). Each type has its own builds: it is emptied. */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  // `build` may be missing in old specs: it is only touched if it has a value (no phantom diff).
  const base = type !== spec.type && spec.build ? { ...spec, build: "" } : spec;
  if (isPlatform(type)) {
    const prev = base.modpack;
    // The slug is only kept within the same platform: a Modrinth slug is not valid on CurseForge.
    return { ...base, type, modpack: { platform: type, slugOrUrl: prev?.platform === type ? prev.slugOrUrl : "", versionId: prev?.platform === type ? prev.versionId : "", loader: prev?.platform === type ? prev.loader : "" } };
  }
  const { modpack: _drop, ...rest } = base;
  return { ...rest, type };
}
```

4. After `withType`, add:

```ts
/**
 * Changes the Minecraft version (plan 10): empties the build (each version has its own) and sets the
 * minimum Java it asks for if the tag is in the catalog; a custom tag (java21-graalvm) is not
 * overwritten, it only warns if it is not enough. Returns the notice to show, or null.
 */
export function withVersion(spec: EditableSpec, version: string): { spec: EditableSpec; notice: string | null } {
  let next: EditableSpec = { ...spec, version };
  if (version !== spec.version && spec.build) next = { ...next, build: "" };
  const need = minJavaTag(version);
  if (!need || spec.imageTag === need) return { spec: next, notice: null };
  if ((JAVA_TAGS as readonly string[]).includes(spec.imageTag)) {
    return { spec: { ...next, imageTag: need }, notice: `Java set to ${need} (the one ${version} requires)` };
  }
  const have = javaMajor(spec.imageTag);
  const needMajor = javaMajor(need) ?? 0;
  return { spec: next, notice: have !== null && have < needMajor ? `The image ${spec.imageTag} is not enough for ${version}: it needs Java ${needMajor}` : null };
}
```

- [ ] **Step 6: Run them and see them pass**

Run: `pnpm --filter @mcsm/web exec vitest run src/lib/ && pnpm --filter @mcsm/web typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add panel/apps/web/src/components/ui/command.tsx panel/apps/web/src/components/ui/popover.tsx panel/apps/web/package.json pnpm-lock.yaml \
  panel/apps/web/src/lib/versions.ts panel/apps/web/src/lib/versions.test.ts panel/apps/web/src/lib/spec-edit.ts panel/apps/web/src/lib/spec-edit.test.ts
git commit -m "feat(web): logic of the version and build selector, and Java adjusted when the version changes"
```

---

### Task 8: Web — version combobox, build selector and their integration

**Files:**
- Create: `panel/apps/web/src/hooks/use-versions.ts`
- Create: `panel/apps/web/src/components/spec-form/version-picker.tsx`
- Create: `panel/apps/web/src/components/spec-form/build-picker.tsx`
- Modify: `panel/apps/web/src/components/spec-form/version-section.tsx`
- Modify: `panel/apps/web/src/lib/wizard.ts` (`summarizeSpec`), `panel/apps/web/src/lib/spec-diff.ts` (`TOP_LABELS`)
- Test: `panel/apps/web/src/components/spec-form/version-section.test.tsx`, `panel/apps/web/src/lib/wizard.test.ts`

**Interfaces:**
- Consumes: Task 7 (`lib/versions.ts`, `withVersion`), `VersionListDto`/`BuildListDto` (Task 1), `api`/`apiPath`, `Field`/`OptionalSelect`/`RequiredSelect`.
- Produces: `useVersions(type, enabled)`, `useBuilds(type, version, enabled)`, `<VersionPicker id type value onChange aria-describedby? />`, `<BuildPicker type version value onChange />`.

- [ ] **Step 1: Write the failing tests**

Add to `panel/apps/web/src/components/spec-form/version-section.test.tsx`:

```tsx
describe("VersionSection: version and build selector (plan 10)", () => {
  it("Paper: version combobox with its hint, Paper build and the new Java hint", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1" });
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="sf-version"|<button[^>]*id="sf-version"[^>]*role="combobox"/);
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toContain("Paper build");
    expect(html).toContain('id="sf-build"');
    expect(html).toContain("java25 for 26.x");
  });
  it("modpack: version as free text and no build", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/<input[^>]*id="sf-version"/);
    expect(html).not.toContain('id="sf-build"');
  });
  it("Vanilla without build; Spigot warns about BUILD_FROM_SOURCE", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).not.toContain('id="sf-build"');
    const spigot = render({ ...defaultSpecInput(), type: "SPIGOT", version: "1.21.4" });
    expect(spigot).toContain("BUILD_FROM_SOURCE=true");
    expect(spigot).not.toContain('id="sf-build"');
  });
  it("with LATEST the build asks for a specific version", () => {
    expect(render({ ...defaultSpecInput(), type: "FABRIC", version: "LATEST" })).toContain("Choose a specific Minecraft version to set the build");
  });
});
```

Add to `panel/apps/web/src/lib/wizard.test.ts` (inside the `describe` of `summarizeSpec` or in a new one; import `defaultSpecInput` if it is not already imported):

```ts
  it("plan-10: the pinned build appears with its type's label, right after the version", () => {
    const lines = summarizeSpec({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1", build: "178" });
    expect(lines.slice(1, 3)).toEqual([{ label: "Minecraft version", value: "1.20.1" }, { label: "Paper build", value: "178" }]);
    expect(summarizeSpec({ ...defaultSpecInput(), type: "PAPER" }).map((l) => l.label)).not.toContain("Paper build");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @mcsm/web exec vitest run src/components/spec-form/version-section.test.tsx src/lib/wizard.test.ts`
Expected: FAIL (there is no `role="combobox"`, nor `sf-build`, nor a build line).

- [ ] **Step 3: Hooks**

`panel/apps/web/src/hooks/use-versions.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { BuildListDto, VersionListDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** The panel keeps the lists for 1 h (builds 15 min); here it is enough not to repeat the request within 10 min. */
const STALE_MS = 10 * 60_000;

export function useVersions(type: string, enabled: boolean) {
  return useQuery({
    queryKey: ["versions", type],
    queryFn: () => api.get<VersionListDto>(apiPath`/api/versions/${type}`),
    enabled, staleTime: STALE_MS, retry: false,
  });
}

export function useBuilds(type: string, version: string, enabled: boolean) {
  return useQuery({
    queryKey: ["builds", type, version],
    queryFn: () => api.get<BuildListDto>(apiPath`/api/versions/${type}/${version}/builds`),
    enabled, staleTime: STALE_MS, retry: false,
  });
}
```

- [ ] **Step 4: `VersionPicker`**

`panel/apps/web/src/components/spec-form/version-picker.tsx`:

```tsx
import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVersions } from "@/hooks/use-versions";
import { ageText, startsUnstable, versionOptions } from "@/lib/versions";
import { cn } from "@/lib/utils";

/**
 * Minecraft version combobox (plan 10): list from the API depending on the type, search, test versions
 * behind a switch and free text (“Use “x””) in case the version is missing or the source does not respond.
 */
export function VersionPicker({ id, type, value, onChange, "aria-describedby": describedby }: {
  id: string; type: string; value: string; onChange: (v: string) => void; "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showUnstable, setShowUnstable] = useState(() => startsUnstable(value));
  const versions = useVersions(type, true);
  const opts = versionOptions(type, versions.data?.versions ?? [], { query, showUnstable });
  const pick = (v: string) => { onChange(v); setOpen(false); setQuery(""); };
  const item = (v: string, label = v) => (
    <CommandItem key={v} value={v} onSelect={() => pick(v)}>
      <Check className={cn("size-4", value === v ? "opacity-100" : "opacity-0")} />{label}
    </CommandItem>
  );
  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-describedby={describedby}
            className="w-full justify-between font-normal">
            <span className="truncate">{value || "Choose a version"}</span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search or type a version…" value={query} onValueChange={setQuery} />
            <CommandList>
              {versions.isPending && <p className="px-3 py-2 text-xs text-muted-foreground">Loading versions…</p>}
              {versions.isError && <p role="alert" className="px-3 py-2 text-xs text-red-400">{versions.error.message}. You can type the version by hand.</p>}
              {opts.freeText && <CommandGroup heading="Typed by hand">{item(opts.freeText, `Use “${opts.freeText}”`)}</CommandGroup>}
              {opts.specials.length > 0 && <CommandGroup heading="Special">{opts.specials.map((s) => item(s.id, s.label))}</CommandGroup>}
              {opts.stable.length > 0 && <CommandGroup heading="Stable">{opts.stable.map((v) => item(v))}</CommandGroup>}
              {opts.unstable.length > 0 && <CommandGroup heading="Snapshots and pre-releases">{opts.unstable.map((v) => item(v))}</CommandGroup>}
              {opts.hidden > 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{opts.hidden} more: type to filter.</p>}
              <CommandEmpty>No matches.</CommandEmpty>
            </CommandList>
          </Command>
          <label className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
            <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Show test versions
          </label>
        </PopoverContent>
      </Popover>
      {versions.data?.stale && (
        <p className="text-xs text-amber-400">The source is not responding; list from {ageText(versions.data.fetchedAt, Date.now())}.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: `BuildPicker`**

`panel/apps/web/src/components/spec-form/build-picker.tsx`:

```tsx
import { useState } from "react";
import { VERSION_QUERY_RE, isFloatingVersion } from "@mcsm/shared";
import { useBuilds } from "@/hooks/use-versions";
import { buildLabel, buildOptions, hasUnstableBuilds } from "@/lib/versions";
import { Field, OptionalSelect } from "./fields";

/** Build or loader version (empty = the latest on startup). Only for the types that allow it (plan 10). */
export function BuildPicker({ type, version, value, onChange }: { type: string; version: string; value: string; onChange: (v: string) => void }) {
  const label = buildLabel(type);
  const concrete = !isFloatingVersion(version) && VERSION_QUERY_RE.test(version);
  const [showUnstable, setShowUnstable] = useState(false);
  const builds = useBuilds(type, version, label !== null && concrete);
  if (label === null) return null;
  const list = builds.data?.builds ?? [];
  const hint = !concrete ? "Choose a specific Minecraft version to set the build."
    : builds.isPending ? "Loading builds…"
    : builds.isError ? `${builds.error.message}. The latest will be used.`
    : list.length === 0 ? "The source does not publish stable builds for this version: the latest will be used."
    : "Empty = the latest on startup.";
  return (
    <div className="flex flex-col gap-1">
      <Field id="sf-build" label={label} hint={hint}>
        <OptionalSelect id="sf-build" value={value || undefined} defaultLabel="(the latest)"
          options={concrete ? buildOptions(list, value, showUnstable) : []} onChange={(v) => onChange(v ?? "")} />
      </Field>
      {concrete && hasUnstableBuilds(type) && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Show betas
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Integrate into `VersionSection`**

In `panel/apps/web/src/components/spec-form/version-section.tsx`:

1. Imports: change the one from `@/lib/spec-edit` to `import { typeChangeNotice, withType, withVersion, type EditableSpec } from "@/lib/spec-edit";` and add:

```tsx
import { hasVersionList } from "@/lib/versions";
import { BuildPicker } from "./build-picker";
import { VersionPicker } from "./version-picker";
```

2. Before `VersionSection`:

```tsx
const JAVA_HINT = "java25 for 26.x; java21 for 1.20.5–1.21.x; java17 for 1.17–1.20.4; java8 for earlier. It adjusts itself when the version changes.";
```

3. Inside `VersionSection`, after `const [notice, setNotice] = useState<string | null>(null);`:

```tsx
  const [javaNotice, setJavaNotice] = useState<string | null>(null);
  // Choosing a version empties the build and adjusts the Java (withVersion); typed by hand, when leaving the field.
  const setVersion = (v: string) => {
    const r = withVersion(spec, v);
    setJavaNotice(r.notice);
    if (r.spec.version !== spec.version || r.spec.imageTag !== spec.imageTag || r.spec.build !== spec.build) onChange(r.spec);
  };
```

4. Replace the first block `<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">…</div>` (Type, Version, Java) with:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="sf-type" label="Type">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => { setNotice(typeChangeNotice(spec, t)); setJavaNotice(null); onChange(withType(spec, t)); }} />
          {notice && <p role="status" className="text-xs text-amber-400">{notice}</p>}
        </Field>
        {hasVersionList(spec.type) ? (
          <Field id="sf-version" label="Minecraft version" hint="Choose from the list or type a version.">
            <VersionPicker id="sf-version" type={spec.type} value={spec.version} onChange={setVersion} />
          </Field>
        ) : (
          <Field id="sf-version" label="Minecraft version" hint="LATEST, SNAPSHOT or a version such as 1.21.4.">
            <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value })}
              onBlur={(e) => setVersion(e.target.value.trim())} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <Field id="sf-java" label="Java (image tag)" hint={JAVA_HINT}>
            <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))}
              onChange={(t) => { setJavaNotice(null); onChange({ ...spec, imageTag: t }); }} />
          </Field>
          {javaNotice && <p role="status" className="text-xs text-amber-400">{javaNotice}</p>}
        </div>
        {/* `build` is missing in old specs: it is read as empty. */}
        <BuildPicker type={spec.type} version={spec.version} value={spec.build ?? ""} onChange={(build) => onChange({ ...spec, build })} />
      </div>
      {spec.type === "SPIGOT" && (
        <p className="text-xs text-amber-400">itzg no longer downloads Spigot automatically: add BUILD_FROM_SOURCE=true in the environment variables (Advanced) or use Paper.</p>
      )}
```

7. Summary and diff: in `panel/apps/web/src/lib/wizard.ts`, import `import { buildLabel } from "./versions";` and in `summarizeSpec` replace the construction of `lines` with:

```ts
  const lines = [
    { label: "Type", value: typeLabel(spec.type) },
    { label: "Minecraft version", value: spec.version },
    // plan-10: `build` is missing in old templates.
    ...(spec.build ? [{ label: buildLabel(spec.type) ?? "Build", value: spec.build }] : []),
    { label: "Java", value: spec.imageTag },
    { label: "Memory", value: spec.memory + (spec.resources.memLimit ? ` (limit ${spec.resources.memLimit})` : "") },
  ];
```

In `panel/apps/web/src/lib/spec-diff.ts`, add the entry `build: "Build / loader",` to `TOP_LABELS`.

- [ ] **Step 8: Run them and see them pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS (including the earlier test “sf-version and sf-mp-slug reference their hint”, which uses a modpack and still has an `<input>`), clean typecheck and build.

- [ ] **Step 9: Commit**

```bash
git add panel/apps/web/src/hooks/use-versions.ts panel/apps/web/src/components/spec-form/version-picker.tsx panel/apps/web/src/components/spec-form/build-picker.tsx \
  panel/apps/web/src/components/spec-form/version-section.tsx panel/apps/web/src/components/spec-form/version-section.test.tsx \
  panel/apps/web/src/lib/wizard.ts panel/apps/web/src/lib/wizard.test.ts panel/apps/web/src/lib/spec-diff.ts
git commit -m "feat(web): Minecraft version combobox and build selector in the form"
```

---

### Task 9: E2E, documentation and full verification

**Files:**
- Modify: `panel/apps/e2e/tests/10-server.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (§4.1)
- Modify: `docs/superpowers/plans/README.md` (table)
- Modify: `CLAUDE.md` (Lessons learned)

**Interfaces:**
- Consumes: everything above, merged into `feat/plan-10`.

- [ ] **Step 1: Adapt the wizard's E2E**

In `panel/apps/e2e/tests/10-server.spec.ts` replace `await page.locator("#sf-version").fill("1.21.4");` with:

```ts
  // plan-10: combobox. With network the list option appears; without it, “Use “1.21.4””.
  await page.locator("#sf-version").click();
  await page.getByPlaceholder("Search or type a version…").fill("1.21.4");
  await shot(page, "01b-selector-version");
  await page.getByRole("option", { name: /^(Use “)?1\.21\.4”?$/ }).first().click();
  await expect(page.locator("#sf-version")).toContainText("1.21.4");
```

(The next step of the test still picks `java21`, which `withVersion` sets by itself for 1.21.4.)

- [ ] **Step 2: Run the E2E**

Before: `docker ps -a --format '{{.Names}}' | sort > /tmp/claude-ps-before.txt; docker network ls -q | sort > /tmp/claude-net-before.txt; docker volume ls -q | sort > /tmp/claude-vol-before.txt` (use the session's scratchpad if there is one).
Run: `bash deploy/e2e/run.sh`
Expected: the whole suite green and `panel/apps/e2e/screenshots/01b-selector-version.png` with the combobox open (review it).
Afterwards: repeat the three listings and compare them with `diff`; nothing new must remain nor anything from production be missing.

- [ ] **Step 3: Documentation**

`docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`, §4.1: after the line `"version": "1.21.4", …` add

```jsonc
  "build": "",                          // plan 10: build/loader → PAPER_BUILD, FOLIABUILD, PURPUR_BUILD, FABRIC_LOADER_VERSION, QUILT_LOADER_VERSION, FORGE_VERSION or NEOFORGE_VERSION depending on the type; empty = the latest
```

and in the following paragraph change “generated env (TYPE, VERSION, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,” to “generated env (TYPE, VERSION, the type's `build` variable, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,”.

`docs/superpowers/plans/README.md`: add to the table

```markdown
| 10 | [Version selector](2026-10-13-10-version-selector.md) | [own spec](../specs/2026-10-13-version-selector-design.md) | done (branch `feat/plan-10`) |
```

`CLAUDE.md`, at the end of “Lessons learned”:

```markdown
- `build` (plan 10): itzg variable per type (`BUILD_ENV` in shared, `buildEnvKeys` in Go; Folia is
  `FOLIABUILD`, without underscore). Empty emits nothing (hash intact); with a value it requires a type with build and
  a concrete version, and forbids its variable in `env` (fixture `build-cases.json`). The web does not add `build`
  to old specs that do not have it (no phantom diff).
- Version lists: `app.versions` (`VersionCatalog`, `api/src/versions/`) queries the official sources
  with an in-memory cache (lists 1 h, builds 15 min, stale if the source goes down); the tests inject
  `fetch` and never touch the network. New source = adapter in `versions/sources.ts` + host in
  `allowedSource`. Only STABLE builds of Paper/Folia (experimental ones require `*_CHANNEL`).
```

- [ ] **Step 4: Full verification**

Run:

```bash
eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=master" \
  && (cd agent && go vet ./... && go vet -tags integration ./... && go test -race ./...) \
  && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build
```

Expected: all green. In addition: `git diff master --stat -- agent/gen panel/packages/proto-ts/src/gen` empty (there are no protocol changes) and no `var`/`func` with the same name in `agent/internal/spec` (`go vet` detects it).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/e2e/tests/10-server.spec.ts docs/superpowers/specs/2026-10-12-mc-server-manager-design.md docs/superpowers/plans/README.md CLAUDE.md
git commit -m "docs: close Plan 10 (version selector) and the wizard's E2E with the combobox"
```
