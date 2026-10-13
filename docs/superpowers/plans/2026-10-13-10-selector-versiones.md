# Plan 10 — Selector de versión de Minecraft y de build/loader

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al crear o editar un servidor (o una plantilla) se elige la versión de Minecraft de una lista según el tipo, y opcionalmente el build/loader, con la Java ajustada sola.

**Architecture:** La spec gana un campo `build` (vacío = el último) que el agente traduce a la variable de itzg de cada tipo (`PAPER_BUILD`, `FABRIC_LOADER_VERSION`…). La API del panel consulta las fuentes oficiales (Mojang, PaperMC Fill v3, Purpur, Spigot, Fabric, Quilt, Forge, NeoForge) con caché en memoria y expone `GET /api/versions/:type` y `GET /api/versions/:type/:version/builds`. La web sustituye el campo de versión por un combobox (shadcn `command` + `popover`) y añade un selector de build.

**Tech Stack:** Go 1.27 (agente), TypeScript strict + zod 4 (shared), Fastify 5 (API), React 19 + TanStack Query + shadcn (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-selector-versiones-design.md` (amplía §4.1 y §8 de `2026-10-12-mc-server-manager-design.md`).

## Global Constraints

- Mensajes de UI y de error en castellano; identificadores en inglés. Commits conventional en español, pequeños, con `Co-Authored-By: Claude <tu modelo> <noreply@anthropic.com>` (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 según quién escriba). Nunca `git push`, nunca `--no-verify`, nunca reescribir historia.
- TDD: test que falla → código mínimo → test que pasa → commit. Salida de tests limpia.
- Tests sin red: nada de `fetch` real ni `setTimeout`/`time.Sleep` para sincronizar (reloj, `fetch` y `Timers` inyectables; `ManualTimers` de `panel/apps/api/test/manual-timers.ts`).
- Regex y reglas de `build` idénticas en Go y zod, con fixture compartida `proto/fixtures/build-cases.json`: `""` o `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`; solo con tipo PAPER, FOLIA, PURPUR, FABRIC, QUILT, FORGE, NEOFORGE; nunca con versión `LATEST`/`SNAPSHOT` (sin distinguir mayúsculas); con valor, la variable que genera no puede estar en `env`.
- Mapeo de `build`: PAPER→`PAPER_BUILD`, FOLIA→`FOLIABUILD` (sin guion bajo), PURPUR→`PURPUR_BUILD`, FABRIC→`FABRIC_LOADER_VERSION`, QUILT→`QUILT_LOADER_VERSION`, FORGE→`FORGE_VERSION`, NEOFORGE→`NEOFORGE_VERSION`.
- `TestHashGolden` sigue en `09ff6e5490b40677`: con `build` vacío no se emite nada (`json:"build,omitempty"`).
- Caché: listas 1 h, builds 15 min, plazo 10 s, respuesta ≤ 8 MiB, ≤ 256 entradas (LRU), `User-Agent: mc-server-manager (self-hosted)`, solo HTTPS a los hosts de las fuentes.
- Solo builds `STABLE` de Paper/Folia (los experimentales exigirían `PAPER_CHANNEL`/`FOLIA_CHANNEL`, fuera de alcance).
- Web: rutas de la API con `apiPath`; shadcn con `pnpm dlx shadcn@3.8.5` (nunca `@latest`); vitest en node sin jsdom (lógica en funciones puras con test, componentes con render SSR).
- Docker de la máquina: hay PRODUCCIÓN (`mcsm-panel-1`, `mcsm-agent`, red `mcsm`, volúmenes `mcsm_*`, puertos 8080 y 25565–25600). El E2E solo crea recursos `mcsm-test-*`; compara `docker ps -a`/`network ls`/`volume ls` antes y después.
- Toolchain: `eval "$(mise env)"` en la raíz antes de `go`/`buf`.

## Review Focus

1. **Specs y plantillas antiguas sin `build`** (la API devuelve el JSON guardado tal cual, así que en la web `spec.build` puede ser `undefined`): cambiar de versión o guardar no debe inventar un cambio `build: ""` en el diff ni romper. → Test en Task 7 (`withVersion` sobre una spec sin `build` + `buildSpecPatch`).
2. **Una fuente responde 200 con algo que no es lo esperado** (página HTML de error, JSON con otra forma): debe acabar en 502 con mensaje en castellano o en la lista guardada con `stale`, nunca en 500. → Tests en Task 3 (forma inesperada → `UpstreamError`) y Task 4 (HTML/JSON ajeno → 502).
3. **Versión con caracteres de ruta en la URL de builds** (`..%2F..`, `%00`, espacios, > 64): 400 sin tocar la red, nunca interpolada en la URL de la fuente. → Tests en Task 4 y Task 5.
4. **Actualizar el agente no recrea contenedores** y un agente antiguo ignora `build` sin fallar (`json.Unmarshal` sin `DisallowUnknownFields`). → Test en Task 2 (hash con `build` vacío).
5. **Imagen personalizada** (p. ej. `java21-graalvm` de un servidor importado) al elegir una versión que pide otra Java: no se pisa la etiqueta; solo se avisa si no basta. → Test en Task 7.

## Orden de ejecución

Rama `feat/plan-10` desde `master`. Task 1 primero (contrato compartido). Después dos carriles en
paralelo, cada uno en su worktree bajo `.worktrees/` con ficheros disjuntos (como mucho 2 agentes):

- Carril A: Task 2 (Go) → Tasks 3–6 (API).
- Carril B: Tasks 7–8 (web).

Al acabar ambos, se fusionan en `feat/plan-10` y se hace Task 9 (E2E, documentación y verificación
completa). Revisión por carril (un `task-reviewer` por lote) y una revisión final conjunta.

## Mapa de ficheros

| Fichero | Responsabilidad |
|---|---|
| `panel/packages/shared/src/versions.ts` (nuevo) | `BUILD_ENV`, `BUILD_RE`, `buildError`/`buildCheck`, `compareVersions`, `isStableVersion`, `minJavaTag`, `javaMajor`, DTOs |
| `panel/packages/shared/src/spec.ts` | campo `build` en `baseFields` y `buildCheck` en `specChecks` |
| `proto/fixtures/build-cases.json` (nuevo) | casos de `build` compartidos Go/zod |
| `agent/internal/spec/build.go` (nuevo) | `Spec.Build`: validación y variable de entorno |
| `agent/internal/spec/spec.go` | campo `Build`, llamadas en `Validate` y `envList` |
| `panel/apps/api/src/versions/sources.ts` (nuevo) | adaptadores por tipo (URL + parseo con zod) |
| `panel/apps/api/src/versions/catalog.ts` (nuevo) | `VersionCatalog`: caché, deduplicación, plazo, topes, 400/502 |
| `panel/apps/api/src/versions/routes.ts` (nuevo) | rutas `/api/versions/…` |
| `panel/apps/api/src/app.ts` | `AppOptions.versions`, decorado `app.versions`, registro de rutas |
| `panel/apps/api/src/import/propose.ts`, `service.ts` | `env` → `build` al importar; `build` editable |
| `panel/apps/web/src/components/ui/{command,popover}.tsx` (nuevos, shadcn) | primitivas del combobox |
| `panel/apps/web/src/lib/versions.ts` (nuevo) | opciones del combobox y del selector de build (puras) |
| `panel/apps/web/src/lib/spec-edit.ts` | `withVersion`, `withType` vacía `build`, `FORM_KEYS` |
| `panel/apps/web/src/hooks/use-versions.ts` (nuevo) | `useVersions`, `useBuilds` |
| `panel/apps/web/src/components/spec-form/{version-picker,build-picker}.tsx` (nuevos) | combobox de versión y selector de build |
| `panel/apps/web/src/components/spec-form/version-section.tsx` | integra ambos, Java ajustada, aviso de Spigot |
| `panel/apps/web/src/lib/{wizard,spec-diff}.ts` | build en el resumen y en el diff |
| `panel/apps/e2e/tests/10-server.spec.ts` | el asistente usa el combobox |

---

### Task 1: Contrato compartido — `versions.ts` y campo `build` en la spec

**Files:**
- Create: `panel/packages/shared/src/versions.ts`
- Create: `panel/packages/shared/src/versions.test.ts`
- Create: `proto/fixtures/build-cases.json`
- Modify: `panel/packages/shared/src/spec.ts` (import, `baseFields`, `specChecks`)
- Modify: `panel/packages/shared/src/index.ts`

**Interfaces:**
- Produces (desde `@mcsm/shared`):
  - `VERSION_LIST_TYPES: readonly ["VANILLA","PAPER","FOLIA","PURPUR","SPIGOT","FABRIC","QUILT","FORGE","NEOFORGE"]`, `type VersionListType`
  - `BUILD_ENV: Readonly<Record<string, string>>`, `buildEnvFor(type: string): string | undefined`
  - `BUILD_RE`, `VERSION_QUERY_RE` (la misma regex), `BUILD_MESSAGES.{invalid, type(t), floating, env(k)}`
  - `isFloatingVersion(v: string): boolean`, `isStableVersion(v: string): boolean`
  - `buildError(s: {type; version; build; env}): {path: string[]; message: string} | null`, `buildCheck(s, ctx)`
  - `compareVersions(a: string, b: string): number` (> 0 si `a` es más nueva)
  - `minJavaTag(version: string): "java8" | "java17" | "java21" | "java25" | null`, `javaMajor(tag: string): number | null`
  - `interface VersionEntry { id: string; stable: boolean }`, `interface BuildEntry { id: string; stable: boolean; recommended: boolean }`
  - `interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }`
  - `interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }`
  - `Spec`/`SpecInput`/`TemplateSpec` con `build: string` (por defecto `""`).

- [ ] **Step 1: Crear la fixture compartida**

`proto/fixtures/build-cases.json`:

```json
[
  { "name": "vacío en cualquier tipo", "type": "VANILLA", "version": "LATEST", "build": "", "ok": true },
  { "name": "Paper con build numérico", "type": "PAPER", "version": "1.20.1", "build": "178", "ok": true },
  { "name": "Folia", "type": "FOLIA", "version": "1.21.11", "build": "12", "ok": true },
  { "name": "Purpur", "type": "PURPUR", "version": "26.2", "build": "2633", "ok": true },
  { "name": "loader de Fabric", "type": "FABRIC", "version": "26.3", "build": "0.19.5", "ok": true },
  { "name": "loader beta de Quilt", "type": "QUILT", "version": "26.3", "build": "0.20.0-beta.9", "ok": true },
  { "name": "Forge", "type": "FORGE", "version": "1.20.1", "build": "47.4.27", "ok": true },
  { "name": "NeoForge beta", "type": "NEOFORGE", "version": "26.3", "build": "26.3.0.75-beta", "ok": true },
  { "name": "build con +", "type": "FABRIC", "version": "1.21.4", "build": "0.16.0+local", "ok": true },
  { "name": "64 caracteres", "type": "FORGE", "version": "1.20.1", "build": "a123456789012345678901234567890123456789012345678901234567890123", "ok": true },
  { "name": "65 caracteres", "type": "FORGE", "version": "1.20.1", "build": "a1234567890123456789012345678901234567890123456789012345678901234", "ok": false },
  { "name": "Vanilla no admite build", "type": "VANILLA", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "Spigot no admite build", "type": "SPIGOT", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "tipo desconocido", "type": "BUKKIT", "version": "1.21.4", "build": "1", "ok": false },
  { "name": "con LATEST", "type": "PAPER", "version": "LATEST", "build": "178", "ok": false },
  { "name": "con snapshot en minúsculas", "type": "FABRIC", "version": "snapshot", "build": "0.19.5", "ok": false },
  { "name": "empieza por punto", "type": "PAPER", "version": "1.20.1", "build": ".1", "ok": false },
  { "name": "espacio", "type": "PAPER", "version": "1.20.1", "build": "1 2", "ok": false },
  { "name": "barra", "type": "PAPER", "version": "1.20.1", "build": "1/2", "ok": false },
  { "name": "salto de línea al final", "type": "PAPER", "version": "1.20.1", "build": "1\n", "ok": false },
  { "name": "no ASCII", "type": "PAPER", "version": "1.20.1", "build": "1é", "ok": false },
  { "name": "env con la variable que genera", "type": "PAPER", "version": "1.20.1", "build": "178", "env": { "PAPER_BUILD": "100" }, "ok": false },
  { "name": "env con la variable sin build", "type": "PAPER", "version": "1.20.1", "build": "", "env": { "PAPER_BUILD": "100" }, "ok": true },
  { "name": "env con la variable de otro tipo", "type": "FABRIC", "version": "1.21.4", "build": "0.19.5", "env": { "PAPER_BUILD": "100" }, "ok": true },
  { "name": "Folia genera FOLIABUILD", "type": "FOLIA", "version": "1.21.11", "build": "12", "env": { "FOLIABUILD": "1" }, "ok": false }
]
```

- [ ] **Step 2: Escribir los tests que fallan**

`panel/packages/shared/src/versions.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { BUILD_ENV, buildError, compareVersions, isFloatingVersion, isStableVersion, javaMajor, minJavaTag } from "./versions.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("build-cases.json") as { name: string; type: string; version: string; build: string; env?: Record<string, string>; ok: boolean }[];

describe("casos compartidos con el agente Go (proto/fixtures/build-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(20));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, type: c.type, version: c.version, build: c.build, env: c.env ?? base.env });
    expect(r.success).toBe(c.ok);
  });
});

describe("build en la spec", () => {
  it("por defecto vacío; viaja en plantillas; null en un PATCH es 400", () => {
    expect(specInputSchema.parse({}).build).toBe("");
    expect(templateSpecSchema.parse({ type: "PAPER", version: "1.20.1", build: "178" }).build).toBe("178");
    expect(specPatchNullError({ build: null })).toMatch(/build/);
  });
  it("los errores apuntan al campo y explican el motivo", () => {
    expect(buildError({ type: "VANILLA", version: "1.21.4", build: "1", env: {} })).toEqual({ path: ["build"], message: expect.stringMatching(/VANILLA no admite/) });
    expect(buildError({ type: "PAPER", version: "latest", build: "1", env: {} })?.message).toMatch(/versión concreta/);
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "1", env: { PAPER_BUILD: "2" } }))
      .toEqual({ path: ["env", "PAPER_BUILD"], message: expect.stringMatching(/Quita la variable PAPER_BUILD/) });
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "", env: { PAPER_BUILD: "2" } })).toBeNull();
  });
  it("cada tipo con build tiene su variable de itzg (Folia sin guion bajo)", () => {
    expect(BUILD_ENV).toEqual({
      PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD", FABRIC: "FABRIC_LOADER_VERSION",
      QUILT: "QUILT_LOADER_VERSION", FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
    });
  });
});

describe("compareVersions", () => {
  const newestFirst = (xs: string[]) => [...xs].sort((a, b) => compareVersions(b, a));
  it("por componentes numéricos; el año va antes que 1.x y la release antes que su pre-release", () => {
    expect(newestFirst(["1.21.9", "1.21.10", "26.1", "1.21", "26.1.2", "1.21.11-rc3", "1.21.11"]))
      .toEqual(["26.1.2", "26.1", "1.21.11", "1.21.11-rc3", "1.21.10", "1.21.9", "1.21"]);
  });
  it("pre-releases entre sí y builds largos", () => {
    expect(newestFirst(["0.20.0-beta.9", "0.24.0", "0.20.0-beta.10", "0.25.0-beta.1"])).toEqual(["0.25.0-beta.1", "0.24.0", "0.20.0-beta.10", "0.20.0-beta.9"]);
    expect(newestFirst(["26.3.0.9", "26.3.0.76", "26.3.0.75-beta"])).toEqual(["26.3.0.76", "26.3.0.75-beta", "26.3.0.9"]);
    expect(newestFirst(["1.7.10_pre4", "1.7.10", "1.8"])).toEqual(["1.8", "1.7.10", "1.7.10_pre4"]);
    expect(compareVersions("1.21", "1.21.0")).toBe(0);
  });
});

describe("minJavaTag y compañía", () => {
  it.each([
    ["LATEST", "java25"], ["snapshot", "java25"], ["26.3", "java25"], ["26.4-snapshot-3", "java25"], ["26.3-rc-3", "java25"],
    ["1.21.11", "java21"], ["1.21", "java21"], ["1.20.5", "java21"], ["1.20.5-pre1", "java21"],
    ["1.20.4", "java17"], ["1.18.2", "java17"], ["1.17", "java17"],
    ["1.16.5", "java8"], ["1.12.2", "java8"], ["1.7.10", "java8"],
    ["24w14a", "java21"], ["24w13a", "java17"], ["21w19a", "java17"], ["21w18a", "java8"],
    ["25w14craftmine", null], ["b1.7.3", null], ["", null],
  ] as const)("%s → %s", (v, tag) => expect(minJavaTag(v)).toBe(tag));
  it("javaMajor lee el número de la etiqueta", () => {
    expect(javaMajor("java21-graalvm")).toBe(21);
    expect(javaMajor("java8")).toBe(8);
    expect(javaMajor("latest")).toBeNull();
  });
  it("estable = solo dígitos y puntos; LATEST/SNAPSHOT son flotantes", () => {
    expect(isStableVersion("1.21.11")).toBe(true);
    expect(isStableVersion("1.21.11-rc3")).toBe(false);
    expect(isStableVersion("25w14a")).toBe(false);
    expect(isFloatingVersion("Latest")).toBe(true);
    expect(isFloatingVersion("1.21")).toBe(false);
  });
});
```

- [ ] **Step 3: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/shared exec vitest run src/versions.test.ts`
Expected: FAIL (`Cannot find module './versions.js'`).

- [ ] **Step 4: Implementar `versions.ts`**

`panel/packages/shared/src/versions.ts`:

```ts
import type { z } from "zod";

/**
 * Selector de versiones (plan 10, spec docs/superpowers/specs/2026-10-13-selector-versiones-design.md):
 * tipos con lista de versiones, campo `build` de la spec y su variable de itzg, comparación de
 * versiones y Java mínima. Las reglas de `build` son espejo de agent/internal/spec/build.go; los casos
 * de proto/fixtures/build-cases.json se prueban en los dos lados.
 */

/** Tipos con lista de versiones de Minecraft (los modpacks y los desconocidos van con texto libre). */
export const VERSION_LIST_TYPES = ["VANILLA", "PAPER", "FOLIA", "PURPUR", "SPIGOT", "FABRIC", "QUILT", "FORGE", "NEOFORGE"] as const;
export type VersionListType = (typeof VERSION_LIST_TYPES)[number];

/** Variable de itzg que genera `build` según el tipo; solo estos tipos admiten build. Folia: FOLIABUILD (scripts/start-deployFolia). */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD",
  FABRIC: "FABRIC_LOADER_VERSION", QUILT: "QUILT_LOADER_VERSION",
  FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
};
export const buildEnvFor = (type: string): string | undefined => (Object.hasOwn(BUILD_ENV, type) ? BUILD_ENV[type] : undefined);

/** Build/loader: ASCII sin espacios ni barras, máx. 64. La versión que se pide a la API usa la misma gramática. */
export const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const VERSION_QUERY_RE = BUILD_RE;

/** LATEST / SNAPSHOT (sin distinguir mayúsculas): itzg elige la versión al arrancar. */
export const isFloatingVersion = (v: string): boolean => /^(latest|snapshot)$/i.test(v);

/** Estable = solo dígitos y puntos (1.21.11, 26.3). Pre-releases, rc y snapshots no lo son. */
export const isStableVersion = (v: string): boolean => /^\d+(\.\d+)*$/.test(v);

export const BUILD_MESSAGES = {
  invalid: "Build inválido: letras, números y . _ + - (máx. 64; empieza por letra o número)",
  type: (type: string) => `El tipo ${type} no admite fijar el build (solo Paper, Folia, Purpur, Fabric, Quilt, Forge y NeoForge)`,
  floating: "Para fijar el build elige una versión concreta de Minecraft (no LATEST ni SNAPSHOT)",
  env: (key: string) => `Quita la variable ${key} de las variables de entorno (Avanzado): la fija el campo Build`,
};

/** Primer motivo por el que `build` no vale en esta spec (con la ruta del campo); null si vale o está vacío. */
export function buildError(s: { type: string; version: string; build: string; env: Record<string, string> }): { path: string[]; message: string } | null {
  if (s.build === "") return null;
  if (!BUILD_RE.test(s.build)) return { path: ["build"], message: BUILD_MESSAGES.invalid };
  const key = buildEnvFor(s.type);
  if (!key) return { path: ["build"], message: BUILD_MESSAGES.type(s.type) };
  if (isFloatingVersion(s.version)) return { path: ["build"], message: BUILD_MESSAGES.floating };
  // El env libre gana sobre lo generado: con build fijado, su variable en env lo anularía en silencio.
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

/** Compara versiones: > 0 si `a` es más nueva (1.21.10 > 1.21.9; 26.1 > 1.21.11; una release > su pre-release). */
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
 * Etiqueta de imagen itzg con la Java mínima que pide la versión de Minecraft; null si no se reconoce.
 * 26.x → 25; 1.20.5–1.21.x → 21; 1.17–1.20.4 → 17; anteriores → 8. Snapshots antiguas AAwSSl:
 * ≥ 24w14a → 21, ≥ 21w19a → 17. LATEST/SNAPSHOT → 25 (la última).
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

/** Número de Java de una etiqueta itzg ("java21-graalvm" → 21); null si no empieza por javaNN. */
export function javaMajor(tag: string): number | null {
  const m = /^java(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
}

export interface VersionEntry { id: string; stable: boolean }
export interface BuildEntry { id: string; stable: boolean; recommended: boolean }
export interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }
export interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }
```

- [ ] **Step 5: Añadir `build` a la spec**

En `panel/packages/shared/src/spec.ts`:

1. Junto a los imports: `import { buildCheck } from "./versions.js";`
2. Al final de `baseFields` (tras `// ── plan-9 ──`):

```ts
  // ── plan-9 ──
  // ── plan-10 ──
  build: z.string().default(""),
};
```

3. `specChecks` queda así:

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

En `panel/packages/shared/src/index.ts` añade `export * from "./versions.js";`.

- [ ] **Step 6: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/shared exec vitest run src/versions.test.ts`
Expected: PASS.

- [ ] **Step 7: Arreglar las fixtures tipadas que ahora exigen `build`**

`Spec`, `SpecInput` y `TemplateSpec` tienen ahora `build: string`. Run: `pnpm typecheck && pnpm test`.
Para cada fallo cuyo único motivo sea la clave nueva (literales de spec en tests, p. ej. el `spec` de
`server-config-form.test.tsx`, o un `toEqual` sobre una spec completa), añade `build: ""` al literal.
No cambies lógica; si un fallo no es de este tipo, para y avisa (NEEDS_CONTEXT).
Expected tras el arreglo: typecheck limpio y todos los tests en verde.

- [ ] **Step 8: Commit**

```bash
git add proto/fixtures/build-cases.json panel/packages/shared/src/versions.ts panel/packages/shared/src/versions.test.ts panel/packages/shared/src/spec.ts panel/packages/shared/src/index.ts
git add -u panel   # solo los literales de test del Step 7
git commit -m "feat(shared): campo build de la spec, compareVersions y minJavaTag"
```

---

### Task 2: Agente — `Spec.Build` y su variable de entorno

**Files:**
- Create: `agent/internal/spec/build.go`
- Create: `agent/internal/spec/build_test.go`
- Modify: `agent/internal/spec/spec.go` (campo en `Spec`, `Validate`, `envList`)

**Interfaces:**
- Consumes: `proto/fixtures/build-cases.json` (Task 1).
- Produces: `Spec.Build string` (`json:"build,omitempty"`), `buildEnvKeys map[string]string`, `(Spec).validateBuild() error`, `(Spec).buildEnvVars(m map[string]string)`.
  Ojo: `content_test.go` ya define la función de test `buildEnv(t, s)`; el mapa se llama `buildEnvKeys` para no chocar.

- [ ] **Step 1: Escribir los tests que fallan**

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
		t.Fatalf("solo %d casos: ¿fixture truncada?", len(cases))
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Type, s.Version, s.Build = c.Type, c.Version, c.Build
		if c.Env != nil {
			s.Env = c.Env
		}
		if err := s.Validate(); (err == nil) != c.OK {
			t.Errorf("%s: Validate() = %v; ok esperado %v", c.Name, err, c.OK)
		}
	}
}

func TestBuildEnvPorTipo(t *testing.T) {
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
				t.Errorf("%s: no debe emitir %s", typ, other)
			}
		}
	}
}

// Sin build no se emite nada: al actualizar el agente ningún contenedor se recrea.
func TestBuildVacioNoCambiaElHash(t *testing.T) {
	s := loadFixture(t)
	if s.Build != "" {
		t.Fatal("la fixture no debe llevar build")
	}
	if h := hashOfSpec(t, s); h != "09ff6e5490b40677" {
		t.Fatalf("el hash de una spec sin build cambió: %s", h)
	}
	env := buildEnv(t, s)
	for _, k := range buildEnvKeys {
		if _, ok := env[k]; ok {
			t.Errorf("sin build no se emite %s", k)
		}
	}
	s.Build = "178"
	if hashOfSpec(t, s) == "09ff6e5490b40677" {
		t.Error("un build fijado cambia el entorno y debe cambiar el hash")
	}
}

// Un panel sin el campo (o un agente antiguo) no rompe el JSON.
func TestBuildAusenteEnElJSON(t *testing.T) {
	s, err := Parse([]byte(`{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"4G","ports":{"game":25565,"extra":[]},"restartPolicy":"unless-stopped","rconPassword":"s3cretpassw0rd"}`))
	if err != nil || s.Build != "" {
		t.Fatalf("Parse sin build: %v, %q", err, s.Build)
	}
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["build"]; ok {
		t.Error("build vacío no se serializa (omitempty)")
	}
}
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `eval "$(mise env)" && (cd agent && go test ./internal/spec/ -run 'TestBuild' )`
Expected: FAIL de compilación (`s.Build undefined`, `buildEnvKeys undefined`).

- [ ] **Step 3: Implementar**

`agent/internal/spec/build.go`:

```go
package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// Campo build (plan 10): build del servidor o versión del loader. Vacío = el último (lo elige
// itzg): no se emite nada y el hash no cambia. Espejo de panel/packages/shared/src/versions.ts;
// casos compartidos en proto/fixtures/build-cases.json.

// buildEnvKeys es la variable de itzg que genera build según el tipo. Folia usa FOLIABUILD (sin
// guion bajo; scripts/start-deployFolia de itzg).
var buildEnvKeys = map[string]string{
	"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
	"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
	"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
}

// Misma regex que BUILD_RE en el panel.
var buildRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

func isFloatingVersion(v string) bool {
	return strings.EqualFold(v, "LATEST") || strings.EqualFold(v, "SNAPSHOT")
}

func (s Spec) validateBuild() error {
	if s.Build == "" {
		return nil
	}
	if !buildRe.MatchString(s.Build) {
		return fmt.Errorf("spec: build inválido (letras, números y . _ + -; máx. 64; empieza por letra o número)")
	}
	key, ok := buildEnvKeys[s.Type]
	if !ok {
		return fmt.Errorf("spec: el tipo %s no admite fijar el build (solo Paper, Folia, Purpur, Fabric, Quilt, Forge y NeoForge)", s.Type)
	}
	if isFloatingVersion(s.Version) {
		return fmt.Errorf("spec: para fijar el build elige una versión concreta de Minecraft (no LATEST ni SNAPSHOT)")
	}
	// El env libre gana sobre lo generado: anularía el build en silencio.
	if _, ok := s.Env[key]; ok {
		return fmt.Errorf("spec: Quita la variable %s de las variables de entorno (Avanzado): la fija el campo Build", key)
	}
	return nil
}

// buildEnvVars añade al entorno generado la variable del build, si lo hay.
func (s Spec) buildEnvVars(m map[string]string) {
	if s.Build == "" {
		return
	}
	if key, ok := buildEnvKeys[s.Type]; ok {
		m[key] = s.Build
	}
}
```

En `agent/internal/spec/spec.go`:

1. En `type Spec struct`, tras `// ── plan-9 ──`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	// Build: build o versión del loader (PAPER_BUILD, FABRIC_LOADER_VERSION…). Vacío = el último:
	// no entra en el entorno y el hash no cambia.
	Build string `json:"build,omitempty"`
}
```

2. En `Validate`, tras `// ── plan-9 ──` y antes de `return nil`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	if err := s.validateBuild(); err != nil {
		return err
	}
	return nil
```

3. En `envList`, tras `// ── plan-9 ──` y antes del bucle de `s.Env`:

```go
	// ── plan-9 ──
	// ── plan-10 ──
	s.buildEnvVars(m)
	for k, v := range s.Env {
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `eval "$(mise env)" && (cd agent && go vet ./... && go test ./internal/spec/ && go test -race ./...)`
Expected: PASS (incluidos `TestHashGolden` y `TestContentHash` sin tocar).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/spec/build.go agent/internal/spec/build_test.go agent/internal/spec/spec.go
git commit -m "feat(agent): campo build de la spec traducido a la variable de itzg de cada tipo"
```

---

### Task 3: API — adaptadores de las fuentes de versiones

**Files:**
- Create: `panel/apps/api/src/versions/sources.ts`
- Create: `panel/apps/api/src/versions/sources.test.ts`

**Interfaces:**
- Consumes: `compareVersions`, `isStableVersion`, `VersionEntry`, `BuildEntry`, `VersionListType` de `@mcsm/shared`.
- Produces:
  - `class UpstreamError extends Error { status: number | null }`
  - `interface GetOptions { kind?: "json" | "text"; ttl?: "list" | "builds" }`, `type Get = (url: string, opts?: GetOptions) => Promise<unknown>`
  - `interface Source { label: string; versions(get: Get): Promise<VersionEntry[]>; builds?(get: Get, version: string): Promise<BuildEntry[]> }`
  - `SOURCES: Readonly<Record<VersionListType, Source>>`, `allowedSource(url: string): boolean`, `forgeBuildId(full, mc)`, `neoforgeMcVersion(v)`.

Las fixtures van en línea en el test: documentos pequeños con la forma exacta de las respuestas reales
(comprobadas el 2026-10-13; los campos que el parseo ignora se recortan).

- [ ] **Step 1: Escribir los tests que fallan**

`panel/apps/api/src/versions/sources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCES, UpstreamError, allowedSource, forgeBuildId, neoforgeMcVersion, type Get, type GetOptions } from "./sources.js";

/** `get` falso: devuelve el documento de cada URL y apunta qué se pidió. */
function fakeGet(docs: Record<string, unknown>) {
  const asked: ({ url: string } & GetOptions)[] = [];
  const get: Get = async (url, opts = {}) => {
    asked.push({ url, ...opts });
    if (!Object.hasOwn(docs, url)) throw new Error(`URL inesperada: ${url}`);
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
  it("releases y snapshots en el orden de la fuente; sin old_alpha/old_beta", async () => {
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

describe("Paper y Folia (Fill v3)", () => {
  it("aplana las familias y ordena de más nueva a más antigua", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: {
      project: { id: "paper", name: "Paper" },
      versions: { "26.3": ["26.3", "26.3-rc-3"], "1.21": ["1.21.11", "1.21.11-rc3", "1.21.10", "1.21"], "1.20": ["1.20.6", "1.20.1"] },
    } });
    expect(await SOURCES.PAPER.versions(get)).toEqual([
      { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false }, { id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false },
      { id: "1.21.10", stable: true }, { id: "1.21", stable: true }, { id: "1.20.6", stable: true }, { id: "1.20.1", stable: true },
    ]);
  });
  it("builds: solo STABLE, con la caché de builds", async () => {
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
  it("Folia usa su proyecto", async () => {
    const { get } = fakeGet({ [`${FILL}/folia`]: { project: { id: "folia" }, versions: { "1.21": ["1.21.11"] } } });
    expect(await SOURCES.FOLIA.versions(get)).toEqual([{ id: "1.21.11", stable: true }]);
  });
  it("la versión se codifica al construir la URL", async () => {
    const { get, asked } = fakeGet({ [`${FILL}/paper/versions/1.21%2B1/builds`]: [] });
    await SOURCES.PAPER.builds!(get, "1.21+1");
    expect(asked[0]!.url).toBe(`${FILL}/paper/versions/1.21%2B1/builds`);
  });
  it("una respuesta con otra forma es UpstreamError (no un 500)", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: "<html>mantenimiento</html>" });
    await expect(SOURCES.PAPER.versions(get)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("Purpur", () => {
  it("versiones y builds de más nueva a más antigua", async () => {
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

describe("Spigot (índice de BuildTools)", () => {
  it("solo nombres de versión, sin repetidos ni builds sueltos", async () => {
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

describe("Fabric y Quilt", () => {
  it("Fabric: versiones y loaders con su marca de estable", async () => {
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
  it("Quilt: los loaders llegan desordenados; beta = con sufijo", async () => {
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
  it("versiones de MC = claves del metadata", async () => {
    expect(await SOURCES.FORGE.versions(fakeGet(docs).get)).toEqual([
      { id: "26.3", stable: true }, { id: "1.20.1", stable: true }, { id: "1.7.10", stable: true }, { id: "1.7.10_pre4", stable: false },
    ]);
  });
  it("builds sin el prefijo de la versión, con la recomendada marcada", async () => {
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
  it("versión de MC deducida", () => {
    expect(["26.3.0.76", "26.1.2.5", "21.0.167", "21.1.77", "20.2.3-beta", "0.25w14craftmine.3-beta", "19.1.2", "26.1"].map(neoforgeMcVersion))
      .toEqual(["26.3", "26.1.2", "1.21", "1.21.1", "1.20.2", null, null, null]);
  });
  it("versiones únicas y builds filtrados por versión", async () => {
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
  it("solo HTTPS y solo los hosts de las fuentes", () => {
    expect(allowedSource(`${PURPUR}/26.2`)).toBe(true);
    expect(allowedSource(FORGE_PROMOS)).toBe(true);
    expect(allowedSource("http://api.purpurmc.org/v2/purpur")).toBe(false);
    expect(allowedSource("https://evil.example/v2/purpur")).toBe(false);
    expect(allowedSource("no es una url")).toBe(false);
  });
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/sources.test.ts`
Expected: FAIL (`Cannot find module './sources.js'`).

- [ ] **Step 3: Implementar**

`panel/apps/api/src/versions/sources.ts`:

```ts
import { z } from "zod";
import { compareVersions, isStableVersion, type BuildEntry, type VersionEntry, type VersionListType } from "@mcsm/shared";

/**
 * Fuentes oficiales de versiones (spec 2026-10-13-selector-versiones-design.md §2). Cada adaptador pide
 * sus documentos con `get` (el VersionCatalog pone caché, plazo y topes) y los normaliza a listas de
 * más nueva a más antigua. Una respuesta con forma inesperada lanza UpstreamError (→ 502 o lista
 * guardada), nunca un 500.
 */

export class UpstreamError extends Error {
  /** `status`: HTTP de la fuente, o null (red, plazo, tamaño, forma inesperada). */
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface GetOptions { kind?: "json" | "text"; ttl?: "list" | "builds" }
export type Get = (url: string, opts?: GetOptions) => Promise<unknown>;

export interface Source {
  /** Nombre para los mensajes ("No se pudo consultar la lista de versiones de Paper"). */
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

/** Solo HTTPS y solo los hosts de las fuentes (el catálogo lo comprueba antes de cada descarga). */
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
  if (!r.success) throw new UpstreamError(null, `respuesta inesperada de ${label}`);
  return r.data;
}

const newestFirst = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => compareVersions(b.id, a.id));
const unique = (xs: string[]): string[] => [...new Set(xs)];
const enc = encodeURIComponent;
const asVersions = (ids: string[]): VersionEntry[] => newestFirst(unique(ids).map((id) => ({ id, stable: isStableVersion(id) })));
const build = (id: string, stable = true, recommended = false): BuildEntry => ({ id, stable, recommended });

const metaGame = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const versionsDoc = z.object({ versions: z.array(z.string()) });

// Mojang, Fabric y Quilt ya vienen de más nueva a más antigua y mezclan snapshots con nombres que
// compareVersions no ordena (25w14a): se respeta su orden.
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
      // Solo STABLE: un build experimental exigiría PAPER_CHANNEL/FOLIA_CHANNEL=experimental.
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
    if (typeof html !== "string") throw new UpstreamError(null, "respuesta inesperada de Spigot");
    // Índice de BuildTools: <versión>.json; los números sueltos (3000.json) son builds internos.
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

/** "1.20.1-47.4.27" → "47.4.27"; las antiguas ("1.7.10-10.13.4.1614-1.7.10") repiten la versión al final. */
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
 * Versión de Minecraft de una de NeoForge (parte antes del primer "-"): mayor ≥ 26 → 26.3.0.76 = 26.3,
 * 26.1.2.5 = 26.1.2; mayor 20–25 → 21.0.167 = 1.21, 21.1.77 = 1.21.1. Otras formas → null.
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

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/sources.test.ts && pnpm --filter @mcsm/api typecheck`
Expected: PASS, typecheck limpio.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/sources.ts panel/apps/api/src/versions/sources.test.ts
git commit -m "feat(panel): adaptadores de las fuentes oficiales de versiones y builds"
```

---

### Task 4: API — `VersionCatalog` (caché, deduplicación, plazo y errores)

**Files:**
- Create: `panel/apps/api/src/versions/catalog.ts`
- Create: `panel/apps/api/src/versions/catalog.test.ts`

**Interfaces:**
- Consumes: `SOURCES`, `UpstreamError`, `allowedSource`, `Get`, `Source` (Task 3); `Timers`, `realTimers` (`src/files/stream.ts`); `HttpError` (`src/lib/http.ts`); `BUILD_MESSAGES`, `VERSION_LIST_TYPES`, `VERSION_QUERY_RE`, DTOs (Task 1).
- Produces:
  - `LIST_TTL_MS`, `BUILDS_TTL_MS`, `FETCH_TIMEOUT_MS`, `MAX_BODY_BYTES`, `MAX_ENTRIES`, `USER_AGENT`
  - `type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>`
  - `interface CatalogOptions { fetch?; now?: () => number; timers?: Timers; onError?: (url: string, err: unknown) => void }`
  - `class VersionCatalog { versions(type: string): Promise<VersionListDto>; builds(type: string, version: string): Promise<BuildListDto> }` — lanza `HttpError` 400/502.

- [ ] **Step 1: Escribir los tests que fallan**

`panel/apps/api/src/versions/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { BUILDS_TTL_MS, FETCH_TIMEOUT_MS, LIST_TTL_MS, MAX_BODY_BYTES, MAX_ENTRIES, VersionCatalog, type FetchFn } from "./catalog.js";

const PURPUR = "https://api.purpurmc.org/v2/purpur";
const purpurDoc = (versions: string[]) => JSON.stringify({ project: "purpur", versions });
const buildsDoc = (all: string[]) => JSON.stringify({ builds: { all } });
type Init = Parameters<FetchFn>[1];

/** fetch falso: respuestas en cola por URL; apunta cada llamada. */
function fakeFetch() {
  const calls: ({ url: string } & Init)[] = [];
  const routes = new Map<string, ((init: Init) => Promise<Response>)[]>();
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift();
    return next ? next(init) : Promise.reject(new TypeError(`sin red para ${url}`));
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
  it("guarda la lista 1 h y la vuelve a pedir al caducar", async () => {
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

  it("si la fuente falla sirve lo guardado con stale; sin nada guardado, 502 en castellano", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["26.2"]));
    await t.catalog.versions("PURPUR");
    t.advance(LIST_TTL_MS);
    t.reply(PURPUR, "caído", 503);
    expect(await t.catalog.versions("PURPUR")).toMatchObject({ stale: true, fetchedAt: "2026-10-13T10:00:00.000Z", versions: [{ id: "26.2", stable: true }] });
    expect(t.errors).toEqual([PURPUR]);

    const t2 = setup();
    t2.reply(PURPUR, "caído", 503);
    await expect(t2.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502, message: "No se pudo consultar la lista de versiones de Purpur" });
  });

  it("un 200 que no es el JSON esperado es 502, no 500", async () => {
    const t = setup();
    t.reply(PURPUR, "<html>mantenimiento</html>");
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    t.reply(PURPUR, JSON.stringify({ otra: "forma" }));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("dos consultas a la vez comparten la descarga", async () => {
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

  it("plazo de 10 s: aborta la descarga y responde 502", async () => {
    const t = setup();
    t.reply(PURPUR, (init) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("plazo", "AbortError")));
    }));
    const p = t.catalog.versions("PURPUR");
    expect(t.timers.pending).toBe(1);
    t.timers.advance(FETCH_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ status: 502 });
    expect(t.timers.pending).toBe(0);
  });

  it("una respuesta de más de 8 MiB es 502", async () => {
    const t = setup();
    t.reply(PURPUR, "x".repeat(MAX_BODY_BYTES + 1));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("builds: 15 min de caché; un 4xx de la fuente es una lista vacía", async () => {
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

  it("tipos sin lista, tipos sin build y versiones inválidas: 400 sin tocar la red", async () => {
    const t = setup();
    await expect(t.catalog.versions("MODRINTH")).rejects.toMatchObject({ status: 400, message: "Tipo sin lista de versiones" });
    await expect(t.catalog.versions("__proto__")).rejects.toMatchObject({ status: 400 });
    await expect(t.catalog.builds("VANILLA", "1.21.4")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/VANILLA no admite/) });
    for (const v of ["../../etc", "1.21 ", "\u0000", "a".repeat(65), ""]) {
      await expect(t.catalog.builds("PAPER", v)).rejects.toMatchObject({ status: 400, message: "Versión inválida" });
    }
    expect(t.calls).toHaveLength(0);
  });

  it(`como mucho ${MAX_ENTRIES} entradas: se descarta la menos usada`, async () => {
    const t = setup();
    const url = (i: number) => `${PURPUR}/1.0.${i}`;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      t.reply(url(i), buildsDoc([String(i)]));
      await t.catalog.builds("PURPUR", `1.0.${i}`);
    }
    await t.catalog.builds("PURPUR", "1.0.0"); // uso: pasa a ser la más reciente
    t.reply(url(MAX_ENTRIES), buildsDoc(["x"]));
    await t.catalog.builds("PURPUR", `1.0.${MAX_ENTRIES}`); // descarta 1.0.1
    const before = t.calls.length;
    await t.catalog.builds("PURPUR", "1.0.0");
    expect(t.calls).toHaveLength(before);
    t.reply(url(1), buildsDoc(["1"]));
    await t.catalog.builds("PURPUR", "1.0.1");
    expect(t.calls).toHaveLength(before + 1);
  });
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/catalog.test.ts`
Expected: FAIL (`Cannot find module './catalog.js'`).

- [ ] **Step 3: Implementar**

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
/** Fill v3 (PaperMC) pide un User-Agent que identifique al cliente. */
export const USER_AGENT = "mc-server-manager (self-hosted)";

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface CatalogOptions {
  fetch?: FetchFn;
  now?: () => number;
  timers?: Timers;
  /** Fallo de una fuente (también cuando se sirve lo guardado): para el log. */
  onError?: (url: string, err: unknown) => void;
}

interface Entry { doc: unknown; fetchedAt: number; expiresAt: number }

/**
 * Listas de versiones y builds de las fuentes oficiales con caché en memoria por URL de origen (spec
 * 2026-10-13-selector-versiones-design.md §4): listas 1 h, builds 15 min, como mucho MAX_ENTRIES
 * entradas (se descarta la menos usada). Consultas simultáneas a una URL comparten la descarga. Si la
 * fuente falla se sirve lo guardado con `stale: true`; sin nada guardado, 502.
 */
export class VersionCatalog {
  private readonly cache = new Map<string, Entry>(); // orden de inserción: de menos a más usada
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
    if (!VERSION_QUERY_RE.test(version)) throw new HttpError(400, "Versión inválida");
    const run = this.run();
    try {
      const builds = await src.builds(run.get, version);
      return { type, version, builds, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      // La fuente no conoce esa versión (404; Fabric responde 400): no hay builds que elegir.
      if (e instanceof UpstreamError && e.status !== null && e.status >= 400 && e.status < 500) {
        return { type, version, builds: [], fetchedAt: new Date(this.now()).toISOString(), stale: false };
      }
      throw unavailable(src, e);
    }
  }

  private source(type: string): Source {
    if (!(VERSION_LIST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Tipo sin lista de versiones");
    return SOURCES[type as VersionListType];
  }

  /** `get` de una consulta: anota si algo salió de lo guardado caducado y la descarga más antigua usada. */
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

  /** La pone como la más usada y descarta las menos usadas por encima del tope. */
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
    if (!allowedSource(url)) throw new UpstreamError(null, "origen no permitido");
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
        throw new UpstreamError(null, "JSON inválido");
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(null, ctrl.signal.aborted ? "plazo agotado" : "error de red");
    } finally {
      cancel();
    }
  }
}

function unavailable(src: Source, e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(502, `No se pudo consultar la lista de versiones de ${src.label}`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new UpstreamError(null, "respuesta demasiado grande");
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
      throw new UpstreamError(null, "respuesta demasiado grande");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/ && pnpm --filter @mcsm/api typecheck`
Expected: PASS, typecheck limpio.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/catalog.ts panel/apps/api/src/versions/catalog.test.ts
git commit -m "feat(panel): catálogo de versiones con caché, descarga compartida, plazo y topes"
```

---

### Task 5: API — rutas `/api/versions` y registro en `buildApp`

**Files:**
- Create: `panel/apps/api/src/versions/routes.ts`
- Create: `panel/apps/api/src/versions/routes.test.ts`
- Modify: `panel/apps/api/src/app.ts` (imports, `AppOptions`, registro tras `settingsRoutes`)

**Interfaces:**
- Consumes: `VersionCatalog`, `FetchFn` (Task 4); `ManualTimers`.
- Produces: `GET /api/versions/:type` → `VersionListDto`; `GET /api/versions/:type/:version/builds` → `BuildListDto`; `AppOptions.versions?: VersionCatalog`; `app.versions`.

- [ ] **Step 1: Escribir los tests que fallan**

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
    if (!r) throw new TypeError("sin red");
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
  it("exige sesión", async () => {
    expect((await get("/api/versions/PAPER", false)).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("lista de versiones de Paper", async () => {
    responses.set(FILL, () => new Response(JSON.stringify({ project: { id: "paper" }, versions: { "1.21": ["1.21.11", "1.21.11-rc3"] } })));
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: "PAPER", versions: [{ id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
  });

  it("builds de Paper: solo estables", async () => {
    responses.set(`${FILL}/versions/1.20.1/builds`, () => new Response(JSON.stringify([
      { id: 178, channel: "STABLE" }, { id: 177, channel: "BETA" },
    ])));
    const res = await get("/api/versions/PAPER/1.20.1/builds");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "PAPER", version: "1.20.1", builds: [{ id: "178", stable: true, recommended: false }] });
  });

  it("400 para tipos sin lista, tipos sin build y versiones inválidas, sin tocar la red", async () => {
    expect((await get("/api/versions/MODRINTH")).json()).toEqual({ error: "Tipo sin lista de versiones" });
    expect((await get("/api/versions/VANILLA/1.21.4/builds")).statusCode).toBe(400);
    for (const v of ["..%2F..%2Fetc", "1.21%20", "%00", "a".repeat(65)]) {
      expect((await get(`/api/versions/PAPER/${v}/builds`)).statusCode, v).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("fuente caída sin nada guardado: 502 con mensaje", async () => {
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "No se pudo consultar la lista de versiones de Paper" });
  });
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/routes.test.ts`
Expected: FAIL (`Cannot find module './routes.js'` o `versions` no existe en `AppOptions`).

- [ ] **Step 3: Implementar**

`panel/apps/api/src/versions/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { VersionCatalog } from "./catalog.js";

/**
 * Listas de versiones de Minecraft y de builds/loaders por tipo (plan 10). Las sirve el panel porque la
 * CSP (connect-src 'self') no deja al navegador consultar las fuentes. Pasan por el guard de sesión.
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

En `panel/apps/api/src/app.ts`:

1. Imports (junto a los demás):

```ts
import { VersionCatalog } from "./versions/catalog.js";
import { versionRoutes } from "./versions/routes.js";
```

2. `AppOptions`:

```ts
/** `logger`: true en producción; los tests pueden pasar opciones de pino (p. ej. un `stream` para capturar los logs). */
export interface AppOptions {
  db: Db;
  logger?: FastifyServerOptions["logger"];
  config?: Partial<Config>;
  /** plan-10: catálogo de versiones (los tests inyectan uno con fetch falso; nunca tocan la red). */
  versions?: VersionCatalog;
}
```

3. Tras `await app.register(settingsRoutes);` (bloque `// ── plan-9 ──`) y antes de `if (cfg.webDist)`:

```ts
  // ── plan-10 ──
  app.decorate("versions", opts.versions ?? new VersionCatalog({
    onError: (url, err) => app.log.warn({ url, err }, "no se pudo consultar una fuente de versiones"),
  }));
  await app.register(versionRoutes);
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/api exec vitest run src/versions/ && pnpm --filter @mcsm/api typecheck && pnpm --filter @mcsm/api test`
Expected: PASS; el resto de la suite de la API sigue en verde (ningún otro test llama a `/api/versions`).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/versions/routes.ts panel/apps/api/src/versions/routes.test.ts panel/apps/api/src/app.ts
git commit -m "feat(panel): rutas /api/versions con el catálogo de versiones"
```

---

### Task 6: Importación — la variable de build del tipo pasa a `build`

**Files:**
- Modify: `panel/apps/api/src/import/propose.ts` (tras la memoria, antes de «Modpack»; y el objeto `raw`)
- Modify: `panel/apps/api/src/import/service.ts` (`EDITABLE_KEYS`)
- Test: `panel/apps/api/src/import/propose.test.ts`

**Interfaces:**
- Consumes: `BUILD_RE`, `buildEnvFor`, `isFloatingVersion` (Task 1).
- Produces: `proposeImport(...).spec.build` con el valor de la variable si vale; `build` editable al importar.

- [ ] **Step 1: Escribir el test que falla**

Añade al `describe("proposeImport", …)` de `panel/apps/api/src/import/propose.test.ts`:

```ts
  it("plan-10: la variable de build del tipo pasa a build (mismo entorno); si no vale, se queda en env", () => {
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

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/api exec vitest run src/import/propose.test.ts`
Expected: FAIL (`build` es `""` en el caso de Fabric).

- [ ] **Step 3: Implementar**

En `panel/apps/api/src/import/propose.ts`, añade `BUILD_RE`, `buildEnvFor` e `isFloatingVersion` al import de `@mcsm/shared` y, justo después del bloque de `memory` (antes de `// Modpack.`):

```ts
  // plan-10: la variable de build del tipo pasa al campo build solo si vale tal cual (mismo entorno,
  // mismo hash); con LATEST/SNAPSHOT o un valor que no cumple BUILD_RE se queda en env.
  let build = "";
  const buildKey = buildEnvFor(type);
  const buildRaw = buildKey === undefined ? undefined : env[buildKey];
  if (buildKey !== undefined && buildRaw !== undefined && BUILD_RE.test(buildRaw) && !isFloatingVersion(version)) {
    build = buildRaw;
    delete env[buildKey];
  }
```

y en el objeto `raw`:

```ts
  const raw = {
    imageTag: imageTag(c.image, warn), type, version, build, memory, properties, env: passEnv,
```

En `panel/apps/api/src/import/service.ts`, `EDITABLE_KEYS`:

```ts
const EDITABLE_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "build", // plan-10
] as const;
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/api exec vitest run src/import/ && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/import/propose.ts panel/apps/api/src/import/service.ts panel/apps/api/src/import/propose.test.ts
git commit -m "feat(panel): la importación lleva la variable de build del tipo al campo build"
```

---

### Task 7: Web — componentes shadcn y lógica pura (opciones, `withVersion`)

**Files:**
- Create (shadcn): `panel/apps/web/src/components/ui/command.tsx`, `panel/apps/web/src/components/ui/popover.tsx`
- Create: `panel/apps/web/src/lib/versions.ts`, `panel/apps/web/src/lib/versions.test.ts`
- Modify: `panel/apps/web/src/lib/spec-edit.ts` (`FORM_KEYS`, `withType`, `withVersion` nueva)
- Test: `panel/apps/web/src/lib/spec-edit.test.ts`

**Interfaces:**
- Consumes: `VERSION_LIST_TYPES`, `VERSION_QUERY_RE`, `isFloatingVersion`, `isStableVersion`, `minJavaTag`, `javaMajor`, `VersionEntry`, `BuildEntry` (Task 1); `JAVA_TAGS` (`lib/spec-catalog.ts`).
- Produces:
  - `lib/versions.ts`: `MAX_OPTIONS = 200`, `hasVersionList(type)`, `specialVersions(type)`, `versionOptions(type, list, {query, showUnstable}) → { specials: {id,label}[]; stable: string[]; unstable: string[]; hidden: number; freeText: string | null }`, `freeTextOption(query, list)`, `startsUnstable(version)`, `buildLabel(type): string | null`, `hasUnstableBuilds(type)`, `buildOptions(list, current, showUnstable) → {value,label}[]`, `ageText(fetchedAt, now)`.
  - `spec-edit.ts`: `withVersion(spec, version) → { spec: EditableSpec; notice: string | null }`; `withType` vacía `build` al cambiar de tipo; `FORM_KEYS` incluye `"build"`.

- [ ] **Step 1: Añadir los componentes shadcn**

Run: `cd panel/apps/web && pnpm dlx shadcn@3.8.5 add command popover --yes`
Si pregunta por sobrescribir ficheros que ya existen (`dialog.tsx`, `button.tsx`…), responde que no.
Comprueba con `git status` que solo cambian `components/ui/command.tsx`, `components/ui/popover.tsx`,
`package.json` (añade `cmdk`) y `pnpm-lock.yaml`; si tocó otro fichero de `components/ui/`,
`git checkout -- <fichero>`. Después: `pnpm --filter @mcsm/web typecheck` (Expected: limpio).

- [ ] **Step 2: Escribir los tests que fallan**

`panel/apps/web/src/lib/versions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ageText, buildLabel, buildOptions, freeTextOption, hasUnstableBuilds, hasVersionList, startsUnstable, versionOptions } from "./versions";

const LIST = [
  { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false },
  { id: "1.21.11", stable: true }, { id: "1.21.4", stable: true }, { id: "25w14a", stable: false },
];

describe("versionOptions", () => {
  it("sin buscar: especiales del tipo y estables; las de prueba solo con el interruptor", () => {
    expect(versionOptions("VANILLA", LIST, { query: "", showUnstable: false })).toEqual({
      specials: [{ id: "LATEST", label: "LATEST — la última estable" }, { id: "SNAPSHOT", label: "SNAPSHOT — la última snapshot" }],
      stable: ["26.3", "1.21.11", "1.21.4"], unstable: [], hidden: 0, freeText: null,
    });
    expect(versionOptions("PAPER", LIST, { query: "", showUnstable: true })).toMatchObject({
      specials: [{ id: "LATEST" }], unstable: ["26.4-snapshot-3", "26.3-rc-3", "25w14a"],
    });
  });
  it("al buscar entran también las de prueba, y lo escrito que no está como «Usar»", () => {
    expect(versionOptions("PAPER", LIST, { query: "26.3", showUnstable: false })).toMatchObject({ specials: [], stable: ["26.3"], unstable: ["26.3-rc-3"], freeText: null });
    expect(versionOptions("PAPER", LIST, { query: " 1.8.9 ", showUnstable: false })).toMatchObject({ stable: [], unstable: [], freeText: "1.8.9" });
  });
  it("como mucho MAX_OPTIONS por grupo; el resto se cuenta", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `1.0.${i}`, stable: true }));
    const o = versionOptions("PAPER", many, { query: "", showUnstable: false });
    expect(o.stable).toHaveLength(200);
    expect(o.hidden).toBe(50);
  });
});

describe("freeTextOption", () => {
  it("solo versiones válidas que no estén en la lista ni sean LATEST/SNAPSHOT", () => {
    expect(freeTextOption("1.8.9", LIST)).toBe("1.8.9");
    expect(freeTextOption("26.3", LIST)).toBeNull();
    expect(freeTextOption("latest", LIST)).toBeNull();
    expect(freeTextOption("Snapshot", LIST)).toBeNull();
    expect(freeTextOption("1 2", LIST)).toBeNull();
    expect(freeTextOption("../x", LIST)).toBeNull();
    expect(freeTextOption("", LIST)).toBeNull();
  });
});

describe("selector de build", () => {
  it("etiqueta por tipo; null si no admite build", () => {
    expect(buildLabel("FABRIC")).toBe("Versión del loader de Fabric");
    expect(buildLabel("PAPER")).toBe("Build de Paper");
    expect(buildLabel("VANILLA")).toBeNull();
    expect(hasUnstableBuilds("NEOFORGE")).toBe(true);
    expect(hasUnstableBuilds("PAPER")).toBe(false);
  });
  it("estables por defecto, la recomendada marcada y la actual siempre presente", () => {
    const builds = [
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26-beta", stable: false, recommended: false },
      { id: "47.4.0", stable: true, recommended: true },
    ];
    expect(buildOptions(builds, "", false)).toEqual([{ value: "47.4.27", label: "47.4.27" }, { value: "47.4.0", label: "47.4.0 (recomendada)" }]);
    expect(buildOptions(builds, "", true).map((o) => o.label)).toContain("47.4.26-beta (beta)");
    expect(buildOptions(builds, "40.0.1", false)[0]).toEqual({ value: "40.0.1", label: "40.0.1" });
    expect(buildOptions(builds, "47.4.26-beta", false).map((o) => o.value)).toContain("47.4.26-beta");
  });
});

describe("otros", () => {
  it("hasVersionList / startsUnstable / ageText", () => {
    expect(hasVersionList("FORGE")).toBe(true);
    expect(hasVersionList("MODRINTH")).toBe(false);
    expect(startsUnstable("26.4-snapshot-3")).toBe(true);
    expect(startsUnstable("1.21.4")).toBe(false);
    expect(startsUnstable("LATEST")).toBe(false);
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ageText("2026-10-13T11:45:00Z", now)).toBe("hace 15 min");
    expect(ageText("2026-10-13T10:00:00Z", now)).toBe("hace 2 h");
    expect(ageText("2026-10-10T12:00:00Z", now)).toBe("hace 3 días");
  });
});
```

Añade a `panel/apps/web/src/lib/spec-edit.test.ts` (importa `withVersion`, `withType`, `buildSpecPatch` y `type EditableSpec` de `./spec-edit`, y `defaultSpecInput` de `@mcsm/shared` si no están ya):

```ts
describe("withVersion (plan 10)", () => {
  const base: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", imageTag: "java21", build: "178" };
  it("vacía el build al cambiar de versión y ajusta la Java del catálogo", () => {
    const r = withVersion(base, "26.3");
    expect(r.spec).toMatchObject({ version: "26.3", build: "", imageTag: "java25" });
    expect(r.notice).toBe("Java ajustada a java25 (la que pide 26.3)");
    expect(withVersion(base, "1.12.2").spec.imageTag).toBe("java8");
    expect(withVersion({ ...base, imageTag: "latest" }, "1.20.1").spec.imageTag).toBe("java17");
  });
  it("misma Java: sin aviso; versión que no se reconoce: no toca la Java", () => {
    expect(withVersion(base, "1.21.11")).toMatchObject({ notice: null, spec: { imageTag: "java21", build: "" } });
    expect(withVersion(base, "25w14craftmine")).toMatchObject({ notice: null, spec: { imageTag: "java21" } });
  });
  it("una etiqueta personalizada no se pisa; solo avisa si no basta", () => {
    const custom = { ...base, imageTag: "java21-graalvm" };
    expect(withVersion(custom, "26.3")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: "La imagen java21-graalvm no basta para 26.3: necesita Java 25" });
    expect(withVersion(custom, "1.20.1")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: null });
  });
  it("una spec antigua sin build no gana la clave (sin diff fantasma)", () => {
    const { build: _build, ...old } = base;
    const r = withVersion(old as EditableSpec, "1.21.11");
    expect(r.spec).not.toHaveProperty("build");
    expect(buildSpecPatch(old, r.spec)).toEqual({ version: "1.21.11" });
  });
  it("withType vacía el build solo al cambiar de tipo", () => {
    expect(withType(base, "FABRIC").build).toBe("");
    expect(withType(base, "PAPER").build).toBe("178");
  });
});
```

- [ ] **Step 3: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/web exec vitest run src/lib/versions.test.ts src/lib/spec-edit.test.ts`
Expected: FAIL (`Cannot find module './versions'`, `withVersion is not a function`).

- [ ] **Step 4: Implementar `lib/versions.ts`**

`panel/apps/web/src/lib/versions.ts`:

```ts
import { VERSION_LIST_TYPES, VERSION_QUERY_RE, isFloatingVersion, isStableVersion, type BuildEntry, type VersionEntry } from "@mcsm/shared";

/** Lógica del combobox de versión y del selector de build (plan 10). Puras: se prueban sin DOM. */

const SPECIALS = [
  { id: "LATEST", label: "LATEST — la última estable" },
  { id: "SNAPSHOT", label: "SNAPSHOT — la última snapshot" },
] as const;
const SNAPSHOT_TYPES = new Set(["VANILLA", "FABRIC", "QUILT"]);
/** Opciones como mucho por grupo (el resto se alcanza escribiendo). */
export const MAX_OPTIONS = 200;

export const hasVersionList = (type: string): boolean => (VERSION_LIST_TYPES as readonly string[]).includes(type);

/** LATEST siempre; SNAPSHOT solo donde itzg sabe resolverla. */
export function specialVersions(type: string): { id: string; label: string }[] {
  return SPECIALS.filter((s) => s.id === "LATEST" || SNAPSHOT_TYPES.has(type));
}

export interface VersionOptions {
  specials: { id: string; label: string }[];
  stable: string[];
  unstable: string[];
  /** Coincidencias que no se muestran por el tope de MAX_OPTIONS. */
  hidden: number;
  /** Lo escrito, para «Usar «x»», o null. */
  freeText: string | null;
}

/** Opciones del combobox: filtra por lo escrito; las de prueba solo con el interruptor o al buscar. */
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

/** Lo escrito como opción «Usar «x»»: una versión válida que no está en la lista ni es LATEST/SNAPSHOT. */
export function freeTextOption(query: string, list: readonly VersionEntry[]): string | null {
  const v = query.trim();
  if (!VERSION_QUERY_RE.test(v) || isFloatingVersion(v) || list.some((e) => e.id === v)) return null;
  return v;
}

/** ¿Abrir con «Mostrar versiones de prueba» encendido? Sí si la versión actual no es estable ni especial. */
export const startsUnstable = (version: string): boolean => version !== "" && !isStableVersion(version) && !isFloatingVersion(version);

const BUILD_LABELS: Record<string, string> = {
  PAPER: "Build de Paper", FOLIA: "Build de Folia", PURPUR: "Build de Purpur",
  FABRIC: "Versión del loader de Fabric", QUILT: "Versión del loader de Quilt",
  FORGE: "Versión de Forge", NEOFORGE: "Versión de NeoForge",
};
export const buildLabel = (type: string): string | null => (Object.hasOwn(BUILD_LABELS, type) ? (BUILD_LABELS[type] ?? null) : null);

/** Tipos cuyas fuentes publican builds beta (Paper/Folia/Purpur/Forge solo listan estables). */
export const hasUnstableBuilds = (type: string): boolean => type === "FABRIC" || type === "QUILT" || type === "NEOFORGE";

/** Opciones del selector de build: betas solo con el interruptor; la actual siempre, aunque ya no esté en la lista. */
export function buildOptions(list: readonly BuildEntry[], current: string, showUnstable: boolean): { value: string; label: string }[] {
  const out = list
    .filter((b) => b.stable || showUnstable || b.id === current)
    .map((b) => ({ value: b.id, label: `${b.id}${b.recommended ? " (recomendada)" : ""}${b.stable ? "" : " (beta)"}` }));
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

/** «hace 15 min», «hace 2 h», «hace 3 días» para el aviso de lista desactualizada. */
export function ageText(fetchedAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
```

- [ ] **Step 5: Implementar `withVersion` y ajustar `withType` y `FORM_KEYS`**

En `panel/apps/web/src/lib/spec-edit.ts`:

1. Añade `javaMajor` y `minJavaTag` al import de `@mcsm/shared`, y `JAVA_TAGS` al de `./spec-catalog`:
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

3. Sustituye `withType` entera por:

```ts
/** Cambia el tipo manteniendo coherente el modpack (tipo de modpack ⇔ sección modpack). Cada tipo tiene sus builds: se vacía. */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  // `build` puede faltar en specs antiguas: solo se toca si tiene valor (sin diff fantasma).
  const base = type !== spec.type && spec.build ? { ...spec, build: "" } : spec;
  if (isPlatform(type)) {
    const prev = base.modpack;
    // El slug solo se conserva dentro de la misma plataforma: un slug de Modrinth no vale en CurseForge.
    return { ...base, type, modpack: { platform: type, slugOrUrl: prev?.platform === type ? prev.slugOrUrl : "", versionId: prev?.platform === type ? prev.versionId : "", loader: prev?.platform === type ? prev.loader : "" } };
  }
  const { modpack: _drop, ...rest } = base;
  return { ...rest, type };
}
```

4. Tras `withType`, añade:

```ts
/**
 * Cambia la versión de Minecraft (plan 10): vacía el build (cada versión tiene los suyos) y pone la
 * Java mínima que pide si la etiqueta es del catálogo; una etiqueta personalizada (java21-graalvm) no
 * se pisa, solo se avisa si no basta. Devuelve el aviso a mostrar, o null.
 */
export function withVersion(spec: EditableSpec, version: string): { spec: EditableSpec; notice: string | null } {
  let next: EditableSpec = { ...spec, version };
  if (version !== spec.version && spec.build) next = { ...next, build: "" };
  const need = minJavaTag(version);
  if (!need || spec.imageTag === need) return { spec: next, notice: null };
  if ((JAVA_TAGS as readonly string[]).includes(spec.imageTag)) {
    return { spec: { ...next, imageTag: need }, notice: `Java ajustada a ${need} (la que pide ${version})` };
  }
  const have = javaMajor(spec.imageTag);
  const needMajor = javaMajor(need) ?? 0;
  return { spec: next, notice: have !== null && have < needMajor ? `La imagen ${spec.imageTag} no basta para ${version}: necesita Java ${needMajor}` : null };
}
```

- [ ] **Step 6: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/web exec vitest run src/lib/ && pnpm --filter @mcsm/web typecheck`
Expected: PASS, typecheck limpio.

- [ ] **Step 7: Commit**

```bash
git add panel/apps/web/src/components/ui/command.tsx panel/apps/web/src/components/ui/popover.tsx panel/apps/web/package.json pnpm-lock.yaml \
  panel/apps/web/src/lib/versions.ts panel/apps/web/src/lib/versions.test.ts panel/apps/web/src/lib/spec-edit.ts panel/apps/web/src/lib/spec-edit.test.ts
git commit -m "feat(web): lógica del selector de versiones y build, y Java ajustada al cambiar de versión"
```

---

### Task 8: Web — combobox de versión, selector de build y su integración

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

- [ ] **Step 1: Escribir los tests que fallan**

Añade a `panel/apps/web/src/components/spec-form/version-section.test.tsx`:

```tsx
describe("VersionSection: selector de versión y build (plan 10)", () => {
  it("Paper: combobox de versión con su hint, build de Paper y la pista de Java nueva", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1" });
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="sf-version"|<button[^>]*id="sf-version"[^>]*role="combobox"/);
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toContain("Build de Paper");
    expect(html).toContain('id="sf-build"');
    expect(html).toContain("java25 para 26.x");
  });
  it("modpack: versión como texto libre y sin build", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/<input[^>]*id="sf-version"/);
    expect(html).not.toContain('id="sf-build"');
  });
  it("Vanilla sin build; Spigot avisa de BUILD_FROM_SOURCE", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).not.toContain('id="sf-build"');
    const spigot = render({ ...defaultSpecInput(), type: "SPIGOT", version: "1.21.4" });
    expect(spigot).toContain("BUILD_FROM_SOURCE=true");
    expect(spigot).not.toContain('id="sf-build"');
  });
  it("con LATEST el build pide una versión concreta", () => {
    expect(render({ ...defaultSpecInput(), type: "FABRIC", version: "LATEST" })).toContain("Elige una versión concreta de Minecraft para fijar el build");
  });
});
```

Añade a `panel/apps/web/src/lib/wizard.test.ts` (dentro del `describe` de `summarizeSpec` o en uno nuevo; importa `defaultSpecInput` si no está):

```ts
  it("plan-10: el build fijado sale con la etiqueta de su tipo, justo tras la versión", () => {
    const lines = summarizeSpec({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1", build: "178" });
    expect(lines.slice(1, 3)).toEqual([{ label: "Versión de Minecraft", value: "1.20.1" }, { label: "Build de Paper", value: "178" }]);
    expect(summarizeSpec({ ...defaultSpecInput(), type: "PAPER" }).map((l) => l.label)).not.toContain("Build de Paper");
  });
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `pnpm --filter @mcsm/web exec vitest run src/components/spec-form/version-section.test.tsx src/lib/wizard.test.ts`
Expected: FAIL (no hay `role="combobox"`, ni `sf-build`, ni línea de build).

- [ ] **Step 3: Hooks**

`panel/apps/web/src/hooks/use-versions.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { BuildListDto, VersionListDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** El panel guarda las listas 1 h (builds 15 min); aquí basta con no repetir la petición en 10 min. */
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
 * Combobox de versión de Minecraft (plan 10): lista de la API según el tipo, búsqueda, versiones de
 * prueba tras un interruptor y texto libre («Usar «x»») por si la versión no está o la fuente no responde.
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
            <span className="truncate">{value || "Elige una versión"}</span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Buscar o escribir una versión…" value={query} onValueChange={setQuery} />
            <CommandList>
              {versions.isPending && <p className="px-3 py-2 text-xs text-muted-foreground">Cargando versiones…</p>}
              {versions.isError && <p role="alert" className="px-3 py-2 text-xs text-red-400">{versions.error.message}. Puedes escribir la versión a mano.</p>}
              {opts.freeText && <CommandGroup heading="Escrita a mano">{item(opts.freeText, `Usar «${opts.freeText}»`)}</CommandGroup>}
              {opts.specials.length > 0 && <CommandGroup heading="Especiales">{opts.specials.map((s) => item(s.id, s.label))}</CommandGroup>}
              {opts.stable.length > 0 && <CommandGroup heading="Estables">{opts.stable.map((v) => item(v))}</CommandGroup>}
              {opts.unstable.length > 0 && <CommandGroup heading="Snapshots y pre-releases">{opts.unstable.map((v) => item(v))}</CommandGroup>}
              {opts.hidden > 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{opts.hidden} más: escribe para filtrar.</p>}
              <CommandEmpty>Sin coincidencias.</CommandEmpty>
            </CommandList>
          </Command>
          <label className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
            <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Mostrar versiones de prueba
          </label>
        </PopoverContent>
      </Popover>
      {versions.data?.stale && (
        <p className="text-xs text-amber-400">La fuente no responde; lista de {ageText(versions.data.fetchedAt, Date.now())}.</p>
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

/** Build o versión del loader (vacío = el último al arrancar). Solo para los tipos que lo admiten (plan 10). */
export function BuildPicker({ type, version, value, onChange }: { type: string; version: string; value: string; onChange: (v: string) => void }) {
  const label = buildLabel(type);
  const concrete = !isFloatingVersion(version) && VERSION_QUERY_RE.test(version);
  const [showUnstable, setShowUnstable] = useState(false);
  const builds = useBuilds(type, version, label !== null && concrete);
  if (label === null) return null;
  const list = builds.data?.builds ?? [];
  const hint = !concrete ? "Elige una versión concreta de Minecraft para fijar el build."
    : builds.isPending ? "Cargando builds…"
    : builds.isError ? `${builds.error.message}. Se usará el último.`
    : list.length === 0 ? "La fuente no publica builds estables para esta versión: se usará el último."
    : "Vacío = el último al arrancar.";
  return (
    <div className="flex flex-col gap-1">
      <Field id="sf-build" label={label} hint={hint}>
        <OptionalSelect id="sf-build" value={value || undefined} defaultLabel="(el último)"
          options={concrete ? buildOptions(list, value, showUnstable) : []} onChange={(v) => onChange(v ?? "")} />
      </Field>
      {concrete && hasUnstableBuilds(type) && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Mostrar betas
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Integrar en `VersionSection`**

En `panel/apps/web/src/components/spec-form/version-section.tsx`:

1. Imports: cambia el de `@/lib/spec-edit` a `import { typeChangeNotice, withType, withVersion, type EditableSpec } from "@/lib/spec-edit";` y añade:

```tsx
import { hasVersionList } from "@/lib/versions";
import { BuildPicker } from "./build-picker";
import { VersionPicker } from "./version-picker";
```

2. Antes de `VersionSection`:

```tsx
const JAVA_HINT = "java25 para 26.x; java21 para 1.20.5–1.21.x; java17 para 1.17–1.20.4; java8 para anteriores. Se ajusta sola al cambiar la versión.";
```

3. Dentro de `VersionSection`, tras `const [notice, setNotice] = useState<string | null>(null);`:

```tsx
  const [javaNotice, setJavaNotice] = useState<string | null>(null);
  // Elegir versión vacía el build y ajusta la Java (withVersion); escrita a mano, al salir del campo.
  const setVersion = (v: string) => {
    const r = withVersion(spec, v);
    setJavaNotice(r.notice);
    if (r.spec.version !== spec.version || r.spec.imageTag !== spec.imageTag || r.spec.build !== spec.build) onChange(r.spec);
  };
```

4. Sustituye el primer bloque `<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">…</div>` (Tipo, Versión, Java) por:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="sf-type" label="Tipo">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => { setNotice(typeChangeNotice(spec, t)); setJavaNotice(null); onChange(withType(spec, t)); }} />
          {notice && <p role="status" className="text-xs text-amber-400">{notice}</p>}
        </Field>
        {hasVersionList(spec.type) ? (
          <Field id="sf-version" label="Versión de Minecraft" hint="Elige de la lista o escribe una versión.">
            <VersionPicker id="sf-version" type={spec.type} value={spec.version} onChange={setVersion} />
          </Field>
        ) : (
          <Field id="sf-version" label="Versión de Minecraft" hint="LATEST, SNAPSHOT o una versión como 1.21.4.">
            <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value })}
              onBlur={(e) => setVersion(e.target.value.trim())} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <Field id="sf-java" label="Java (etiqueta de la imagen)" hint={JAVA_HINT}>
            <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))}
              onChange={(t) => { setJavaNotice(null); onChange({ ...spec, imageTag: t }); }} />
          </Field>
          {javaNotice && <p role="status" className="text-xs text-amber-400">{javaNotice}</p>}
        </div>
        {/* `build` falta en specs antiguas: se lee como vacío. */}
        <BuildPicker type={spec.type} version={spec.version} value={spec.build ?? ""} onChange={(build) => onChange({ ...spec, build })} />
      </div>
      {spec.type === "SPIGOT" && (
        <p className="text-xs text-amber-400">itzg ya no descarga Spigot automáticamente: añade BUILD_FROM_SOURCE=true en las variables de entorno (Avanzado) o usa Paper.</p>
      )}
```

- [ ] **Step 7: Resumen y diff**

En `panel/apps/web/src/lib/wizard.ts`, importa `import { buildLabel } from "./versions";` y en `summarizeSpec` sustituye la construcción de `lines` por:

```ts
  const lines = [
    { label: "Tipo", value: typeLabel(spec.type) },
    { label: "Versión de Minecraft", value: spec.version },
    // plan-10: `build` falta en plantillas antiguas.
    ...(spec.build ? [{ label: buildLabel(spec.type) ?? "Build", value: spec.build }] : []),
    { label: "Java", value: spec.imageTag },
    { label: "Memoria", value: spec.memory + (spec.resources.memLimit ? ` (límite ${spec.resources.memLimit})` : "") },
  ];
```

En `panel/apps/web/src/lib/spec-diff.ts`, añade a `TOP_LABELS` la entrada `build: "Build / loader",`.

- [ ] **Step 8: Ejecutar y ver que pasa**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS (incluido el test previo «sf-version y sf-mp-slug referencian su hint», que usa un modpack y sigue con `<input>`), typecheck y build limpios.

- [ ] **Step 9: Commit**

```bash
git add panel/apps/web/src/hooks/use-versions.ts panel/apps/web/src/components/spec-form/version-picker.tsx panel/apps/web/src/components/spec-form/build-picker.tsx \
  panel/apps/web/src/components/spec-form/version-section.tsx panel/apps/web/src/components/spec-form/version-section.test.tsx \
  panel/apps/web/src/lib/wizard.ts panel/apps/web/src/lib/wizard.test.ts panel/apps/web/src/lib/spec-diff.ts
git commit -m "feat(web): combobox de versión de Minecraft y selector de build en el formulario"
```

---

### Task 9: E2E, documentación y verificación completa

**Files:**
- Modify: `panel/apps/e2e/tests/10-server.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (§4.1)
- Modify: `docs/superpowers/plans/README.md` (tabla)
- Modify: `CLAUDE.md` (Notas aprendidas)

**Interfaces:**
- Consumes: todo lo anterior, fusionado en `feat/plan-10`.

- [ ] **Step 1: Adaptar el E2E del asistente**

En `panel/apps/e2e/tests/10-server.spec.ts` sustituye `await page.locator("#sf-version").fill("1.21.4");` por:

```ts
  // plan-10: combobox. Con red sale la opción de la lista; sin ella, «Usar «1.21.4»».
  await page.locator("#sf-version").click();
  await page.getByPlaceholder("Buscar o escribir una versión…").fill("1.21.4");
  await shot(page, "01b-selector-version");
  await page.getByRole("option", { name: /^(Usar «)?1\.21\.4»?$/ }).first().click();
  await expect(page.locator("#sf-version")).toContainText("1.21.4");
```

(El paso siguiente del test sigue eligiendo `java21`, que es la que pone sola `withVersion` para 1.21.4.)

- [ ] **Step 2: Ejecutar el E2E**

Antes: `docker ps -a --format '{{.Names}}' | sort > /tmp/claude-ps-before.txt; docker network ls -q | sort > /tmp/claude-net-before.txt; docker volume ls -q | sort > /tmp/claude-vol-before.txt` (usa el scratchpad de la sesión si lo hay).
Run: `bash deploy/e2e/run.sh`
Expected: toda la suite en verde y `panel/apps/e2e/screenshots/01b-selector-version.png` con el combobox abierto (revísala).
Después: repite los tres listados y compáralos con `diff`; no debe quedar nada nuevo ni faltar nada de producción.

- [ ] **Step 3: Documentación**

`docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`, §4.1: tras la línea `"version": "1.21.4", …` añade

```jsonc
  "build": "",                          // plan 10: build/loader → PAPER_BUILD, FOLIABUILD, PURPUR_BUILD, FABRIC_LOADER_VERSION, QUILT_LOADER_VERSION, FORGE_VERSION o NEOFORGE_VERSION según el tipo; vacío = el último
```

y en el párrafo siguiente cambia «env generado (TYPE, VERSION, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,» por «env generado (TYPE, VERSION, la variable de `build` del tipo, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,».

`docs/superpowers/plans/README.md`: añade a la tabla

```markdown
| 10 | [Selector de versiones](2026-10-13-10-selector-versiones.md) | [spec propia](../specs/2026-10-13-selector-versiones-design.md) | hecho (rama `feat/plan-10`) |
```

`CLAUDE.md`, al final de «Notas aprendidas»:

```markdown
- `build` (plan 10): variable de itzg por tipo (`BUILD_ENV` en shared, `buildEnvKeys` en Go; Folia es
  `FOLIABUILD`, sin guion bajo). Vacío no emite nada (hash intacto); con valor exige tipo con build y
  versión concreta, y prohíbe su variable en `env` (fixture `build-cases.json`). La web no añade `build`
  a specs antiguas que no lo tienen (sin diff fantasma).
- Listas de versiones: `app.versions` (`VersionCatalog`, `api/src/versions/`) consulta las fuentes
  oficiales con caché en memoria (listas 1 h, builds 15 min, stale si la fuente cae); los tests inyectan
  `fetch` y nunca tocan la red. Fuente nueva = adaptador en `versions/sources.ts` + host en
  `allowedSource`. Solo builds STABLE de Paper/Folia (los experimentales exigen `*_CHANNEL`).
```

- [ ] **Step 4: Verificación completa**

Run:

```bash
eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=master" \
  && (cd agent && go vet ./... && go vet -tags integration ./... && go test -race ./...) \
  && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build
```

Expected: todo en verde. Además: `git diff master --stat -- agent/gen panel/packages/proto-ts/src/gen` vacío (no hay cambios de protocolo) y ningún `var`/`func` homónimo en `agent/internal/spec` (`go vet` lo detecta).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/e2e/tests/10-server.spec.ts docs/superpowers/specs/2026-10-12-mc-server-manager-design.md docs/superpowers/plans/README.md CLAUDE.md
git commit -m "docs: cierre del Plan 10 (selector de versiones) y E2E del asistente con el combobox"
```
