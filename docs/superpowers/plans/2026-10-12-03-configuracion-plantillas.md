# MC Server Manager — Plan 3: Configuración completa y plantillas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurar desde la web todo lo que la spec §4.1 permite (modpack, mods, plugins, whitelist, ops, ~20 propiedades tipadas, red, recursos, env libre) con un formulario por secciones y diff antes de aplicar, y guardar/instanciar plantillas con un asistente de nuevo servidor en 3 pasos.

**Architecture:** La spec crece con cinco secciones opcionales (`modpack`, `mods`, `plugins`, `whitelist`, `ops`) validadas igual en Go y en zod (una tabla de casos JSON compartida lo garantiza) y traducidas por `BuildContainer` a variables itzg; una sección ausente no emite nada, así que el hash de las specs existentes no cambia. El `PATCH` de spec pasa a ser un merge de primer nivel (cada pantalla envía solo lo que edita). La API key de CurseForge vive en `settings` y solo se añade a la spec en el mensaje hacia el agente. Las plantillas son specs sin `ports` ni `rconPassword` en una tabla nueva. La web sustituye el formulario plano del Plan 1 por `SpecForm` (pestañas por sección) y el asistente de un paso por uno de tres.

**Tech Stack:** Go 1.27.2 (agente, `internal/spec`); Node 26, pnpm 12, Fastify 5, `node:sqlite`, zod 4.6 (con `z.locales.es()`); React 19, TanStack Router/Query, shadcn/ui (Radix), Vitest 4 (incluye render en servidor con `react-dom/server` para pruebas de humo de componentes). Sin cambios de protocolo.

**Spec:** `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (§4.1 completa, §4 `templates` y `settings`, §8 formulario por secciones, asistente y Plantillas, §9). Alcance y aceptación: `docs/superpowers/plans/README.md` (Plan 3). Coordinación: `docs/superpowers/plans/COORDINATION.md`.

## Global Constraints

- Rama `feat/plan-3` en `.worktrees/plan-3`, desde el Plan 1 integrado **con las anclas** del commit de preparación de la oleada A. Toolchain: `eval "$(mise env)"` antes de `go`/`buf`; Node 26 y pnpm 12 globales.
- Ficheros compartidos: este plan escribe **debajo de las anclas `plan-3`** (`// ── plan-3 ──` en TS/Go; en el array `migrations` es el mismo comentario TS). Las pocas ediciones fuera de ancla están señaladas en cada tarea con «(fuera de ancla)».
- Protocolo: **ningún cambio**. La spec viaja como JSON en `ServerSpec.spec_json`; el rango `Envelope.body` 40–49 queda libre. No hace falta `pnpm gen`.
- Migraciones: `020_cf_api_key_env_to_settings` y `021_templates` (rango 020–029), en ese orden, debajo de la ancla `plan-3` del array `migrations`.
- Campos de spec exactos (todos opcionales; ausente = no se emite nada): `modpack {platform: MODRINTH|AUTO_CURSEFORGE|FTBA, slugOrUrl, versionId, loader}`, `mods {modrinthProjects[], curseforgeFiles[], urls[]}`, `plugins {modrinthProjects[], spigetResources[], urls[]}`, `whitelist {enabled, players[]}`, `ops[]`. `type` debe ser igual a `modpack.platform` cuando hay modpack, y un `type` de modpack exige `modpack`.
- `CF_API_KEY` pasa a ser variable **reservada** (no se puede poner en `env`). La key global vive en `settings.curseforge_api_key`, se gestiona con `GET/PUT /api/settings/curseforge` (que solo devuelven `{configured}`) y solo se inyecta como campo `curseforgeApiKey` en el `spec_json` que va al agente, y solo si la spec usa CurseForge.
- `PATCH /api/servers/:id` y `PATCH /api/templates/:id`: `spec` es un **merge de primer nivel** (clave presente sustituye, `null` borra, ausente se conserva). El formulario solo envía las claves de `FORM_KEYS` que cambiaron; **nunca** `backups` (Plan 4) ni claves que no conoce.
- Plantillas: misma forma que la spec de servidor **sin `ports` ni `rconPassword`** (spec §4 `templates`); el panel asigna puerto y RCON al instanciar.
- El formulario **no** tiene sección Backups (es del Plan 4, pestaña Backups). No se toca `panel/apps/api/src/auth/**`.
- Mensajes de UI y de error en castellano (zod configurado con `z.locales.es()` en `@mcsm/shared`); identificadores en inglés.
- Commits Conventional en castellano, pequeños, con la línea `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (o la del modelo que implemente la tarea). Nunca `git push`, `--no-verify` ni reescribir historia.
- Docker en la máquina de desarrollo: la verificación extremo a extremo solo crea recursos con prefijo `mcsm-test-` (servidores con slug `test-…`, proyecto compose `mcsm-test-p3`) y los borra al terminar.

## Review Focus

1. **Go y zod no aceptan exactamente lo mismo** (modpack con `type` incompatible, entradas con espacios Unicode, `whitelist` sin `enabled`) → el panel guarda una spec que el agente rechaza y el servidor se queda en `observed.error`. Se fija con la tabla compartida `proto/fixtures/spec-content-cases.json`, que ejecutan los tests de Go (Task 1) y de zod (Task 2), y con regex solo ASCII (sin `\s`, que en RE2 y en JS no significa lo mismo).
2. **Actualizar el agente recrea todos los contenedores** porque cambia el hash de specs que no usan nada nuevo → reinicio de todos los servidores. Test en Task 1: hash dorado `6a5a213aad161661` de `spec-example.json`; `ops: []`, la key de CurseForge en servidores sin CurseForge, reordenar o duplicar mods y campos desconocidos (`backups`) no cambian el hash; cambiar la key sí recrea los que usan CurseForge.
3. **Un PATCH parcial pisa lo que no edita** (la pestaña Backups del Plan 4 envía solo `backups` y el panel resetea tipo y memoria; o el formulario borra `backups` al guardar) → configuración perdida. Tests en Task 3 (merge, `null`, misma spec no versiona, `rconPassword` inmutable, `__proto__`) y Task 6 (`buildSpecPatch` solo toca `FORM_KEYS`).
4. **La API key de CurseForge llega al navegador** (listados, detalle, `GET` de ajustes, env libre) → secreto filtrado. Tests en Task 4 (no aparece en ningún DTO ni en `servers.spec`; solo la reciben specs de CurseForge; migración que la saca del env libre) y Task 1 (`$` pasa literal).
5. **Una plantilla arrastra puertos o la contraseña RCON** → dos servidores del mismo nodo chocan o comparten RCON. Tests en Task 5 (guardar desde servidor y crear desde spec descartan `ports`/`rconPassword`; instanciar da puerto libre y RCON nuevo; el resto idéntico) y verificación real en Task 12.
6. **Quitar algo en la UI no lo quita del servidor** (desactivar la whitelist, borrar el último mod de Modrinth, quitar a alguien de la whitelist) → el servidor sigue con lo viejo. Tests en Task 1 (`ENABLE_WHITELIST=false` explícito, `MODRINTH_PROJECTS` vacía cuando la sección existe, `EXISTING_WHITELIST_FILE=SYNCHRONIZE`) y Task 7 (la sección de mods se conserva vacía en vez de desaparecer).

---

## Mapeo spec → variables itzg (verificado en `itzg/docker-minecraft-server` master, 2026-10-12)

| Spec | Variables | Notas (fuente) |
|---|---|---|
| `type` con modpack | `TYPE=MODRINTH\|AUTO_CURSEFORGE\|FTBA` | `scripts/start-configuration` copia `TYPE` de plataforma a `MODPACK_PLATFORM`; emitir también `MODPACK_PLATFORM` con `TYPE≠VANILLA` solo da el aviso «Avoid setting TYPE and MODPACK_PLATFORM». **Desviación consciente** del README de planes, que listaba `MODPACK_PLATFORM`: no se emite. |
| `modpack` Modrinth | `MODRINTH_MODPACK`, `MODRINTH_VERSION`, `MODRINTH_LOADER` | Loader: `fabric\|forge\|quilt\|neoforge` (`ModpackLoader` de mc-image-helper). Vacío = sin fijar. |
| `modpack` CurseForge | `CF_SLUG` o `CF_PAGE_URL` (si empieza por `http`), `CF_FILE_ID` | El fichero fija el loader; no hay loader propio. `CF_API_KEY` opcional en imágenes java17+ (traen una). |
| `modpack` FTB | `FTB_MODPACK_ID`, `FTB_MODPACK_VERSION_ID` | Numéricos (`start-deployFTBA`). |
| `mods.modrinthProjects` + `plugins.modrinthProjects` | `MODRINTH_PROJECTS` | Coma, ordenada y sin duplicados. Con la sección presente se emite **aunque quede vacía**: `[[ -v MODRINTH_PROJECTS ]]` con lista vacía borra lo instalado. |
| `mods.curseforgeFiles` | `CURSEFORGE_FILES` | Solo si no está vacía. |
| `mods.urls` / `plugins.urls` | `MODS` / `PLUGINS` | Solo si no están vacías. Quitar una URL no borra el `.jar` ya copiado. |
| `plugins.spigetResources` | `SPIGET_RESOURCES` | Ids numéricos. |
| `whitelist` | `ENABLE_WHITELIST=true\|false`, `WHITELIST`, `EXISTING_WHITELIST_FILE=SYNCHRONIZE` | `ENABLE_WHITELIST=true` activa también `enforce-whitelist` (`start-setupServerProperties`). `false` explícito desactiva una whitelist anterior. Sin lista no se emite `WHITELIST` (no vacía el fichero). |
| `ops` | `OPS`, `EXISTING_OPS_FILE=SYNCHRONIZE` | Lista vacía = no se emite (no toca `ops.json`). |
| `settings.curseforge_api_key` | `CF_API_KEY` | Solo si la spec usa CurseForge (modpack `AUTO_CURSEFORGE` o `mods.curseforgeFiles`). Por la API de Docker los `$` no se escapan. |

El `env` libre sigue ganando sobre todo lo generado (p. ej. `EXISTING_WHITELIST_FILE=MERGE` para sumar en vez de sincronizar), salvo las reservadas.

## Estructura de archivos

```
proto/fixtures/spec-modded.json                 spec válida con todas las secciones (Go y TS)
proto/fixtures/spec-content-cases.json          tabla de casos válidos/ inválidos compartida Go↔zod

agent/internal/spec/content.go                  tipos Modpack/ModSources/PluginSources/Whitelist, validación y env itzg
agent/internal/spec/content_test.go
agent/internal/spec/spec.go                     (mod) campos bajo ancla, Validate, envList, CF_API_KEY reservada

panel/packages/shared/src/spec-content.ts       zod de las secciones + contentCheck + usesCurseForge
panel/packages/shared/src/spec-content.test.ts
panel/packages/shared/src/zod-locale.ts         z.config(z.locales.es())
panel/packages/shared/src/spec-patch.ts         mergeSpecPatch, canonicalJson, formatZodError, specPatchSchema
panel/packages/shared/src/spec-patch.test.ts
panel/packages/shared/src/templates.ts          esquemas de plantillas, specToTemplate, copyName
panel/packages/shared/src/templates.test.ts
panel/packages/shared/src/spec.ts               (mod) campos, specChecks, serverPatchSchema, templateSpecSchema
panel/packages/shared/src/index.ts              (mod) exports

panel/apps/api/src/servers/service.ts           (mod) PATCH con merge, key de CF al empujar, reapplyCurseForge
panel/apps/api/src/servers/repo.ts              (mod) toServerSpecMessage(row, {curseforgeApiKey}), bumpVersion
panel/apps/api/src/servers/patch.test.ts
panel/apps/api/src/agents/service.ts            (mod) SyncSpecs con la key de CF
panel/apps/api/src/curseforge/{repo.ts,routes.ts,curseforge.test.ts}
panel/apps/api/src/templates/{repo.ts,routes.ts,templates.test.ts}
panel/apps/api/src/app.ts                       (mod) decoraciones y rutas bajo ancla
panel/apps/api/src/db/migrations.ts             (mod) 020_*, 021_*

panel/apps/web/src/lib/spec-catalog.ts          tipos de servidor, Java, reinicio, ~20 propiedades tipadas
panel/apps/web/src/lib/spec-edit.ts             estado editable, listas/kv, withType, buildSpecPatch, validateSpec
panel/apps/web/src/lib/spec-diff.ts             diff legible para el diálogo "Aplicar"
panel/apps/web/src/lib/wizard.ts                petición y resumen del asistente
panel/apps/web/src/lib/api.ts                   (mod) api.put, TemplateDto
panel/apps/web/src/components/spec-form/{fields,curseforge-key,version-section,properties-section,players-section,network-section,resources-section,advanced-section,spec-form}.tsx
panel/apps/web/src/components/save-template-dialog.tsx
panel/apps/web/src/components/server-config-form.tsx   (sustituye al del Plan 1)
panel/apps/web/src/hooks/use-templates.ts
panel/apps/web/src/routes/{templates.tsx,template-edit.tsx,new-server.tsx}
panel/apps/web/src/router.tsx, components/layout.tsx  (mod)
panel/apps/web/src/lib/spec-form.ts(+test)      (se borran en Task 10: los sustituye spec-edit.ts)
```

## Orden y dependencias

Las tareas van en orden en una sola rama. La Task 1 crea las fixtures que lee la Task 2. Las tareas web (6–11) necesitan los tipos y endpoints de las Tasks 2, 3 y 5. La Task 12 cierra el plan.

---

### Task 1: Agente — secciones de contenido de la spec y su traducción a variables itzg

**Agent:** go-agent-dev

**Files:**
- Create: `proto/fixtures/spec-modded.json`, `proto/fixtures/spec-content-cases.json`, `agent/internal/spec/content.go`, `agent/internal/spec/content_test.go`
- Modify: `agent/internal/spec/spec.go` (struct `Spec`, `Validate`, `envList` bajo las anclas `plan-3`; `ReservedEnv` fuera de ancla)

**Interfaces:**
- Consumes: `spec.Spec`, `spec.Parse`, `spec.BuildContainer(meta, s, dataRoot, network)`, `(Spec).envList()` y los helpers de test `loadFixture`, `meta`, `envMap` de `spec_test.go` (Plan 1).
- Produces (Go): tipos `spec.Modpack{Platform, SlugOrURL, VersionID, Loader}`, `spec.ModSources{ModrinthProjects, CurseforgeFiles, URLs}`, `spec.PluginSources{ModrinthProjects, SpigetResources, URLs}`, `spec.Whitelist{Enabled, Players}`; campos `Spec.Modpack *Modpack`, `Spec.Mods *ModSources`, `Spec.Plugins *PluginSources`, `Spec.Whitelist *Whitelist`, `Spec.Ops []string`, `Spec.CurseForgeAPIKey string` (JSON `curseforgeApiKey`); `(Spec).UsesCurseForge() bool`; constantes `PlatformModrinth`, `PlatformAutoCurseForge`, `PlatformFTBA`; `ReservedEnv["CF_API_KEY"]`.
- Produces (fixtures): `proto/fixtures/spec-modded.json` y `proto/fixtures/spec-content-cases.json` (array de `{name, ok, merge}`: `merge` se mezcla en la raíz de `spec-example.json`), que la Task 2 ejecuta con zod.

- [ ] **Step 1: Fixtures compartidas**

`proto/fixtures/spec-modded.json` (los duplicados y el desorden son a propósito: el agente debe ordenar y deduplicar):
```json
{
  "imageTag": "java21",
  "type": "MODRINTH",
  "version": "1.21.1",
  "memory": "6G",
  "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric", "versionId": "", "loader": "fabric" },
  "mods": { "modrinthProjects": ["lithium", "ferritecore:beta", "lithium"], "curseforgeFiles": [], "urls": [] },
  "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [] },
  "properties": { "motd": "Modpack de casa", "max-players": "8" },
  "whitelist": { "enabled": true, "players": ["Steve", "Lobo"] },
  "ops": ["Lobo"],
  "env": {},
  "ports": { "game": 25566, "extra": [] },
  "resources": { "cpus": 0, "memLimit": "8G" },
  "restartPolicy": "unless-stopped",
  "rconPassword": "s3cretpassw0rd"
}
```

`proto/fixtures/spec-content-cases.json`:
```json
[
  { "name": "modpack de Modrinth con type MODRINTH", "ok": true,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric" } } },
  { "name": "modpack con type PAPER", "ok": false,
    "merge": { "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric" } } },
  { "name": "type MODRINTH sin modpack", "ok": false,
    "merge": { "type": "MODRINTH" } },
  { "name": "type AUTO_CURSEFORGE con modpack de Modrinth", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x" } } },
  { "name": "plataforma de modpack desconocida", "ok": false,
    "merge": { "type": "CURSEFORGE", "modpack": { "platform": "CURSEFORGE", "slugOrUrl": "x" } } },
  { "name": "slugOrUrl vacío", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "" } } },
  { "name": "slugOrUrl con espacio", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "mi pack" } } },
  { "name": "loader neoforge en Modrinth", "ok": true,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x", "versionId": "abc123", "loader": "neoforge" } } },
  { "name": "loader desconocido en Modrinth", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x", "loader": "liteloader" } } },
  { "name": "loader en un modpack de CurseForge", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "all-the-mods-10", "loader": "forge" } } },
  { "name": "CurseForge por URL con fileId numérico", "ok": true,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10", "versionId": "6013341" } } },
  { "name": "CurseForge con fileId no numérico", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "all-the-mods-10", "versionId": "v1.2" } } },
  { "name": "FTBA con ids numéricos", "ok": true,
    "merge": { "type": "FTBA", "modpack": { "platform": "FTBA", "slugOrUrl": "126", "versionId": "100" } } },
  { "name": "FTBA con slug en vez de id", "ok": false,
    "merge": { "type": "FTBA", "modpack": { "platform": "FTBA", "slugOrUrl": "ftb-skies" } } },
  { "name": "mods válidos", "ok": true,
    "merge": { "mods": { "modrinthProjects": ["lithium", "fabric:sodium", "ferritecore:beta"], "curseforgeFiles": ["jei:4593548"], "urls": ["https://example.com/mods/a.jar"] } } },
  { "name": "mods vacío", "ok": true, "merge": { "mods": {} } },
  { "name": "proyecto de Modrinth con coma", "ok": false,
    "merge": { "mods": { "modrinthProjects": ["lithium,sodium"] } } },
  { "name": "proyecto de Modrinth con espacio", "ok": false,
    "merge": { "mods": { "modrinthProjects": ["lithium sodium"] } } },
  { "name": "proyecto de Modrinth vacío", "ok": false,
    "merge": { "mods": { "modrinthProjects": [""] } } },
  { "name": "URL de mod que no es http", "ok": false,
    "merge": { "mods": { "urls": ["ftp://example.com/a.jar"] } } },
  { "name": "URL de plugin con espacio no ASCII", "ok": false,
    "merge": { "plugins": { "urls": ["https://example.com/a b.jar"] } } },
  { "name": "recursos de Spiget numéricos", "ok": true,
    "merge": { "plugins": { "spigetResources": ["28140", "34315"], "modrinthProjects": ["luckperms"] } } },
  { "name": "recurso de Spiget no numérico", "ok": false,
    "merge": { "plugins": { "spigetResources": ["essentials"] } } },
  { "name": "whitelist con nombre y UUID", "ok": true,
    "merge": { "whitelist": { "enabled": true, "players": ["Lobo", "069a79f4-44e9-4726-a5be-fca90e38aaf5"] } } },
  { "name": "whitelist sin enabled (vale false)", "ok": true,
    "merge": { "whitelist": { "players": ["Lobo"] } } },
  { "name": "whitelist desactivada con jugadores", "ok": true,
    "merge": { "whitelist": { "enabled": false, "players": ["Lobo"] } } },
  { "name": "jugador con espacio", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": ["Lo bo"] } } },
  { "name": "jugador de 17 caracteres", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": ["abcdefghijklmnopq"] } } },
  { "name": "ops válidos", "ok": true, "merge": { "ops": ["Lobo", "Steve"] } },
  { "name": "op con coma", "ok": false, "merge": { "ops": ["Lobo,Steve"] } },
  { "name": "sección whitelist y propiedad white-list a la vez", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": [] }, "properties": { "white-list": "true" } } },
  { "name": "sección whitelist y propiedad enforce-whitelist a la vez", "ok": false,
    "merge": { "whitelist": { "enabled": false, "players": [] }, "properties": { "enforce-whitelist": "true" } } },
  { "name": "propiedad white-list sin sección whitelist (compatibilidad)", "ok": true,
    "merge": { "properties": { "white-list": "true" } } },
  { "name": "CF_API_KEY en env libre", "ok": false, "merge": { "env": { "CF_API_KEY": "x" } } }
]
```

- [ ] **Step 2: Test (falla)**

`agent/internal/spec/content_test.go`:
```go
package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixturePath(name string) string {
	return filepath.Join("..", "..", "..", "proto", "fixtures", name)
}

func loadModded(t *testing.T) Spec {
	t.Helper()
	b, err := os.ReadFile(fixturePath("spec-modded.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func buildEnv(t *testing.T, s Spec) map[string]string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return envMap(b.Config.Env)
}

func hashOfSpec(t *testing.T, s Spec) string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return b.Hash
}

// Casos compartidos con panel/packages/shared/src/spec-content.test.ts: Go y zod deben
// aceptar y rechazar exactamente lo mismo.
func TestContentCasesSharedWithZod(t *testing.T) {
	baseRaw, err := os.ReadFile(fixturePath("spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	casesRaw, err := os.ReadFile(fixturePath("spec-content-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string                     `json:"name"`
		OK    bool                       `json:"ok"`
		Merge map[string]json.RawMessage `json:"merge"`
	}
	if err := json.Unmarshal(casesRaw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("solo %d casos: ¿fixture truncada?", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(baseRaw, &doc); err != nil {
				t.Fatal(err)
			}
			for k, v := range c.Merge {
				doc[k] = v
			}
			b, _ := json.Marshal(doc)
			_, err := Parse(b)
			if c.OK && err != nil {
				t.Fatalf("debía aceptarse: %v", err)
			}
			if !c.OK && err == nil {
				t.Fatal("debía rechazarse")
			}
		})
	}
}

func TestContentEnvModrinthModpack(t *testing.T) {
	env := buildEnv(t, loadModded(t))
	want := map[string]string{
		"TYPE":                    "MODRINTH",
		"MODRINTH_MODPACK":        "cobblemon-fabric",
		"MODRINTH_LOADER":         "fabric",
		"MODRINTH_PROJECTS":       "ferritecore:beta,lithium",
		"ENABLE_WHITELIST":        "true",
		"WHITELIST":               "Lobo,Steve",
		"EXISTING_WHITELIST_FILE": "SYNCHRONIZE",
		"OPS":                     "Lobo",
		"EXISTING_OPS_FILE":       "SYNCHRONIZE",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	for _, k := range []string{"MODPACK_PLATFORM", "MODRINTH_VERSION", "CF_API_KEY", "MODS", "PLUGINS", "SPIGET_RESOURCES", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("no debía emitirse %s (= %q)", k, env[k])
		}
	}
}

func TestContentEnvCurseForgeAndFTB(t *testing.T) {
	s := loadFixture(t)
	s.Type = PlatformAutoCurseForge
	s.Modpack = &Modpack{Platform: PlatformAutoCurseForge, SlugOrURL: "all-the-mods-10", VersionID: "6013341"}
	s.CurseForgeAPIKey = "$2a$10$abc/def"
	env := buildEnv(t, s)
	if env["CF_SLUG"] != "all-the-mods-10" || env["CF_FILE_ID"] != "6013341" || env["CF_PAGE_URL"] != "" {
		t.Errorf("slug: %v", env)
	}
	if env["CF_API_KEY"] != "$2a$10$abc/def" {
		t.Errorf("CF_API_KEY = %q (los $ no se escapan: la API de Docker no interpola)", env["CF_API_KEY"])
	}

	s.Modpack.SlugOrURL = "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10"
	env = buildEnv(t, s)
	if env["CF_PAGE_URL"] != s.Modpack.SlugOrURL || env["CF_SLUG"] != "" {
		t.Errorf("url: %v", env)
	}

	f := loadFixture(t)
	f.Type = PlatformFTBA
	f.Modpack = &Modpack{Platform: PlatformFTBA, SlugOrURL: "126", VersionID: "100"}
	env = buildEnv(t, f)
	if env["FTB_MODPACK_ID"] != "126" || env["FTB_MODPACK_VERSION_ID"] != "100" || env["TYPE"] != "FTBA" {
		t.Errorf("ftba: %v", env)
	}
}

func TestContentEnvModsPluginsAndWhitelistOff(t *testing.T) {
	s := loadFixture(t) // PAPER
	s.Plugins = &PluginSources{ModrinthProjects: []string{"luckperms"}, SpigetResources: []string{"34315", "28140"}, URLs: []string{"https://example.com/b.jar", "https://example.com/a.jar"}}
	s.Mods = &ModSources{CurseforgeFiles: []string{"jei:4593548"}}
	s.Whitelist = &Whitelist{Enabled: false, Players: []string{"Lobo"}}
	env := buildEnv(t, s)
	want := map[string]string{
		"MODRINTH_PROJECTS": "luckperms",
		"SPIGET_RESOURCES":  "28140,34315",
		"PLUGINS":           "https://example.com/a.jar,https://example.com/b.jar",
		"CURSEFORGE_FILES":  "jei:4593548",
		"ENABLE_WHITELIST":  "false",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	if _, ok := env["WHITELIST"]; ok {
		t.Error("con la whitelist desactivada no se emite WHITELIST (itzg la activaría)")
	}
	if _, ok := env["CF_API_KEY"]; ok {
		t.Error("sin API key en la spec no se emite CF_API_KEY")
	}
}

func TestEnvLibreGanaSobreLoGenerado(t *testing.T) {
	s := loadModded(t)
	s.Env = map[string]string{"EXISTING_WHITELIST_FILE": "MERGE"}
	if env := buildEnv(t, s); env["EXISTING_WHITELIST_FILE"] != "MERGE" {
		t.Errorf("env libre debe ganar: %q", env["EXISTING_WHITELIST_FILE"])
	}
}

// El hash solo cambia cuando cambia el contenedor.
func TestContentHash(t *testing.T) {
	base := loadFixture(t)
	h0 := hashOfSpec(t, base)
	// Valor calculado con el código del Plan 1 para spec-example.json: si cambia, al
	// actualizar el agente se recrearían TODOS los contenedores existentes. Solo puede
	// cambiar si se actualiza la versión de github.com/moby/moby/api.
	if h0 != "6a5a213aad161661" {
		t.Fatalf("el hash de una spec sin campos nuevos cambió: %s", h0)
	}

	noOps := base
	noOps.Ops = []string{}
	if hashOfSpec(t, noOps) != h0 {
		t.Error("ops vacío no debe cambiar el hash")
	}

	withKey := base
	withKey.CurseForgeAPIKey = "k"
	if hashOfSpec(t, withKey) != h0 {
		t.Error("la API key de CurseForge no debe afectar a servidores que no usan CurseForge")
	}

	a := base
	a.Mods = &ModSources{ModrinthProjects: []string{"lithium", "sodium"}}
	b := base
	b.Mods = &ModSources{ModrinthProjects: []string{"sodium", "lithium", "lithium"}}
	if hashOfSpec(t, a) != hashOfSpec(t, b) {
		t.Error("reordenar o duplicar mods no debe recrear el contenedor")
	}
	if hashOfSpec(t, a) == h0 {
		t.Error("añadir mods debe cambiar el hash")
	}

	cf := base
	cf.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	cf1, cf2 := cf, cf
	cf1.CurseForgeAPIKey = "uno"
	cf2.CurseForgeAPIKey = "dos"
	if hashOfSpec(t, cf1) == hashOfSpec(t, cf2) {
		t.Error("cambiar la API key debe recrear los servidores que usan CurseForge")
	}
}

// Quitar el último mod debe llegar a itzg como MODRINTH_PROJECTS vacía (borra lo instalado);
// sin la sección, la variable no existe y itzg no toca nada.
func TestEmptyModsSectionClearsModrinthProjects(t *testing.T) {
	s := loadFixture(t)
	if _, ok := buildEnv(t, s)["MODRINTH_PROJECTS"]; ok {
		t.Fatal("sin sección mods/plugins no debe existir MODRINTH_PROJECTS")
	}
	s.Mods = &ModSources{}
	env := buildEnv(t, s)
	if v, ok := env["MODRINTH_PROJECTS"]; !ok || v != "" {
		t.Errorf("MODRINTH_PROJECTS = %q (presente=%v), want vacía y presente", v, ok)
	}
	for _, k := range []string{"MODS", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s vacía no debe emitirse", k)
		}
	}
}

func TestParseIgnoresUnknownFields(t *testing.T) {
	// Campos de otros planes (p. ej. backups) no deben romper el agente de este plan.
	raw, _ := os.ReadFile(fixturePath("spec-example.json"))
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc)
	doc["backups"] = json.RawMessage(`{"enabled":true,"cron":"0 4 * * *"}`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if hashOfSpec(t, s) != "6a5a213aad161661" {
		t.Error("un campo desconocido no debe cambiar el hash")
	}
	if !strings.Contains(string(b), "backups") {
		t.Fatal("fixture mal construida")
	}
}
```

- [ ] **Step 3: Ejecutar (debe fallar)**

```bash
eval "$(mise env)" && cd agent && go test ./internal/spec/
```
Expected: FAIL de compilación (`undefined: ModSources`, `s.Modpack undefined`…).

- [ ] **Step 4: Implementación de las secciones**

`agent/internal/spec/content.go`:
```go
package spec

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Plataformas de modpack. El TYPE de la imagen es la propia plataforma: itzg
// (scripts/start-configuration) copia TYPE=MODRINTH|AUTO_CURSEFORGE|FTBA a
// MODPACK_PLATFORM, y emitir también MODPACK_PLATFORM con TYPE≠VANILLA solo
// produce el aviso "Avoid setting TYPE and MODPACK_PLATFORM". Por eso no se emite.
const (
	PlatformModrinth       = "MODRINTH"
	PlatformAutoCurseForge = "AUTO_CURSEFORGE"
	PlatformFTBA           = "FTBA"
)

// ModpackPlatforms son los valores válidos de modpack.platform (y de type con modpack).
var ModpackPlatforms = map[string]bool{PlatformModrinth: true, PlatformAutoCurseForge: true, PlatformFTBA: true}

// ModrinthLoaders son los valores de MODRINTH_LOADER que acepta mc-image-helper ("" = sin fijar).
var ModrinthLoaders = map[string]bool{"": true, "fabric": true, "forge": true, "quilt": true, "neoforge": true}

var (
	// listEntryRe: ASCII imprimible sin espacios ni comas (las listas se unen con comas).
	// El mismo patrón está en zod; no usar \s, que no significa lo mismo en Go (RE2) y en JS.
	listEntryRe = regexp.MustCompile(`^[!-+\--~]{1,300}$`)
	urlRe       = regexp.MustCompile(`^https?://[!-+\--~]{1,1000}$`)
	digitsRe    = regexp.MustCompile(`^[0-9]{1,12}$`)
	// playerRe: nombre de perfil de Java (1-16 letras, números o _) o UUID con o sin guiones.
	playerRe = regexp.MustCompile(`^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$`)
)

// whitelistProps las gestiona la sección whitelist por env; no pueden ir también en properties.
var whitelistProps = []string{"white-list", "enforce-whitelist"}

type Modpack struct {
	Platform  string `json:"platform"`
	SlugOrURL string `json:"slugOrUrl"`
	VersionID string `json:"versionId"`
	Loader    string `json:"loader"`
}

type ModSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	CurseforgeFiles  []string `json:"curseforgeFiles"`
	URLs             []string `json:"urls"`
}

type PluginSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	SpigetResources  []string `json:"spigetResources"`
	URLs             []string `json:"urls"`
}

type Whitelist struct {
	Enabled bool     `json:"enabled"`
	Players []string `json:"players"`
}

type listRule struct {
	name  string
	items []string
	re    *regexp.Regexp
}

// UsesCurseForge indica si la spec descarga algo de CurseForge (y por tanto recibe CF_API_KEY).
func (s Spec) UsesCurseForge() bool {
	return (s.Modpack != nil && s.Modpack.Platform == PlatformAutoCurseForge) ||
		(s.Mods != nil && len(s.Mods.CurseforgeFiles) > 0)
}

func (s Spec) validateContent() error {
	if err := s.validateModpack(); err != nil {
		return err
	}
	var rules []listRule
	if s.Mods != nil {
		rules = append(rules,
			listRule{"mods.modrinthProjects", s.Mods.ModrinthProjects, listEntryRe},
			listRule{"mods.curseforgeFiles", s.Mods.CurseforgeFiles, listEntryRe},
			listRule{"mods.urls", s.Mods.URLs, urlRe})
	}
	if s.Plugins != nil {
		rules = append(rules,
			listRule{"plugins.modrinthProjects", s.Plugins.ModrinthProjects, listEntryRe},
			listRule{"plugins.spigetResources", s.Plugins.SpigetResources, digitsRe},
			listRule{"plugins.urls", s.Plugins.URLs, urlRe})
	}
	rules = append(rules, listRule{"ops", s.Ops, playerRe})
	if s.Whitelist != nil {
		rules = append(rules, listRule{"whitelist.players", s.Whitelist.Players, playerRe})
		for _, k := range whitelistProps {
			if _, ok := s.Properties[k]; ok {
				return fmt.Errorf("spec: la propiedad %s se gestiona desde la sección whitelist", k)
			}
		}
	}
	for _, r := range rules {
		for _, it := range r.items {
			if !r.re.MatchString(it) {
				return fmt.Errorf("spec: entrada inválida en %s: %q", r.name, it)
			}
		}
	}
	return nil
}

func (s Spec) validateModpack() error {
	mp := s.Modpack
	if mp == nil {
		if ModpackPlatforms[s.Type] {
			return fmt.Errorf("spec: type %s requiere un modpack", s.Type)
		}
		return nil
	}
	if !ModpackPlatforms[mp.Platform] {
		return fmt.Errorf("spec: modpack.platform inválida %q (MODRINTH|AUTO_CURSEFORGE|FTBA)", mp.Platform)
	}
	if s.Type != mp.Platform {
		return fmt.Errorf("spec: un modpack de %s requiere type=%s (type actual %q)", mp.Platform, mp.Platform, s.Type)
	}
	if !listEntryRe.MatchString(mp.SlugOrURL) {
		return fmt.Errorf("spec: modpack.slugOrUrl es obligatorio, sin espacios ni comas")
	}
	if mp.VersionID != "" && !listEntryRe.MatchString(mp.VersionID) {
		return fmt.Errorf("spec: modpack.versionId inválido %q", mp.VersionID)
	}
	if mp.Platform != PlatformModrinth && mp.Loader != "" {
		return fmt.Errorf("spec: modpack.loader solo se elige en modpacks de Modrinth")
	}
	switch mp.Platform {
	case PlatformModrinth:
		if !ModrinthLoaders[mp.Loader] {
			return fmt.Errorf("spec: modpack.loader inválido %q (fabric|forge|quilt|neoforge)", mp.Loader)
		}
	case PlatformAutoCurseForge:
		if mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID) {
			return fmt.Errorf("spec: en CurseForge modpack.versionId es el id numérico del fichero")
		}
	case PlatformFTBA:
		if !digitsRe.MatchString(mp.SlugOrURL) || (mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID)) {
			return fmt.Errorf("spec: los modpacks de FTB se indican con su id numérico (y versión numérica)")
		}
	}
	return nil
}

// contentEnv añade a m las variables itzg de modpack, mods, plugins, whitelist y ops.
// Una sección ausente no emite nada: las specs anteriores a este plan conservan su hash.
func (s Spec) contentEnv(m map[string]string) {
	if mp := s.Modpack; mp != nil {
		switch mp.Platform {
		case PlatformModrinth:
			m["MODRINTH_MODPACK"] = mp.SlugOrURL
			setIf(m, "MODRINTH_VERSION", mp.VersionID)
			setIf(m, "MODRINTH_LOADER", mp.Loader)
		case PlatformAutoCurseForge:
			if strings.HasPrefix(mp.SlugOrURL, "http://") || strings.HasPrefix(mp.SlugOrURL, "https://") {
				m["CF_PAGE_URL"] = mp.SlugOrURL
			} else {
				m["CF_SLUG"] = mp.SlugOrURL
			}
			setIf(m, "CF_FILE_ID", mp.VersionID)
		case PlatformFTBA:
			m["FTB_MODPACK_ID"] = mp.SlugOrURL
			setIf(m, "FTB_MODPACK_VERSION_ID", mp.VersionID)
		}
	}
	if s.Mods != nil || s.Plugins != nil {
		var mods, plugins []string
		if s.Mods != nil {
			mods = s.Mods.ModrinthProjects
		}
		if s.Plugins != nil {
			plugins = s.Plugins.ModrinthProjects
		}
		// Con la sección presente se emite aunque quede vacía: itzg borra entonces lo que
		// instaló desde Modrinth (quitar el último mod en la UI lo quita del servidor).
		m["MODRINTH_PROJECTS"] = joinList(mods, plugins)
	}
	if s.Mods != nil {
		setIf(m, "CURSEFORGE_FILES", joinList(s.Mods.CurseforgeFiles))
		setIf(m, "MODS", joinList(s.Mods.URLs))
	}
	if s.Plugins != nil {
		setIf(m, "SPIGET_RESOURCES", joinList(s.Plugins.SpigetResources))
		setIf(m, "PLUGINS", joinList(s.Plugins.URLs))
	}
	if w := s.Whitelist; w != nil {
		if w.Enabled {
			m["ENABLE_WHITELIST"] = "true"
			if list := joinList(w.Players); list != "" {
				m["WHITELIST"] = list
				// El panel es la fuente de verdad: quitar a alguien de la lista lo quita del fichero.
				m["EXISTING_WHITELIST_FILE"] = "SYNCHRONIZE"
			}
		} else {
			// Explícito: sin esto, una whitelist activada antes seguiría activa en server.properties.
			m["ENABLE_WHITELIST"] = "false"
		}
	}
	if list := joinList(s.Ops); list != "" {
		m["OPS"] = list
		m["EXISTING_OPS_FILE"] = "SYNCHRONIZE"
	}
	if s.CurseForgeAPIKey != "" && s.UsesCurseForge() {
		m["CF_API_KEY"] = s.CurseForgeAPIKey
	}
}

func setIf(m map[string]string, k, v string) {
	if v != "" {
		m[k] = v
	}
}

// joinList une las listas sin duplicados y ordenadas, separadas por comas: reordenar en la
// UI no cambia el env (ni el hash, ni recrea el contenedor).
func joinList(lists ...[]string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, it := range l {
			if !seen[it] {
				seen[it] = true
				out = append(out, it)
			}
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}
```

- [ ] **Step 5: Conectar con `spec.go`**

En `agent/internal/spec/spec.go`:

1. (fuera de ancla) Añade `CF_API_KEY` a `ReservedEnv` (la key se configura en Ajustes, no en el env libre):
```go
var ReservedEnv = map[string]bool{
	"EULA": true, "TYPE": true, "VERSION": true, "MEMORY": true, "ENABLE_RCON": true,
	"RCON_PASSWORD": true, "RCON_PORT": true, "SERVER_PORT": true, "CUSTOM_SERVER_PROPERTIES": true,
	"CF_API_KEY": true,
}
```

2. Al final del struct `Spec`, debajo de la ancla `// ── plan-3 ──`:
```go
	// ── plan-3 ──
	// Secciones de contenido: nil = ausente (no se emite nada y el hash no cambia).
	Modpack   *Modpack       `json:"modpack,omitempty"`
	Mods      *ModSources    `json:"mods,omitempty"`
	Plugins   *PluginSources `json:"plugins,omitempty"`
	Whitelist *Whitelist     `json:"whitelist,omitempty"`
	Ops       []string       `json:"ops,omitempty"`
	// CurseForgeAPIKey la añade el panel al enviar la spec al agente (Ajustes → API key de
	// CurseForge). Nunca se guarda en la spec del panel ni viaja al navegador.
	CurseForgeAPIKey string `json:"curseforgeApiKey,omitempty"`
```

3. En `Validate()`, justo antes del `return nil` final (debajo de la ancla `plan-3` si la preparación la dejó ahí):
```go
	// ── plan-3 ──
	if err := s.validateContent(); err != nil {
		return err
	}
	return nil
```

4. En `envList()`, entre el bloque que rellena `CUSTOM_SERVER_PROPERTIES` y el bucle `for k, v := range s.Env` (el env libre debe seguir ganando):
```go
	// ── plan-3 ──
	s.contentEnv(m)
	for k, v := range s.Env {
```

- [ ] **Step 6: Ejecutar (debe pasar)**

```bash
eval "$(mise env)" && cd agent && gofmt -l ./internal/spec && go vet ./internal/spec/ && go test ./internal/spec/ -v -run 'Content|EnvLibre|EmptyMods|ParseIgnores' && go test -race ./...
```
Expected: `gofmt -l` sin salida; PASS en `TestContentCasesSharedWithZod` (34 subtests), `TestContentEnvModrinthModpack`, `TestContentEnvCurseForgeAndFTB`, `TestContentEnvModsPluginsAndWhitelistOff`, `TestEnvLibreGanaSobreLoGenerado`, `TestContentHash`, `TestEmptyModsSectionClearsModrinthProjects`, `TestParseIgnoresUnknownFields`; el resto de paquetes `ok` (los tests del Plan 1 no cambian). Si `TestContentHash` falla con otro hash dorado, **no lo actualices**: algo de lo añadido está cambiando el contenedor de specs sin secciones nuevas (revisa que `contentEnv` no emita nada con todo `nil`).

- [ ] **Step 7: Commit**

```bash
git add proto/fixtures/spec-modded.json proto/fixtures/spec-content-cases.json agent/internal/spec/
git commit -m "feat(agent): modpack, mods, plugins, whitelist y ops en la spec con sus variables itzg

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared — esquema zod de las secciones de contenido (espejo del agente)

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/spec-content.ts`, `panel/packages/shared/src/spec-content.test.ts`, `panel/packages/shared/src/zod-locale.ts`
- Modify: `panel/packages/shared/src/spec.ts` (campos bajo la ancla `plan-3` de `baseFields`; imports, `RESERVED_ENV`, mensaje de env y `specChecks` fuera de ancla), `panel/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: fixtures de la Task 1 (`proto/fixtures/spec-modded.json`, `proto/fixtures/spec-content-cases.json`); `baseFields`, `memLimitCheck`, `specSchema`, `specInputSchema` de `spec.ts` (Plan 1).
- Produces (`@mcsm/shared`): `MODPACK_PLATFORMS` (`readonly ["MODRINTH","AUTO_CURSEFORGE","FTBA"]`), `type ModpackPlatform`, `MODRINTH_LOADERS` (`["", "fabric","forge","quilt","neoforge"]`), `PLAYER_RE`, `modpackSchema`, `modsSchema`, `pluginsSchema`, `whitelistSchema`, `contentFields`, `contentCheck(s, ctx)`, `usesCurseForge(spec): boolean`. `Spec`/`SpecInput` ganan `modpack?`, `mods?`, `plugins?`, `whitelist?`, `ops?`. `RESERVED_ENV` incluye `CF_API_KEY`. Efecto global: mensajes de zod en castellano (`zod-locale.ts`).

- [ ] **Step 1: Test (falla)**

`panel/packages/shared/src/spec-content.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema } from "./spec.js";
import { usesCurseForge } from "./spec-content.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const modded = fixture("spec-modded.json");
const cases = fixture("spec-content-cases.json") as { name: string; ok: boolean; merge: Record<string, unknown> }[];

describe("casos compartidos con el agente Go (proto/fixtures/spec-content-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, ...c.merge });
    expect(r.success, r.success ? "" : r.error.issues[0]?.message).toBe(c.ok);
  });
});

describe("spec con contenido", () => {
  it("acepta spec-modded.json sin cambios", () => {
    expect(specSchema.parse(modded)).toEqual(modded);
  });
  it("la spec del Plan 1 sigue sin campos nuevos tras parsear (no cambia lo que se guarda)", () => {
    const parsed = specSchema.parse(base);
    for (const k of ["modpack", "mods", "plugins", "whitelist", "ops"]) expect(parsed).not.toHaveProperty(k);
  });
  it("rellena defaults dentro de las secciones presentes", () => {
    const parsed = specInputSchema.parse({ mods: {}, whitelist: { players: ["Lobo"] } });
    expect(parsed.mods).toEqual({ modrinthProjects: [], curseforgeFiles: [], urls: [] });
    expect(parsed.whitelist).toEqual({ enabled: false, players: ["Lobo"] });
  });
  it("descarta curseforgeApiKey si llega desde fuera (nunca se persiste)", () => {
    const parsed = specSchema.parse({ ...base, curseforgeApiKey: "secreto" });
    expect(parsed).not.toHaveProperty("curseforgeApiKey");
  });
  it("mensajes en castellano con la ruta del campo", () => {
    const r = specInputSchema.safeParse({ type: "MODRINTH" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["modpack"]);
      expect(r.error.issues[0]?.message).toMatch(/requiere indicar el modpack/);
    }
  });
  it("usesCurseForge", () => {
    expect(usesCurseForge(base)).toBe(false);
    expect(usesCurseForge({ mods: { curseforgeFiles: ["jei"] } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "AUTO_CURSEFORGE" } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "MODRINTH" } })).toBe(false);
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/shared test
```
Expected: FAIL (`Cannot find module './spec-content.js'`).

- [ ] **Step 3: Implementación**

`panel/packages/shared/src/zod-locale.ts`:
```ts
import { z } from "zod";

// Mensajes por defecto de zod en castellano para el panel y la web (comparten esta instancia de zod).
z.config(z.locales.es());
```

`panel/packages/shared/src/spec-content.ts`:
```ts
import { z } from "zod";

/**
 * Secciones de contenido de la spec (§4.1): modpack, mods, plugins, whitelist y ops.
 * Espejo exacto de agent/internal/spec/content.go; los casos de
 * proto/fixtures/spec-content-cases.json se prueban en los dos lados.
 */

export const MODPACK_PLATFORMS = ["MODRINTH", "AUTO_CURSEFORGE", "FTBA"] as const;
export type ModpackPlatform = (typeof MODPACK_PLATFORMS)[number];
export const MODRINTH_LOADERS = ["", "fabric", "forge", "quilt", "neoforge"] as const;

// ASCII imprimible sin espacios ni comas. No usar \s: en JS incluye espacios Unicode y en Go no.
const ENTRY_RE = /^[!-+\--~]{1,300}$/;
const URL_RE = /^https?:\/\/[!-+\--~]{1,1000}$/;
const DIGITS_RE = /^[0-9]{1,12}$/;
export const PLAYER_RE = /^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$/;

const entry = z.string().regex(ENTRY_RE, "Entrada inválida: sin espacios ni comas (máx. 300 caracteres)");
const url = z.string().regex(URL_RE, "URL inválida: debe empezar por http:// o https:// y no tener espacios ni comas");
const spigetId = z.string().regex(DIGITS_RE, "Los recursos de Spiget son ids numéricos");
const player = z.string().regex(PLAYER_RE, "Jugador inválido: nombre de Java (1-16 letras, números o _) o UUID");

export const modpackSchema = z
  .object({
    platform: z.enum(MODPACK_PLATFORMS, "Plataforma de modpack inválida (MODRINTH, AUTO_CURSEFORGE o FTBA)"),
    slugOrUrl: z.string().regex(ENTRY_RE, "Indica el modpack (slug, id o URL) sin espacios ni comas"),
    versionId: z.union([z.literal(""), entry]).default(""),
    loader: z.enum(MODRINTH_LOADERS, "Loader inválido (fabric, forge, quilt o neoforge)").default(""),
  })
  .superRefine((mp, ctx) => {
    if (mp.platform !== "MODRINTH" && mp.loader !== "") {
      ctx.addIssue({ code: "custom", path: ["loader"], message: "El loader solo se elige en modpacks de Modrinth" });
    }
    if (mp.platform === "AUTO_CURSEFORGE" && mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)) {
      ctx.addIssue({ code: "custom", path: ["versionId"], message: "En CurseForge la versión es el id numérico del fichero" });
    }
    if (mp.platform === "FTBA" && (!DIGITS_RE.test(mp.slugOrUrl) || (mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)))) {
      ctx.addIssue({ code: "custom", path: ["slugOrUrl"], message: "Los modpacks de FTB se indican con su id numérico (y versión numérica)" });
    }
  });

export const modsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  curseforgeFiles: z.array(entry).default([]),
  urls: z.array(url).default([]),
});

export const pluginsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  spigetResources: z.array(spigetId).default([]),
  urls: z.array(url).default([]),
});

export const whitelistSchema = z.object({
  enabled: z.boolean().default(false),
  players: z.array(player).default([]),
});

/** Campos que se añaden a la spec (todos opcionales: sin ellos la spec es la del Plan 1). */
export const contentFields = {
  modpack: modpackSchema.optional(),
  mods: modsSchema.optional(),
  plugins: pluginsSchema.optional(),
  whitelist: whitelistSchema.optional(),
  ops: z.array(player).optional(),
};

const WHITELIST_PROPS = ["white-list", "enforce-whitelist"];

type ContentShape = {
  type: string;
  properties: Record<string, string>;
  modpack?: { platform: ModpackPlatform } | undefined;
  whitelist?: unknown;
};

/** Validación cruzada (tipo ↔ modpack, whitelist ↔ properties). */
export function contentCheck(s: ContentShape, ctx: z.RefinementCtx) {
  const typeIsPlatform = (MODPACK_PLATFORMS as readonly string[]).includes(s.type);
  if (s.modpack && s.type !== s.modpack.platform) {
    ctx.addIssue({ code: "custom", path: ["type"], message: `Un modpack de ${s.modpack.platform} requiere el tipo ${s.modpack.platform}` });
  }
  if (!s.modpack && typeIsPlatform) {
    ctx.addIssue({ code: "custom", path: ["modpack"], message: `El tipo ${s.type} requiere indicar el modpack` });
  }
  if (s.whitelist) {
    for (const k of WHITELIST_PROPS) {
      if (k in s.properties) {
        ctx.addIssue({ code: "custom", path: ["properties", k], message: `La propiedad ${k} se gestiona desde la sección Jugadores (whitelist)` });
      }
    }
  }
}

/** ¿La spec descarga algo de CurseForge? Solo entonces el panel le envía CF_API_KEY. */
export function usesCurseForge(s: { modpack?: { platform: string } | undefined; mods?: { curseforgeFiles: string[] } | undefined }): boolean {
  return s.modpack?.platform === "AUTO_CURSEFORGE" || (s.mods?.curseforgeFiles.length ?? 0) > 0;
}
```

En `panel/packages/shared/src/spec.ts`:

1. (fuera de ancla) Imports al principio:
```ts
import { z } from "zod";
import "./zod-locale.js";
import { contentCheck, contentFields } from "./spec-content.js";
```

2. (fuera de ancla) `CF_API_KEY` en `RESERVED_ENV` y en el mensaje de `envSchema`:
```ts
export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
  "CF_API_KEY",
]);
```
```ts
    message: "Contiene una variable reservada (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES, CF_API_KEY)",
```

3. Al final de `baseFields`, debajo de la ancla:
```ts
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  // ── plan-3 ──
  ...contentFields,
};
```

4. (fuera de ancla) Debajo de `memLimitCheck`, añade `specChecks` y sustituye **las dos** apariciones de `.superRefine(memLimitCheck)` (en `specSchema` y `specInputSchema`) por `.superRefine(specChecks)`:
```ts
/** Validaciones de objeto completo: memoria y, debajo de las anclas, las de cada plan. */
function specChecks(s: Parameters<typeof memLimitCheck>[0] & Parameters<typeof contentCheck>[0], ctx: z.RefinementCtx) {
  memLimitCheck(s, ctx);
  // ── plan-3 ──
  contentCheck(s, ctx);
}
```

En `panel/packages/shared/src/index.ts` añade:
```ts
export * from "./spec-content.js";
```

- [ ] **Step 4: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/shared test && pnpm typecheck && pnpm --filter @mcsm/api test
```
Expected: `@mcsm/shared` PASS (los 34 casos compartidos con el mismo resultado que en Go, más los tests del Plan 1 sin cambios); `typecheck` limpio en todos los paquetes (la web compila: los campos nuevos son opcionales); la API sigue en verde.

- [ ] **Step 5: Commit**

```bash
git add panel/packages/shared/src/
git commit -m "feat(shared): secciones modpack, mods, plugins, whitelist y ops validadas igual que en el agente

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Panel — PATCH de spec como merge de primer nivel

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/spec-patch.ts`, `panel/packages/shared/src/spec-patch.test.ts`, `panel/apps/api/src/servers/patch.test.ts`
- Modify: `panel/packages/shared/src/spec.ts` (`serverPatchSchema`, fuera de ancla), `panel/packages/shared/src/index.ts`, `panel/apps/api/src/servers/service.ts` (`patch`, mensajes de `completeSpec`)

**Interfaces:**
- Consumes: `specInputSchema`, `specSchema`, `serverPatchSchema` (Task 2); `ServersService.completeSpec(nodeId, input, previous)`, `ServersRepo.updateSpec/rename` (Plan 1).
- Produces (`@mcsm/shared`): `specPatchSchema` (`z.record(z.string(), z.unknown())`), `type SpecPatch`, `mergeSpecPatch(previous, patch): Record<string, unknown>`, `canonicalJson(v): string`, `formatZodError(err): string` (`"ruta: mensaje"`). `serverPatchSchema.spec` pasa a ser `SpecPatch`.
- Produces (API): `ServersService.patch(id, { name?, spec?: SpecPatch })` con semántica de merge; si la spec resultante es idéntica no incrementa `spec_version` ni empuja nada. Los 400 de spec dicen la ruta del campo (`mods.modrinthProjects.0: …`). **El Plan 4 (pestaña Backups) depende de esto para enviar solo `{ spec: { backups } }`.**

- [ ] **Step 1: Tests (fallan)**

`panel/packages/shared/src/spec-patch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, formatZodError, mergeSpecPatch } from "./spec-patch.js";

describe("mergeSpecPatch", () => {
  const prev = { type: "PAPER", memory: "4G", mods: { modrinthProjects: ["a"] }, whitelist: { enabled: true, players: [] } };
  it("sustituye las claves presentes, conserva las ausentes y borra las null", () => {
    expect(mergeSpecPatch(prev, { memory: "6G", whitelist: null })).toEqual({ type: "PAPER", memory: "6G", mods: { modrinthProjects: ["a"] } });
  });
  it("no mezcla objetos anidados: la sección se sustituye entera", () => {
    expect(mergeSpecPatch(prev, { mods: { urls: ["https://x/a.jar"] } }).mods).toEqual({ urls: ["https://x/a.jar"] });
  });
  it("ignora __proto__ y constructor", () => {
    const patch = JSON.parse('{"__proto__":{"type":"FORGE"},"constructor":1}') as Record<string, unknown>;
    const out = mergeSpecPatch(prev, patch);
    expect(out.type).toBe("PAPER");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
  it("no modifica el objeto anterior", () => {
    mergeSpecPatch(prev, { memory: "1G" });
    expect(prev.memory).toBe("4G");
  });
});

describe("canonicalJson", () => {
  it("no depende del orden de las claves pero sí del de los arrays", () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }));
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
  });
});

describe("formatZodError", () => {
  it("antepone la ruta", () => {
    const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toMatch(/^a\.b: /);
  });
});
```

`panel/apps/api/src/servers/patch.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const create = async (spec: object = {}) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno", spec: { type: "PAPER", memory: "4G", properties: { motd: "Hola" }, ...spec } } })).json();
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: payload as object });

describe("PATCH de spec como merge de primer nivel", () => {
  it("una sección sola no pisa el resto de la spec", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { whitelist: { enabled: true, players: ["Lobo"] } } });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.specVersion).toBe(2);
    expect(after.spec).toMatchObject({ type: "PAPER", memory: "4G", properties: { motd: "Hola" }, whitelist: { enabled: true, players: ["Lobo"] } });
    expect(after.spec.ports.game).toBe(s.spec.ports.game);
    expect(after.spec.rconPassword).toBe(s.spec.rconPassword);
  });

  it("null borra una sección; el tipo de modpack exige modpack", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await patch(s.id, { spec: { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "" });
    res = await patch(s.id, { spec: { type: "PAPER", modpack: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).not.toHaveProperty("modpack");
    expect(res.json().specVersion).toBe(3);
  });

  it("reenviar la misma spec no incrementa la versión; con nombre nuevo solo renombra", async () => {
    const s = await create();
    const { rconPassword: _r, ...same } = s.spec;
    let res = await patch(s.id, { spec: same });
    expect(res.json().specVersion).toBe(1);
    res = await patch(s.id, { name: "Otro nombre", spec: same });
    expect(res.json()).toMatchObject({ name: "Otro nombre", specVersion: 1 });
  });

  it("no se puede cambiar rconPassword por PATCH", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { rconPassword: "hackhackhack" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.rconPassword).toBe(s.spec.rconPassword);
    expect(res.json().specVersion).toBe(1);
  });

  it("ports sin game conserva el puerto de juego", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { ports: { extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.ports).toEqual({ game: s.spec.ports.game, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] });
  });

  it("errores con la ruta del campo y cuerpos inválidos", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { mods: { modrinthProjects: ["con espacio"] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^mods\.modrinthProjects\.0: /);
    res = await patch(s.id, { spec: "x" });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie, "content-type": "application/json" }, payload: '{"spec":{"__proto__":{"type":"FORGE"}}}' });
    expect(res.statusCode).toBe(400);
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });
});
```

- [ ] **Step 2: Ejecutar (deben fallar)**

```bash
pnpm --filter @mcsm/shared test; pnpm --filter @mcsm/api exec vitest run src/servers/patch.test.ts
```
Expected: FAIL (`Cannot find module './spec-patch.js'`; en la API, "una sección sola no pisa el resto" falla porque hoy el PATCH sustituye la spec entera y `memory` vuelve a `2G`).

- [ ] **Step 3: Implementación**

`panel/packages/shared/src/spec-patch.ts`:
```ts
import { z } from "zod";

/**
 * PATCH de spec: merge de primer nivel (RFC 7386 solo en la raíz).
 * - clave presente → sustituye el valor anterior entero (no se mezclan objetos anidados);
 * - clave con `null` → se borra (vuelve a su valor por defecto o a "sin sección");
 * - clave ausente → se conserva lo que había.
 * Así cada pantalla (formulario de configuración, pestaña Backups del Plan 4…) envía solo
 * las secciones que edita sin pisar las demás.
 */
export const specPatchSchema = z.record(z.string(), z.unknown());
export type SpecPatch = z.infer<typeof specPatchSchema>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mergeSpecPatch(previous: Record<string, unknown>, patch: SpecPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** JSON con las claves ordenadas: compara specs sin depender del orden de inserción. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

/** Primer error de zod con la ruta del campo delante ("modpack.slugOrUrl: …"). */
export function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Spec inválida";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
```

En `panel/packages/shared/src/spec.ts` (fuera de ancla): importa `import { specPatchSchema } from "./spec-patch.js";` junto a los demás imports y cambia `serverPatchSchema` por:
```ts
export const serverPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  /** Merge de primer nivel sobre la spec guardada (ver mergeSpecPatch). */
  spec: specPatchSchema.optional(),
});
```

En `panel/packages/shared/src/index.ts` añade `export * from "./spec-patch.js";`.

En `panel/apps/api/src/servers/service.ts`:

1. Sustituye el import de `@mcsm/shared` por:
```ts
import {
  canonicalJson, formatZodError, mergeSpecPatch, specInputSchema, specSchema, slugify,
  type ServerCreateInput, type Spec, type SpecInput, type SpecPatch, type PowerActionName,
} from "@mcsm/shared";
```

2. En `completeSpec`, el error de validación usa la ruta del campo:
```ts
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
```

3. Sustituye el método `patch` entero por:
```ts
  /** `input.spec` es un merge de primer nivel sobre la spec guardada (ver mergeSpecPatch). */
  async patch(id: string, input: { name?: string; spec?: SpecPatch }) {
    const row = this.requireServer(id);
    let updated = row;
    let spec: Spec | null = null;
    if (input.spec) {
      const previous = JSON.parse(row.spec) as Spec;
      const { rconPassword: _secret, ...previousInput } = previous;
      const merged = specInputSchema.safeParse(mergeSpecPatch(previousInput, input.spec));
      if (!merged.success) throw new HttpError(400, formatZodError(merged.error));
      const candidate = this.completeSpec(row.node_id, merged.data, previous);
      // Sin cambios reales no se versiona: el agente no tendría nada que aplicar.
      if (canonicalJson(candidate) !== canonicalJson(previous)) spec = candidate;
    }
    if (spec) {
      this.checkPorts(row.node_id, spec, row.id);
      updated = this.app.servers.updateSpec(id, spec, input.name);
      void this.push(updated);
    } else if (input.name && input.name !== row.name) {
      updated = this.app.servers.rename(id, input.name); // sin cambio de spec: no se versiona
    }
    return toServerDto(updated, { includeSecrets: true });
  }
```
(`rconPassword` nunca entra en el merge: `completeSpec` conserva siempre el anterior; `ports` sin `game` conserva el puerto de juego.)

- [ ] **Step 4: Ejecutar (deben pasar)**

```bash
pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS. Los tests del Plan 1 en `servers.test.ts` siguen en verde (el PATCH `{ name, spec: { memory: "3G" } }` produce la versión 2 con memoria 3G). El formulario de la web del Plan 1, que aún envía la spec completa, sigue funcionando (un merge con todas las claves equivale a sustituir).

- [ ] **Step 5: Commit**

```bash
git add panel/packages/shared/src/ panel/apps/api/src/servers/
git commit -m "feat(api): PATCH de spec como merge de primer nivel sin versionar cambios vacíos

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Panel — API key global de CurseForge

**Agent:** panel-api-dev (revisión también con `security-auditor`: maneja un secreto)

**Files:**
- Create: `panel/apps/api/src/curseforge/repo.ts`, `panel/apps/api/src/curseforge/routes.ts`, `panel/apps/api/src/curseforge/curseforge.test.ts`
- Modify: `panel/apps/api/src/servers/repo.ts` (`toServerSpecMessage`, `bumpVersion`), `panel/apps/api/src/servers/service.ts` (`push`, `reapplyCurseForge`), `panel/apps/api/src/agents/service.ts` (una línea del handshake, fuera de ancla), `panel/apps/api/src/app.ts` (bajo ancla), `panel/apps/api/src/db/migrations.ts` (bajo ancla)

**Interfaces:**
- Consumes: `usesCurseForge`, `formatZodError` (`@mcsm/shared`, Tasks 2–3); `ServersService`, `ServersRepo`, `AgentService.handshake` (Plan 1); tabla `settings(key, value)`.
- Produces: `CurseForgeKeyRepo` decorado como `app.curseforge` con `get(): string | null` y `set(apiKey: string): boolean` (true si cambió; `""` borra); constante `CURSEFORGE_KEY_SETTING = "curseforge_api_key"`; `GET /api/settings/curseforge` y `PUT /api/settings/curseforge {apiKey}` → `{ configured: boolean }` (nunca la key); `toServerSpecMessage(row, { curseforgeApiKey?: string | null })`; `ServersRepo.bumpVersion(id): ServerRow`; `ServersService.reapplyCurseForge(): number`; migración `020_cf_api_key_env_to_settings`. **El Plan 9 (página Ajustes) reutiliza estos endpoints; cualquier llamada nueva a `toServerSpecMessage` (Planes 6–7) debe pasar `{ curseforgeApiKey: app.curseforge.get() }`.**

- [ ] **Step 1: Test (falla)**

`panel/apps/api/src/curseforge/curseforge.test.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { migrate, openDb } from "../db/db.js";
import { migrations } from "../db/migrations.js";
import { FakeAgent } from "../../test/fake-agent.js";

const KEY = "$2a$10$abcdefghijklmnopqrstuv";

let app: FastifyInstance; let url: string; let cookie: string; let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const putKey = (apiKey: string) => app.inject({ method: "PUT", url: "/api/settings/curseforge", headers: { cookie }, payload: { apiKey } });
const createServer = async (name: string, spec: object) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name, spec } })).json();
const cfSpec = { type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10" } };
const specOf = (env: Envelope) => {
  if (env.body.case !== "applySpec") throw new Error(`esperaba applySpec, llegó ${env.body.case}`);
  return { version: env.body.value.server!.version, serverId: env.body.value.server!.serverId, spec: JSON.parse(new TextDecoder().decode(env.body.value.server!.specJson)) };
};

describe("API key de CurseForge", () => {
  it("GET/PUT nunca devuelven la key; valida el formato", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } })).json()).toEqual({ configured: false });
    let res = await putKey(KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true });
    res = await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true });
    expect(res.body).not.toContain(KEY);
    expect((await putKey("con espacio")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge" })).statusCode).toBe(401);
    expect((await putKey("")).json()).toEqual({ configured: false });
  });

  it("solo viaja al agente en specs que usan CurseForge y nunca al navegador", async () => {
    await putKey(KEY);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const cfP = createServer("Pack", cfSpec);
    const a1 = await agent.waitFor("applySpec");
    agent.ack(a1.id);
    const cf = await cfP;
    expect(specOf(a1).spec.curseforgeApiKey).toBe(KEY);

    const paperP = createServer("Paper", { type: "PAPER" });
    const a2 = await agent.waitFor("applySpec");
    agent.ack(a2.id);
    await paperP;
    expect(specOf(a2).spec).not.toHaveProperty("curseforgeApiKey");

    for (const u of ["/api/servers", `/api/servers/${cf.id}`]) {
      const body = (await app.inject({ method: "GET", url: u, headers: { cookie } })).body;
      expect(body).not.toContain(KEY);
      expect(body).not.toContain("curseforgeApiKey");
    }
    expect(app.servers.get(cf.id)!.spec).not.toContain(KEY);
    agent.close();
  });

  it("cambiar la key reaplica solo los servidores de CurseForge; la misma key no hace nada", async () => {
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER", mods: { curseforgeFiles: [] } });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [cf.id]: 1n, [paper.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const put = putKey(KEY);
    const apply = specOf(await agent.waitFor("applySpec"));
    expect(apply).toMatchObject({ serverId: cf.id, version: 2n });
    expect(apply.spec.curseforgeApiKey).toBe(KEY);
    expect((await put).statusCode).toBe(200);
    expect(app.servers.get(paper.id)!.spec_version).toBe(1);

    await putKey(KEY);
    expect(app.servers.get(cf.id)!.spec_version).toBe(2);

    const clear = putKey("");
    const cleared = specOf(await agent.waitFor("applySpec"));
    expect(cleared.version).toBe(3n);
    expect(cleared.spec).not.toHaveProperty("curseforgeApiKey");
    await clear;
    agent.close();
  });

  it("el SyncSpecs tras Hello incluye la key en los servidores de CurseForge", async () => {
    await putKey(KEY);
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    const sync = await agent.waitFor("syncSpecs");
    if (sync.body.case !== "syncSpecs") throw new Error();
    const byId = Object.fromEntries(sync.body.value.servers.map((s) => [s.serverId, JSON.parse(new TextDecoder().decode(s.specJson))]));
    expect(byId[cf.id].curseforgeApiKey).toBe(KEY);
    expect(byId[paper.id]).not.toHaveProperty("curseforgeApiKey");
    agent.ack(sync.id);
    agent.close();
  });
});

describe("migración 020_cf_api_key_env_to_settings", () => {
  it("mueve CF_API_KEY del env libre a Ajustes y versiona la spec", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const idx = migrations.findIndex((m) => m.name === "020_cf_api_key_env_to_settings");
    expect(idx).toBeGreaterThan(0);
    for (const m of migrations.slice(0, idx)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, "t");
    }
    db.prepare("INSERT INTO nodes (id, name, token_hash, created_at) VALUES ('n', 'nas', 'h', 't')").run();
    const withKey = JSON.stringify({ type: "PAPER", env: { CF_API_KEY: KEY, USE_AIKAR_FLAGS: "true" } });
    const without = JSON.stringify({ type: "PAPER", env: { USE_AIKAR_FLAGS: "true" } });
    const ins = db.prepare("INSERT INTO servers (id, node_id, name, slug, spec, spec_version, created_at, updated_at) VALUES (?, 'n', ?, ?, ?, 4, ?, 't')");
    ins.run("a", "A", "a", withKey, "2026-01-01");
    ins.run("b", "B", "b", without, "2026-01-02");
    migrate(db);
    const rows = db.prepare("SELECT id, spec, spec_version FROM servers ORDER BY id").all() as { id: string; spec: string; spec_version: number }[];
    expect(JSON.parse(rows[0]!.spec).env).toEqual({ USE_AIKAR_FLAGS: "true" });
    expect(rows[0]!.spec_version).toBe(5);
    expect(rows[1]!.spec_version).toBe(4);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'curseforge_api_key'").get()).toEqual({ value: KEY });
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/api exec vitest run src/curseforge/curseforge.test.ts
```
Expected: FAIL (`/api/settings/curseforge` responde 404; `migrations.findIndex(...)` es -1).

- [ ] **Step 3: Repositorio y rutas**

`panel/apps/api/src/curseforge/repo.ts`:
```ts
import type { Db } from "../db/db.js";

/** Clave de la tabla settings donde vive la API key global de CurseForge (spec §4 settings). */
export const CURSEFORGE_KEY_SETTING = "curseforge_api_key";

/**
 * API key global de CurseForge. Se guarda en claro (hay que enviarla a los agentes), nunca se
 * devuelve por la API y nunca se copia a servers.spec: se añade a la spec solo en el mensaje
 * hacia el agente (toServerSpecMessage) y solo si la spec usa CurseForge.
 */
export class CurseForgeKeyRepo {
  constructor(private db: Db) {}

  get(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CURSEFORGE_KEY_SETTING) as { value: string } | undefined;
    return row?.value || null;
  }

  /** Guarda la key ("" la borra). Devuelve true si el valor cambió. */
  set(apiKey: string): boolean {
    if ((this.get() ?? "") === apiKey) return false;
    if (apiKey === "") this.db.prepare("DELETE FROM settings WHERE key = ?").run(CURSEFORGE_KEY_SETTING);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CURSEFORGE_KEY_SETTING, apiKey);
    return true;
  }
}

declare module "fastify" {
  interface FastifyInstance { curseforge: CurseForgeKeyRepo }
}
```

`panel/apps/api/src/curseforge/routes.ts`:
```ts
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { formatZodError } from "@mcsm/shared";

const bodySchema = z.object({
  apiKey: z.string().trim().max(200, "La API key es demasiado larga").regex(/^\S*$/, "La API key no puede contener espacios"),
});

/** GET/PUT de la API key global de CurseForge. Nunca devuelve la key: solo si está configurada. */
export async function curseforgeRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Error interno" });
  });

  app.get("/api/settings/curseforge", async () => ({ configured: app.curseforge.get() !== null }));

  app.put("/api/settings/curseforge", async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: formatZodError(body.error) });
    if (app.curseforge.set(body.data.apiKey)) {
      // Los servidores que usan CurseForge deben recrearse con la key nueva (o sin ella).
      app.serversService.reapplyCurseForge();
    }
    return { configured: app.curseforge.get() !== null };
  });
}
```

- [ ] **Step 4: La key solo en el mensaje al agente**

En `panel/apps/api/src/servers/repo.ts`, cambia el import de `@mcsm/shared` a `import { usesCurseForge, type Spec } from "@mcsm/shared";`, sustituye `toServerSpecMessage` por:
```ts
/**
 * Mensaje ServerSpec para el agente. La API key global de CurseForge se añade aquí, solo a las
 * specs que usan CurseForge: no está en servers.spec ni en los DTO del navegador.
 */
export function toServerSpecMessage(r: ServerRow, opts: { curseforgeApiKey?: string | null } = {}): ServerSpec {
  let json = r.spec;
  if (opts.curseforgeApiKey) {
    const spec = JSON.parse(r.spec) as Spec;
    if (usesCurseForge(spec)) json = JSON.stringify({ ...spec, curseforgeApiKey: opts.curseforgeApiKey });
  }
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(json),
  });
}
```
y añade a `ServersRepo`, antes de `setDesiredState`:
```ts
  /** Nueva versión con la misma spec (p. ej. cambió la API key de CurseForge): el agente la reaplica. */
  bumpVersion(id: string): ServerRow {
    this.db.prepare("UPDATE servers SET spec_version = spec_version + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
    return this.get(id)!;
  }
```

En `panel/apps/api/src/servers/service.ts`: añade `usesCurseForge` al import de `@mcsm/shared`; en `push` envía la key:
```ts
      await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(row, { curseforgeApiKey: this.app.curseforge.get() }) } }, 120_000);
```
y añade antes de `create`:
```ts
  /** Reaplica (versión +1, misma spec) los servidores que usan CurseForge. Devuelve cuántos. */
  reapplyCurseForge(): number {
    let n = 0;
    for (const row of this.app.servers.list()) {
      if (!usesCurseForge(JSON.parse(row.spec) as Spec)) continue;
      void this.push(this.app.servers.bumpVersion(row.id));
      n++;
    }
    return n;
  }
```

En `panel/apps/api/src/agents/service.ts` (fuera de ancla), en `handshake`, sustituye la línea que construye `servers` por:
```ts
    const curseforgeApiKey = this.app.curseforge.get();
    const servers = rows
      .filter((r) => hello.specVersions[r.id] !== BigInt(r.spec_version))
      .map((r) => toServerSpecMessage(r, { curseforgeApiKey }));
```
(Con la firma nueva, `.map(toServerSpecMessage)` ya no compila: `map` pasaría el índice como segundo argumento.)

- [ ] **Step 5: Cableado y migración**

En `panel/apps/api/src/app.ts`, imports junto a los demás:
```ts
import { CurseForgeKeyRepo } from "./curseforge/repo.js";
import { curseforgeRoutes } from "./curseforge/routes.js";
```
y en `buildApp`, debajo de la ancla `// ── plan-3 ──` (después de `serverRoutes`):
```ts
  // ── plan-3 ──
  app.decorate("curseforge", new CurseForgeKeyRepo(opts.db));
  await app.register(curseforgeRoutes);
```

En `panel/apps/api/src/db/migrations.ts`, debajo de la ancla `// ── plan-3 ──` del array:
```ts
  {
    // CF_API_KEY pasa a ser reservada: la key que alguien hubiera puesto en el env libre de un
    // servidor se mueve a Ajustes (si no había ya una) y se quita de la spec (versión +1).
    name: "020_cf_api_key_env_to_settings",
    sql: `
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'curseforge_api_key', json_extract(spec, '$.env.CF_API_KEY') FROM servers
  WHERE json_type(spec, '$.env.CF_API_KEY') = 'text' AND json_extract(spec, '$.env.CF_API_KEY') <> ''
  ORDER BY created_at LIMIT 1;
UPDATE servers
  SET spec = json_remove(spec, '$.env.CF_API_KEY'),
      spec_version = spec_version + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE json_type(spec, '$.env.CF_API_KEY') IS NOT NULL;
`,
  },
```

- [ ] **Step 6: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS (`curseforge.test.ts` 5 tests y el resto de la API sin cambios).

- [ ] **Step 7: Commit**

```bash
git add panel/apps/api/src/
git commit -m "feat(api): API key global de CurseForge que solo viaja al agente en specs que la usan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Panel — plantillas (tabla, CRUD, guardar como, duplicar, crear servidor)

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/templates.ts`, `panel/packages/shared/src/templates.test.ts`, `panel/apps/api/src/templates/repo.ts`, `panel/apps/api/src/templates/routes.ts`, `panel/apps/api/src/templates/templates.test.ts`
- Modify: `panel/packages/shared/src/spec.ts` (`templateSpecSchema` al final del fichero, bloque `plan-3`), `panel/packages/shared/src/index.ts`, `panel/apps/api/src/app.ts` (bajo ancla), `panel/apps/api/src/db/migrations.ts` (bajo ancla)

**Interfaces:**
- Consumes: `baseFields`, `specChecks`, `serverCreateSchema` (`spec.ts`); `specPatchSchema`, `mergeSpecPatch`, `formatZodError` (Task 3); `ServersService.create`, `HttpError` (`servers/service.ts`); `app.servers`.
- Produces (`@mcsm/shared`): `templateSpecSchema`, `type TemplateSpec`, `templateCreateSchema` (`{name, description, spec? | fromServerId?}`), `templatePatchSchema`, `templateInstantiateSchema` (`{nodeId, name, slug?, port?, desiredState}`), `specToTemplate(spec)`, `copyName(name, n)`.
- Produces (API): tabla `templates` (migración `021_templates`), `app.templates: TemplatesRepo`, `TemplateDto {id, name, description, spec: TemplateSpec, sourceServerId, createdAt, updatedAt}` y las rutas: `GET /api/templates`, `GET /api/templates/:id`, `POST /api/templates` (201), `PATCH /api/templates/:id` (spec con merge), `POST /api/templates/:id/duplicate` (201), `DELETE /api/templates/:id` (204), `POST /api/templates/:id/servers` (201, devuelve el `ServerDto` con secretos como `POST /api/servers`).

- [ ] **Step 1: Tests (fallan)**

`panel/packages/shared/src/templates.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyName, specToTemplate, templateCreateSchema, templateInstantiateSchema } from "./templates.js";
import { specInputSchema, templateSpecSchema } from "./spec.js";

const modded = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-modded.json", import.meta.url), "utf8"));

describe("plantillas", () => {
  it("specToTemplate quita puertos, rconPassword y la key de CurseForge y conserva el resto", () => {
    const t = specToTemplate({ ...modded, curseforgeApiKey: "k" });
    expect(t).not.toHaveProperty("ports");
    expect(t).not.toHaveProperty("rconPassword");
    expect(t).not.toHaveProperty("curseforgeApiKey");
    const { ports: _p, rconPassword: _r, ...rest } = modded;
    expect(t).toEqual(rest);
  });
  it("una plantilla se instancia como SpecInput válida añadiendo solo puertos", () => {
    const t = specToTemplate(modded);
    expect(specInputSchema.parse({ ...t, ports: { extra: [] } }).ports.game).toBeUndefined();
  });
  it("la plantilla aplica las mismas validaciones que la spec", () => {
    expect(templateSpecSchema.safeParse({ type: "MODRINTH" }).success).toBe(false);
    expect(templateSpecSchema.safeParse({ env: { CF_API_KEY: "x" } }).success).toBe(false);
  });
  it("crear exige spec o servidor de origen, no ambos", () => {
    expect(templateCreateSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "A", spec: {}, fromServerId: "x" }).success).toBe(false);
    expect(templateCreateSchema.parse({ name: " A ", spec: {} })).toEqual({ name: "A", description: "", spec: {} });
  });
  it("instanciar valida puerto y slug", () => {
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", port: 70000 }).success).toBe(false);
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", slug: "Mal Slug" }).success).toBe(false);
    expect(templateInstantiateSchema.parse({ nodeId: "n", name: "X" }).desiredState).toBe("stopped");
  });
  it("copyName", () => {
    expect(copyName("Survival", 1)).toBe("Survival (copia)");
    expect(copyName("Survival", 3)).toBe("Survival (copia 3)");
    expect(copyName("x".repeat(60), 2)).toHaveLength(60);
  });
});
```

`panel/apps/api/src/templates/templates.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const fullSpec = {
  type: "FABRIC", version: "1.21.4", imageTag: "java21", memory: "3G",
  mods: { modrinthProjects: ["lithium", "fabric-api"] },
  properties: { motd: "Plantilla", difficulty: "hard" },
  whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"],
  env: { USE_AIKAR_FLAGS: "true" }, resources: { cpus: 2, memLimit: "4G" }, restartPolicy: "always",
  ports: { game: 25580, extra: [{ host: 24454, container: 24454, proto: "udp", label: "Voice" }] },
};

describe("plantillas", () => {
  it("guardar como plantilla quita puertos y rconPassword; instanciar reproduce el servidor salvo nombre, puertos y RCON", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Original", spec: fullSpec })).json();
    let res = await req("POST", "/api/templates", { name: "Fabric optimizado", description: "Con lithium", fromServerId: server.id });
    expect(res.statusCode).toBe(201);
    const tpl = res.json();
    expect(tpl).toMatchObject({ name: "Fabric optimizado", description: "Con lithium", sourceServerId: server.id });
    expect(tpl.spec).not.toHaveProperty("ports");
    expect(tpl.spec).not.toHaveProperty("rconPassword");
    expect(JSON.stringify(tpl)).not.toContain(server.spec.rconPassword);

    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "Copia" });
    expect(res.statusCode).toBe(201);
    const copy = res.json();
    expect(copy.name).toBe("Copia");
    expect(copy.slug).toBe("copia");
    expect(copy.spec.ports).toEqual({ game: 25565, extra: [] });
    expect(copy.spec.rconPassword).toHaveLength(43);
    expect(copy.spec.rconPassword).not.toBe(server.spec.rconPassword);
    const strip = (s: Record<string, unknown>) => { const { ports: _p, rconPassword: _r, ...rest } = s; return rest; };
    expect(strip(copy.spec)).toEqual(strip(server.spec));
  });

  it("instanciar con puerto explícito; puerto ocupado da 409", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Vanilla", spec: { type: "VANILLA" } })).json();
    let res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "A", port: 25590, desiredState: "running" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ desiredState: "running", spec: { ports: { game: 25590 } } });
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "B", port: 25590 });
    expect(res.statusCode).toBe(409);
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId: "no-existe", name: "C" });
    expect(res.statusCode).toBe(404);
  });

  it("crear desde spec descarta puertos y rconPassword y valida igual que un servidor", async () => {
    let res = await req("POST", "/api/templates", { name: "Con puertos", spec: { ...fullSpec, rconPassword: "secretosecreto" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec).not.toHaveProperty("ports");
    expect(res.json().spec).not.toHaveProperty("rconPassword");
    res = await req("POST", "/api/templates", { name: "Mala", spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await req("POST", "/api/templates", { name: "Nada" });
    expect(res.statusCode).toBe(400);
  });

  it("nombres únicos, PATCH con merge, duplicar y borrar", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Base", spec: { type: "PAPER", memory: "4G" } })).json();
    expect((await req("POST", "/api/templates", { name: "Base", spec: {} })).statusCode).toBe(409);

    let res = await req("PATCH", `/api/templates/${tpl.id}`, { description: "Nueva", spec: { ops: ["Lobo"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Base", description: "Nueva", spec: { type: "PAPER", memory: "4G", ops: ["Lobo"] } });
    res = await req("PATCH", `/api/templates/${tpl.id}`, { spec: { ops: null } });
    expect(res.json().spec).not.toHaveProperty("ops");

    const d1 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    const d2 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    expect([d1.name, d2.name]).toEqual(["Base (copia)", "Base (copia 2)"]);
    expect(d1.spec).toEqual(res.json().spec);
    expect((await req("PATCH", `/api/templates/${d1.id}`, { name: "Base" })).statusCode).toBe(409);

    expect((await req("GET", "/api/templates")).json().map((t: { name: string }) => t.name)).toEqual(["Base", "Base (copia 2)", "Base (copia)"]); // orden por nombre (NOCASE)
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(204);
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(404);
    expect((await req("GET", `/api/templates/${d2.id}`)).statusCode).toBe(404);
  });

  it("borrar el servidor de origen deja la plantilla con sourceServerId null", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Origen" })).json();
    const tpl = (await req("POST", "/api/templates", { name: "De origen", fromServerId: server.id })).json();
    expect((await req("DELETE", `/api/servers/${server.id}`)).statusCode).toBe(204);
    expect((await req("GET", `/api/templates/${tpl.id}`)).json().sourceServerId).toBeNull();
  });

  it("requiere sesión", async () => {
    expect((await app.inject({ method: "GET", url: "/api/templates" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Ejecutar (deben fallar)**

```bash
pnpm --filter @mcsm/shared test; pnpm --filter @mcsm/api exec vitest run src/templates/templates.test.ts
```
Expected: FAIL (`Cannot find module './templates.js'`; en la API, `/api/templates` responde 404).

- [ ] **Step 3: Esquemas compartidos**

Al final de `panel/packages/shared/src/spec.ts`:
```ts
// ── plan-3 ── plantillas
/**
 * Spec de plantilla (spec §4 templates): la de servidor sin `ports` ni `rconPassword`. Al
 * parsear, zod descarta esas claves (y cualquier otra desconocida), así que guardar una
 * spec de servidor como plantilla nunca arrastra puertos ni secretos.
 */
export const templateSpecSchema = z.object({ ...baseFields }).superRefine(specChecks);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;
```
(No uses `.omit()`: zod 4 lanza «.omit() cannot be used on object schemas containing refinements».)

`panel/packages/shared/src/templates.ts`:
```ts
import { z } from "zod";
import { templateSpecSchema, type TemplateSpec } from "./spec.js";
import { specPatchSchema } from "./spec-patch.js";

const templateName = z.string().trim().min(1, "El nombre es obligatorio").max(60, "Máximo 60 caracteres");
const templateDescription = z.string().trim().max(500, "Máximo 500 caracteres");

/** Crear plantilla: desde una spec (editor de plantillas) o desde un servidor ("Guardar como plantilla"). */
export const templateCreateSchema = z
  .object({
    name: templateName,
    description: templateDescription.default(""),
    spec: specPatchSchema.optional(),
    fromServerId: z.string().min(1).optional(),
  })
  .refine((t) => (t.spec === undefined) !== (t.fromServerId === undefined), { message: "Indica una spec o un servidor de origen (solo uno)" });
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;

/** PATCH de plantilla: `spec` con la misma semántica de merge que el PATCH de servidor. */
export const templatePatchSchema = z.object({
  name: templateName.optional(),
  description: templateDescription.optional(),
  spec: specPatchSchema.optional(),
});

/** Crear un servidor desde una plantilla: el panel rellena puerto (si no se da) y rconPassword. */
export const templateInstantiateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
});
export type TemplateInstantiateInput = z.infer<typeof templateInstantiateSchema>;

/** Quita puertos, rconPassword y cualquier clave ajena a la plantilla. Lanza ZodError si no valida. */
export function specToTemplate(spec: Record<string, unknown>): TemplateSpec {
  return templateSpecSchema.parse(spec);
}

/** "Nombre (copia)", "Nombre (copia 2)"… sin pasar de 60 caracteres. */
export function copyName(name: string, n: number): string {
  const suffix = n <= 1 ? " (copia)" : ` (copia ${n})`;
  return name.slice(0, 60 - suffix.length).trimEnd() + suffix;
}
```

En `panel/packages/shared/src/index.ts` añade `export * from "./templates.js";`.

- [ ] **Step 4: Repositorio, rutas y migración**

`panel/apps/api/src/templates/repo.ts`:
```ts
import type { TemplateSpec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface TemplateRow {
  id: string; name: string; description: string; spec: string; source_server_id: string | null;
  created_at: string; updated_at: string;
}

export interface TemplateDto {
  id: string; name: string; description: string; spec: TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}

export function toTemplateDto(r: TemplateRow): TemplateDto {
  return {
    id: r.id, name: r.name, description: r.description, spec: JSON.parse(r.spec) as TemplateSpec,
    sourceServerId: r.source_server_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class TemplatesRepo {
  constructor(private db: Db) {}

  list(): TemplateRow[] {
    return this.db.prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE").all() as unknown as TemplateRow[];
  }
  get(id: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined) ?? null;
  }
  getByName(name: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | undefined) ?? null;
  }
  create(input: { name: string; description: string; spec: TemplateSpec; sourceServerId: string | null }): TemplateRow {
    const id = newId();
    const now = nowIso();
    this.db.prepare(`INSERT INTO templates (id, name, description, spec, source_server_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description, JSON.stringify(input.spec), input.sourceServerId, now, now);
    return this.get(id)!;
  }
  update(id: string, input: { name: string; description: string; spec: TemplateSpec }): TemplateRow {
    this.db.prepare("UPDATE templates SET name = ?, description = ?, spec = ?, updated_at = ? WHERE id = ?")
      .run(input.name, input.description, JSON.stringify(input.spec), nowIso(), id);
    return this.get(id)!;
  }
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes === 1;
  }
}

declare module "fastify" {
  interface FastifyInstance { templates: TemplatesRepo }
}
```

`panel/apps/api/src/templates/routes.ts`:
```ts
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import {
  copyName, formatZodError, mergeSpecPatch, serverCreateSchema, specToTemplate, templateCreateSchema,
  templateInstantiateSchema, templatePatchSchema, type Spec, type TemplateSpec,
} from "@mcsm/shared";
import { HttpError } from "../servers/service.js";
import { toTemplateDto, type TemplateRow } from "./repo.js";

/** Valida una spec de plantilla; los errores salen como 400 con la ruta del campo. */
function toTemplateSpec(raw: Record<string, unknown>): TemplateSpec {
  try {
    return specToTemplate(raw);
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, formatZodError(e));
    throw e;
  }
}

export async function templateRoutes(app: FastifyInstance) {
  const repo = app.templates;

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: formatZodError(err) });
    const status = (err as FastifyError).statusCode;
    if (status === undefined || status >= 500) {
      app.log.error(err);
      return reply.code(500).send({ error: "Error interno" });
    }
    return reply.code(status).send({ error: err.message });
  });

  const requireTemplate = (id: string): TemplateRow => {
    const row = repo.get(id);
    if (!row) throw new HttpError(404, "Plantilla no encontrada");
    return row;
  };
  const ensureFreeName = (name: string, selfId?: string) => {
    const other = repo.getByName(name);
    if (other && other.id !== selfId) throw new HttpError(409, `Ya existe una plantilla llamada «${name}»`);
  };

  app.get("/api/templates", async () => repo.list().map(toTemplateDto));

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (req) => toTemplateDto(requireTemplate(req.params.id)));

  app.post("/api/templates", async (req, reply) => {
    const input = templateCreateSchema.parse(req.body);
    ensureFreeName(input.name);
    let spec: TemplateSpec;
    let sourceServerId: string | null = null;
    if (input.fromServerId) {
      const server = app.servers.get(input.fromServerId);
      if (!server) throw new HttpError(404, "Servidor no encontrado");
      spec = toTemplateSpec(JSON.parse(server.spec) as Spec);
      sourceServerId = server.id;
    } else {
      spec = toTemplateSpec(input.spec ?? {});
    }
    const row = repo.create({ name: input.name, description: input.description, spec, sourceServerId });
    return reply.code(201).send(toTemplateDto(row));
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const row = requireTemplate(req.params.id);
    const input = templatePatchSchema.parse(req.body);
    const name = input.name ?? row.name;
    ensureFreeName(name, row.id);
    const spec = input.spec ? toTemplateSpec(mergeSpecPatch(JSON.parse(row.spec) as Record<string, unknown>, input.spec)) : (JSON.parse(row.spec) as TemplateSpec);
    return toTemplateDto(repo.update(row.id, { name, description: input.description ?? row.description, spec }));
  });

  app.post<{ Params: { id: string } }>("/api/templates/:id/duplicate", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    let n = 1;
    while (repo.getByName(copyName(row.name, n))) n++;
    const copy = repo.create({ name: copyName(row.name, n), description: row.description, spec: JSON.parse(row.spec) as TemplateSpec, sourceServerId: row.source_server_id });
    return reply.code(201).send(toTemplateDto(copy));
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!repo.delete(req.params.id)) throw new HttpError(404, "Plantilla no encontrada");
    return reply.code(204).send();
  });

  /** Crea un servidor idéntico a la plantilla salvo nombre, puertos y rconPassword (los pone el panel). */
  app.post<{ Params: { id: string } }>("/api/templates/:id/servers", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    const input = templateInstantiateSchema.parse(req.body);
    const spec = JSON.parse(row.spec) as TemplateSpec;
    const parsed = serverCreateSchema.safeParse({
      nodeId: input.nodeId, name: input.name, slug: input.slug, desiredState: input.desiredState,
      spec: { ...spec, ports: input.port ? { game: input.port, extra: [] } : { extra: [] } },
    });
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return reply.code(201).send(await app.serversService.create(parsed.data));
  });
}
```

En `panel/apps/api/src/app.ts`, imports junto a los demás:
```ts
import { TemplatesRepo } from "./templates/repo.js";
import { templateRoutes } from "./templates/routes.js";
```
y en el bloque `plan-3` de `buildApp`, después de lo de la Task 4 (el decorador **antes** de registrar las rutas, que lo leen al registrarse):
```ts
  app.decorate("templates", new TemplatesRepo(opts.db));
  await app.register(templateRoutes);
```

En `panel/apps/api/src/db/migrations.ts`, en el bloque `plan-3`, después de `020_cf_api_key_env_to_settings`:
```ts
  {
    name: "021_templates",
    sql: `
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL,
  source_server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
```

- [ ] **Step 5: Ejecutar (deben pasar)**

```bash
pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS. El test «instanciar reproduce el servidor salvo nombre, puertos y RCON» compara la spec completa de la copia con la del original quitando solo `ports` y `rconPassword`.

- [ ] **Step 6: Commit**

```bash
git add panel/packages/shared/src/ panel/apps/api/src/
git commit -m "feat(api): plantillas con CRUD, guardar desde servidor, duplicar y crear servidor desde plantilla

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — catálogos, estado editable de la spec, diff y cliente API

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/lib/spec-catalog.ts`, `panel/apps/web/src/lib/spec-edit.ts`, `panel/apps/web/src/lib/spec-edit.test.ts`, `panel/apps/web/src/lib/spec-diff.ts`, `panel/apps/web/src/lib/spec-diff.test.ts`
- Modify: `panel/apps/web/src/lib/api.ts` (`api.put`, `TemplateDto`)

**Interfaces:**
- Consumes (`@mcsm/shared`): `SpecInput`, `TemplateSpec`, `MODPACK_PLATFORMS`, `ModpackPlatform`, `canonicalJson`, `formatZodError`, `specInputSchema`, `templateSpecSchema`, `SpecPatch`, `defaultSpecInput`.
- Produces:
  - `spec-catalog.ts`: `SERVER_TYPES: {value,label,kind}[]`, `typeKind(type): "vanilla"|"plugins"|"mods"|"modpack"|"other"`, `typeLabel(type)`, `JAVA_TAGS`, `RESTART_POLICIES`, `PropDef`, `PROPERTY_DEFS` (22), `TYPED_PROPERTY_KEYS`.
  - `spec-edit.ts`: `type EditableSpec = SpecInput`, `FORM_KEYS`, `parseList`, `listToText`, `parseKv`, `kvToText`, `splitProperties`, `setProperty`, `replaceOtherProperties`, `editableSpec(spec)`, `withType(spec, type)`, `buildSpecPatch(original, edited, keys = FORM_KEYS): SpecPatch`, `validateSpec(spec, "server"|"template"): string | null`, `editableFromTemplate(TemplateSpec): EditableSpec`.
  - `spec-diff.ts`: `DiffLine {label, before, after}`, `diffSpecs(before, after): DiffLine[]`.
  - `api.ts`: `api.put<T>(path, body)`, `interface TemplateDto`.
- Nota: el `lib/spec-form.ts` del Plan 1 sigue existiendo hasta la Task 10, que lo borra junto con el formulario viejo.

- [ ] **Step 1: Tests (fallan)**

`panel/apps/web/src/lib/spec-edit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import {
  buildSpecPatch, editableFromTemplate, editableSpec, kvToText, listToText, parseKv, parseList, replaceOtherProperties,
  setProperty, splitProperties, validateSpec, withType,
} from "./spec-edit";
import { PROPERTY_DEFS, typeKind } from "./spec-catalog";

describe("listas y clave=valor", () => {
  it("parseList acepta líneas y comas, quita vacíos y espacios", () => {
    expect(parseList(" lithium\nsodium, ferritecore:beta\n\n")).toEqual(["lithium", "sodium", "ferritecore:beta"]);
    expect(listToText(["a", "b"])).toBe("a\nb");
    expect(listToText(undefined)).toBe("");
  });
  it("parseKv ignora comentarios y rechaza líneas sin =", () => {
    expect(parseKv("# hola\nmotd=Mi = servidor\n max-players = 10 ")).toEqual({ motd: "Mi = servidor", "max-players": "10" });
    expect(() => parseKv("motd")).toThrow(/clave=valor/);
    expect(kvToText({ a: "1", b: "2" })).toBe("a=1\nb=2");
  });
});

describe("propiedades", () => {
  it("separa las tipadas, fija/quita una y sustituye las otras", () => {
    const props = { motd: "x", "max-players": "5", "custom-x": "1" };
    expect(splitProperties(props)).toEqual({ typed: { motd: "x", "max-players": "5" }, other: { "custom-x": "1" } });
    expect(setProperty(props, "motd", "")).toEqual({ "max-players": "5", "custom-x": "1" });
    expect(setProperty(props, "pvp", "false")).toMatchObject({ pvp: "false" });
    expect(replaceOtherProperties(props, { "other-y": "2" })).toEqual({ motd: "x", "max-players": "5", "other-y": "2" });
  });
  it("el catálogo tiene ~20 propiedades y tipos conocidos", () => {
    expect(PROPERTY_DEFS.length).toBeGreaterThanOrEqual(20);
    expect(typeKind("FABRIC")).toBe("mods");
    expect(typeKind("AUTO_CURSEFORGE")).toBe("modpack");
    expect(typeKind("MOHIST")).toBe("other");
  });
});

describe("withType", () => {
  it("un tipo de modpack crea la sección modpack y uno normal la quita", () => {
    const base = defaultSpecInput();
    const mp = withType(base, "MODRINTH");
    expect(mp.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "", versionId: "", loader: "" });
    const cf = withType({ ...mp, modpack: { ...mp.modpack!, slugOrUrl: "pack", loader: "fabric" } }, "AUTO_CURSEFORGE");
    expect(cf.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "pack", versionId: "", loader: "" });
    const paper = withType(cf, "PAPER");
    expect(paper).not.toHaveProperty("modpack");
    expect(paper.type).toBe("PAPER");
  });
});

describe("buildSpecPatch", () => {
  const original = { type: "PAPER", memory: "4G", properties: { motd: "a" }, whitelist: { enabled: true, players: ["Lobo"] }, backups: { cron: "0 4 * * *" }, rconPassword: "x" };
  it("solo envía lo que cambió y null para lo quitado; nunca toca claves que no edita", () => {
    const edited = { type: "PAPER", memory: "6G", properties: { motd: "a" } };
    expect(buildSpecPatch(original, edited)).toEqual({ memory: "6G", whitelist: null });
  });
  it("partiendo de editableSpec no hay cambios espurios", () => {
    expect(buildSpecPatch(original, { ...editableSpec(original), memory: "6G" })).toEqual({ memory: "6G" });
  });
  it("el orden de las claves no cuenta como cambio", () => {
    expect(buildSpecPatch({ properties: { a: "1", b: "2" } }, { properties: { b: "2", a: "1" } })).toEqual({});
  });
});

describe("validateSpec", () => {
  it("devuelve el error con la ruta del campo", () => {
    expect(validateSpec(withType(defaultSpecInput(), "MODRINTH"), "server")).toMatch(/^modpack\.slugOrUrl: /);
    expect(validateSpec(defaultSpecInput(), "server")).toBeNull();
  });
  it("en plantillas ignora los puertos", () => {
    const t = editableFromTemplate(templateSpecSchema.parse({ type: "PAPER" }));
    expect(t.ports).toEqual({ extra: [] });
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "template")).toBeNull();
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "server")).toMatch(/ports\.game/);
  });
});
```

`panel/apps/web/src/lib/spec-diff.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { diffSpecs } from "./spec-diff";

describe("diffSpecs", () => {
  const before = {
    type: "PAPER", version: "1.21.4", memory: "4G", properties: { motd: "Hola", pvp: "true" }, env: {},
    ports: { game: 25565, extra: [] }, resources: { cpus: 0, memLimit: "" }, rconPassword: "secreto",
  };
  it("sin cambios devuelve vacío", () => {
    expect(diffSpecs(before, { ...before })).toEqual([]);
  });
  it("lista cambios con etiquetas en castellano y nunca muestra rconPassword", () => {
    const after = {
      ...before, type: "FABRIC", memory: "6G", properties: { motd: "Adiós" },
      mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
      whitelist: { enabled: true, players: ["Lobo"] },
      ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
      rconPassword: "otro",
    };
    const lines = diffSpecs(before, after);
    expect(lines).toEqual(expect.arrayContaining([
      { label: "Tipo", before: "PAPER", after: "FABRIC" },
      { label: "Memoria JVM", before: "4G", after: "6G" },
      { label: "Propiedad motd", before: "Hola", after: "Adiós" },
      { label: "Propiedad pvp", before: "true", after: "—" },
      { label: "Mods de Modrinth", before: "—", after: "lithium" },
      { label: "Whitelist", before: "—", after: "activada: Lobo" },
      { label: "Puertos extra", before: "—", after: "19132→19132/udp (Geyser)" },
    ]));
    expect(JSON.stringify(lines)).not.toMatch(/secreto|otro/);
    expect(lines.find((l) => l.label === "Mods de CurseForge")).toBeUndefined();
  });
  it("modpack legible", () => {
    const lines = diffSpecs({ type: "PAPER" }, { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(lines).toContainEqual({ label: "Modpack", before: "—", after: "MODRINTH: cobblemon-fabric (fabric)" });
  });
});
```

- [ ] **Step 2: Ejecutar (deben fallar)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './spec-edit'`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/lib/spec-catalog.ts`:
```ts
/** Catálogos para el formulario de configuración (etiquetas en castellano, valores itzg). */

export type TypeKind = "vanilla" | "plugins" | "mods" | "modpack" | "other";

export const SERVER_TYPES: readonly { value: string; label: string; kind: TypeKind }[] = [
  { value: "VANILLA", label: "Vanilla", kind: "vanilla" },
  { value: "PAPER", label: "Paper", kind: "plugins" },
  { value: "PURPUR", label: "Purpur", kind: "plugins" },
  { value: "SPIGOT", label: "Spigot", kind: "plugins" },
  { value: "FOLIA", label: "Folia", kind: "plugins" },
  { value: "FABRIC", label: "Fabric", kind: "mods" },
  { value: "FORGE", label: "Forge", kind: "mods" },
  { value: "NEOFORGE", label: "NeoForge", kind: "mods" },
  { value: "QUILT", label: "Quilt", kind: "mods" },
  { value: "MODRINTH", label: "Modpack de Modrinth", kind: "modpack" },
  { value: "AUTO_CURSEFORGE", label: "Modpack de CurseForge", kind: "modpack" },
  { value: "FTBA", label: "Modpack de FTB", kind: "modpack" },
];

export function typeKind(type: string): TypeKind {
  return SERVER_TYPES.find((t) => t.value === type)?.kind ?? "other";
}

export function typeLabel(type: string): string {
  return SERVER_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const JAVA_TAGS = ["java21", "java25", "java17", "java8", "latest"] as const;

export const RESTART_POLICIES: readonly { value: "unless-stopped" | "always" | "on-failure" | "no"; label: string }[] = [
  { value: "unless-stopped", label: "Salvo si lo paro yo (unless-stopped)" },
  { value: "always", label: "Siempre (always)" },
  { value: "on-failure", label: "Solo si falla (on-failure)" },
  { value: "no", label: "Nunca (no)" },
];

export type PropKind = "text" | "int" | "bool" | "enum";
export interface PropDef { key: string; label: string; kind: PropKind; options?: readonly string[]; placeholder?: string; min?: number; max?: number }

/** Las ~20 propiedades de server.properties más usadas, con campo tipado. El resto va en "Otras". */
export const PROPERTY_DEFS: readonly PropDef[] = [
  { key: "motd", label: "MOTD (mensaje de la lista)", kind: "text", placeholder: "Servidor de casa" },
  { key: "difficulty", label: "Dificultad", kind: "enum", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Modo de juego", kind: "enum", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "max-players", label: "Jugadores máximos", kind: "int", min: 1, max: 1000, placeholder: "20" },
  { key: "view-distance", label: "Distancia de visión (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "simulation-distance", label: "Distancia de simulación (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "pvp", label: "PvP", kind: "bool" },
  { key: "hardcore", label: "Hardcore", kind: "bool" },
  { key: "online-mode", label: "Modo online (cuentas premium)", kind: "bool" },
  { key: "allow-flight", label: "Permitir volar", kind: "bool" },
  { key: "allow-nether", label: "Permitir el Nether", kind: "bool" },
  { key: "spawn-protection", label: "Protección del spawn (bloques)", kind: "int", min: 0, max: 1000, placeholder: "16" },
  { key: "level-name", label: "Nombre del mundo (carpeta)", kind: "text", placeholder: "world" },
  { key: "level-seed", label: "Semilla", kind: "text" },
  { key: "level-type", label: "Tipo de mundo", kind: "enum", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"] },
  { key: "generate-structures", label: "Generar estructuras", kind: "bool" },
  { key: "spawn-monsters", label: "Aparecen monstruos", kind: "bool" },
  { key: "enable-command-block", label: "Bloques de comandos", kind: "bool" },
  { key: "force-gamemode", label: "Forzar modo de juego al entrar", kind: "bool" },
  { key: "player-idle-timeout", label: "Expulsar por inactividad (minutos, 0 = nunca)", kind: "int", min: 0, max: 10000 },
  { key: "max-world-size", label: "Radio máximo del mundo (bloques)", kind: "int", min: 1, max: 29999984 },
  { key: "enforce-secure-profile", label: "Exigir perfil seguro (chat firmado)", kind: "bool" },
];

export const TYPED_PROPERTY_KEYS = new Set(PROPERTY_DEFS.map((d) => d.key));
```

`panel/apps/web/src/lib/spec-edit.ts`:
```ts
import {
  MODPACK_PLATFORMS, canonicalJson, formatZodError, specInputSchema, templateSpecSchema,
  type ModpackPlatform, type SpecInput, type SpecPatch, type TemplateSpec,
} from "@mcsm/shared";
import { TYPED_PROPERTY_KEYS } from "./spec-catalog";

/** Estado del formulario: una SpecInput (sin rconPassword). En plantillas, `ports` se ignora. */
export type EditableSpec = SpecInput;

/** Secciones de la spec que edita el formulario. Lo demás (p. ej. `backups`) no se toca nunca. */
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
] as const;

/** Una entrada por línea; también acepta comas (pegar "lithium,sodium"). */
export function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export function listToText(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

/** `clave=valor` por línea; `#` comenta. Lanza Error con un mensaje para el usuario. */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Línea inválida: "${line}" (usa clave=valor)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function kvToText(o: Record<string, string> | undefined): string {
  return Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** Separa las propiedades con campo tipado de las demás ("Otras propiedades"). */
export function splitProperties(props: Record<string, string>): { typed: Record<string, string>; other: Record<string, string> } {
  const typed: Record<string, string> = {};
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) (TYPED_PROPERTY_KEYS.has(k) ? typed : other)[k] = v;
  return { typed, other };
}

/** Fija (o quita, con undefined/"") una propiedad tipada. */
export function setProperty(props: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const out = { ...props };
  if (value === undefined || value === "") delete out[key];
  else out[key] = value;
  return out;
}

/** Sustituye las propiedades "otras" conservando las tipadas. */
export function replaceOtherProperties(props: Record<string, string>, other: Record<string, string>): Record<string, string> {
  return { ...splitProperties(props).typed, ...other };
}

/** Quita lo que la UI no edita como spec (rconPassword). */
export function editableSpec<T extends Record<string, unknown>>(spec: T): Omit<T, "rconPassword"> {
  const { rconPassword: _secret, ...rest } = spec;
  return rest;
}

const isPlatform = (t: string): t is ModpackPlatform => (MODPACK_PLATFORMS as readonly string[]).includes(t);

/** Cambia el tipo manteniendo coherente el modpack (tipo de modpack ⇔ sección modpack). */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  if (isPlatform(type)) {
    const prev = spec.modpack;
    return { ...spec, type, modpack: { platform: type, slugOrUrl: prev?.slugOrUrl ?? "", versionId: "", loader: "" } };
  }
  const { modpack: _drop, ...rest } = spec;
  return { ...rest, type };
}

/**
 * PATCH mínimo (merge de primer nivel, ver mergeSpecPatch en @mcsm/shared): solo las secciones
 * de FORM_KEYS que cambiaron; `null` para las que el formulario quitó. Nunca toca lo demás.
 */
export function buildSpecPatch(original: Record<string, unknown>, edited: Record<string, unknown>, keys: readonly string[] = FORM_KEYS): SpecPatch {
  const patch: SpecPatch = {};
  for (const k of keys) {
    const before = original[k];
    const after = edited[k];
    if (after === undefined) {
      if (before !== undefined) patch[k] = null;
    } else if (canonicalJson(after) !== canonicalJson(before)) {
      patch[k] = after;
    }
  }
  return patch;
}

/** Valida como lo hará el panel. Devuelve el primer error ("ruta: mensaje") o null. */
export function validateSpec(spec: EditableSpec, mode: "server" | "template"): string | null {
  if (mode === "template") {
    const { ports: _ports, ...rest } = spec;
    const r = templateSpecSchema.safeParse(rest);
    return r.success ? null : formatZodError(r.error);
  }
  const r = specInputSchema.safeParse(spec);
  return r.success ? null : formatZodError(r.error);
}

/** Estado inicial del editor de plantillas a partir de su spec. */
export function editableFromTemplate(spec: TemplateSpec): EditableSpec {
  return { ...spec, ports: { extra: [] } };
}
```

`panel/apps/web/src/lib/spec-diff.ts`:
```ts
export interface DiffLine { label: string; before: string; after: string }

const NONE = "—";

const TOP_LABELS: Record<string, string> = {
  type: "Tipo", version: "Versión de Minecraft", imageTag: "Java (imagen)", memory: "Memoria JVM",
  restartPolicy: "Política de reinicio", modpack: "Modpack", whitelist: "Whitelist", ops: "Operadores",
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
  return `${v.enabled ? "activada" : "desactivada"}${players}`;
}

function showPorts(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return NONE;
  return v.map((p: Obj) => `${String(p.host)}→${String(p.container)}/${String(p.proto)}${p.label ? ` (${String(p.label)})` : ""}`).join(", ");
}

/** Aplana una spec a `etiqueta → texto` para compararla línea a línea. */
function flatten(spec: Obj): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(spec)) {
    if (k === "rconPassword" || v === undefined) continue;
    if (k === "properties" && isObj(v)) for (const [pk, pv] of Object.entries(v)) out.set(`Propiedad ${pk}`, show(pv));
    else if (k === "env" && isObj(v)) for (const [ek, ev] of Object.entries(v)) out.set(`Variable ${ek}`, show(ev));
    else if (k === "modpack") out.set(TOP_LABELS.modpack!, showModpack(v));
    else if (k === "whitelist") out.set(TOP_LABELS.whitelist!, showWhitelist(v));
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
    const x = a.get(label) ?? NONE;
    const y = b.get(label) ?? NONE;
    if (x !== y) lines.push({ label, before: x, after: y });
  }
  return lines;
}
```

En `panel/apps/web/src/lib/api.ts`, añade `put` al objeto `api`:
```ts
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
```
y al final del fichero:
```ts
export interface TemplateDto {
  id: string; name: string; description: string; spec: import("@mcsm/shared").TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}
```

- [ ] **Step 4: Ejecutar (deben pasar)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/lib/
git commit -m "feat(web): catálogos de configuración, PATCH mínimo de spec y diff legible

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — campos del formulario y sección «Versión y mods»

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/components/spec-form/fields.tsx`, `panel/apps/web/src/components/spec-form/curseforge-key.tsx`, `panel/apps/web/src/components/spec-form/version-section.tsx`, `panel/apps/web/src/components/spec-form/version-section.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`spec-catalog`, `spec-edit`, `api.put`); `MODRINTH_LOADERS`, `usesCurseForge` (`@mcsm/shared`); endpoints `GET/PUT /api/settings/curseforge` (Task 4); componentes shadcn `Input`, `Label`, `Textarea`, `Select*`, `Dialog*`, `Button`.
- Produces:
  - `fields.tsx`: `type ReportError = (field: string, message: string | null) => void`, `Field`, `ListField` (lista en textarea, guarda su texto), `KvField` (clave=valor, avisa con `onError`), `NumberField` (vacío = `undefined`), `OptionalSelect` (con «(por defecto)»; Radix no admite `value=""`), `RequiredSelect` (añade el valor actual si no está en la lista).
  - `curseforge-key.tsx`: `CurseForgeKeyNotice` (estado y diálogo de la API key; nunca la lee de vuelta).
  - `version-section.tsx`: `VersionSection({ spec, onChange })`: tipo, versión, Java, modpack según plataforma, mods (tipos de mods/modpack) y plugins (tipos de plugins), aviso de CurseForge. Al vaciar mods/plugins **conserva la sección** (el agente emite `MODRINTH_PROJECTS` vacía e itzg borra lo instalado).
- Los campos de texto guardan su texto local: quien los use debe remontarlos (cambiando `key`) al recargar la spec desde fuera.

- [ ] **Step 1: Test de humo (falla)**

El entorno de Vitest de la web es `node` (sin DOM): se prueba con `renderToString`, que ejecuta los componentes de verdad (Radix incluido) sin navegador.

`panel/apps/web/src/components/spec-form/version-section.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { VersionSection } from "./version-section";
import { withType, type EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><VersionSection spec={spec} onChange={() => {}} /></QueryClientProvider>);

describe("VersionSection (render en servidor, sin DOM)", () => {
  it("Fabric muestra Mods y no Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("MODRINTH_PROJECTS");
    expect(html).toContain("lithium");
    expect(html).not.toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("API key de CurseForge");
  });
  it("Paper muestra Plugins y no Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER" });
    expect(html).toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CURSEFORGE_FILES");
  });
  it("un modpack de CurseForge pide el slug y muestra el estado de la API key", () => {
    const html = render({ ...withType(defaultSpecInput(), "AUTO_CURSEFORGE"), modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" } });
    expect(html).toContain("Modpack de CurseForge");
    expect(html).toContain("all-the-mods-9");
    expect(html).toContain("API key de CurseForge");
    expect(html).not.toContain("Loader (opcional)");
  });
  it("Vanilla sin mods explica que no carga mods ni plugins", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).toContain("Vanilla no carga mods ni plugins");
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './version-section'`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/components/spec-form/fields.tsx`:
```tsx
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listToText, kvToText, parseKv, parseList } from "@/lib/spec-edit";

/** Notifica errores de campo al formulario (null = el campo vuelve a ser válido). */
export type ReportError = (field: string, message: string | null) => void;

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lista en un textarea (una entrada por línea). Guarda su propio texto para no comerse los saltos de línea al escribir. */
export function ListField({ id, label, value, onChange, placeholder, hint, rows = 4 }: {
  id: string; label: string; value: readonly string[] | undefined; onChange: (v: string[]) => void;
  placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => listToText(value));
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value)); }} />
    </Field>
  );
}

/** Pares clave=valor en un textarea. Si una línea es inválida, avisa con onError y no propaga el valor. */
export function KvField({ id, label, value, onChange, onError, placeholder, hint, rows = 6 }: {
  id: string; label: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void;
  onError: ReportError; placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => kvToText(value));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    try {
      const kv = parseKv(t);
      setError(null); onError(id, null); onChange(kv);
    } catch (e) {
      const msg = `${label}: ${(e as Error).message}`;
      setError(msg); onError(id, msg);
    }
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

/** Número opcional (vacío = undefined). Avisa con onError si no es un número válido en [min, max]. */
export function NumberField({ id, label, value, onChange, onError, min, max, integer = true, placeholder, hint }: {
  id: string; label: string; value: number | undefined; onChange: (v: number | undefined) => void; onError: ReportError;
  min?: number; max?: number; integer?: boolean; placeholder?: string; hint?: React.ReactNode;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : String(value)));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed === "") { setError(null); onError(id, null); onChange(undefined); return; }
    const n = Number(trimmed.replace(",", "."));
    const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max);
    if (bad) {
      const range = min !== undefined && max !== undefined ? ` entre ${min} y ${max}` : min !== undefined ? ` ≥ ${min}` : "";
      const msg = `${label}: debe ser un número${integer ? " entero" : ""}${range}`;
      setError(msg); onError(id, msg); return;
    }
    setError(null); onError(id, null); onChange(n);
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} value={text} inputMode={integer ? "numeric" : "decimal"} placeholder={placeholder} aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

const DEFAULT = "__default__"; // Radix Select no admite value=""

/** Select con opción "(por defecto)" que equivale a no fijar el valor. */
export function OptionalSelect({ id, value, options, onChange, defaultLabel = "(por defecto)" }: {
  id: string; value: string | undefined; options: readonly { value: string; label: string }[]; onChange: (v: string | undefined) => void; defaultLabel?: string;
}) {
  const known = value === undefined || options.some((o) => o.value === value);
  const all = known ? options : [{ value: value!, label: value! }, ...options];
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? undefined : v)}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Select obligatorio; si el valor actual no está en la lista (p. ej. un tipo importado) se añade. */
export function RequiredSelect({ id, value, options, onChange }: {
  id: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
```

`panel/apps/web/src/components/spec-form/curseforge-key.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";

interface KeyStatus { configured: boolean }

/** Estado de la API key global de CurseForge y diálogo para cambiarla. La key nunca se lee de vuelta. */
export function CurseForgeKeyNotice() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") });
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string) => api.put<KeyStatus>("/api/settings/curseforge", { apiKey }),
    onSuccess: (s) => {
      qc.setQueryData(["settings", "curseforge"], s);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      setOpen(false); setKey("");
    },
  });
  const configured = status.data?.configured;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
      <KeyRound className="size-4 text-muted-foreground" />
      <span>
        API key de CurseForge: {configured === undefined ? "…" : configured ? <strong className="text-emerald-400">configurada</strong> : <strong className="text-amber-400">sin configurar</strong>}
        {configured === false && " (las imágenes java17 o superiores traen una; con java8 es obligatoria)"}
      </span>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setKey(""); save.reset(); } }}>
        <DialogTrigger asChild><Button type="button" size="sm" variant="secondary">{configured ? "Cambiar" : "Configurar"}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key de CurseForge</DialogTitle>
            <DialogDescription>Es global para todos los servidores. Al cambiarla se recrean los que descargan de CurseForge.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(key.trim()); }}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-api-key">Nueva API key</Label>
              <Input id="cf-api-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" />
              <p className="text-xs text-muted-foreground">Se obtiene en console.curseforge.com. Pégala tal cual: los «$» no se escapan.</p>
            </div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Error inesperado"}</p>}
            <DialogFooter>
              {configured && <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate("")}>Quitar la key</Button>}
              <Button type="submit" disabled={save.isPending || key.trim() === ""}>{save.isPending ? "Guardando…" : "Guardar"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/version-section.tsx`:
```tsx
import { MODRINTH_LOADERS, usesCurseForge } from "@mcsm/shared";
import { Input } from "@/components/ui/input";
import { JAVA_TAGS, SERVER_TYPES, typeKind } from "@/lib/spec-catalog";
import { withType, type EditableSpec } from "@/lib/spec-edit";
import { Field, ListField, OptionalSelect, RequiredSelect } from "./fields";
import { CurseForgeKeyNotice } from "./curseforge-key";

type Mods = NonNullable<EditableSpec["mods"]>;
type Plugins = NonNullable<EditableSpec["plugins"]>;
const EMPTY_MODS: Mods = { modrinthProjects: [], curseforgeFiles: [], urls: [] };
const EMPTY_PLUGINS: Plugins = { modrinthProjects: [], spigetResources: [], urls: [] };

const MODPACK_HELP: Record<string, { slug: string; slugHint: string; version: string; versionHint: string }> = {
  MODRINTH: {
    slug: "Modpack de Modrinth", slugHint: "Slug, id o URL de modrinth.com (MODRINTH_MODPACK).",
    version: "Versión del modpack (opcional)", versionHint: "Id o número de versión (MODRINTH_VERSION). Vacío = la última compatible con la versión de Minecraft.",
  },
  AUTO_CURSEFORGE: {
    slug: "Modpack de CurseForge", slugHint: "Slug (CF_SLUG) o URL de la página o de un fichero (CF_PAGE_URL).",
    version: "Id del fichero (opcional)", versionHint: "Número de fichero para fijar versión (CF_FILE_ID). Vacío = el último.",
  },
  FTBA: {
    slug: "Id del modpack de FTB", slugHint: "Número del modpack (FTB_MODPACK_ID).",
    version: "Id de versión (opcional)", versionHint: "Número de versión (FTB_MODPACK_VERSION_ID). Vacío = la última.",
  },
};

/** Sección "Versión y mods": tipo, versión, Java, modpack, mods y plugins. */
export function VersionSection({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const kind = typeKind(spec.type);
  const mods = spec.mods ?? EMPTY_MODS;
  const plugins = spec.plugins ?? EMPTY_PLUGINS;
  const hasMods = Object.values(mods).some((l) => l.length > 0);
  const hasPlugins = Object.values(plugins).some((l) => l.length > 0);
  const showMods = kind === "mods" || kind === "modpack" || kind === "other" || hasMods;
  const showPlugins = kind === "plugins" || kind === "other" || hasPlugins;
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  // La sección se conserva aunque quede vacía: así el agente emite MODRINTH_PROJECTS vacía e itzg
  // borra lo que instaló (quitar el último mod lo quita del servidor).
  const setMods = (m: Partial<Mods>) => onChange({ ...spec, mods: { ...mods, ...m } });
  const setPlugins = (p: Partial<Plugins>) => onChange({ ...spec, plugins: { ...plugins, ...p } });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id="sf-type" label="Tipo">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => onChange(withType(spec, t))} />
        </Field>
        <Field id="sf-version" label="Versión de Minecraft" hint="LATEST, SNAPSHOT o una versión como 1.21.4.">
          <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value.trim() })} />
        </Field>
        <Field id="sf-java" label="Java (etiqueta de la imagen)" hint="java21 para 1.20.5+; java17 para 1.17–1.20.4; java8 para versiones antiguas.">
          <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))} onChange={(t) => onChange({ ...spec, imageTag: t })} />
        </Field>
      </div>

      {mp && help && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Modpack</legend>
          <Field id="sf-mp-slug" label={help.slug} hint={help.slugHint}>
            <Input id="sf-mp-slug" value={mp.slugOrUrl} onChange={(e) => onChange({ ...spec, modpack: { ...mp, slugOrUrl: e.target.value.trim() } })} />
          </Field>
          <Field id="sf-mp-version" label={help.version} hint={help.versionHint}>
            <Input id="sf-mp-version" value={mp.versionId} onChange={(e) => onChange({ ...spec, modpack: { ...mp, versionId: e.target.value.trim() } })} />
          </Field>
          {mp.platform === "MODRINTH" && (
            <Field id="sf-mp-loader" label="Loader (opcional)" hint="Solo si el modpack publica versiones para varios loaders.">
              <OptionalSelect id="sf-mp-loader" value={mp.loader || undefined}
                options={MODRINTH_LOADERS.filter((l) => l !== "").map((l) => ({ value: l, label: l }))}
                onChange={(l) => onChange({ ...spec, modpack: { ...mp, loader: (l ?? "") as typeof mp.loader } })} defaultLabel="(cualquiera)" />
            </Field>
          )}
        </fieldset>
      )}

      {showMods && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Mods</legend>
          <ListField id="sf-mods-modrinth" label="Modrinth (MODRINTH_PROJECTS)" value={mods.modrinthProjects} placeholder={"lithium\nferritecore:beta"}
            hint="Slug o id por línea; «:beta» o «:versión» para fijar." onChange={(l) => setMods({ modrinthProjects: l })} />
          <ListField id="sf-mods-cf" label="CurseForge (CURSEFORGE_FILES)" value={mods.curseforgeFiles} placeholder={"jei\njei:4593548"}
            hint="Slug, id, slug:fichero o URL por línea." onChange={(l) => setMods({ curseforgeFiles: l })} />
          <ListField id="sf-mods-urls" label="URLs de .jar (MODS)" value={mods.urls} placeholder="https://…/mod.jar"
            hint="Una URL http(s) por línea. Quitar una URL no borra el .jar ya descargado." onChange={(l) => setMods({ urls: l })} />
        </fieldset>
      )}

      {showPlugins && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Plugins</legend>
          <ListField id="sf-pl-modrinth" label="Modrinth (MODRINTH_PROJECTS)" value={plugins.modrinthProjects} placeholder={"luckperms\nchunky"}
            hint="Slug o id por línea." onChange={(l) => setPlugins({ modrinthProjects: l })} />
          <ListField id="sf-pl-spiget" label="Spiget (SPIGET_RESOURCES)" value={plugins.spigetResources} placeholder={"28140\n34315"}
            hint="Id numérico de SpigotMC por línea. Algunos (p. ej. EssentialsX) no permiten descarga automática." onChange={(l) => setPlugins({ spigetResources: l })} />
          <ListField id="sf-pl-urls" label="URLs de .jar (PLUGINS)" value={plugins.urls} placeholder="https://…/plugin.jar"
            hint="Una URL http(s) por línea. Quitar una URL no borra el .jar ya descargado." onChange={(l) => setPlugins({ urls: l })} />
        </fieldset>
      )}

      {kind === "vanilla" && !hasMods && !hasPlugins && (
        <p className="text-xs text-muted-foreground">Vanilla no carga mods ni plugins. Elige Fabric/Forge/NeoForge/Quilt para mods o Paper/Purpur/Spigot para plugins.</p>
      )}
      {usesCurseForge(spec) && <CurseForgeKeyNotice />}
    </div>
  );
}
```

- [ ] **Step 4: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS (4 tests nuevos de `VersionSection`).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/components/spec-form/
git commit -m "feat(web): campos del formulario de spec y sección Versión y mods con modpacks y API key de CurseForge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — secciones Propiedades, Jugadores, Red, Recursos y Avanzado, y `SpecForm`

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/components/spec-form/properties-section.tsx`, `players-section.tsx`, `network-section.tsx`, `resources-section.tsx`, `advanced-section.tsx`, `spec-form.tsx`, `spec-form.test.tsx` (todos en `panel/apps/web/src/components/spec-form/`)

**Interfaces:**
- Consumes: Task 6 (`PROPERTY_DEFS`, `RESTART_POLICIES`, `setProperty`, `replaceOtherProperties`, `splitProperties`, `EditableSpec`), Task 7 (`Field`, `KvField`, `ListField`, `NumberField`, `OptionalSelect`, `RequiredSelect`, `ReportError`, `VersionSection`), shadcn `Tabs*`.
- Produces: `SpecForm({ value, onChange, onError, mode: "server" | "template", general: ReactNode })` con pestañas **General, Versión y mods, Propiedades, Jugadores, Red (solo `server`), Recursos, Avanzado** (sin Backups: es del Plan 4). Todas las pestañas se montan siempre (`forceMount` + `data-[state=inactive]:hidden`) para que los campos no pierdan su texto al cambiar de pestaña. Cada sección: `XSection({ spec, onChange, onError? })`.

- [ ] **Step 1: Test de humo (falla)**

`panel/apps/web/src/components/spec-form/spec-form.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { SpecForm } from "./spec-form";
import type { EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec, mode: "server" | "template") =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SpecForm value={spec} onChange={() => {}} onError={() => {}} mode={mode} general={<p>contenido general</p>} />
    </QueryClientProvider>,
  );

describe("SpecForm (render en servidor, sin DOM)", () => {
  const modded: EditableSpec = {
    ...defaultSpecInput(), type: "AUTO_CURSEFORGE", version: "1.20.1",
    modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" },
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    properties: { motd: "Hola", difficulty: "hard", "max-players": "8", "custom-x": "1" },
    whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"], env: { USE_AIKAR_FLAGS: "true" },
    ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
  };

  it("pinta todas las secciones (forceMount) con valores", () => {
    const html = render(modded, "server");
    for (const t of ["General", "Versión y mods", "Propiedades", "Jugadores", "Red", "Recursos", "Avanzado", "contenido general"]) expect(html).toContain(t);
    for (const v of ["all-the-mods-9", "lithium", "Lobo", "custom-x=1", "USE_AIKAR_FLAGS=true", "Geyser", "API key de CurseForge"]) expect(html).toContain(v);
    expect(html).not.toContain("Backups");
  });

  it("en plantillas no hay sección Red", () => {
    const html = render({ ...defaultSpecInput(), ports: { extra: [] } }, "template");
    expect(html).not.toContain("Puerto de juego");
    expect(html).toContain("Avanzado");
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './spec-form'`).

- [ ] **Step 3: Secciones**

`panel/apps/web/src/components/spec-form/properties-section.tsx`:
```tsx
import { Input } from "@/components/ui/input";
import { PROPERTY_DEFS, type PropDef } from "@/lib/spec-catalog";
import { replaceOtherProperties, setProperty, splitProperties, type EditableSpec } from "@/lib/spec-edit";
import { Field, KvField, NumberField, OptionalSelect, type ReportError } from "./fields";

const BOOL_OPTIONS = [{ value: "true", label: "Sí" }, { value: "false", label: "No" }] as const;

function TypedProperty({ def, value, onChange, onError }: { def: PropDef; value: string | undefined; onChange: (v: string | undefined) => void; onError: ReportError }) {
  const id = `sf-prop-${def.key}`;
  const label = `${def.label} (${def.key})`;
  if (def.kind === "bool") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={BOOL_OPTIONS} onChange={onChange} /></Field>;
  if (def.kind === "enum") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} onChange={onChange} /></Field>;
  if (def.kind === "int") {
    const n = value === undefined || value === "" ? undefined : Number(value);
    return <NumberField id={id} label={label} value={Number.isFinite(n) ? n : undefined} min={def.min} max={def.max} placeholder={def.placeholder}
      onError={onError} onChange={(v) => onChange(v === undefined ? undefined : String(v))} />;
  }
  return <Field id={id} label={label}><Input id={id} value={value ?? ""} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} /></Field>;
}

/** Sección "Propiedades": ~20 campos tipados + el resto de server.properties como texto. Vacío = valor por defecto de la imagen. */
export function PropertiesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const props = spec.properties;
  const { other } = splitProperties(props);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROPERTY_DEFS.map((def) => (
          <TypedProperty key={def.key} def={def} value={props[def.key]} onError={onError}
            onChange={(v) => onChange({ ...spec, properties: setProperty(spec.properties, def.key, v) })} />
        ))}
      </div>
      <KvField id="sf-props-other" label="Otras propiedades de server.properties (clave=valor por línea)" value={other} onError={onError}
        placeholder={"spawn-npcs=true\nresource-pack=https://…"} hint="Se pasan con CUSTOM_SERVER_PROPERTIES. No se admiten server-port, enable-rcon ni rcon.*."
        onChange={(kv) => onChange({ ...spec, properties: replaceOtherProperties(spec.properties, kv) })} />
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/players-section.tsx`:
```tsx
import type { EditableSpec } from "@/lib/spec-edit";
import { ListField } from "./fields";

/** Sección "Jugadores": whitelist y operadores (WHITELIST/ENABLE_WHITELIST y OPS). */
export function PlayersSection({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const wl = spec.whitelist ?? { enabled: false, players: [] };
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={wl.enabled} onChange={(e) => onChange({ ...spec, whitelist: { ...wl, enabled: e.target.checked } })} />
          Activar whitelist (solo pueden entrar los de la lista)
        </label>
        <ListField id="sf-whitelist" label="Jugadores de la whitelist" value={wl.players} rows={6} placeholder={"Lobo\nSteve"}
          hint="Nombre de Java o UUID, uno por línea. Al arrancar, whitelist.json queda igual que esta lista: lo añadido con /whitelist add se pierde (pon EXISTING_WHITELIST_FILE=MERGE en Avanzado si prefieres sumar)."
          onChange={(players) => onChange({ ...spec, whitelist: { ...wl, players } })} />
      </div>
      <ListField id="sf-ops" label="Operadores (OPS)" value={spec.ops} rows={6} placeholder="Lobo"
        hint="Nombre de Java o UUID, uno por línea. Quitar a alguien aquí le quita el op al reiniciar (lista vacía = no se toca ops.json)."
        onChange={(ops) => onChange({ ...spec, ops: ops.length ? ops : undefined })} />
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/network-section.tsx`:
```tsx
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EditableSpec } from "@/lib/spec-edit";
import { NumberField, RequiredSelect, type ReportError } from "./fields";

type Extra = EditableSpec["ports"]["extra"][number];
const PROTOS = [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }] as const;

function toPort(text: string): number { const n = Number(text); return Number.isInteger(n) ? n : 0; }

/** Sección "Red": puerto de juego (en el host) y puertos extra (Geyser, voz, mapas web…). */
export function NetworkSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const extra = spec.ports.extra;
  const setExtra = (list: Extra[]) => onChange({ ...spec, ports: { ...spec.ports, extra: list } });
  const update = (i: number, patch: Partial<Extra>) => setExtra(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xs">
        <NumberField id="sf-port" label="Puerto de juego (host)" value={spec.ports.game} min={1} max={65535} onError={onError}
          hint="Dentro del contenedor siempre es 25565. Vacío = el panel elige uno libre."
          onChange={(game) => onChange({ ...spec, ports: { ...spec.ports, game } })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Puertos extra</div>
        {extra.length === 0 && <p className="text-xs text-muted-foreground">Ninguno. RCON (25575) nunca se publica.</p>}
        {extra.map((e, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_6rem_1.5fr_auto] items-center gap-2">
            <Input aria-label="Puerto en el host" inputMode="numeric" value={e.host || ""} placeholder="host" onChange={(ev) => update(i, { host: toPort(ev.target.value) })} />
            <Input aria-label="Puerto en el contenedor" inputMode="numeric" value={e.container || ""} placeholder="contenedor" onChange={(ev) => update(i, { container: toPort(ev.target.value) })} />
            <RequiredSelect id={`sf-proto-${i}`} value={e.proto} options={PROTOS} onChange={(p) => update(i, { proto: p as Extra["proto"] })} />
            <Input aria-label="Etiqueta" value={e.label} maxLength={40} placeholder="Geyser, voz…" onChange={(ev) => update(i, { label: ev.target.value })} />
            <Button type="button" size="icon" variant="ghost" aria-label="Quitar puerto" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExtra([...extra, { host: 0, container: 0, proto: "tcp", label: "" }])}>
            <Plus className="size-4" /> Añadir puerto
          </Button>
        </div>
      </div>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/resources-section.tsx`:
```tsx
import { Input } from "@/components/ui/input";
import { RESTART_POLICIES } from "@/lib/spec-catalog";
import type { EditableSpec } from "@/lib/spec-edit";
import { Field, NumberField, RequiredSelect, type ReportError } from "./fields";

/** Sección "Recursos": memoria de la JVM, límites del contenedor y política de reinicio. */
export function ResourcesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id="sf-memory" label="Memoria de la JVM (MEMORY)" hint="Ej. 4G o 512M.">
        <Input id="sf-memory" value={spec.memory} onChange={(e) => onChange({ ...spec, memory: e.target.value.trim() })} />
      </Field>
      <Field id="sf-memlimit" label="Límite de RAM del contenedor" hint="Vacío = sin límite. Si lo pones, al menos la memoria de la JVM (mejor +1G).">
        <Input id="sf-memlimit" value={spec.resources.memLimit} placeholder="5G" onChange={(e) => onChange({ ...spec, resources: { ...spec.resources, memLimit: e.target.value.trim() } })} />
      </Field>
      <NumberField id="sf-cpus" label="Límite de CPUs" value={spec.resources.cpus || undefined} min={0} max={256} integer={false} placeholder="2" onError={onError}
        hint="Vacío = sin límite. Admite decimales (1.5)." onChange={(cpus) => onChange({ ...spec, resources: { ...spec.resources, cpus: cpus ?? 0 } })} />
      <Field id="sf-restart" label="Política de reinicio">
        <RequiredSelect id="sf-restart" value={spec.restartPolicy} options={RESTART_POLICIES}
          onChange={(v) => onChange({ ...spec, restartPolicy: v as EditableSpec["restartPolicy"] })} />
      </Field>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/advanced-section.tsx`:
```tsx
import type { EditableSpec } from "@/lib/spec-edit";
import { KvField, type ReportError } from "./fields";

/** Sección "Avanzado": variables de entorno libres de la imagen itzg (ganan sobre lo generado). */
export function AdvancedSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <KvField id="sf-env" label="Variables de entorno extra (CLAVE=valor por línea)" value={spec.env} rows={10} onError={onError}
      placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false\nMODRINTH_DOWNLOAD_DEPENDENCIES=required"}
      hint="Ganan sobre lo que generan las demás secciones. No se pueden fijar EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES ni CF_API_KEY (la API key de CurseForge se configura aparte)."
      onChange={(env) => onChange({ ...spec, env })} />
  );
}
```

- [ ] **Step 4: Composición**

`panel/apps/web/src/components/spec-form/spec-form.tsx`:
```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EditableSpec } from "@/lib/spec-edit";
import type { ReportError } from "./fields";
import { VersionSection } from "./version-section";
import { PropertiesSection } from "./properties-section";
import { PlayersSection } from "./players-section";
import { NetworkSection } from "./network-section";
import { ResourcesSection } from "./resources-section";
import { AdvancedSection } from "./advanced-section";

/**
 * Formulario de spec por secciones (spec §8). Controlado: `value` + `onChange`. Lo usan la
 * pestaña Configuración (mode "server") y el editor de plantillas (mode "template", sin Red).
 * La sección Backups es del Plan 4 y vive en su propia pestaña.
 * `general` es el contenido propio de quien lo usa (nombre, descripción, RCON…).
 */
export function SpecForm({ value, onChange, onError, mode, general }: {
  value: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError; mode: "server" | "template"; general: React.ReactNode;
}) {
  const props = { spec: value, onChange, onError };
  return (
    <Tabs defaultValue="general" className="flex flex-col gap-4">
      <TabsList className="flex-wrap">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="version">Versión y mods</TabsTrigger>
        <TabsTrigger value="properties">Propiedades</TabsTrigger>
        <TabsTrigger value="players">Jugadores</TabsTrigger>
        {mode === "server" && <TabsTrigger value="network">Red</TabsTrigger>}
        <TabsTrigger value="resources">Recursos</TabsTrigger>
        <TabsTrigger value="advanced">Avanzado</TabsTrigger>
      </TabsList>
      {/* forceMount: los campos guardan su texto local; desmontarlos al cambiar de pestaña lo perdería. */}
      <TabsContent forceMount value="general" className="data-[state=inactive]:hidden">{general}</TabsContent>
      <TabsContent forceMount value="version" className="data-[state=inactive]:hidden"><VersionSection spec={value} onChange={onChange} /></TabsContent>
      <TabsContent forceMount value="properties" className="data-[state=inactive]:hidden"><PropertiesSection {...props} /></TabsContent>
      <TabsContent forceMount value="players" className="data-[state=inactive]:hidden"><PlayersSection spec={value} onChange={onChange} /></TabsContent>
      {mode === "server" && <TabsContent forceMount value="network" className="data-[state=inactive]:hidden"><NetworkSection {...props} /></TabsContent>}
      <TabsContent forceMount value="resources" className="data-[state=inactive]:hidden"><ResourcesSection {...props} /></TabsContent>
      <TabsContent forceMount value="advanced" className="data-[state=inactive]:hidden"><AdvancedSection {...props} /></TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 5: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS (2 tests de `SpecForm`: todas las secciones pintan sus valores, ninguna se llama «Backups», y en plantillas no hay Red).

- [ ] **Step 6: Commit**

```bash
git add panel/apps/web/src/components/spec-form/
git commit -m "feat(web): formulario de spec por secciones con propiedades tipadas, jugadores, red, recursos y avanzado

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web — página Plantillas y editor de plantillas

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/hooks/use-templates.ts`, `panel/apps/web/src/routes/templates.tsx`, `panel/apps/web/src/routes/template-edit.tsx`
- Modify: `panel/apps/web/src/router.tsx` (bajo ancla `plan-3`), `panel/apps/web/src/components/layout.tsx` (entrada de navegación, fuera de ancla)

**Interfaces:**
- Consumes: endpoints de plantillas (Task 5), `TemplateDto`/`api` (Task 6), `SpecForm`/`Field` (Tasks 7–8), `FORM_KEYS`, `buildSpecPatch`, `editableFromTemplate`, `validateSpec` (Task 6), `useServers` (Plan 1), `defaultSpecInput` (`@mcsm/shared`).
- Produces: hooks `useTemplates()` (query `["templates"]`) y `useTemplate(id)` (query `["template", id]`); páginas `TemplatesPage` (`/templates`: lista, crear servidor → `/servers/new?template=<id>`, editar, duplicar, borrar con confirmación), `NewTemplatePage` (`/templates/new`) y `EditTemplatePage` (`/templates/$templateId`, id de ruta `/app/templates/$templateId`); exports `templatesRoute`, `newTemplateRoute`, `templateRoute`; entrada «Plantillas» en la barra lateral.

- [ ] **Step 1: Hooks y páginas**

`panel/apps/web/src/hooks/use-templates.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import { api, type TemplateDto } from "@/lib/api";

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateDto[]>("/api/templates") });
}

export function useTemplate(id: string) {
  return useQuery({ queryKey: ["template", id], queryFn: () => api.get<TemplateDto>(`/api/templates/${id}`) });
}
```

`panel/apps/web/src/routes/templates.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, type TemplateDto } from "@/lib/api";
import { typeLabel } from "@/lib/spec-catalog";
import { useTemplates } from "@/hooks/use-templates";
import { useServers } from "@/hooks/use-servers";

/** Página Plantillas: lista, crear, editar, duplicar, borrar y "crear servidor desde plantilla". */
export function TemplatesPage() {
  const templates = useTemplates();
  const servers = useServers();
  const qc = useQueryClient();
  const [toDelete, setToDelete] = useState<TemplateDto | null>(null);
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<TemplateDto>(`/api/templates/${id}/duplicate`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/templates/${id}`),
    onSuccess: () => { setToDelete(null); void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name : undefined);
  const actionError = duplicate.error ?? del.error;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Plantillas</h1>
        <Button asChild><Link to="/templates/new"><Plus className="size-4" /> Nueva plantilla</Link></Button>
      </div>
      <p className="text-sm text-muted-foreground">Una plantilla guarda toda la configuración de un servidor salvo nombre, puertos y contraseña RCON. Créalas desde cero o con «Guardar como plantilla» en la configuración de un servidor.</p>
      {templates.isError && <p role="alert" className="text-sm text-red-400">No se pudieron cargar las plantillas: {templates.error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-red-400">{actionError instanceof ApiError ? actionError.message : "Error inesperado"}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Tipo</TableHead><TableHead>Memoria</TableHead><TableHead>Origen</TableHead><TableHead><span className="sr-only">Acciones</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {templates.isPending && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Cargando plantillas…</TableCell></TableRow>}
          {templates.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Aún no hay plantillas.</TableCell></TableRow>}
          {templates.data?.map((t) => (
            <TableRow key={t.id} data-testid={`template-row-${t.id}`}>
              <TableCell>
                <Link to="/templates/$templateId" params={{ templateId: t.id }} className="font-medium hover:underline">{t.name}</Link>
                {t.description && <div className="max-w-md truncate text-xs text-muted-foreground">{t.description}</div>}
              </TableCell>
              <TableCell>{typeLabel(t.spec.type)} {t.spec.version}{t.spec.modpack ? ` · ${t.spec.modpack.slugOrUrl}` : ""}</TableCell>
              <TableCell>{t.spec.memory}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{t.sourceServerId ? `«${serverName(t.sourceServerId) ?? "servidor"}»` : "—"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm"><Link to="/servers/new" search={{ template: t.id }}><Rocket className="size-4" /> Crear servidor</Link></Button>
                  <Button asChild size="icon" variant="ghost" aria-label={`Editar ${t.name}`}><Link to="/templates/$templateId" params={{ templateId: t.id }}><Pencil className="size-4" /></Link></Button>
                  <Button size="icon" variant="ghost" aria-label={`Duplicar ${t.name}`} disabled={duplicate.isPending} onClick={() => duplicate.mutate(t.id)}><Copy className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Borrar ${t.name}`} onClick={() => { del.reset(); setToDelete(t); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o && !del.isPending) setToDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Borrar la plantilla «{toDelete?.name}»</DialogTitle>
            <DialogDescription>Los servidores creados con ella no se ven afectados.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setToDelete(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => toDelete && del.mutate(toDelete.id)}>{del.isPending ? "Borrando…" : "Borrar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

`panel/apps/web/src/routes/template-edit.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { defaultSpecInput } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SpecForm } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { api, ApiError, type TemplateDto } from "@/lib/api";
import { FORM_KEYS, buildSpecPatch, editableFromTemplate, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { useTemplate } from "@/hooks/use-templates";

const TEMPLATE_KEYS = FORM_KEYS.filter((k) => k !== "ports");
const withoutPorts = ({ ports: _ports, ...rest }: EditableSpec) => rest;

function TemplateEditor({ template }: { template?: TemplateDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const initial = template ? editableFromTemplate(template.spec) : defaultSpecInput();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [spec, setSpec] = useState<EditableSpec>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const reportError = (field: string, message: string | null) =>
    setErrors((e) => {
      if (message === null) { if (!(field in e)) return e; const { [field]: _gone, ...rest } = e; return rest; }
      return e[field] === message ? e : { ...e, [field]: message };
    });

  const save = useMutation({
    mutationFn: () => template
      ? api.patch<TemplateDto>(`/api/templates/${template.id}`, {
        name: name.trim(), description: description.trim(),
        spec: buildSpecPatch(editableFromTemplate(template.spec), spec, TEMPLATE_KEYS),
      })
      : api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), spec: withoutPorts(spec) }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["templates"] });
      qc.setQueryData(["template", t.id], t);
      void navigate({ to: "/templates" });
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    if (!name.trim()) return setLocalErr("El nombre es obligatorio");
    const fieldError = Object.values(errors)[0];
    if (fieldError) return setLocalErr(fieldError);
    const invalid = validateSpec(spec, "template");
    if (invalid) return setLocalErr(invalid);
    save.mutate();
  };

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="tpl-name" label="Nombre de la plantilla"><Input id="tpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="tpl-desc" label="Descripción (opcional)"><Textarea id="tpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Las plantillas no guardan puertos ni contraseña RCON: el panel los asigna al crear cada servidor.</p>
    </div>
  );
  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Error inesperado" : null);

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{template ? `Plantilla «${template.name}»` : "Nueva plantilla"}</h1>
        <Button asChild variant="ghost"><Link to="/templates">Volver</Link></Button>
      </div>
      <SpecForm value={spec} onChange={setSpec} onError={reportError} mode="template" general={general} />
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div><Button type="submit" disabled={save.isPending}>{save.isPending ? "Guardando…" : template ? "Guardar cambios" : "Crear plantilla"}</Button></div>
    </form>
  );
}

export function NewTemplatePage() {
  return <TemplateEditor />;
}

export function EditTemplatePage() {
  const { templateId } = useParams({ from: "/app/templates/$templateId" });
  const q = useTemplate(templateId);
  if (q.isPending) return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cargando…</div>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <div role="alert" className="p-6 text-red-400">{notFound ? "Plantilla no encontrada" : `No se pudo cargar la plantilla: ${q.error.message}`}</div>;
  }
  return <TemplateEditor key={q.data.id} template={q.data} />;
}
```

- [ ] **Step 2: Rutas y navegación**

En `panel/apps/web/src/router.tsx`, imports junto a los demás:
```ts
import { TemplatesPage } from "./routes/templates";
import { EditTemplatePage, NewTemplatePage } from "./routes/template-edit";
```
debajo de la ancla `plan-3` de las definiciones de rutas (o justo encima de `routeTree` si la ancla solo está en el árbol):
```ts
// ── plan-3 ──
export const templatesRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates", component: TemplatesPage });
export const newTemplateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/new", component: NewTemplatePage });
export const templateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/$templateId", component: EditTemplatePage });
```
y en los hijos de `appRoute`, debajo de la ancla `plan-3`: `templatesRoute, newTemplateRoute, templateRoute`. (TanStack Router prioriza el segmento estático `new` sobre `$templateId`, igual que `/servers/new` frente a `/servers/$serverId`.)

En `panel/apps/web/src/components/layout.tsx` (fuera de ancla), importa `LayoutTemplate` de `lucide-react` y añade al array `nav`, después de «Nodos»:
```ts
  { to: "/templates", label: "Plantillas", icon: LayoutTemplate },
```

- [ ] **Step 3: Verificar**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS y build sin errores. Prueba manual (`pnpm dev:api` + `pnpm dev:web`, sesión iniciada): **Plantillas → Nueva plantilla**, tipo Fabric, mod `lithium`, guardar → aparece en la lista con «Fabric LATEST»; **Duplicar** crea «… (copia)»; **Editar** conserva los valores; **Borrar** pide confirmación; recargar `/templates/<id>` directamente funciona; una plantilla con el tipo «Modpack de Modrinth» sin slug muestra «modpack.slugOrUrl: …» y no se guarda.

- [ ] **Step 4: Commit**

```bash
git add panel/apps/web/src/
git commit -m "feat(web): página de plantillas con editor, duplicar, borrar y crear servidor desde plantilla

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web — pestaña Configuración por secciones, diff antes de aplicar y «Guardar como plantilla»

**Agent:** web-ui-dev

**Files:**
- Replace: `panel/apps/web/src/components/server-config-form.tsx` (el del Plan 1)
- Create: `panel/apps/web/src/components/save-template-dialog.tsx`, `panel/apps/web/src/components/server-config-form.test.tsx`
- Delete: `panel/apps/web/src/lib/spec-form.ts`, `panel/apps/web/src/lib/spec-form.test.ts` (solo los usaba el formulario viejo; `spec-edit.ts` los sustituye)

**Interfaces:**
- Consumes: `SpecForm`, `Field` (Tasks 7–8); `buildSpecPatch`, `editableSpec`, `validateSpec`, `EditableSpec` (Task 6); `diffSpecs`, `DiffLine` (Task 6); `canonicalJson`, `mergeSpecPatch`, `SpecPatch` (`@mcsm/shared`); `POST /api/templates {fromServerId}` (Task 5); `ServerDto` (Plan 1).
- Produces: `ServerConfigForm({ server: ServerDto })` con la **misma firma** que el del Plan 1, así que `routes/server.tsx` no se toca (`<ServerConfigForm key={s.id} server={s} />`). Mantiene del Plan 1: detección de cambios hechos fuera (versión distinta con/sin cambios locales), revelar RCON y diálogo de cambios antes de aplicar. Nuevo: PATCH mínimo (`{ name? , spec?: SpecPatch }`), diff con etiquetas en castellano calculado contra lo que quedará tras el merge, aviso de recreación del contenedor y `SaveTemplateDialog({ server })`.

- [ ] **Step 1: Test de humo (falla)**

`panel/apps/web/src/components/server-config-form.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerConfigForm } from "./server-config-form";
import type { ServerDto } from "@/lib/api";

const server: ServerDto = {
  id: "s1", nodeId: "n1", name: "Supervivencia", slug: "supervivencia", specVersion: 3, desiredState: "running",
  observed: null, observedSpecVersion: 3, observedAt: null, createdAt: "", updatedAt: "",
  spec: {
    imageTag: "java21", type: "FABRIC", version: "1.21.4", memory: "4G", properties: { motd: "Hola" }, env: {},
    resources: { cpus: 0, memLimit: "" }, restartPolicy: "unless-stopped",
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    ports: { game: 25565, extra: [] }, rconPassword: "secretosecreto",
  },
};

describe("ServerConfigForm (render en servidor)", () => {
  it("pinta el formulario por secciones, oculta RCON y ofrece guardar como plantilla", () => {
    const html = renderToString(<QueryClientProvider client={new QueryClient()}><ServerConfigForm server={server} /></QueryClientProvider>);
    expect(html).toContain("Supervivencia");
    expect(html).toContain("mcsm-supervivencia");
    expect(html).toContain("lithium");
    expect(html).toContain("Guardar como plantilla");
    expect(html).toContain("Revisar y aplicar");
    expect(html).not.toContain("secretosecreto");
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (el formulario del Plan 1 no contiene «Guardar como plantilla» ni `mcsm-supervivencia`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/components/save-template-dialog.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError, type ServerDto, type TemplateDto } from "@/lib/api";

/** "Guardar como plantilla": copia la spec APLICADA del servidor sin puertos ni rconPassword (lo quita el panel). */
export function SaveTemplateDialog({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), fromServerId: server.id }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setName(server.name); setDescription(""); save.reset(); } }}>
      <DialogTrigger asChild><Button type="button" variant="secondary"><BookmarkPlus className="size-4" /> Guardar como plantilla</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Guardar «{server.name}» como plantilla</DialogTitle>
          <DialogDescription>Se guarda la configuración aplicada (v{server.specVersion}) sin puertos ni contraseña RCON. Los cambios sin aplicar no se incluyen.</DialogDescription>
        </DialogHeader>
        {save.isSuccess ? (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-emerald-400">Plantilla «{save.data.name}» creada.</p>
            <DialogFooter>
              <Button asChild variant="secondary"><Link to="/templates">Ver plantillas</Link></Button>
              <Button type="button" onClick={() => setOpen(false)}>Cerrar</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="tpl-name">Nombre</Label><Input id="tpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="tpl-desc">Descripción (opcional)</Label><Textarea id="tpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Error inesperado"}</p>}
            <DialogFooter><Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? "Guardando…" : "Guardar plantilla"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Sustituye `panel/apps/web/src/components/server-config-form.tsx` entero por:
```tsx
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { canonicalJson, mergeSpecPatch, type SpecPatch } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SpecForm } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { SaveTemplateDialog } from "@/components/save-template-dialog";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { buildSpecPatch, editableSpec, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { diffSpecs, type DiffLine } from "@/lib/spec-diff";

interface Pending { name?: string; spec?: SpecPatch; changes: DiffLine[]; recreate: boolean }

const toEditable = (s: ServerDto): EditableSpec => editableSpec(s.spec) as EditableSpec;

/** Pestaña Configuración: formulario por secciones, diff antes de aplicar y PATCH mínimo (merge). */
export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [spec, setSpec] = useState<EditableSpec>(() => toEditable(server));
  // Línea base: lo cargado en el formulario y su versión (para detectar cambios hechos fuera).
  const [base, setBase] = useState(() => ({ version: server.specVersion, name: server.name, spec: toEditable(server) }));
  const [formKey, setFormKey] = useState(0); // remonta los campos (que guardan texto local) al recargar
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showRcon, setShowRcon] = useState(false);

  const dirty = name !== base.name || canonicalJson(spec) !== canonicalJson(base.spec);
  const stale = server.specVersion !== base.version;
  const resetTo = (s: ServerDto) => {
    const sp = toEditable(s);
    setName(s.name); setSpec(sp); setBase({ version: s.specVersion, name: s.name, spec: sp });
    setErrors({}); setLocalErr(null); setFormKey((k) => k + 1);
  };
  useEffect(() => { if (stale && !dirty) resetTo(server); }, [stale, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const reportError = (field: string, message: string | null) =>
    setErrors((e) => {
      if (message === null) { if (!(field in e)) return e; const { [field]: _gone, ...rest } = e; return rest; }
      return e[field] === message ? e : { ...e, [field]: message };
    });

  const save = useMutation({
    mutationFn: (p: Pending) => api.patch<ServerDto>(`/api/servers/${server.id}`, { ...(p.name ? { name: p.name } : {}), ...(p.spec ? { spec: p.spec } : {}) }),
    onSuccess: (dto) => {
      setPending(null);
      resetTo(dto);
      qc.setQueryData(["server", server.id], dto);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: () => setPending(null),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    const trimmed = name.trim();
    if (!trimmed) return setLocalErr("El nombre no puede estar vacío");
    const fieldError = Object.values(errors)[0];
    if (fieldError) return setLocalErr(fieldError);
    const invalid = validateSpec(spec, "server");
    if (invalid) return setLocalErr(invalid);
    const patch = buildSpecPatch(base.spec, spec);
    const hasSpec = Object.keys(patch).length > 0;
    // El diff compara lo guardado con lo que quedará tras el merge del panel.
    const changes = hasSpec ? diffSpecs(base.spec, mergeSpecPatch(base.spec, patch)) : [];
    if (trimmed !== base.name) changes.unshift({ label: "Nombre", before: base.name, after: trimmed });
    if (changes.length === 0) return setLocalErr("No hay cambios que aplicar");
    setPending({ name: trimmed !== base.name ? trimmed : undefined, spec: hasSpec ? patch : undefined, changes, recreate: hasSpec });
  };

  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Error inesperado" : null);

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="cf-name" label="Nombre"><Input id="cf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="text-sm text-muted-foreground">Slug <code className="rounded bg-muted px-1">{server.slug}</code> · contenedor <code className="rounded bg-muted px-1">{`mcsm-${server.slug}`}</code></div>
      {server.spec.rconPassword && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Contraseña RCON:</span>
          <code className="rounded bg-muted px-1.5 py-0.5" data-testid="rcon">{showRcon ? server.spec.rconPassword : "••••••••••••"}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowRcon((s) => !s)} aria-pressed={showRcon}>
            {showRcon ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{showRcon ? "Ocultar" : "Revelar"}
          </Button>
        </div>
      )}
      <div><SaveTemplateDialog server={server} /></div>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6" data-testid="config-form">
      <SpecForm key={formKey} value={spec} onChange={setSpec} onError={reportError} mode="server" general={general} />
      {stale && dirty && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700 bg-amber-950/30 p-2 text-sm text-amber-300">
          La configuración cambió en el servidor (v{server.specVersion}) y tienes cambios sin guardar.
          <Button type="button" size="sm" variant="secondary" onClick={() => resetTo(server)}>Recargar y descartar mis cambios</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Guardado (v{save.data.specVersion}). El agente recreará el contenedor si hace falta.</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>Revisar y aplicar</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => resetTo(server)}>Descartar cambios</Button>}
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Aplicar cambios en «{base.name}»</DialogTitle>
            <DialogDescription>{pending?.recreate ? "El contenedor se recreará: si el servidor está en marcha, se reiniciará (el mundo no se toca)." : "Solo cambia el nombre: el contenedor no se toca."}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-1 overflow-auto text-xs" data-testid="spec-diff">
            {pending?.changes.map((c) => (
              <li key={c.label} className="rounded border border-border p-2">
                <div className="text-muted-foreground">{c.label}</div>
                <div className="break-all font-mono text-red-300">- {c.before}</div>
                <div className="break-all font-mono text-emerald-300">+ {c.after}</div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>Cancelar</Button>
            <Button type="button" disabled={save.isPending} onClick={() => pending && save.mutate(pending)}>{save.isPending ? "Aplicando…" : "Aplicar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
```

Borra el formulario viejo y su lógica:
```bash
git rm panel/apps/web/src/lib/spec-form.ts panel/apps/web/src/lib/spec-form.test.ts
grep -rn "lib/spec-form\|@/routes/new-server" panel/apps/web/src || true
```
Expected del `grep`: sin resultados (el formulario nuevo importa los catálogos de `lib/spec-catalog`, no de `routes/new-server`).

- [ ] **Step 4: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS y build sin errores.

Prueba manual con un servidor existente (`pnpm dev:api`, `pnpm dev:web`, agente del compose de desarrollo): pestaña **Configuración** → pestañas General/Versión y mods/Propiedades/Jugadores/Red/Recursos/Avanzado (sin Backups). Cambia «Dificultad» a `hard` y añade `Lobo` a la whitelist activada → **Revisar y aplicar** muestra «Propiedad difficulty: — → hard» y «Whitelist: — → activada: Lobo» y avisa de que se recreará el contenedor → **Aplicar** → «Guardado (vN)» y el estado pasa por «Aplicando vN…». Cambiar solo el nombre dice «Solo cambia el nombre» y no incrementa la versión. Escribir `motd` (sin `=`) en «Otras propiedades» muestra el error y bloquea el envío. **Guardar como plantilla** crea la plantilla y ofrece «Ver plantillas».

- [ ] **Step 5: Commit**

```bash
git add -A panel/apps/web/src/
git commit -m "feat(web): configuración por secciones con diff, PATCH mínimo y guardar como plantilla

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — asistente de nuevo servidor en 3 pasos

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/lib/wizard.ts`, `panel/apps/web/src/lib/wizard.test.ts`
- Replace: `panel/apps/web/src/routes/new-server.tsx` (el de un paso del Plan 1)
- Modify: `panel/apps/web/src/router.tsx` (`newServerRoute` con `validateSearch`, fuera de ancla)

**Interfaces:**
- Consumes: `POST /api/servers` (Plan 1, spec con merge de defaults), `POST /api/templates/:id/servers` (Task 5), `useTemplates` (Task 9), `useNodes` (Plan 1), `VersionSection`/`Field` (Task 7), `validateSpec`, `EditableSpec` (Task 6), `typeLabel` (Task 6), `slugify`/`defaultSpecInput` (`@mcsm/shared`).
- Produces: `createRequest(source, target): { url, body }`, `summarizeSpec(spec): {label, value}[]`, `WizardTarget`; `NewServerPage` en 3 pasos (**Plantilla o desde cero → Nodo y nombre → Revisar**), que acepta `?template=<id>` (empieza en el paso 2 con esa plantilla). `newServerRoute` valida la búsqueda como `{ template?: string }`.

- [ ] **Step 1: Test (falla)**

`panel/apps/web/src/lib/wizard.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import { createRequest, summarizeSpec } from "./wizard";

describe("asistente de nuevo servidor", () => {
  it("desde plantilla llama al endpoint de la plantilla y solo pasa el puerto si se dio", () => {
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: " Survival ", start: true })).toEqual({
      url: "/api/templates/t1/servers", body: { nodeId: "n", name: "Survival", desiredState: "running" },
    });
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: "S", port: 25570, start: false }).body).toMatchObject({ port: 25570, desiredState: "stopped" });
  });
  it("desde cero envía la spec con el puerto de juego solo si se dio", () => {
    const spec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const r = createRequest({ spec }, { nodeId: "n", name: "Fabric", start: true });
    expect(r.url).toBe("/api/servers");
    expect(r.body.spec).toMatchObject({ type: "FABRIC", mods: { modrinthProjects: ["lithium"] }, ports: { extra: [] } });
    expect((r.body.spec as { ports: object }).ports).not.toHaveProperty("game");
    expect(createRequest({ spec }, { nodeId: "n", name: "F", port: 25599, start: true }).body.spec).toMatchObject({ ports: { game: 25599 } });
  });
  it("resume la spec", () => {
    const t = templateSpecSchema.parse({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" }, memory: "6G", whitelist: { enabled: true, players: ["Lobo"] }, mods: { modrinthProjects: ["a", "b"] } });
    expect(summarizeSpec(t)).toEqual(expect.arrayContaining([
      { label: "Tipo", value: "Modpack de Modrinth" },
      { label: "Modpack", value: "cobblemon-fabric" },
      { label: "Memoria", value: "6G" },
      { label: "Mods", value: "2 mods" },
      { label: "Whitelist", value: "1 jugador" },
    ]));
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './wizard'`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/lib/wizard.ts`:
```ts
import type { TemplateSpec } from "@mcsm/shared";
import type { EditableSpec } from "./spec-edit";
import { typeLabel } from "./spec-catalog";

export interface WizardTarget { nodeId: string; name: string; port?: number; start: boolean }

/** Petición de creación: desde plantilla (el panel copia su spec) o desde cero (spec del paso 1). */
export function createRequest(source: { templateId: string } | { spec: EditableSpec }, t: WizardTarget): { url: string; body: Record<string, unknown> } {
  const desiredState = t.start ? "running" : "stopped";
  if ("templateId" in source) {
    return { url: `/api/templates/${source.templateId}/servers`, body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, ...(t.port ? { port: t.port } : {}) } };
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
  return lines;
}
```

Sustituye `panel/apps/web/src/routes/new-server.tsx` entero por:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { defaultSpecInput, slugify } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/spec-form/fields";
import { VersionSection } from "@/components/spec-form/version-section";
import { api, type ServerDto } from "@/lib/api";
import { validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { createRequest, summarizeSpec } from "@/lib/wizard";
import { typeLabel } from "@/lib/spec-catalog";
import { cn } from "@/lib/utils";
import { useNodes } from "@/hooks/use-nodes";
import { useTemplates } from "@/hooks/use-templates";

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [{ n: 1, label: "Plantilla o desde cero" }, { n: 2, label: "Nodo y nombre" }, { n: 3, label: "Revisar" }];
const SCRATCH = "__scratch__";

/** Asistente de nuevo servidor en 3 pasos (spec §8). `?template=<id>` lo abre con esa plantilla elegida. */
export function NewServerPage() {
  const { template: preselected } = useSearch({ from: "/app/servers/new" });
  const nodes = useNodes();
  const templates = useTemplates();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(preselected ? 2 : 1);
  const [source, setSource] = useState<string>(preselected ?? SCRATCH);
  const [spec, setSpec] = useState<EditableSpec>(() => ({ ...defaultSpecInput(), type: "PAPER", imageTag: "java21", memory: "4G" }));
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [start, setStart] = useState(true);
  const [stepErr, setStepErr] = useState<string | null>(null);

  const tpl = source === SCRATCH ? undefined : templates.data?.find((t) => t.id === source);
  const portNum = port.trim() === "" ? undefined : Number(port);
  const portInvalid = portNum !== undefined && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535);
  const selectedNode = nodes.data?.find((n) => n.id === nodeId);
  const online = nodes.data?.filter((n) => n.status === "online") ?? [];

  const create = useMutation({
    mutationFn: () => {
      // Nunca crear "desde cero" por error si la plantilla aún no ha cargado o se borró.
      if (source !== SCRATCH && !tpl) throw new Error("La plantilla elegida no está disponible (¿se ha borrado?)");
      const req = createRequest(tpl ? { templateId: tpl.id } : { spec }, { nodeId, name, port: portNum, start });
      return api.post<ServerDto>(req.url, req.body);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers/$serverId", params: { serverId: s.id } });
    },
  });

  const next = () => {
    setStepErr(null);
    if (step === 1) {
      if (source !== SCRATCH && !tpl) return setStepErr("La plantilla elegida ya no existe");
      if (source === SCRATCH) { const invalid = validateSpec(spec, "server"); if (invalid) return setStepErr(invalid); }
      return setStep(2);
    }
    if (step === 2) {
      if (!nodeId) return setStepErr("Elige un nodo");
      if (!name.trim()) return setStepErr("Escribe un nombre");
      if (portInvalid) return setStepErr("El puerto debe ser un número entre 1 y 65535");
      return setStep(3);
    }
  };
  const back = () => { setStepErr(null); create.reset(); setStep((s) => (s > 1 ? ((s - 1) as Step) : s)); };

  const summary = tpl ? summarizeSpec(tpl.spec) : source === SCRATCH ? summarizeSpec(spec) : [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Pasos">
        {STEPS.map((s) => (
          <li key={s.n} aria-current={s.n === step ? "step" : undefined}
            className={cn("rounded-full border px-3 py-1", s.n === step ? "border-ring bg-accent" : s.n < step ? "border-emerald-800 text-emerald-400" : "border-border text-muted-foreground")}>
            {s.n < step ? <Check className="mr-1 inline size-3" /> : `${s.n}. `}{s.label}
          </li>
        ))}
      </ol>

      <Card className="max-w-4xl">
        <CardHeader><CardTitle>Nuevo servidor</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-5">
          {step === 1 && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Origen">
                <SourceCard selected={source === SCRATCH} onSelect={() => setSource(SCRATCH)} title="Desde cero" subtitle="Elige tipo, versión y mods. El resto se ajusta después en Configuración." />
                {templates.data?.map((t) => (
                  <SourceCard key={t.id} selected={source === t.id} onSelect={() => setSource(t.id)} title={t.name}
                    subtitle={`${typeLabel(t.spec.type)} ${t.spec.version} · ${t.spec.memory}${t.description ? ` · ${t.description}` : ""}`} />
                ))}
              </div>
              {templates.isError && <p role="alert" className="text-xs text-red-400">No se pudieron cargar las plantillas: {templates.error.message}</p>}
              {source === SCRATCH && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <VersionSection spec={spec} onChange={setSpec} />
                  <div className="max-w-xs">
                    <Field id="ns-mem" label="Memoria de la JVM" hint="Ej. 4G o 512M.">
                      <Input id="ns-mem" value={spec.memory} onChange={(e) => setSpec({ ...spec, memory: e.target.value.trim() })} />
                    </Field>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="ns-node" label="Nodo">
                <Select value={nodeId} onValueChange={setNodeId}>
                  <SelectTrigger id="ns-node"><SelectValue placeholder={nodes.isPending ? "Cargando nodos…" : "Elige un nodo"} /></SelectTrigger>
                  <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (desconectado, se creará al volver)" : ""}</SelectItem>)}</SelectContent>
                </Select>
                {nodes.isError && <p role="alert" className="text-xs text-red-400">No se pudieron cargar los nodos: {nodes.error.message}</p>}
                {selectedNode && selectedNode.status !== "online" && <p className="text-xs text-amber-400">El nodo «{selectedNode.name}» está desconectado: el servidor se creará pero no arrancará hasta que vuelva.</p>}
                {nodes.data && online.length === 0 && <p className="text-xs text-amber-400">Ningún nodo conectado: el servidor se creará cuando el nodo vuelva.</p>}
              </Field>
              <Field id="ns-name" label="Nombre" hint={name.trim() ? <>Carpeta y contenedor: <code>{slugify(name)}</code> (si ya existe se añade -2, -3…)</> : undefined}>
                <Input id="ns-name" value={name} maxLength={60} placeholder="Supervivencia 2026" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field id="ns-port" label="Puerto de juego (vacío = automático)">
                <Input id="ns-port" value={port} inputMode="numeric" placeholder="25565" aria-invalid={portInvalid} onChange={(e) => setPort(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Arrancar al crear</label>
            </div>
          )}

          {step === 3 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm" data-testid="wizard-summary">
              <dt className="text-muted-foreground">Origen</dt><dd>{tpl ? `Plantilla «${tpl.name}»` : source === SCRATCH ? "Desde cero" : "Plantilla (cargando…)"}</dd>
              {summary.map((l) => <Row key={l.label} label={l.label} value={l.value} />)}
              <Row label="Nodo" value={selectedNode?.name ?? "—"} />
              <Row label="Nombre" value={name.trim()} />
              <Row label="Puerto" value={portNum ? String(portNum) : "automático"} />
              <Row label="Al crear" value={start ? "arrancar" : "dejar parado"} />
            </dl>
          )}

          {stepErr && <p role="alert" className="text-sm text-red-400">{stepErr}</p>}
          {create.error && <p role="alert" className="text-sm text-red-400">{create.error.message}</p>}
          <div className="flex justify-between">
            <Button type="button" variant="ghost" disabled={step === 1 || create.isPending} onClick={back}><ArrowLeft className="size-4" /> Atrás</Button>
            {step < 3
              ? <Button type="button" onClick={next}>Siguiente <ArrowRight className="size-4" /></Button>
              : <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creando…" : "Crear servidor"}</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></>;
}

function SourceCard({ selected, onSelect, title, subtitle }: { selected: boolean; onSelect: () => void; title: string; subtitle: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn("flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm hover:border-ring", selected ? "border-ring bg-accent" : "border-border")}>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}
```

En `panel/apps/web/src/router.tsx` (fuera de ancla), sustituye la definición de `newServerRoute` por:
```ts
export const newServerRoute = createRoute({
  getParentRoute: () => appRoute, path: "/servers/new", component: NewServerPage,
  // plan-3: ?template=<id> abre el asistente con esa plantilla elegida.
  validateSearch: (s: Record<string, unknown>): { template?: string } => (typeof s.template === "string" && s.template ? { template: s.template } : {}),
});
```
(Los `<Link to="/servers/new">` existentes sin `search` siguen compilando: la clave es opcional.)

- [ ] **Step 4: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS y build sin errores.

Prueba manual: **Nuevo servidor** → paso 1 «Desde cero», tipo Fabric, versión `1.21.4`, Java `java21`, mod `lithium` → Siguiente → paso 2 nodo + nombre (muestra el slug) → paso 3 resume «Tipo Fabric · Mods 1 mod · Puerto automático» → Crear → navega al detalle. Desde **Plantillas → Crear servidor** el asistente abre en el paso 2 con la plantilla elegida y el paso 3 dice «Origen: Plantilla «…»». Elegir «Modpack de Modrinth» sin slug y pulsar Siguiente muestra «modpack.slugOrUrl: …» y no avanza.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/
git commit -m "feat(web): asistente de nuevo servidor en 3 pasos desde cero o desde plantilla

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Verificación extremo a extremo y criterios de aceptación

**Agent:** infra-dev (Docker real; si algo falla sin causa obvia, `debugger`)

**Files:**
- Modify (solo si hay desviaciones): este plan, como nota al pie de esta tarea.

**Interfaces:**
- Consumes: todo lo anterior; `deploy/docker-compose.dev.yml` del Plan 1 (agente en Docker contra el panel en el host, red externa `mcsm`).
- Produces: evidencia de los criterios de aceptación del README de planes (Plan 3): *crear un servidor Fabric con `MODRINTH_PROJECTS=lithium` arranca y la consola muestra la descarga del mod; una plantilla reproduce un servidor idéntico salvo nombre, puerto y RCON.*

Reglas de Docker de este repo: solo se crean recursos `mcsm-test-…` (proyecto compose `mcsm-test-p3`, servidores con slug `test-…` → contenedores `mcsm-test-fabric`, `mcsm-test-fabric-copia`) y se borran al final. Nada de `docker system prune` ni de tocar contenedores ajenos. En Claude Code, las esperas (`until …; do sleep …; done`) se ejecutan con la herramienta Monitor; el panel, con `run_in_background`.

- [ ] **Step 1: Verificación completa**

```bash
eval "$(mise env)" && pnpm lint:proto && (cd agent && go vet ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build
```
Expected: todo en verde. `buf breaking` no aplica: este plan no toca `proto/`.

- [ ] **Step 2: Entorno de prueba**

```bash
export E2E=/tmp/mcsm-test-p3 J=/tmp/mcsm-test-p3/cookies API=http://localhost:8080
mkdir -p $E2E/panel $E2E/data
docker network inspect mcsm >/dev/null 2>&1 || { docker network create mcsm && touch $E2E/created-network; }
```
Arranca el panel en segundo plano (necesita el puerto 8080 libre: el compose de desarrollo apunta a `host.docker.internal:8080`):
```bash
PORT=8080 DATA_DIR=$E2E/panel pnpm --filter @mcsm/api start
```
Alta del nodo y agente con el código de este plan:
```bash
curl -sf -c $J -H 'content-type: application/json' -d '{"password":"correct horse battery"}' $API/api/auth/setup
TOKEN=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nameHint\":\"test-p3\",\"dataRoot\":\"$E2E/data\"}" $API/api/nodes/enrollment-tokens | jq -r .token)
ENROLL_TOKEN=$TOKEN DATA_ROOT=$E2E/data docker compose -p mcsm-test-p3 -f deploy/docker-compose.dev.yml up -d --build
until [ "$(curl -sf -b $J $API/api/nodes | jq -r '.[0].status')" = online ]; do sleep 2; done
NODE=$(curl -sf -b $J $API/api/nodes | jq -r '.[0].id')
```
Expected: el nodo pasa a `online` en segundos.

- [ ] **Step 3: Aceptación 1 — Fabric con `lithium`**

```bash
S1=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nodeId\":\"$NODE\",\"name\":\"Test Fabric\",\"slug\":\"test-fabric\",\"desiredState\":\"running\",\"spec\":{\"type\":\"FABRIC\",\"version\":\"1.21.4\",\"imageTag\":\"java21\",\"memory\":\"2G\",\"mods\":{\"modrinthProjects\":[\"lithium\"]},\"properties\":{\"motd\":\"Plan 3\",\"difficulty\":\"hard\"},\"whitelist\":{\"enabled\":true,\"players\":[\"Lobo\"]},\"ops\":[\"Lobo\"]}}" $API/api/servers | jq -r .id)
until docker inspect mcsm-test-fabric >/dev/null 2>&1; do sleep 2; done
docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(TYPE|MODRINTH_PROJECTS|ENABLE_WHITELIST|WHITELIST|OPS|EXISTING_[A-Z_]+|CF_API_KEY|MODPACK_PLATFORM)=' | sort
```
Expected (exactamente estas líneas; ni `CF_API_KEY` ni `MODPACK_PLATFORM`):
```
ENABLE_WHITELIST=true
EXISTING_OPS_FILE=SYNCHRONIZE
EXISTING_WHITELIST_FILE=SYNCHRONIZE
MODRINTH_PROJECTS=lithium
OPS=Lobo
TYPE=FABRIC
WHITELIST=Lobo
```
Abre la web (`pnpm dev:web`, `http://localhost:5173`, contraseña `correct horse battery`) → «Test Fabric» → **Consola** mientras arranca: aparecen las líneas de descarga de `lithium` (mc-image-helper) y, al cargar Fabric, la lista de mods con `- lithium …`. Por terminal:
```bash
until docker logs mcsm-test-fabric 2>&1 | grep -q 'Done ('; do sleep 5; done
docker logs mcsm-test-fabric 2>&1 | grep -i lithium
ls $E2E/data/test-fabric/data/mods/
```
Expected: varias líneas con `lithium` (descarga y `- lithium <versión>` de Fabric); en `mods/` un `lithium-fabric-*.jar`. En la web el servidor está «En marcha» con la versión aplicada.

- [ ] **Step 4: Aceptación 2 — la plantilla reproduce el servidor salvo nombre, puerto y RCON**

```bash
TPL=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"name\":\"test-p3 Fabric\",\"fromServerId\":\"$S1\"}" $API/api/templates)
echo "$TPL" | jq '.spec | has("ports"), has("rconPassword")'
S2=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nodeId\":\"$NODE\",\"name\":\"Test Fabric copia\",\"desiredState\":\"stopped\"}" $API/api/templates/$(echo "$TPL" | jq -r .id)/servers | jq -r .id)
diff <(curl -sf -b $J $API/api/servers/$S1 | jq -S '.spec | del(.ports, .rconPassword)') \
     <(curl -sf -b $J $API/api/servers/$S2 | jq -S '.spec | del(.ports, .rconPassword)') && echo SPEC_IGUAL
curl -sf -b $J $API/api/servers/$S1 | jq -c '[.slug, .spec.ports.game, (.spec.rconPassword|length)]'
curl -sf -b $J $API/api/servers/$S2 | jq -c '[.slug, .spec.ports.game, (.spec.rconPassword|length)]'
until docker inspect mcsm-test-fabric-copia >/dev/null 2>&1; do sleep 2; done
diff <(docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^RCON_PASSWORD=') \
     <(docker inspect mcsm-test-fabric-copia --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^RCON_PASSWORD=') && echo ENV_IGUAL
```
Expected: `false` `false`; `SPEC_IGUAL`; dos líneas con slugs `test-fabric` / `test-fabric-copia`, puertos distintos y RCON de 43 caracteres (distintas: compáralas con `.spec.rconPassword`); `ENV_IGUAL` (el contenedor de la copia solo difiere en `RCON_PASSWORD` y en el puerto publicado).

- [ ] **Step 5: Comprobaciones de los riesgos de la Review Focus**

```bash
# 3. PATCH parcial: solo ops; el resto se conserva y el agente lo aplica
curl -sf -b $J -X PATCH -H 'content-type: application/json' -d '{"spec":{"ops":["Lobo","Steve"]}}' $API/api/servers/$S1 | jq -c '[.specVersion, .spec.type, .spec.mods.modrinthProjects, .spec.whitelist.enabled]'
until docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'OPS=Lobo,Steve'; do sleep 2; done && echo OPS_APLICADO
# 4. La key de CurseForge no sale nunca hacia el navegador y no recrea servidores sin CurseForge
curl -sf -b $J -X PUT -H 'content-type: application/json' -d '{"apiKey":"$2a$10$test-p3-falsa"}' $API/api/settings/curseforge
curl -sf -b $J $API/api/servers | grep -c 'test-p3-falsa' || true
curl -sf -b $J $API/api/servers/$S1 | jq .specVersion
curl -sf -b $J -X PUT -H 'content-type: application/json' -d '{"apiKey":""}' $API/api/settings/curseforge
```
Expected: `[2,"FABRIC",["lithium"],true]`, luego `OPS_APLICADO`; `{"configured":true}`; `0`; la versión de S1 sigue en `2` (no usa CurseForge); `{"configured":false}`.

- [ ] **Step 6: Recorrido por la UI**

Con la web abierta, comprueba y anota cualquier fallo:
1. **Nuevo servidor**: los 3 pasos; «Desde cero» con «Modpack de Modrinth» sin slug no avanza y muestra `modpack.slugOrUrl: …`; desde **Plantillas → Crear servidor** abre en el paso 2 con la plantilla elegida. (No hace falta crearlo: «Atrás» y sal.)
2. **Configuración de «Test Fabric»**: pestañas General, Versión y mods, Propiedades, Jugadores, Red, Recursos, Avanzado y **ninguna Backups**; cambiar «Dificultad» a `normal` → el diálogo muestra «Propiedad difficulty: hard → normal» y avisa de la recreación; **Aplicar** → «Aplicando v3…» → «En marcha».
3. Tipo «Modpack de CurseForge» en un formulario sin guardar muestra «API key de CurseForge: sin configurar» y el diálogo para configurarla (no la guardes; descarta los cambios).
4. **Plantillas**: la de este test aparece con «Fabric 1.21.4» y origen «Test Fabric»; **Duplicar** y **Borrar** funcionan.

- [ ] **Step 7: Limpieza**

```bash
curl -sf -b $J -X DELETE "$API/api/servers/$S1?deleteData=true" -o /dev/null -w '%{http_code}\n'
curl -sf -b $J -X DELETE "$API/api/servers/$S2?deleteData=true" -o /dev/null -w '%{http_code}\n'
docker compose -p mcsm-test-p3 -f deploy/docker-compose.dev.yml down -v
[ -f $E2E/created-network ] && docker network rm mcsm
```
Detén el panel en segundo plano y borra `$E2E` (`rm -rf /tmp/mcsm-test-p3`). Expected: `204` `204`; `docker ps -a --filter name=mcsm-test-` vacío.

- [ ] **Step 8: Cierre**

Si algo se desvió del plan (nombres de variables itzg, mensajes, comportamiento de la UI), anótalo como nota al pie de esta tarea y commitea solo esa nota:
```bash
git add docs/superpowers/plans/2026-10-12-03-configuracion-plantillas.md
git commit -m "docs: notas de verificación del plan 3

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Si no hubo desviaciones, no hay commit.

> **Notas de la verificación (ejecutada):** todos los criterios en verde con Docker real. Desviaciones del procedimiento: (1) en esta máquina el firewall descarta contenedor → host, así que el panel corrió como contenedor `mcsm-test-panel` en la red `mcsm` y el agente con `PANEL_URL=http://mcsm-test-panel:8080` en un override del compose; (2) `buf breaking` se invoca con `--against ".git#ref=<commit>"` (con `#commit=` y un SHA corto falla); (3) el `down -v` de limpieza necesita `DATA_ROOT` definido; (4) el recorrido por la UI (Step 6) no se hizo: el navegador de Claude bloquea `localhost:8080`, queda para el humano; (5) con `CF_API_KEY` la clave sí aparece en `docker inspect` del contenedor MC (inevitable, va en env) y en ningún otro sitio (consola reenviada, logs del agente y del panel, DTOs).

---

## Cierre del plan

Con la Task 12 en verde, el sistema cumple el paso 5 del orden de construcción de la spec (§13) salvo la sección Backups del formulario, que el Plan 4 añade en su propia pestaña. Antes de fusionar la oleada A:

- Revisión de rama con `final-reviewer` y `security-auditor` (API key de CurseForge, reservas de env).
- Notas para `CLAUDE.md` (las añade el controlador): PATCH de spec = merge de primer nivel (`mergeSpecPatch`, `null` borra) y el formulario solo envía `FORM_KEYS`; `CF_API_KEY` reservada y solo en `toServerSpecMessage(row, { curseforgeApiKey })`; regex de spec solo ASCII (sin `\s`) para que Go y zod coincidan y casos en `proto/fixtures/spec-content-cases.json`; zod en castellano vía `zod-locale.ts`; Vitest de la web hace pruebas de humo con `renderToString`.
- Puntos de contacto con los otros planes de la oleada: el Plan 4 envía `PATCH { spec: { backups } }` (depende de la Task 3) y su campo `backups` debe ir en `baseFields` (para que las plantillas lo incluyan) y **no** generar env (no debe cambiar el hash); la entrada «Plantillas» de `layout.tsx` y `api.put` pueden chocar trivialmente con otras entradas; el Plan 9 reutiliza `GET/PUT /api/settings/curseforge`; los Planes 6–7 deben llamar a `toServerSpecMessage(row, { curseforgeApiKey })` y el 6 debe mapear `CF_API_KEY` de contenedores importados a Ajustes (es reservada).
