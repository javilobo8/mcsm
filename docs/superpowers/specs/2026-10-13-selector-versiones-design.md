# Selector de versión de Minecraft y de build/loader — diseño

Fecha: 2026-10-13. Amplía la spec principal (`2026-10-12-mc-server-manager-design.md`, §4.1 y §8).

## 1. Objetivo

Al crear un servidor (y al editar su configuración o una plantilla) el administrador elige la
versión de Minecraft de una lista según el tipo, y opcionalmente la versión del loader/build
(Fabric loader, Forge, NeoForge, build de Paper…). Hoy la versión es un texto libre y el build no
se puede fijar salvo con variables en `env`.

No se descarga nada desde el panel ni el agente: `itzg/minecraft-server` descarga el jar al arrancar
a partir de `TYPE`, `VERSION` y la variable de build. El panel solo ofrece listas de valores
válidos, obtenidas de las fuentes oficiales.

Criterios de aceptación:

- En el asistente, con tipo Paper, el selector lista las versiones estables de Paper (la más nueva
  primero); al elegir `1.20.1` la Java pasa a `java17` con aviso y el selector de build lista los
  builds estables de Paper para 1.20.1. Crear el servidor arranca un contenedor con
  `VERSION=1.20.1` y `PAPER_BUILD=<elegido>`.
- Actualizar el agente no recrea ningún contenedor existente (`TestHashGolden` intacto).
- Con las fuentes inaccesibles, el selector muestra el error y deja escribir la versión a mano; el
  servidor se crea igual.

## 2. Fuentes (JSON públicos, sin clave; comprobadas el 2026-10-13)

| Tipo | Versiones de Minecraft | Builds / loaders | Variable itzg del build |
|---|---|---|---|
| VANILLA | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` (`type` release/snapshot; se descartan old_alpha/old_beta) | — | — |
| PAPER | `https://fill.papermc.io/v3/projects/paper` (`versions` agrupadas por familia) | `…/v3/projects/paper/versions/{v}/builds` (`id`, `channel`; solo `STABLE`) | `PAPER_BUILD` |
| FOLIA | `https://fill.papermc.io/v3/projects/folia` | `…/v3/projects/folia/versions/{v}/builds` (solo `STABLE`) | `FOLIABUILD` (sin guion bajo; `scripts/start-deployFolia`) |
| PURPUR | `https://api.purpurmc.org/v2/purpur` (`versions`, ascendente) | `https://api.purpurmc.org/v2/purpur/{v}` (`builds.all`, ascendente) | `PURPUR_BUILD` |
| SPIGOT | `https://hub.spigotmc.org/versions/` (índice HTML de `<versión>.json`; solo nombres `^\d+\.\d+(\.\d+)?$`) | — | — |
| FABRIC | `https://meta.fabricmc.net/v2/versions/game` (`version`, `stable`) | `https://meta.fabricmc.net/v2/versions/loader/{v}` (`loader.version`, `loader.stable`) | `FABRIC_LOADER_VERSION` |
| QUILT | `https://meta.quiltmc.org/v3/versions/game` (`version`, `stable`) | `https://meta.quiltmc.org/v3/versions/loader/{v}` (`loader.version`; inestable si lleva sufijo `-…`) | `QUILT_LOADER_VERSION` |
| FORGE | claves de `https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json` | `maven-metadata.json[v]` (`"<v>-<forge>"` → `<forge>`) + `…/forge/promotions_slim.json` (`<v>-recommended`) | `FORGE_VERSION` |
| NEOFORGE | derivadas de `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge` | la misma lista filtrada por versión de MC (inestable si lleva sufijo `-beta`/`-alpha`) | `NEOFORGE_VERSION` |

Modpacks (`MODRINTH`, `AUTO_CURSEFORGE`, `FTBA`) y tipos desconocidos: sin lista (texto libre como hoy).

Derivación de la versión de MC de NeoForge (sobre la parte antes del primer `-`):

- mayor ≥ 26: `A.B.C.N` → `A.B` si `C = 0`, si no `A.B.C` (`26.3.0.76` → `26.3`, `26.1.2.5` → `26.1.2`).
- mayor 20–25: `A.B.N` → `1.A` si `B = 0`, si no `1.A.B` (`21.0.x` → `1.21`, `21.1.x` → `1.21.1`).
- Cualquier otra forma (`0.25w14craftmine.3-beta`) se descarta.

Estabilidad: donde la fuente no la indica (Paper, Folia, Purpur, Spigot, Forge, versiones
derivadas de NeoForge), una versión es estable si es solo dígitos y puntos (`1.21.11` sí;
`1.21.11-rc3`, `26.3-rc-3` no).

Orden: más nueva primero. Donde la fuente no ordena, `compareVersions` compara por componentes
numéricos y una pre-release (sufijo `-…`) va detrás de su release.

Spigot: itzg ya no puede descargarlo de getbukkit; solo funciona con `BUILD_FROM_SOURCE=true`
(BuildTools `--rev <VERSION>`), por eso la lista es la de revisiones de BuildTools. La UI lo avisa
(§5).

## 3. Spec: campo `build`

- `build: string`, por defecto `""` (= el último, comportamiento actual). Va en `baseFields`
  (shared) y en `Spec` (Go, `json:"build,omitempty"`); viaja en plantillas. Sin cambio de `.proto`
  (la spec viaja como JSON en `ServerSpec`).
- Validación idéntica en zod y Go, con fixture compartida `proto/fixtures/build-cases.json`:
  - `""` o `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`.
  - No vacío solo con `type` ∈ {PAPER, FOLIA, PURPUR, FABRIC, QUILT, FORGE, NEOFORGE}; si no:
    «El tipo X no admite fijar build».
  - No vacío exige `version` concreta (ni `LATEST` ni `SNAPSHOT`, sin distinguir mayúsculas):
    «Para fijar el build elige una versión concreta de Minecraft».
  - No vacío prohíbe en `env` la variable que genera (patrón de ops/whitelist): «La variable X la
    genera el campo build».
- PATCH: clave de primer nivel con valor por defecto; `null` → 400 (clave obligatoria).
- Mapeo (agente, `envList`, tras `contentEnv`, antes de `env`): PAPER→`PAPER_BUILD`,
  FOLIA→`FOLIABUILD`, PURPUR→`PURPUR_BUILD`, FABRIC→`FABRIC_LOADER_VERSION`,
  QUILT→`QUILT_LOADER_VERSION`, FORGE→`FORGE_VERSION`, NEOFORGE→`NEOFORGE_VERSION`. Vacío no
  emite nada: el hash de los contenedores existentes no cambia.
- Importación (`import/propose.ts`): si `env` trae la variable del tipo detectado con un valor que
  cumple la regex y la versión es concreta, pasa a `build` y sale de `env` (mismo entorno final,
  mismo hash). Si no, se queda en `env`.
- La spec principal §4.1 añade `build` al ejemplo y a la lista de variables generadas.

## 4. API: módulo `panel/apps/api/src/versions/`

- `sources.ts`: un adaptador por tipo con `versions(fetchJson)` y, si aplica,
  `builds(version, fetchJson)`, que devuelven `{ id, stable, recommended? }[]` ya ordenadas. Puros
  salvo por el `fetchJson` inyectado; tests con documentos recortados con la forma exacta de las
  respuestas reales, en línea en el propio test.
- `catalog.ts` — `VersionCatalog` (decorado como `app.versions` en `buildApp`):
  - Caché en memoria por URL de origen: listas de versiones (y los documentos compartidos de Forge
    y NeoForge) 1 h; endpoints de builds 15 min. Máximo 256 entradas; al llenarse se descarta la
    menos usada recientemente.
  - Peticiones concurrentes a la misma URL comparten la promesa en vuelo.
  - Plazo 10 s, respuesta ≤ 8 MiB, `User-Agent: mc-server-manager (self-hosted)` (Fill v3 pide
    un User-Agent descriptivo), solo HTTPS a los hosts de §2.
  - Fallo de origen (red, plazo, no 2xx, JSON inválido): si hay entrada caducada se sirve con
    `stale: true`; si no, `HttpError(502, "No se pudo consultar la lista de versiones de <Tipo>")`.
  - Reloj y `fetch` inyectables.
- `routes.ts` (encapsulado, tras el guard de sesión):
  - `GET /api/versions/:type` → `{ type, versions: {id, stable}[], fetchedAt, stale }`.
  - `GET /api/versions/:type/:version/builds` → `{ type, version, builds: {id, stable, recommended}[], fetchedAt, stale }`.
  - `:type` fuera de {VANILLA, PAPER, FOLIA, PURPUR, SPIGOT, FABRIC, QUILT, FORGE, NEOFORGE} → 400
    «Tipo sin lista de versiones»; builds de un tipo sin build → 400 «El tipo X no admite fijar
    build»; `:version` fuera de `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$` → 400. La versión se codifica
    con `encodeURIComponent` al construir la URL de origen.
  - `fetchedAt` en ISO con la hora del panel.

## 5. Web

- Componentes shadcn `command` y `popover` (`pnpm dlx shadcn@3.8.5 add command popover`; añade
  `cmdk`).
- `components/spec-form/version-picker.tsx` sustituye al `Input` de versión en `VersionSection`
  para los tipos de §2 (modpacks y tipos desconocidos conservan el `Input`):
  - Botón con la versión actual; al abrir, buscador y grupos «Especiales» (`LATEST`; `SNAPSHOT`
    solo en VANILLA, FABRIC y QUILT), «Estables» y «Snapshots y pre-releases» (este solo con el
    interruptor «Mostrar versiones de prueba», apagado por defecto y encendido si la versión
    actual es inestable)
    Mientras se busca (texto escrito) las de prueba que coinciden se listan también con el
    interruptor apagado: es el comportamiento real y mejora el uso (quien teclea «26.4-snap» las
    quiere).
  - Lo escrito que no coincide con ninguna opción y cumple la regex de `:version` aparece como
    «Usar «x»».
  - Estados: «Cargando versiones…»; error → mensaje + texto libre; `stale` → «La fuente no
    responde; lista de hace N».
- `components/spec-form/build-picker.tsx`: `Select` con «(el último)» + builds (Forge marca
  «recomendada»; los inestables de Fabric/Quilt/NeoForge con el mismo interruptor). Etiqueta por
  tipo («Build de Paper», «Versión del loader de Fabric», «Versión de Forge»…). Oculto para tipos
  sin build; sin opciones y con pista si la versión es `LATEST`/`SNAPSHOT`.
- Lógica pura con tests:
  - shared `minJavaTag(version)`: `LATEST`/`SNAPSHOT` y mayor ≥ 26 (`26.3`, `26.4-snapshot-3`,
    `26.3-rc-3`) → `java25`; `1.20.5`–`1.21.x` → `java21`; `1.17`–`1.20.4` → `java17`; `< 1.17` →
    `java8`; snapshots antiguas `AAwSSl`: ≥ `24w14a` → `java21`, ≥ `21w19a` → `java17`, resto →
    `java8`; otra forma → `null`.
  - `spec-edit.ts` `withVersion(spec, v)` → `{ spec, notice }`: vacía `build`; si `imageTag` ∈
    `JAVA_TAGS` y `minJavaTag(v)` difiere, lo cambia y avisa («Java cambiada a java25: 26.3 la
    necesita»); si la etiqueta es otra (p. ej. `java21-graalvm`) no la toca y avisa solo si su
    `javaNN` es menor que la necesaria. `withType` también vacía `build`.
  - `lib/versions.ts`: `versionOptions(list, { query, showUnstable })`, `freeTextOption`,
    `buildLabel(type)`.
- `hooks/use-versions.ts`: `useVersions(type)` y `useBuilds(type, version)` (TanStack Query,
  `staleTime` 10 min, `apiPath`).
- Pista de Java corregida: «java25 para 26.x; java21 para 1.20.5–1.21.x; java17 para 1.17–1.20.4;
  java8 para anteriores». Con tipo SPIGOT, aviso: «itzg ya no descarga Spigot automáticamente:
  añade BUILD_FROM_SOURCE=true en las variables de entorno o usa Paper».
- `summarizeSpec` (paso 3 del asistente) añade la línea «Build» si está fijado.

## 6. Pruebas

- shared: validación de `build` (fixture compartida), prohibición en `env`, `minJavaTag`.
- Agente: `Validate` con la fixture, mapeo por tipo en `envList`, `TestHashGolden` intacto.
- API: adaptadores contra fixtures; `VersionCatalog` (TTL, `stale`, promesa compartida, plazo,
  tope de tamaño, LRU) con reloj y `fetch` falsos; rutas (400 de tipo/versión, 502, sesión);
  importación (`env` → `build`).
- Web: funciones puras; render SSR de `VersionSection` (picker para Paper, `Input` para modpack,
  aviso de Spigot, pista de Java).
- E2E: el asistente crea un servidor eligiendo la versión por texto («Usar «1.21.4»» o la opción de
  la lista, según haya red) y deja captura del combobox abierto.

## 7. Fuera de alcance

Aviso al bajar de versión un servidor existente; fijar launcher/installer de Fabric/Quilt; builds
experimentales de Paper/Folia (necesitarían `*_CHANNEL`); versiones de modpacks.
