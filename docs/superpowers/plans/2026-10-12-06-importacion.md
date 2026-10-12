# MC Server Manager — Plan 6: Importación de servidores existentes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los servidores `itzg/minecraft-server` que ya corren en un nodo (p. ej. los del docker-compose del usuario) aparezcan en Nodos → Importar, se revisen con el formulario de configuración y se adopten sin pararlos; el primer «Guardar y aplicar» los recrea como `mcsm-<slug>` con etiquetas `mcsm.*` y el mismo directorio de datos.

**Architecture:** El agente lista los contenedores itzg ajenos (`ImportScan` → `ImportScanResult`, con el env del usuario sin el ENV de la imagen) y el panel deduce la spec candidata con una función pura, sin dejar salir `RCON_PASSWORD` ni `CF_API_KEY` hacia el navegador. Al adoptar (`ImportAdopt`), el agente comprueba que el `/data` del contenedor es el de la spec, lo conecta a la red `mcsm` con el alias `mcsm-<slug>` (RCON, ping y métricas lo buscan por ese nombre) y guarda un registro de adopción: el reconciliador trata ese contenedor como el del servidor hasta que la versión de la spec supere la de la adopción, y entonces lo sustituye. La spec que el panel envía de un importado lleva `adopt` (como la key de CurseForge: solo en el mensaje, nunca en `servers.spec`), así que una adopción perdida o un store del agente nuevo se reconstruyen sin crear un segundo contenedor sobre el mismo mundo. `dataPath` (campo nuevo y opcional, siempre fuera de `DATA_ROOT`) solo lo fija la importación; con él no hay copias ni navegador de archivos, porque el agente solo monta `DATA_ROOT` (§6.1).

**Tech Stack:** Go 1.27.2 (agente: `reconcile`, `store` bbolt, `docker` sobre `github.com/moby/moby/client` v0.6.2, paquete nuevo `importer`); protobuf con buf 1.73 (`pnpm gen`); Node 26, pnpm 12, Fastify 5, `node:sqlite`, zod 4; React 19, TanStack Router/Query, shadcn/ui (Radix), Vitest 4 en node (sin jsdom).

**Spec:** `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (§4 `servers.imported_from`, §5.3 `ImportScan`/`ImportAdopt`, §6.7, §7 `ImportService`, §8 Nodos → importación). Alcance y aceptación: `docs/superpowers/plans/README.md` (Plan 6). Coordinación: `docs/superpowers/plans/COORDINATION.md`.

## Global Constraints

- Rama `feat/plan-6` en `.worktrees/plan-6`, creada desde `feat/wave-a` **con los Planes 1–5 integrados** (oleada B, en paralelo con los Planes 7 y 8). Todos los comandos empiezan con `cd <worktree> && …`; `eval "$(mise env)"` antes de `go`/`buf`. Solo se escribe en el worktree propio.
- Ficheros compartidos: este plan escribe **debajo de las anclas `plan-6`** (`// ── plan-6 ──`, `{/* ── plan-6 ── */}` en JSX). Las ediciones fuera de ancla están señaladas en cada tarea con «(fuera de ancla)» y son mínimas. No muevas ni borres anclas.
- Protocolo: `Envelope.body` 90 `ImportScan`, 91 `ImportScanResult`, 92 `ImportAdopt` (rango 90–99); los mensajes nuevos van al final de `agent.proto`, debajo de la ancla `plan-6`. Solo se añade (`buf breaking` contra `feat/wave-a` en verde); tras tocar el proto, `pnpm gen` y se commitea lo generado. `ServerSpec` **no** cambia.
- Código de error nuevo `external_data` (409) en los tres sitios del catálogo (`message Error` del proto, `agent/internal/errcode`, `panel/apps/api/src/agents/error-codes.ts`) y en `STATUS_BY_CODE` de `lib/http.ts`.
- Migración `050_servers_imported_from` (rango 050–059) debajo de la ancla `plan-6` del array `migrations`.
- Spec: `dataPath` (string opcional) va en `specSchema`/`specInputSchema` y en el struct Go, **nunca** en `baseFields` (las plantillas no lo llevan). Lo fija solo la importación; un PATCH puede reenviarlo igual o quitarlo con `null`. `adopt {containerId, version}` solo existe en el `spec_json` del mensaje al agente (lo añade `toServerSpecMessage`). Con ambos vacíos el hash no cambia: `TestHashGolden` sigue en `09ff6e5490b40677`.
- `dataPath` se valida igual en Go y zod (fixture `proto/fixtures/data-path-cases.json`): absoluta, normalizada (sin `//`, `.`, `..` ni `/` final), al menos dos niveles, solo ASCII `[A-Za-z0-9._@+ -]` por tramo, ≤ 1024 bytes y fuera de `/bin /boot /dev /etc /lib /lib32 /lib64 /libx32 /proc /run /sbin /sys /usr /var/lib/docker /var/run`. Además, nunca dentro de `DATA_ROOT` ni conteniéndolo (lo comprueban `BuildContainer` y la importación) y nunca con copias programadas (`backups.enabled`).
- Secretos: `RCON_PASSWORD` y `CF_API_KEY` del contenedor solo viajan agente → panel; no aparecen en ningún DTO, mensaje de aviso ni log del panel o del agente.
- Agente: lo que muta Docker o el store usa `App.life` (`ImportAdopt`); `ImportScan` usa el contexto de la sesión. Orden de locks: lock por servidor → `adoptMu` → `r.mu`. El observer del reconciliador no reentra. Tests sin `time.Sleep` para sincronizar; `go test -race` limpio. `gofmt -l` sin salida antes de commitear (alinea los literales de los briefs).
- `toServerSpecMessage(row, curseforgeApiKey)` sigue siendo el único constructor de `ServerSpec`; todo emisor de `ApplySpec`/`SyncSpecs`/`ImportAdopt` lo usa con la key.
- Web: rutas con `apiPath`; nada de `crypto.randomUUID()` ni APIs que exijan HTTPS; un `<form>` dentro de un diálogo usa `dialogSubmit`; la lógica de UI va en funciones puras con test (Vitest en node, render con `renderToString`); no se afirman textos de mensajes de zod en tests.
- Mensajes de UI y de error en castellano; identificadores en inglés. Commits Conventional en castellano, pequeños, terminados en `Co-Authored-By: Claude <Modelo> 5.5 <noreply@anthropic.com>` con el modelo que implementa la tarea. Nunca `git push`, `--no-verify` ni reescribir historia; `git add` con rutas concretas.
- Docker en la máquina de desarrollo: solo recursos `mcsm-test-*` (o etiqueta `mcsm.test=true`), y se borran al terminar. El escaneo de importación **lista** contenedores ajenos del usuario: se miran, nunca se adoptan ni se tocan en las pruebas. Nada de `docker system prune` ni borrados masivos.

## Review Focus

1. **Se recrea sobre otra carpeta y el mundo «desaparece»** (slug cambiado con los datos en `<DATA_ROOT>/<slug>/data`, `dataPath` que no llega al agente, `dataPath` tomado del navegador). Tests: Task 2 (bind con `dataPath`), Task 4 (`Adopt` exige que el `/data` real sea el de la spec; la recreación conserva el bind), Task 10 (slug fijo cuando los datos están en `DATA_ROOT`; `dataPath` sale del escaneo, no del cuerpo), Task 13 (marcador y semilla del mundo tras recrear).
2. **Dos contenedores sobre el mismo mundo** (ImportAdopt perdido, store del agente nuevo, el original desaparece, dos servidores adoptan el mismo contenedor o la misma carpeta). Tests: Task 4 (readopción desde `adopt`; con `/data` distinto no crea nada; adopción concurrente del mismo contenedor: gana uno), Task 10 (fallo dudoso → la fila se conserva; error del agente → se borra; carpetas solapadas → 409).
3. **Secretos del contenedor en el navegador o en logs** (`RCON_PASSWORD`, `CF_API_KEY`, `rcon.password` dentro de `CUSTOM_SERVER_PROPERTIES`). Tests: Task 9 (avisos sin valores), Task 10 (el JSON de candidatos no contiene los secretos), Task 13 (grep sobre la respuesta real).
4. **`dataPath` como puerta al host** (el entrypoint de itzg corre como root y hace `chown -R` de `/data`). Tests: Task 2 y Task 7 (fixture compartida con zonas del sistema), Task 8 (crear o PATCH no pueden fijarlo; las plantillas no lo copian), Task 4 (el agente no crea directorios fuera de `DATA_ROOT`).
5. **El adoptado es invisible para algún subsistema** (métricas solo ven `mcsm.managed`, ping por `mcsm-<slug>`, logs/consola/power buscan por etiqueta, copias que paran el contenedor). Tests: Task 4 (`find`, `ServerContainers`, `Power`, ping al alias, `Hold` aplaza la recreación), Task 6 (el muestreador mide al adoptado), Task 13 (logs, jugadores, métricas y consola reales).
6. **Actualizar el agente recrea todos los contenedores** (campos nuevos que cambian `hashInput`). Test: Task 2 (`dataPath` vacío y `adopt` dejan el hash dorado).

---

## Decisiones resueltas con el código real

- **Adopción sin recrear.** Docker no permite añadir etiquetas a un contenedor existente, así que «añadir las etiquetas» (§6.7) es recrear. Hasta el primer cambio de spec, el agente sigue el contenedor original por un **registro de adopción** en bbolt (`store.Adoption{ContainerID, Slug, Version}`). `reconcile.find` devuelve primero el contenedor gestionado (etiqueta `mcsm.server_id`) y, si no hay, el adoptado (con `Adopted=true` y `mcsm.server_id`/`mcsm.slug` sintetizados); así logs, consola, `Power`, copias (`Container`) y observación funcionan sin cambios. `reconcileLocked` no compara hash en un adoptado: si `spec_version` > `Adoption.Version`, para y borra el original (los datos están en el bind) y crea `mcsm-<slug>`; si no, solo ajusta el estado deseado.
- **`adopt` en el mensaje, no en la spec guardada.** `toServerSpecMessage` añade `"adopt": {containerId, version}` a toda spec de un servidor con `imported_from`. Si el agente no tiene registro (ImportAdopt perdido, store nuevo), `reconcileLocked` vuelve a adoptar con las mismas comprobaciones; si el original ya no existe, crea el gestionado; si existe pero no cuadra (otro `/data`, ya gestionado…), falla sin crear nada. `adopt` no entra en `BuildContainer` ni en el hash.
- **Red y nombres.** RCON, el ping de estado y el TPS usan `mcsm-<slug>` en la red `mcsm`. Al adoptar, el agente conecta el contenedor original a esa red con el alias `mcsm-<slug>` (`NetworkConnect` en caliente, sin reiniciar). Contenedores con red `host`, `none` o `container:` no se importan.
- **RCON del adoptado.** La contraseña de la spec es la `RCON_PASSWORD` del contenedor si tiene ≥ 8 caracteres; si no la fija (itzg genera una aleatoria en cada arranque), usa otro `RCON_PORT` o tiene RCON desactivado, la consola, el TPS y el `save-off` de las copias en caliente fallan hasta la primera recreación, y la candidata lo avisa. Logs y jugadores (ping) funcionan siempre.
- **Métricas.** El muestreador del Plan 2 recibe como `Containers` un adaptador que lista gestionados + adoptados (`Reconciler.ServerContainers`). Los eventos Docker del adoptado no llegan (el filtro es `mcsm.managed=true`): su estado se refresca con el tick de observación de 10 s.
- **`dataPath` y `DATA_ROOT`.** Bind `/data` = `<DATA_ROOT>/<slug>/data` con slug válido → sin `dataPath` y slug fijo (cambiarlo apuntaría a otra carpeta). Bind fuera de `DATA_ROOT` → `dataPath`. Bind dentro de `DATA_ROOT` con otra forma, o que contiene `DATA_ROOT` → no importable (con la instrucción para moverlo). Así ningún `dataPath` solapa los datos de los servidores gestionados.
- **Copias y archivos.** Con `dataPath` el agente no ve la carpeta (solo monta `DATA_ROOT`): `Files*`, `BackupNow` y `BackupRestore` responden `external_data` (409), las copias programadas no validan y borrar «con datos» se rechaza. Sin `dataPath` (datos ya en `DATA_ROOT`), copias y archivos funcionan también antes de la primera recreación (RCON según el punto anterior). La nota del Plan 5 («usa `dataPath` como raíz de `serverFS`») no sirve: esa carpeta no está montada en el agente.
- **Revisión antes de adoptar.** «Adoptar sin parar» exige la spec deducida sin cambios (y válida): la spec v1 describe el contenedor que sigue en marcha. Con cambios, «Adoptar y aplicar» adopta y enseguida sube a v2 (el agente recrea).
- **Borrar un importado** borra su contenedor (el original si aún está adoptado), como cualquier servidor gestionado; sus datos fuera de `DATA_ROOT` nunca se borran desde el panel.
- **Fallos dudosos al adoptar.** Si el agente rechaza `ImportAdopt` con un código suyo, la fila se borra. Si la petición cae por `timeout` o `disconnected`, la fila se **conserva** (504 explicativo): borrarla haría que el siguiente `SyncSpecs` retirara el servidor y borrara el contenedor original si el agente sí lo adoptó; con la fila, `adopt` completa la adopción al reconectar.
- **Desviaciones de la spec:** `ImportCandidates` se llama `ImportScanResult` (convención `*Result` de `isResponseCase`); `ImportAdopt` lleva el `ServerSpec` completo (incluye `server_id` y `slug`) en lugar de `{container_id, server_id, slug}`; el contenedor no se renombra: se recrea.

## Mapeo contenedor → spec candidata (Task 9)

| Origen | Destino | Notas |
|---|---|---|
| `TYPE` (o `MODPACK_PLATFORM` sin `TYPE`/con `VANILLA`) | `type` en mayúsculas | Ausente → `VANILLA` (por defecto de itzg). |
| `VERSION` | `version` | Ausente → `LATEST`. |
| `MEMORY` | `memory` | Ausente → `1G` (por defecto de itzg). Fuera de `^[1-9]\d*[MmGg]$` → `1G` y aviso. |
| `EULA` | — | El agente pone siempre `TRUE`. |
| `RCON_PASSWORD` | `rconPassword` | Solo si ≥ 8 caracteres (y ≤ 4 KiB). Nunca al navegador. Si no, contraseña nueva y aviso. |
| `ENABLE_RCON=false`, `RCON_PORT≠25575` | — | Aviso (consola sin RCON hasta recrear). |
| `SERVER_PORT≠25565` | — | **Bloqueo**. |
| `CUSTOM_SERVER_PROPERTIES` | `properties` | Líneas `clave=valor` con clave válida y no reservada; las demás se descartan con aviso que nombra solo la clave. |
| `CF_API_KEY` | Ajustes | Si no hay key en Ajustes y la spec usa CurseForge, se guarda al adoptar; nunca al navegador. |
| `MODRINTH_MODPACK`, `MODRINTH_VERSION`, `MODRINTH_LOADER` | `modpack` | Con `type=MODRINTH`. |
| `CF_SLUG` (o `CF_PAGE_URL`), `CF_FILE_ID` | `modpack` | Con `type=AUTO_CURSEFORGE`. |
| `FTB_MODPACK_ID`, `FTB_MODPACK_VERSION_ID` | `modpack` | Con `type=FTBA`. |
| `MODRINTH_PROJECTS` | `plugins.modrinthProjects` si el tipo es de plugins (PAPER, PURPUR, SPIGOT, FOLIA, BUKKIT, PUFFERFISH, LEAF); si no, `mods.modrinthProjects` | Solo si todas las entradas valen; si no, se queda en `env`. |
| `CURSEFORGE_FILES`, `MODS`, `PLUGINS`, `SPIGET_RESOURCES` | `mods.curseforgeFiles`, `mods.urls`, `plugins.urls`, `plugins.spigetResources` | Ídem (las URL deben ser `http(s)`). |
| `WHITELIST`, `ENABLE_WHITELIST` | `whitelist` | **Solo** con `EXISTING_WHITELIST_FILE=SYNCHRONIZE`, sin `WHITELIST_FILE` ni `white-list`/`enforce-whitelist` en properties y con jugadores válidos (regla M1: con la sección presente esas variables no pueden quedar en `env`). Si no, se quedan en `env`: la sección sincroniza el fichero y borraría lo añadido desde el juego. |
| `OPS` | `ops` | Igual: solo con `EXISTING_OPS_FILE=SYNCHRONIZE` y sin `OPS_FILE`. |
| Resto del env | `env` | Nombres inválidos se descartan con aviso. Las variables de propiedades de itzg (`MOTD`, `DIFFICULTY`…) se quedan en `env`. |
| Puerto host de `25565/tcp` | `ports.game` | Sin publicación (o efímera) → **bloqueo**. IP de escucha concreta → aviso. |
| Otras publicaciones | `ports.extra` | Sin duplicados; `25575` (RCON) se descarta con aviso. |
| Bind de `/data` | `dataPath` o slug fijo | Ver «Decisiones». Volumen, sin `/data` o solo lectura → **bloqueo**. Otros montajes → aviso (no se conservan). |
| `RestartPolicy` | `restartPolicy` | `""` → `no`. |
| `Memory`, `NanoCPUs` | `resources.memLimit`, `resources.cpus` | Sin límite → aviso (al recrear: memoria + 1G). Límite menor que `memory` → sin límite y aviso. |
| Imagen `itzg/minecraft-server[:tag]` | `imageTag` | Digest o etiqueta inválida → `latest` y aviso. |
| Nombre / etiquetas de Compose | nombre, slug, aviso | Slug de `slugify(nombre)` con sufijo `-2`… si se repite. Compose → aviso de quitar el servicio antes de aplicar. |
| Estado | `desiredState` | `running`/`restarting` → `running`; si no, `stopped`. |

## Estructura de archivos

```
proto/mcsm/v1/agent.proto                         (mod) ImportScan/ImportScanResult/ImportAdopt, external_data
proto/fixtures/data-path-cases.json               casos de dataPath compartidos Go ↔ zod

agent/internal/errcode/errcode.go                 (mod) ExternalData
agent/internal/spec/adopt.go(+_test)              DataPath, Adopt, ValidateDataPath, IsItzgImage, dataDir
agent/internal/spec/spec.go                       (mod) campos y Validate bajo ancla; dataDir en BuildContainer
agent/internal/docker/engine.go                   (mod) Container.Adopted, métodos ListAll/InspectImport/ImageEnv/ConnectNetwork
agent/internal/docker/import.go                   ImportInfo, PortPublish, Mount
agent/internal/docker/fake.go                     (mod) ImageEnvs, ConnectErr, FakeContainer.Aliases
agent/internal/docker/fake_import.go(+_test)      implementación en el fake
agent/internal/docker/moby_import.go              implementación Moby
agent/internal/docker/moby_import_integration_test.go
agent/internal/store/adoptions.go(+_test)         registro de adopciones (bucket adoptions)
agent/internal/reconcile/adopt.go(+_test)         Adopt, readopt, ServerContainers, errores
agent/internal/reconcile/reconciler.go            (mod) find, reconcileLocked, removeLocked, observeLocked
agent/internal/importer/scan.go(+_test)           Scan, UserEnv
agent/internal/app/import.go(+_test)              handlers, externalData, adaptador de métricas
agent/internal/app/import_guard_test.go
agent/internal/app/app.go                         (mod) Handle bajo ancla
agent/internal/app/metrics.go, files.go, backups.go   (mod, fuera de ancla) adoptados y external_data

panel/packages/shared/src/data-path.ts(+test)     dataPathSchema, dataPathError, pathWithin, dataPathCheck, dataPathPatchError
panel/packages/shared/src/import.ts(+test)        ImportedFrom, ImportCandidateDto, importAdoptSchema, sameSpecInput
panel/packages/shared/src/spec.ts, index.ts       (mod)
panel/apps/api/src/agents/error-codes.ts, lib/http.ts(+test)   (mod) external_data
panel/apps/api/src/db/migrations.ts               (mod) 050_servers_imported_from
panel/apps/api/src/servers/repo.ts, service.ts    (mod) imported_from, adopt en el mensaje, guardas de dataPath
panel/apps/api/src/servers/imported.test.ts, spec-message.test.ts
panel/apps/api/src/import/propose.ts(+test)       candidata → propuesta (pura)
panel/apps/api/src/import/service.ts, routes.ts, import.test.ts
panel/apps/api/src/app.ts                         (mod) bajo ancla

panel/apps/web/src/lib/import.ts(+test)           revisión, bloqueos, petición, avisos
panel/apps/web/src/hooks/use-import.ts
panel/apps/web/src/lib/api.ts                     (mod) ServerDto.importedFrom
panel/apps/web/src/routes/import.tsx              Nodos → Importar (lista y revisión con SpecForm)
panel/apps/web/src/components/import-notices.tsx(+test)
panel/apps/web/src/router.tsx, routes/nodes.tsx, routes/server.tsx   (mod)
```

## Orden y dependencias

- **Task 1** va primero (proto y código generado: lo usan las dos pistas).
- **Pista agente** (en orden): Task 2 → 3 → 4 → 5 → 6. La Task 2 crea `proto/fixtures/data-path-cases.json`.
- **Pista panel** (en orden): Task 7 (necesita la fixture de la Task 2) → 8 → 9 → 10.
- **Pista web**: Task 11 (tras la 7, que fija los tipos compartidos) → 12 (tras la 10 para probar contra la API).
- Las pistas agente y panel pueden ir en paralelo en worktrees propios (conjuntos de ficheros disjuntos). **Task 13** cierra con todo integrado.

---

### Task 1: Protocolo — `ImportScan`, `ImportScanResult`, `ImportAdopt` y el código `external_data`

**Agent:** mechanical-dev

**Files:**
- Modify: `proto/mcsm/v1/agent.proto` (oneof `body` y zona de mensajes, debajo de las anclas `plan-6`; comentario de `message Error` fuera de ancla)
- Regenerate: `agent/gen/mcsm/v1/agent.pb.go`, `panel/packages/proto-ts/src/gen/mcsm/v1/agent_pb.ts`
- Modify: `agent/internal/errcode/errcode.go`, `panel/apps/api/src/agents/error-codes.ts`, `panel/apps/api/src/lib/http.ts`, `panel/apps/api/src/lib/http.test.ts`

**Interfaces:**
- Consumes: `ServerSpec` (proto), `AgentErrorCode` y `STATUS_BY_CODE` (`lib/http.ts`).
- Produces (proto/Go): `mcsmv1.ImportScan{}`, `mcsmv1.ImportScanResult{Candidates []*ImportCandidate, DataRoot string}`, `mcsmv1.ImportCandidate{ContainerId, Name, Image, State string; Env map[string]string; Ports []*ImportPort; Mounts []*ImportMount; RestartPolicy string; MemoryLimitBytes, NanoCpus int64; NetworkMode string; Networks []string; Labels map[string]string}`, `mcsmv1.ImportPort{ContainerPort uint32; Proto, HostIp string; HostPort uint32}`, `mcsmv1.ImportMount{Type, Source, Destination string; ReadWrite bool; Name string}`, `mcsmv1.ImportAdopt{Server *ServerSpec}`; cuerpos `Envelope_ImportScan`, `Envelope_ImportScanResult`, `Envelope_ImportAdopt`; `errcode.ExternalData = "external_data"`.
- Produces (TS): casos `"importScan" | "importScanResult" | "importAdopt"` de `Envelope.body`, `ImportCandidateSchema`/`ImportCandidate` (`memoryLimitBytes`, `nanoCpus` son `bigint`; `env` y `labels` objetos planos); `AgentErrorCode.ExternalData`; `external_data` → 409.

- [ ] **Step 1: Test que falla**

En `panel/apps/api/src/lib/http.test.ts`, dentro del `it.each` de `agentErrorToHttp`, añade debajo de `[AgentErrorCode.IoError, 502],`:
```ts
    [AgentErrorCode.ExternalData, 409],
```

- [ ] **Step 2: Comprueba que falla**

Run: `pnpm --filter @mcsm/api test -- src/lib/http.test.ts`
Expected: FAIL en `undefined → 409` (recibe 502: el código aún no existe).

- [ ] **Step 3: Proto**

En `proto/mcsm/v1/agent.proto`, dentro del `oneof body`, debajo de `    // ── plan-6 ──`:
```proto
    ImportScan import_scan = 90;
    ImportScanResult import_scan_result = 91;
    ImportAdopt import_adopt = 92;
```
En el comentario de `message Error` (fuera de ancla), debajo de la línea de `io_error`:
```proto
//   external_data    los datos del servidor están fuera de DATA_ROOT (dataPath):  409
//                    sin copias de seguridad ni archivos (Plan 6)
```
Al final del fichero, debajo de `// ── plan-6 ──` (y antes de `// ── plan-7 ──`):
```proto
// Importación de contenedores existentes (spec §6.7).

// Panel → agente. Lista los contenedores cuya imagen es itzg/minecraft-server, sin la etiqueta
// mcsm.managed y que este agente no haya adoptado ya. Respuesta: ImportScanResult, o Error.
message ImportScan {}

message ImportScanResult {
  repeated ImportCandidate candidates = 1;
  // DATA_ROOT del agente: el panel decide con él si los datos de un candidato están en
  // <DATA_ROOT>/<slug>/data o necesitan dataPath.
  string data_root = 2;
}

// Inspect reducido de un contenedor importable. `env` lleva solo lo que fijó el usuario (sin las
// variables idénticas al ENV de la imagen) e INCLUYE secretos (RCON_PASSWORD, CF_API_KEY): el
// panel no los reenvía al navegador ni los registra.
message ImportCandidate {
  string container_id = 1; // id completo
  string name = 2; // sin "/" inicial
  string image = 3; // Config.Image tal cual (itzg/minecraft-server:java21)
  string state = 4; // created|running|restarting|exited|paused|dead
  map<string, string> env = 5;
  repeated ImportPort ports = 6; // publicaciones configuradas (HostConfig.PortBindings)
  repeated ImportMount mounts = 7;
  string restart_policy = 8; // no|always|unless-stopped|on-failure ("" = no)
  int64 memory_limit_bytes = 9; // 0 = sin límite
  int64 nano_cpus = 10; // 0 = sin límite
  string network_mode = 11; // bridge|host|none|container:<id>|<red de usuario>
  repeated string networks = 12;
  map<string, string> labels = 13; // solo com.docker.compose.project y com.docker.compose.service
}

message ImportPort {
  uint32 container_port = 1;
  string proto = 2; // tcp|udp
  string host_ip = 3; // "" = todas las interfaces
  uint32 host_port = 4; // 0 = efímero
}

message ImportMount {
  string type = 1; // bind|volume|tmpfs…
  string source = 2; // ruta del host (bind) o del volumen
  string destination = 3;
  bool read_write = 4;
  string name = 5; // nombre del volumen
}

// Panel → agente. Adopta un contenedor sin recrearlo. server.spec_json lleva "adopt":
// {"containerId", "version"} (lo añade el panel). El agente comprueba que el contenedor existe,
// no es de MC Server Manager, usa la imagen itzg y monta en /data la carpeta de la spec; lo
// conecta a su red con el alias mcsm-<slug> y guarda spec y adopción. Respuesta: Ack, o Error con
// not_found (no existe), exists (gestionado o adoptado por otro servidor), invalid_request (no es
// itzg, red host/none/container o /data distinto), invalid_spec o apply_failed (Docker).
message ImportAdopt {
  ServerSpec server = 1;
}
```

- [ ] **Step 4: Lint, compatibilidad y generación**

Run: `eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=$(git merge-base HEAD feat/wave-a)" && pnpm gen`
Expected: sin salida de lint ni de breaking; `pnpm gen` regenera `agent/gen/mcsm/v1/agent.pb.go` y `panel/packages/proto-ts/src/gen/mcsm/v1/agent_pb.ts`.

- [ ] **Step 5: Catálogo de errores**

`agent/internal/errcode/errcode.go`, al final del fichero:
```go
// Importación (Plan 6).
const (
	ExternalData = "external_data" // datos del servidor fuera de DATA_ROOT (dataPath): sin copias ni archivos
)
```
`panel/apps/api/src/agents/error-codes.ts`, justo antes del comentario `// Solo en el panel: AgentError local de AgentConn…`:
```ts
  // Importación (Plan 6).
  ExternalData: "external_data",
```
`panel/apps/api/src/lib/http.ts`, en `STATUS_BY_CODE`, debajo de `[AgentErrorCode.IoError]: 502,`:
```ts
  // Importación (Plan 6): servidor con los datos fuera de DATA_ROOT.
  [AgentErrorCode.ExternalData]: 409,
```

- [ ] **Step 6: Comprueba que pasa**

Run: `pnpm --filter @mcsm/api test -- src/lib/http.test.ts && pnpm -r typecheck && (eval "$(mise env)" && cd agent && go build ./... && go vet ./...)`
Expected: PASS; typecheck y `go vet` limpios.

- [ ] **Step 7: Commit**

```bash
git add proto/mcsm/v1/agent.proto agent/gen panel/packages/proto-ts/src/gen agent/internal/errcode/errcode.go \
  panel/apps/api/src/agents/error-codes.ts panel/apps/api/src/lib/http.ts panel/apps/api/src/lib/http.test.ts
git commit -m "feat(proto): ImportScan, ImportScanResult, ImportAdopt y el código external_data

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Agente — `dataPath` y `adopt` en la spec

**Agent:** go-agent-dev

**Files:**
- Create: `proto/fixtures/data-path-cases.json`, `agent/internal/spec/adopt.go`, `agent/internal/spec/adopt_test.go`
- Modify: `agent/internal/spec/spec.go` (struct `Spec` y `Validate` debajo de las anclas `plan-6`; una línea de `BuildContainer` fuera de ancla)

**Interfaces:**
- Consumes: `spec.Spec`, `spec.Parse`, `spec.BuildContainer(meta, s, dataRoot, network)`, `spec.Image`, `(*Backups)` del Plan 4 (`s.Backups.Enabled`), helpers de test `loadFixture`, `meta` (`spec_test.go`) y `fixturePath` (`content_test.go`).
- Produces: campos `Spec.DataPath string` (JSON `dataPath,omitempty`) y `Spec.Adopt *Adopt` (JSON `adopt,omitempty`); `type Adopt struct{ ContainerID string \`json:"containerId"\`; Version uint64 \`json:"version"\` }`; `const MaxDataPath = 1024`; `var DeniedDataPaths []string`; `func ValidateDataPath(p string) error` (`""` es válido: sin dataPath); `func IsItzgImage(ref string) bool`; `Build.DataDir` = `dataPath` cuando lo hay. Fixture `proto/fixtures/data-path-cases.json` (array de `{path, ok}`) que la Task 7 ejecuta con zod.

- [ ] **Step 1: Fixture compartida**

`proto/fixtures/data-path-cases.json`:
```json
[
  { "path": "/srv/minecraft-viejo/survival", "ok": true },
  { "path": "/home/lobo/minecraft/survival/data", "ok": true },
  { "path": "/srv/minecraft", "ok": true },
  { "path": "/mnt/disco 2/mc_world-1", "ok": true },
  { "path": "/root/mc", "ok": true },
  { "path": "/opt/mc/server@1+2", "ok": true },
  { "path": "/home/lobo/.worktrees/x/data", "ok": true },
  { "path": "/etcetera/mc", "ok": true },
  { "path": "/procs/mc", "ok": true },
  { "path": "/tmp/mc", "ok": true },
  { "path": "relativa/mc", "ok": false },
  { "path": "/", "ok": false },
  { "path": "/data", "ok": false },
  { "path": "/home", "ok": false },
  { "path": "/srv/mc/", "ok": false },
  { "path": "/srv//mc", "ok": false },
  { "path": "/srv/./mc", "ok": false },
  { "path": "/srv/../etc/mc", "ok": false },
  { "path": "/srv/mc/..", "ok": false },
  { "path": "/proc/1/root", "ok": false },
  { "path": "/sys/fs/cgroup", "ok": false },
  { "path": "/etc/minecraft", "ok": false },
  { "path": "/dev/shm/mc", "ok": false },
  { "path": "/boot/mc", "ok": false },
  { "path": "/usr/local/mc", "ok": false },
  { "path": "/lib64/mc", "ok": false },
  { "path": "/run/docker.sock", "ok": false },
  { "path": "/var/run/docker.sock", "ok": false },
  { "path": "/var/lib/docker/volumes/mc/_data", "ok": false },
  { "path": "/srv/mc:/etc", "ok": false },
  { "path": "/srv/mc,ro", "ok": false },
  { "path": "/srv/mc\\x", "ok": false },
  { "path": "/srv/mc\nx", "ok": false },
  { "path": "/srv/Música", "ok": false }
]
```

- [ ] **Step 2: Tests que fallan**

`agent/internal/spec/adopt_test.go`:
```go
package spec

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDataPathCasesSharedWithZod(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("data-path-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Path string `json:"path"`
		OK   bool   `json:"ok"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("solo %d casos: ¿fixture truncada?", len(cases))
	}
	for _, c := range cases {
		if err := ValidateDataPath(c.Path); (err == nil) != c.OK {
			t.Errorf("ValidateDataPath(%q) = %v; ok esperado %v", c.Path, err, c.OK)
		}
	}
}

func TestDataPathLength(t *testing.T) {
	ok := "/srv/" + strings.Repeat("a", MaxDataPath-len("/srv/"))
	if err := ValidateDataPath(ok); err != nil {
		t.Fatalf("%d bytes debería valer: %v", len(ok), err)
	}
	if err := ValidateDataPath(ok + "a"); err == nil {
		t.Fatal("más de MaxDataPath bytes debe fallar")
	}
}

func TestBuildContainerUsesDataPath(t *testing.T) {
	base, err := BuildContainer(meta, loadFixture(t), "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	s := loadFixture(t)
	s.DataPath = "/home/lobo/minecraft/survival/data"
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.DataDir != s.DataPath || len(b.HostConfig.Binds) != 1 || b.HostConfig.Binds[0] != s.DataPath+":/data" {
		t.Fatalf("dataDir = %q, binds = %v", b.DataDir, b.HostConfig.Binds)
	}
	if b.Name != "mcsm-survival" {
		t.Fatalf("name = %q", b.Name)
	}
	if b.Hash == base.Hash {
		t.Fatal("otra carpeta de datos es otro contenedor: el hash debe cambiar")
	}
}

func TestDataPathCannotOverlapDataRoot(t *testing.T) {
	for _, tc := range []struct{ dataPath, root string }{
		{"/srv/minecraft/survival/data", "/srv/minecraft"},
		{"/srv/minecraft/otro", "/srv/minecraft"},
		{"/srv/minecraft", "/srv/minecraft"},
		{"/srv/data", "/srv/data/minecraft"},
	} {
		s := loadFixture(t)
		s.DataPath = tc.dataPath
		if _, err := BuildContainer(meta, s, tc.root, "mcsm"); err == nil || !strings.Contains(err.Error(), "DATA_ROOT") {
			t.Errorf("dataPath %q con DATA_ROOT %q: err = %v", tc.dataPath, tc.root, err)
		}
	}
	s := loadFixture(t)
	s.DataPath = "/srv/minecraft-viejo/survival" // comparte texto con DATA_ROOT, no ruta
	if _, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm"); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyDataPathAndAdoptKeepGoldenHash(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["dataPath"] = json.RawMessage(`""`)
	doc["adopt"] = json.RawMessage(`{"containerId":"` + strings.Repeat("ab", 32) + `","version":1}`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	build, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if build.Hash != "09ff6e5490b40677" {
		t.Fatalf("hash = %s: dataPath vacío y adopt no pueden cambiar el contenedor", build.Hash)
	}
	for _, e := range build.Config.Env {
		if strings.Contains(strings.ToLower(e), "adopt") {
			t.Errorf("adopt no va al env: %q", e)
		}
	}
}

func TestDataPathWithScheduledBackupsIsInvalid(t *testing.T) {
	s := loadFixture(t)
	s.DataPath = "/home/lobo/minecraft/survival"
	s.Backups = &Backups{Enabled: true, Cron: "0 4 * * *", KeepDays: 7, KeepCount: 10}
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), "dataPath") {
		t.Fatalf("copias programadas con dataPath: err = %v", err)
	}
	s.Backups.Enabled = false
	if err := s.Validate(); err != nil {
		t.Fatalf("sin programar sí vale: %v", err)
	}
}

func TestAdoptValidation(t *testing.T) {
	for _, tc := range []struct {
		adopt Adopt
		ok    bool
	}{
		{Adopt{ContainerID: strings.Repeat("0f", 32), Version: 1}, true},
		{Adopt{ContainerID: "fake0001", Version: 3}, true},
		{Adopt{ContainerID: "", Version: 1}, false},
		{Adopt{ContainerID: "../containers/x", Version: 1}, false},
		{Adopt{ContainerID: strings.Repeat("a", 65), Version: 1}, false},
		{Adopt{ContainerID: "abc", Version: 0}, false},
	} {
		s := loadFixture(t)
		a := tc.adopt
		s.Adopt = &a
		if err := s.Validate(); (err == nil) != tc.ok {
			t.Errorf("adopt %+v: err = %v", tc.adopt, err)
		}
	}
}

func TestIsItzgImage(t *testing.T) {
	for ref, want := range map[string]bool{
		"itzg/minecraft-server":                     true,
		"itzg/minecraft-server:java21":              true,
		"docker.io/itzg/minecraft-server:latest":    true,
		"itzg/minecraft-server@sha256:" + strings.Repeat("a", 64): true,
		"itzg/minecraft-server-extra":               false,
		"itzg/minecraft-bedrock-server":             false,
		"ghcr.io/itzg/minecraft-server":             false,
		"alpine:3.22":                               false,
		"":                                          false,
	} {
		if got := IsItzgImage(ref); got != want {
			t.Errorf("IsItzgImage(%q) = %v", ref, got)
		}
	}
}
```

- [ ] **Step 3: Comprueba que fallan**

Run: `eval "$(mise env)" && cd agent && go test ./internal/spec/`
Expected: FAIL de compilación (`undefined: ValidateDataPath`, `s.DataPath`, `Adopt`, `IsItzgImage`).

- [ ] **Step 4: Implementación**

`agent/internal/spec/adopt.go`:
```go
package spec

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Importación (plan-6, spec §6.7): carpeta de datos de un servidor importado y adopción.

// MaxDataPath es la longitud máxima de dataPath en bytes (DATA_PATH_MAX_BYTES en el panel).
const MaxDataPath = 1024

// dataPathSegRe: cada tramo de dataPath, solo ASCII (letras, números, espacio y . _ @ + -). Sin
// ":" (rompería el bind src:/data), "," ni "\". Misma regla en zod (fixture data-path-cases.json).
var dataPathSegRe = regexp.MustCompile(`^[A-Za-z0-9._@+ -]+$`)

// DeniedDataPaths son zonas del sistema que nunca se montan en /data: el agente corre como root
// y el entrypoint de itzg hace chown -R de /data. Se comparan por tramos (/etcetera sí vale).
var DeniedDataPaths = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
	"/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
}

// adoptIDRe: id del contenedor a adoptar. El panel envía ids completos (64 hex); se admite
// cualquier id alfanumérico corto para los del fake de Docker en los tests.
var adoptIDRe = regexp.MustCompile(`^[0-9A-Za-z]{1,64}$`)

// Adopt lo añade el panel a la spec que envía de un servidor importado; nunca se guarda en la
// spec del panel. ContainerID es el contenedor original y Version la versión de la spec con la
// que se adoptó: el agente no lo recrea mientras la spec no la supere.
type Adopt struct {
	ContainerID string `json:"containerId"`
	Version     uint64 `json:"version"`
}

// pathWithin indica si child es parent o cuelga de él (rutas absolutas limpias).
func pathWithin(child, parent string) bool {
	if parent == "/" {
		return strings.HasPrefix(child, "/")
	}
	return child == parent || strings.HasPrefix(child, parent+"/")
}

// ValidateDataPath valida dataPath sin conocer DATA_ROOT ("" = sin dataPath). La relación con
// DATA_ROOT la comprueba BuildContainer.
func ValidateDataPath(p string) error {
	if p == "" {
		return nil
	}
	if len(p) > MaxDataPath {
		return fmt.Errorf("spec: dataPath demasiado largo (máx. %d bytes)", MaxDataPath)
	}
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("spec: dataPath debe ser una ruta absoluta: %q", p)
	}
	segs := strings.Split(p[1:], "/")
	if len(segs) < 2 {
		return fmt.Errorf("spec: dataPath %q es demasiado general: indica al menos dos niveles", p)
	}
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			return fmt.Errorf("spec: dataPath %q no está normalizada (sin //, «.» ni «..», sin / al final)", p)
		}
		if !dataPathSegRe.MatchString(s) {
			return fmt.Errorf("spec: dataPath %q tiene caracteres no admitidos (letras y números ASCII, espacio y . _ @ + -)", p)
		}
	}
	for _, d := range DeniedDataPaths {
		if pathWithin(p, d) {
			return fmt.Errorf("spec: dataPath %q está en una zona del sistema (%s): no se monta", p, d)
		}
	}
	return nil
}

// IsItzgImage indica si ref es itzg/minecraft-server (con o sin docker.io/, con etiqueta o digest).
func IsItzgImage(ref string) bool {
	rest, ok := strings.CutPrefix(strings.TrimPrefix(ref, "docker.io/"), Image)
	return ok && (rest == "" || rest[0] == ':' || rest[0] == '@')
}

// validateImport valida dataPath y adopt. Con dataPath no hay copias programadas: el agente no ve
// esa carpeta (solo monta DATA_ROOT). Mismo criterio que dataPathCheck en el panel.
func (s Spec) validateImport() error {
	if err := ValidateDataPath(s.DataPath); err != nil {
		return err
	}
	if s.DataPath != "" && s.Backups != nil && s.Backups.Enabled {
		return fmt.Errorf("spec: las copias programadas no están disponibles con dataPath: el agente no ve esa carpeta (solo monta DATA_ROOT)")
	}
	if a := s.Adopt; a != nil {
		if !adoptIDRe.MatchString(a.ContainerID) {
			return fmt.Errorf("spec: adopt.containerId inválido %q", a.ContainerID)
		}
		if a.Version == 0 {
			return fmt.Errorf("spec: adopt.version debe ser al menos 1")
		}
	}
	return nil
}

// dataDir es la carpeta del host montada en /data: dataPath si lo hay (fuera de DATA_ROOT y sin
// contenerlo: nunca solapa los datos de los servidores gestionados) o <dataRoot>/<slug>/data.
func (s Spec) dataDir(slug, dataRoot string) (string, error) {
	if s.DataPath == "" {
		return filepath.Join(dataRoot, slug, "data"), nil
	}
	root := filepath.Clean(dataRoot)
	if pathWithin(s.DataPath, root) || pathWithin(root, s.DataPath) {
		return "", fmt.Errorf("spec: dataPath %q no puede estar dentro de DATA_ROOT (%s) ni contenerlo", s.DataPath, root)
	}
	return s.DataPath, nil
}
```

En `agent/internal/spec/spec.go`:
1. Struct `Spec`, debajo de `// ── plan-6 ──`:
```go
	// DataPath: carpeta del host montada en /data en lugar de <DATA_ROOT>/<slug>/data (importados
	// con los datos fuera de DATA_ROOT). Vacío = ruta por defecto: contenedor y hash no cambian.
	DataPath string `json:"dataPath,omitempty"`
	// Adopt lo añade el panel al enviar la spec de un importado; no entra en el contenedor ni en el hash.
	Adopt *Adopt `json:"adopt,omitempty"`
```
2. `Validate`, debajo de `// ── plan-6 ──`:
```go
	if err := s.validateImport(); err != nil {
		return err
	}
```
3. `BuildContainer` (fuera de ancla): sustituye `dataDir := filepath.Join(dataRoot, meta.Slug, "data")` por:
```go
	// plan-6: dataPath de los servidores importados.
	dataDir, err := s.dataDir(meta.Slug, dataRoot)
	if err != nil {
		return nil, err
	}
```
(`hash, err := hashOf(…)` más abajo sigue compilando: `hash` es nueva.)

- [ ] **Step 5: Comprueba que pasa**

Run: `eval "$(mise env)" && cd agent && go test ./internal/spec/ && go vet ./...`
Expected: PASS, incluido `TestHashGolden` sin tocar.

- [ ] **Step 6: Commit**

```bash
git add proto/fixtures/data-path-cases.json agent/internal/spec/adopt.go agent/internal/spec/adopt_test.go agent/internal/spec/spec.go
git commit -m "feat(agent): dataPath y adopt en la spec, con validación compartida con el panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Agente — Docker: listar, inspeccionar para importar y conectar a la red

**Agent:** go-agent-dev

**Files:**
- Create: `agent/internal/docker/import.go`, `agent/internal/docker/fake_import.go`, `agent/internal/docker/fake_import_test.go`, `agent/internal/docker/moby_import.go`, `agent/internal/docker/moby_import_integration_test.go`
- Modify: `agent/internal/docker/engine.go` (fuera de ancla: campo `Container.Adopted` y cuatro métodos de `Engine`), `agent/internal/docker/fake.go` (fuera de ancla: campos `ImageEnvs`, `ConnectErr`, `FakeContainer.Aliases` y su inicialización)

**Interfaces:**
- Consumes: `docker.Engine`, `docker.Fake`/`FakeContainer` (`Config`, `HostConfig`, `Net`), `docker.Moby{cli}`, `notFound`, `copyLabels`, `ErrNotFound`.
- Produces:
  - `Container.Adopted bool` (lo rellena el reconciliador; Docker nunca).
  - `type ImportInfo struct { ID, Name, Image, ImageID, State string; Env []string; Labels map[string]string; Ports []PortPublish; Mounts []Mount; Restart string; Memory, NanoCPUs int64; NetworkMode string; Networks []string }`
  - `type PortPublish struct { ContainerPort int; Proto, HostIP string; HostPort int }` (`HostIP` "" = todas las interfaces; `HostPort` 0 = efímero) y `type Mount struct { Type, Source, Destination, Name string; RW bool }`.
  - `Engine.ListAll(ctx) ([]Container, error)`, `Engine.InspectImport(ctx, id) (*ImportInfo, error)` (`ErrNotFound` si no existe), `Engine.ImageEnv(ctx, image string) ([]string, error)` (`ErrNotFound` si no existe), `Engine.ConnectNetwork(ctx, netName, id string, aliases []string) error`.
  - Fake: `Fake.ImageEnvs map[string][]string` (por referencia de imagen; en el fake `ImageID` = `Config.Image`), `Fake.ConnectErr error`, `FakeContainer.Aliases map[string][]string` (red → alias de `ConnectNetwork`); `ConnectNetwork` se anota en `Calls` como `"ConnectNetwork <red> <id> <alias,…>"`; `ListAll`/`InspectImport`/`ImageEnv` no se anotan (como `Inspect`).

- [ ] **Step 1: Tests que fallan (fake)**

`agent/internal/docker/fake_import_test.go`:
```go
package docker

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

func TestFakeInspectImport(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, err := f.Create(ctx, "viejo",
		&container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"A=1"}, Labels: map[string]string{"x": "y"}},
		&container.HostConfig{
			Binds:         []string{"/srv/viejo:/data", "/srv/mods:/mods:ro,z"},
			NetworkMode:   "bridge",
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyAlways},
			Resources:     container.Resources{Memory: 1 << 30, NanoCPUs: 1e9},
			PortBindings: network.PortMap{
				network.MustParsePort("25565/tcp"): {{HostPort: "25570"}},
				network.MustParsePort("19132/udp"): {{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: "19132"}},
			},
		},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"casa_default": {}}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := f.InspectImport(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	want := &ImportInfo{
		ID: id, Name: "viejo", Image: "itzg/minecraft-server:java21", ImageID: "itzg/minecraft-server:java21", State: "created",
		Env: []string{"A=1"}, Labels: map[string]string{"x": "y"},
		Ports: []PortPublish{{ContainerPort: 19132, Proto: "udp", HostIP: "127.0.0.1", HostPort: 19132}, {ContainerPort: 25565, Proto: "tcp", HostPort: 25570}},
		Mounts: []Mount{{Type: "bind", Source: "/srv/viejo", Destination: "/data", RW: true}, {Type: "bind", Source: "/srv/mods", Destination: "/mods", RW: false}},
		Restart: "always", Memory: 1 << 30, NanoCPUs: 1e9, NetworkMode: "bridge", Networks: []string{"casa_default"},
	}
	if !reflect.DeepEqual(info, want) {
		t.Fatalf("inspect =\n%+v\nwant\n%+v", info, want)
	}
	if _, err := f.InspectImport(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestFakeListAllIncludesForeign(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	managed, _ := f.Create(ctx, "mcsm-a", &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	foreign, _ := f.Create(ctx, "ajeno", &container.Config{Image: "y"}, &container.HostConfig{}, nil)
	all, err := f.ListAll(ctx)
	if err != nil || len(all) != 2 || all[0].ID != managed || all[1].ID != foreign || all[1].Name != "ajeno" {
		t.Fatalf("ListAll = %+v, %v", all, err)
	}
	if m, _ := f.ListManaged(ctx); len(m) != 1 {
		t.Fatalf("ListManaged sigue viendo solo los gestionados: %+v", m)
	}
}

func TestFakeConnectNetwork(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, _ := f.Create(ctx, "ajeno", &container.Config{Image: "y"}, &container.HostConfig{}, nil)
	if err := f.ConnectNetwork(ctx, "mcsm", id, []string{"mcsm-viejo"}); err != nil {
		t.Fatal(err)
	}
	if got := f.Containers[id].Aliases["mcsm"]; !reflect.DeepEqual(got, []string{"mcsm-viejo"}) {
		t.Fatalf("alias = %v", got)
	}
	info, _ := f.InspectImport(ctx, id)
	if !reflect.DeepEqual(info.Networks, []string{"mcsm"}) {
		t.Fatalf("networks = %v", info.Networks)
	}
	if err := f.ConnectNetwork(ctx, "mcsm", id, []string{"otro"}); err == nil {
		t.Fatal("conectar dos veces a la misma red debe fallar, como en Docker")
	}
	if err := f.ConnectNetwork(ctx, "mcsm", "nope", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	f.ConnectErr = errors.New("boom")
	if err := f.ConnectNetwork(ctx, "otra", id, nil); err == nil {
		t.Fatal("ConnectErr debe devolverse")
	}
	if n := len(f.Calls); f.Calls[n-1] != "ConnectNetwork otra "+id+" " {
		t.Fatalf("calls = %v", f.Calls)
	}
}

func TestFakeImageEnv(t *testing.T) {
	f := NewFake()
	f.ImageEnvs["itzg/minecraft-server:java21"] = []string{"PATH=/usr/bin", "UID=1000"}
	env, err := f.ImageEnv(context.Background(), "itzg/minecraft-server:java21")
	if err != nil || !reflect.DeepEqual(env, []string{"PATH=/usr/bin", "UID=1000"}) {
		t.Fatalf("env = %v, %v", env, err)
	}
	if _, err := f.ImageEnv(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 2: Comprueba que fallan**

Run: `eval "$(mise env)" && cd agent && go test ./internal/docker/`
Expected: FAIL de compilación (`undefined: ImportInfo`, `f.ListAll`, `f.ImageEnvs`…).

- [ ] **Step 3: Tipos e interfaz**

`agent/internal/docker/import.go`:
```go
package docker

import "sort"

// ImportInfo es el inspect reducido de un contenedor que se puede importar (spec §6.7).
type ImportInfo struct {
	ID          string
	Name        string
	Image       string // Config.Image tal cual la escribió el usuario
	ImageID     string // imagen con la que corre (sha256:… en Docker)
	State       string
	Env         []string
	Labels      map[string]string
	Ports       []PortPublish // publicaciones configuradas (HostConfig.PortBindings), ordenadas
	Mounts      []Mount
	Restart     string
	Memory      int64 // límite de memoria; 0 = sin límite
	NanoCPUs    int64
	NetworkMode string
	Networks    []string // redes a las que está conectado, ordenadas
}

// PortPublish es una publicación de puerto. HostIP "" = todas las interfaces; HostPort 0 = efímero.
type PortPublish struct {
	ContainerPort int
	Proto         string
	HostIP        string
	HostPort      int
}

// Mount es un montaje del contenedor. Source es la ruta del host (bind) o del volumen.
type Mount struct {
	Type        string
	Source      string
	Destination string
	Name        string
	RW          bool
}

func sortPorts(ps []PortPublish) {
	sort.Slice(ps, func(i, j int) bool {
		a, b := ps[i], ps[j]
		if a.ContainerPort != b.ContainerPort {
			return a.ContainerPort < b.ContainerPort
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		if a.HostPort != b.HostPort {
			return a.HostPort < b.HostPort
		}
		return a.HostIP < b.HostIP
	})
}
```

`agent/internal/docker/engine.go` (fuera de ancla):
1. En `type Container struct`, añade como último campo:
```go
	// Adopted lo marca el reconciliador en el contenedor original de un servidor importado (plan-6):
	// no tiene etiquetas mcsm.* y sus Labels son sintetizadas. Docker nunca lo rellena.
	Adopted bool
```
2. Al final de `type Engine interface`:
```go
	// ── plan-6: importación (spec §6.7) ──
	// ListAll lista todos los contenedores del host (como `docker ps -a`), gestionados o no.
	ListAll(ctx context.Context) ([]Container, error)
	// InspectImport es el inspect reducido de un contenedor importable. ErrNotFound si no existe.
	InspectImport(ctx context.Context, id string) (*ImportInfo, error)
	// ImageEnv devuelve el ENV de una imagen (por id o referencia). ErrNotFound si no existe.
	ImageEnv(ctx context.Context, image string) ([]string, error)
	// ConnectNetwork conecta un contenedor (en marcha o no) a una red con alias DNS, sin reiniciarlo.
	ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error
```

`agent/internal/docker/fake.go` (fuera de ancla):
1. En `type Fake struct`, debajo de `StatsErr error …`:
```go
	ImageEnvs  map[string][]string // plan-6: ENV de cada imagen, por referencia (ImageEnv)
	ConnectErr error               // plan-6: si no es nil, ConnectNetwork lo devuelve
```
2. En `type FakeContainer struct`, al final:
```go
	Aliases    map[string][]string // plan-6: red → alias añadidos con ConnectNetwork
```
3. `NewFake` pasa a ser:
```go
func NewFake() *Fake {
	return &Fake{Containers: map[string]*FakeContainer{}, Images: map[string]bool{}, Networks: map[string]bool{}, ImageEnvs: map[string][]string{}, logPipes: map[string][]*io.PipeWriter{}}
}
```

- [ ] **Step 4: Fake**

`agent/internal/docker/fake_import.go`:
```go
package docker

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// ListAll devuelve todos los contenedores, ordenados por id. Como Inspect, no se anota en Calls.
func (f *Fake) ListAll(context.Context) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Container, 0, len(f.Containers))
	for _, c := range f.Containers {
		labels := map[string]string{}
		if c.Config != nil {
			labels = copyLabels(c.Config.Labels)
		}
		out = append(out, Container{ID: c.ID, Name: c.Name, State: c.State, Labels: labels})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// InspectImport traduce la configuración guardada en Create (y las redes de ConnectNetwork).
// En el fake ImageID es la referencia de la imagen. No se anota en Calls.
func (f *Fake) InspectImport(_ context.Context, id string) (*ImportInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.Containers[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := &ImportInfo{ID: c.ID, Name: c.Name, State: c.State, Labels: map[string]string{}}
	if c.Config != nil {
		out.Image, out.ImageID = c.Config.Image, c.Config.Image
		out.Env = append([]string(nil), c.Config.Env...)
		out.Labels = copyLabels(c.Config.Labels)
	}
	if hc := c.HostConfig; hc != nil {
		out.Restart = string(hc.RestartPolicy.Name)
		out.Memory = hc.Resources.Memory
		out.NanoCPUs = hc.Resources.NanoCPUs
		out.NetworkMode = string(hc.NetworkMode)
		for p, binds := range hc.PortBindings {
			for _, b := range binds {
				hp, _ := strconv.Atoi(b.HostPort)
				ip := ""
				if b.HostIP.IsValid() && !b.HostIP.IsUnspecified() {
					ip = b.HostIP.String()
				}
				out.Ports = append(out.Ports, PortPublish{ContainerPort: int(p.Num()), Proto: string(p.Proto()), HostIP: ip, HostPort: hp})
			}
		}
		for _, bind := range hc.Binds {
			parts := strings.Split(bind, ":")
			if len(parts) < 2 {
				continue
			}
			rw := len(parts) < 3 || !slices.Contains(strings.Split(parts[2], ","), "ro")
			out.Mounts = append(out.Mounts, Mount{Type: "bind", Source: parts[0], Destination: parts[1], RW: rw})
		}
		for _, m := range hc.Mounts {
			mt := Mount{Type: string(m.Type), Source: m.Source, Destination: m.Target, RW: !m.ReadOnly}
			if mt.Type == "volume" {
				mt.Name = m.Source
			}
			out.Mounts = append(out.Mounts, mt)
		}
	}
	nets := map[string]bool{}
	if c.Net != nil {
		for n := range c.Net.EndpointsConfig {
			nets[n] = true
		}
	}
	for n := range c.Aliases {
		nets[n] = true
	}
	for n := range nets {
		out.Networks = append(out.Networks, n)
	}
	sort.Strings(out.Networks)
	sortPorts(out.Ports)
	return out, nil
}

// ImageEnv devuelve el ENV fijado en ImageEnvs para esa referencia. No se anota en Calls.
func (f *Fake) ImageEnv(_ context.Context, image string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	env, ok := f.ImageEnvs[image]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]string(nil), env...), nil
}

// ConnectNetwork imita a Docker: conectar dos veces a la misma red es un error.
func (f *Fake) ConnectNetwork(_ context.Context, netName, id string, aliases []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("ConnectNetwork %s %s %s", netName, id, strings.Join(aliases, ","))
	if f.ConnectErr != nil {
		return f.ConnectErr
	}
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	_, viaAlias := c.Aliases[netName]
	viaCreate := false
	if c.Net != nil {
		_, viaCreate = c.Net.EndpointsConfig[netName]
	}
	if viaAlias || viaCreate {
		return fmt.Errorf("endpoint with name %s already exists in network %s", c.Name, netName)
	}
	if c.Aliases == nil {
		c.Aliases = map[string][]string{}
	}
	c.Aliases[netName] = append([]string(nil), aliases...)
	return nil
}
```

- [ ] **Step 5: Moby**

`agent/internal/docker/moby_import.go`:
```go
package docker

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func (m *Moby) ListAll(ctx context.Context) ([]Container, error) {
	res, err := m.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(res.Items))
	for _, c := range res.Items {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out = append(out, Container{ID: c.ID, Name: name, State: string(c.State), Labels: c.Labels})
	}
	return out, nil
}

func (m *Moby) InspectImport(ctx context.Context, id string) (*ImportInfo, error) {
	res, err := m.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return nil, notFound(err)
	}
	c := res.Container
	out := &ImportInfo{ID: c.ID, Name: strings.TrimPrefix(c.Name, "/"), ImageID: c.Image, Labels: map[string]string{}}
	if c.State != nil {
		out.State = string(c.State.Status)
	}
	if c.Config != nil {
		out.Image = c.Config.Image
		out.Env = c.Config.Env
		if c.Config.Labels != nil {
			out.Labels = c.Config.Labels
		}
	}
	if hc := c.HostConfig; hc != nil {
		out.Restart = string(hc.RestartPolicy.Name)
		out.Memory = hc.Resources.Memory
		out.NanoCPUs = hc.Resources.NanoCPUs
		out.NetworkMode = string(hc.NetworkMode)
		for p, binds := range hc.PortBindings {
			for _, b := range binds {
				hp, _ := strconv.Atoi(b.HostPort)
				ip := ""
				if b.HostIP.IsValid() && !b.HostIP.IsUnspecified() {
					ip = b.HostIP.String()
				}
				out.Ports = append(out.Ports, PortPublish{ContainerPort: int(p.Num()), Proto: string(p.Proto()), HostIP: ip, HostPort: hp})
			}
		}
	}
	for _, mp := range c.Mounts {
		out.Mounts = append(out.Mounts, Mount{Type: string(mp.Type), Source: mp.Source, Destination: mp.Destination, Name: mp.Name, RW: mp.RW})
	}
	if c.NetworkSettings != nil {
		for name := range c.NetworkSettings.Networks {
			out.Networks = append(out.Networks, name)
		}
	}
	sort.Strings(out.Networks)
	sortPorts(out.Ports)
	return out, nil
}

func (m *Moby) ImageEnv(ctx context.Context, image string) ([]string, error) {
	res, err := m.cli.ImageInspect(ctx, image)
	if err != nil {
		return nil, notFound(err)
	}
	if res.Config == nil {
		return nil, nil
	}
	return res.Config.Env, nil
}

func (m *Moby) ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error {
	_, err := m.cli.NetworkConnect(ctx, netName, client.NetworkConnectOptions{
		Container: id, EndpointConfig: &network.EndpointSettings{Aliases: aliases},
	})
	return notFound(err)
}
```

`agent/internal/docker/moby_import_integration_test.go`:
```go
//go:build integration

package docker

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func TestMobyImportInspectAndConnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	const netName, name = "mcsm-test-import-net", "mcsm-test-import"
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = m.cli.NetworkRemove(context.Background(), netName, client.NetworkRemoveOptions{}) }()
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	if all, err := m.ListAll(ctx); err == nil {
		for _, c := range all {
			if c.Name == name {
				_ = m.Remove(ctx, c.ID)
			}
		}
	}
	dir := t.TempDir()
	id, err := m.Create(ctx, name,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sleep", "300"}, Env: []string{"FOO=bar"},
			Labels: map[string]string{"mcsm.test": "true", "com.docker.compose.project": "mcsm-test"}},
		&container.HostConfig{
			Binds:         []string{dir + ":/data", dir + ":/extra:ro"},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			PortBindings:  network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25596"}}},
			Resources:     container.Resources{Memory: 64 << 20, NanoCPUs: 5e8},
		}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	all, err := m.ListAll(ctx)
	if err != nil || !slices.ContainsFunc(all, func(c Container) bool { return c.ID == id && c.Labels["mcsm.test"] == "true" }) {
		t.Fatalf("ListAll no devuelve el contenedor: %v", err)
	}
	info, err := m.InspectImport(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != name || info.Image != "alpine:3.22" || !strings.HasPrefix(info.ImageID, "sha256:") || info.State != "running" ||
		!slices.Contains(info.Env, "FOO=bar") || info.Restart != "unless-stopped" || info.Memory != 64<<20 || info.NanoCPUs != 5e8 {
		t.Fatalf("inspect = %+v", info)
	}
	if len(info.Ports) != 1 || info.Ports[0] != (PortPublish{ContainerPort: 25565, Proto: "tcp", HostPort: 25596}) {
		t.Fatalf("ports = %+v", info.Ports)
	}
	if !slices.Contains(info.Mounts, Mount{Type: "bind", Source: dir, Destination: "/data", RW: true}) ||
		!slices.Contains(info.Mounts, Mount{Type: "bind", Source: dir, Destination: "/extra", RW: false}) {
		t.Fatalf("mounts = %+v", info.Mounts)
	}
	env, err := m.ImageEnv(ctx, info.ImageID)
	if err != nil || !slices.ContainsFunc(env, func(e string) bool { return strings.HasPrefix(e, "PATH=") }) {
		t.Fatalf("ImageEnv = %v, %v", env, err)
	}
	if err := m.ConnectNetwork(ctx, netName, id, []string{"mcsm-test-alias"}); err != nil {
		t.Fatal(err)
	}
	info, _ = m.InspectImport(ctx, id)
	if !slices.Contains(info.Networks, netName) {
		t.Fatalf("networks = %v", info.Networks)
	}
	if _, err := m.InspectImport(ctx, "mcsm-test-no-existe"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 6: Comprueba que pasa**

Run: `eval "$(mise env)" && cd agent && gofmt -l ./internal/docker && go vet ./... && go test -race ./... && go test -tags integration -run TestMobyImportInspectAndConnect ./internal/docker/`
Expected: `gofmt -l` sin salida; todo PASS (el de integración contra el Docker real crea y borra `mcsm-test-import` y la red `mcsm-test-import-net`). Los envoltorios de los tests que incrustan `*docker.Fake` siguen compilando.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/docker/engine.go agent/internal/docker/fake.go agent/internal/docker/import.go \
  agent/internal/docker/fake_import.go agent/internal/docker/fake_import_test.go \
  agent/internal/docker/moby_import.go agent/internal/docker/moby_import_integration_test.go
git commit -m "feat(agent): Docker lista, inspecciona para importar y conecta contenedores a la red

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Agente — adopción en caliente en el reconciliador

**Agent:** systems-expert

**Files:**
- Create: `agent/internal/store/adoptions.go`, `agent/internal/store/adoptions_test.go`, `agent/internal/reconcile/adopt.go`, `agent/internal/reconcile/adopt_test.go`
- Modify: `agent/internal/reconcile/reconciler.go` (fuera de ancla: campo `adoptMu`; `find`, `reconcileLocked`, `removeLocked` y una línea de `observeLocked`; helper `replace`)

**Interfaces:**
- Consumes: Task 2 (`spec.Spec.Adopt`, `spec.Spec.DataPath`, `spec.IsItzgImage`, `Build.DataDir`), Task 3 (`docker.Container.Adopted`, `Engine.InspectImport`, `Engine.ConnectNetwork`, `docker.ImportInfo`), Plan 4 (`Reconciler.Hold`, `Forget`, `RetryRemovals`, `store.ForgetWithTombstone`, `deleteTombstone`).
- Produces (store): `type Adoption struct{ ContainerID string \`json:"containerId"\`; Slug string \`json:"slug"\`; Version uint64 \`json:"version"\` }`; `(*Store).PutAdoption(serverID string, a Adoption) error`; `(*Store).AdoptWithSpec(sp *mcsmv1.ServerSpec, a Adoption) error` (spec + adopción en una transacción, anula la lápida como `PutSpec`); `(*Store).Adoption(serverID) (*Adoption, error)` (nil si no hay); `(*Store).Adoptions() (map[string]Adoption, error)`; `(*Store).AdoptedBy(containerID) (string, error)` ("" si nadie); `(*Store).DeleteAdoption(serverID) error` (idempotente). La adopción sobrevive a `DeleteSpec` y `ForgetWithTombstone` a propósito.
- Produces (reconcile): `var ErrAdoptNotFound, ErrAdoptConflict, ErrAdoptMismatch, ErrAdoptSpec error`; `(*Reconciler).Adopt(ctx, sp *mcsmv1.ServerSpec) error` (idempotente; tras guardar, nunca falla por la reconciliación); `(*Reconciler).ServerContainers(ctx) ([]docker.Container, error)` (gestionados + adoptados con `Adopted=true` y `mcsm.server_id`/`mcsm.slug` sintetizados). `find`, `Container`, `ContainerID`, `Power`, `Observe`, `Remove` y la reconciliación ven al adoptado.

- [ ] **Step 1: Tests del store que fallan**

`agent/internal/store/adoptions_test.go`:
```go
package store

import (
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestAdoptionsCRUD(t *testing.T) {
	s := open(t)
	if a, err := s.Adoption("a"); err != nil || a != nil {
		t.Fatalf("sin bucket: %v, %v", a, err)
	}
	if err := s.DeleteAdoption("a"); err != nil {
		t.Fatalf("borrar sin bucket es idempotente: %v", err)
	}
	if err := s.PutAdoption("a", Adoption{ContainerID: "c1", Slug: "alpha", Version: 2}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutAdoption("", Adoption{ContainerID: "c1"}); err == nil {
		t.Fatal("sin server_id debe fallar")
	}
	if a, _ := s.Adoption("a"); a == nil || *a != (Adoption{ContainerID: "c1", Slug: "alpha", Version: 2}) {
		t.Fatalf("adoption = %+v", a)
	}
	if id, _ := s.AdoptedBy("c1"); id != "a" {
		t.Fatalf("AdoptedBy = %q", id)
	}
	if id, _ := s.AdoptedBy("c2"); id != "" {
		t.Fatalf("AdoptedBy de otro = %q", id)
	}
	all, _ := s.Adoptions()
	if len(all) != 1 || all["a"].ContainerID != "c1" {
		t.Fatalf("adoptions = %+v", all)
	}
	if err := s.DeleteAdoption("a"); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.Adoption("a"); a != nil {
		t.Fatal("debe haberse borrado")
	}
}

func TestAdoptWithSpecIsAtomicAndCancelsTombstone(t *testing.T) {
	s := open(t)
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	sp := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, SpecJson: []byte(`{}`)}
	if err := s.AdoptWithSpec(sp, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetSpec("a"); got == nil || got.Slug != "alpha" {
		t.Fatalf("spec = %v", got)
	}
	if tomb, _ := s.HasTombstone("a"); tomb {
		t.Fatal("la spec anula la lápida, como PutSpec")
	}
	if a, _ := s.Adoption("a"); a == nil || a.ContainerID != "c1" {
		t.Fatalf("adoption = %+v", a)
	}
}

func TestAdoptionSurvivesForget(t *testing.T) {
	s := open(t)
	_ = s.AdoptWithSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1}, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1})
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.Adoption("a"); a == nil {
		t.Fatal("el borrado pendiente necesita saber qué contenedor parar")
	}
}
```

- [ ] **Step 2: Tests del reconciliador que fallan**

`agent/internal/reconcile/adopt_test.go`:
```go
package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const desiredRunning = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

// extDataPath es una carpeta fuera de DATA_ROOT que no existe: el agente nunca debe crearla.
const extDataPath = "/mcsm-test-noexiste/externo/data"

// external crea un contenedor itzg ajeno (sin etiquetas mcsm) que monta bindSrc en /data y publica
// 25565/tcp en el 25570 del host; con run lo arranca.
func external(t *testing.T, fake *docker.Fake, name, bindSrc string, run bool, mut ...func(*container.Config, *container.HostConfig)) string {
	t.Helper()
	ctx := context.Background()
	cfg := &container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"EULA=TRUE", "TYPE=PAPER"}}
	hc := &container.HostConfig{
		Binds:         []string{bindSrc + ":/data"},
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		PortBindings:  network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}},
	}
	for _, m := range mut {
		m(cfg, hc)
	}
	id, err := fake.Create(ctx, name, cfg, hc, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"bridge": {}}})
	if err != nil {
		t.Fatal(err)
	}
	if run {
		if err := fake.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

type impOpts struct {
	adoptVersion uint64
	memory       string
	dataPath     string
	noAdopt      bool
}

// importedSpec es la spec que el panel envía de un importado (con "adopt").
func importedSpec(containerID string, o impOpts) []byte {
	if o.memory == "" {
		o.memory = "2G"
	}
	if o.adoptVersion == 0 {
		o.adoptVersion = 1
	}
	m := map[string]any{
		"imageTag": "java21", "type": "PAPER", "version": "1.21.4", "memory": o.memory,
		"ports": map[string]any{"game": 25570}, "restartPolicy": "unless-stopped", "rconPassword": "abcdefgh",
	}
	if !o.noAdopt {
		m["adopt"] = map[string]any{"containerId": containerID, "version": o.adoptVersion}
	}
	if o.dataPath != "" {
		m["dataPath"] = o.dataPath
	}
	b, _ := json.Marshal(m)
	return b
}

func importMsg(id, slug string, v uint64, js []byte) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: desiredRunning, SpecJson: js}
}

func TestAdoptKeepsContainerRunning(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc-viejo", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if n := calls(fake, "Create") + calls(fake, "Stop") + calls(fake, "Remove") + calls(fake, "Start") + calls(fake, "Kill"); n != 0 {
		t.Fatalf("adoptar no toca el contenedor: %v", fake.Calls)
	}
	if calls(fake, "ConnectNetwork mcsm "+id+" mcsm-alpha") != 1 {
		t.Fatalf("debe conectarlo a la red con el alias mcsm-alpha: %v", fake.Calls)
	}
	if got := r.ContainerID(ctx, "a"); got != id {
		t.Fatalf("ContainerID = %q", got)
	}
	if o := rec.get("a"); o == nil || o.ContainerId != id || o.State != "running" || o.Error != "" {
		t.Fatalf("observed = %+v", o)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d", v)
	}
	if ad, _ := st.Adoption("a"); ad == nil || *ad != (store.Adoption{ContainerID: id, Slug: "alpha", Version: 1}) {
		t.Fatalf("adoption = %+v", ad)
	}
	// Tick posterior: sigue sin recrear (el adoptado no tiene mcsm.spec_hash).
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || len(fake.Containers) != 1 {
		t.Fatalf("un tick no recrea: %v", fake.Calls)
	}
}

func TestAdoptedIsVisibleToPowerObserveAndServerContainers(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	var pinged []string
	r.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		pinged = append(pinged, host)
		return &mcsmv1.McStatus{Online: true}
	}
	id := external(t, fake, "mc-viejo", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if len(pinged) == 0 || pinged[len(pinged)-1] != "mcsm-alpha" {
		t.Fatalf("el ping va al alias mcsm-alpha: %v", pinged)
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
	if fake.Containers[id].State != "exited" {
		t.Fatalf("state = %s", fake.Containers[id].State)
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if fake.Containers[id].State != "running" || calls(fake, "Create") != 0 {
		t.Fatalf("power sobre el original: %v", fake.Calls)
	}
	// Un gestionado normal y el adoptado.
	put(t, r.st, "b", "beta", 1, desiredRunning, specJSON)
	if err := r.Reconcile(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	list, err := r.ServerContainers(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("ServerContainers = %+v, %v", list, err)
	}
	var adopted *docker.Container
	for i := range list {
		if list[i].Adopted {
			adopted = &list[i]
		}
	}
	if adopted == nil || adopted.ID != id || adopted.Labels[spec.LabelServerID] != "a" || adopted.Labels[spec.LabelSlug] != "alpha" || adopted.State != "running" {
		t.Fatalf("adoptado = %+v", adopted)
	}
}

func TestFirstSpecChangeRecreatesWithSameData(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	dataDir := filepath.Join(root, "alpha", "data")
	id := external(t, fake, "mc-viejo", dataDir, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	fake.Calls = nil
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("el contenedor original se borra al recrear")
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Name != "mcsm-alpha" || list[0].Labels[spec.LabelServerID] != "a" || list[0].State != "running" {
		t.Fatalf("gestionado = %+v", list)
	}
	if b := fake.Containers[list[0].ID].HostConfig.Binds; len(b) != 1 || b[0] != dataDir+":/data" {
		t.Fatalf("binds = %v: el mismo directorio de datos", b)
	}
	want := []string{"Stop " + id, "Remove " + id, "EnsureImage itzg/minecraft-server:java21", "Create mcsm-alpha", "Start " + list[0].ID}
	for i, w := range want {
		if i >= len(fake.Calls) || !strings.HasPrefix(fake.Calls[i], w) {
			t.Fatalf("calls = %v; want prefijos %v", fake.Calls, want)
		}
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("la adopción termina al recrear: %+v", ad)
	}
}

func TestAdoptChecks(t *testing.T) {
	cases := []struct {
		name string
		mk   func(t *testing.T, fake *docker.Fake, root string) string
		want error
	}{
		{"no existe", func(*testing.T, *docker.Fake, string) string { return "fake0999" }, ErrAdoptNotFound},
		{"ya gestionado", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mcsm-otro", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) {
				c.Labels = map[string]string{spec.LabelManaged: "true"}
			})
		}, ErrAdoptConflict},
		{"no es itzg", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "web", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) { c.Image = "nginx:1.27" })
		}, ErrAdoptMismatch},
		{"otro /data", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "beta", "data"), false)
		}, ErrAdoptMismatch},
		{"red host", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "alpha", "data"), false, func(_ *container.Config, h *container.HostConfig) { h.NetworkMode = "host" })
		}, ErrAdoptMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, st, fake, _, root := setup(t)
			id := c.mk(t, fake, root)
			fake.Calls = nil
			err := r.Adopt(context.Background(), importMsg("a", "alpha", 1, importedSpec(id, impOpts{})))
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v; want %v", err, c.want)
			}
			if sp, _ := st.GetSpec("a"); sp != nil {
				t.Fatal("un rechazo no guarda la spec")
			}
			if calls(fake, "Create")+calls(fake, "Remove")+calls(fake, "ConnectNetwork") != 0 {
				t.Fatalf("un rechazo no toca Docker: %v", fake.Calls)
			}
		})
	}
	t.Run("spec sin adopt", func(t *testing.T) {
		r, _, _, _, _ := setup(t)
		err := r.Adopt(context.Background(), importMsg("a", "alpha", 1, importedSpec("x", impOpts{noAdopt: true})))
		if !errors.Is(err, ErrAdoptSpec) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestAdoptIsIdempotent(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	msg := importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatalf("reintento del panel: %v", err)
	}
	if calls(fake, "ConnectNetwork") != 1 || calls(fake, "Create") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
}

func TestTwoServersCannotAdoptSameContainer(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, sid := range []string{"a", "b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = r.Adopt(ctx, importMsg(sid, sid+"-slug", 1, importedSpec(id, impOpts{dataPath: extDataPath})))
		}()
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		if err == nil {
			ok++
		} else if !errors.Is(err, ErrAdoptConflict) {
			t.Fatalf("err = %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("exactamente uno adopta: %v", errs)
	}
}

func TestReadoptFromSpecWithoutRecord(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{}))) // SyncSpecs tras perder el ImportAdopt
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || calls(fake, "ConnectNetwork mcsm "+id) != 1 {
		t.Fatalf("debe adoptar, no crear: %v", fake.Calls)
	}
	if ad, _ := st.Adoption("a"); ad == nil || ad.ContainerID != id || ad.Version != 1 {
		t.Fatalf("adoption = %+v", ad)
	}
}

func TestReadoptWithNewerSpecRecreatesAtOnce(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	put(t, r.st, "a", "alpha", 3, desiredRunning, string(importedSpec(id, impOpts{adoptVersion: 1})))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("v3 > adopción v1: se recrea: %v", fake.Calls)
	}
}

func TestReadoptOriginalGoneCreatesManaged(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("fake0042", impOpts{})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("sin original se crea el gestionado: %v", fake.Calls)
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("no queda adopción: %+v", ad)
	}
}

func TestReadoptMismatchCreatesNothing(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	id := external(t, fake, "mc", filepath.Join(root, "otra", "data"), true)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{})))
	err := r.Reconcile(context.Background(), "a")
	if !errors.Is(err, ErrAdoptMismatch) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create") != 0 {
		t.Fatalf("nunca un segundo contenedor sobre datos sin comprobar: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/data") {
		t.Fatalf("observed = %+v", o)
	}
}

func TestRemoveAdoptedRemovesOriginal(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("borrar el servidor borra su contenedor")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("ni adopción")
	}
}

func TestForgetAdoptedThenRetryRemovesOriginal(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Forget("a"); err != nil {
		t.Fatal(err)
	}
	if done := r.RetryRemovals(ctx); len(done) != 1 || done[0] != "a" {
		t.Fatalf("RetryRemovals = %v", done)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("la lápida borra el original adoptado")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("ni adopción")
	}
}

func TestRemoveWithDataPathRefusesDeleteData(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", true); err == nil || !strings.Contains(err.Error(), "fuera de DATA_ROOT") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("un rechazo no toca nada")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("ni la spec")
	}
}

func TestDataPathCreateNeverMkdirs(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("", impOpts{noAdopt: true, dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	list, _ := fake.ListManaged(context.Background())
	if len(list) != 1 || fake.Containers[list[0].ID].HostConfig.Binds[0] != extDataPath+":/data" {
		t.Fatalf("contenedor = %+v", list)
	}
	if _, err := os.Stat("/mcsm-test-noexiste"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("el agente no crea carpetas fuera de DATA_ROOT: %v", err)
	}
}

func TestHoldDefersFirstSpecChange(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "copia de seguridad")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("con el servidor reservado no se recrea")
	}
	release(ctx)
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("al liberar se aplica el cambio: %v", fake.Calls)
	}
}
```

- [ ] **Step 3: Comprueba que fallan**

Run: `eval "$(mise env)" && cd agent && go test ./internal/store/ ./internal/reconcile/`
Expected: FAIL de compilación (`undefined: Adoption`, `r.Adopt`, `ErrAdoptNotFound`…).

- [ ] **Step 4: Store**

`agent/internal/store/adoptions.go`:
```go
package store

import (
	"encoding/json"
	"errors"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bAdoptions guarda las adopciones (plan-6, spec §6.7): servidor importado → contenedor original que
// el agente sigue sin recrear hasta el primer cambio de spec. Sobrevive a DeleteSpec y a
// ForgetWithTombstone a propósito: el borrado pendiente de un importado necesita saber qué contenedor
// parar. La quita quien borra o sustituye ese contenedor (DeleteAdoption). El bucket se crea al
// primer uso (no toca la lista de buckets de Open).
var bAdoptions = []byte("adoptions")

// Adoption es un contenedor adoptado: su id, el slug del servidor (alias de red y etiquetas
// sintetizadas) y la versión de la spec con la que se adoptó (una mayor lo recrea).
type Adoption struct {
	ContainerID string `json:"containerId"`
	Slug        string `json:"slug"`
	Version     uint64 `json:"version"`
}

func putAdoption(tx *bbolt.Tx, serverID string, a Adoption) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	b, err := tx.CreateBucketIfNotExists(bAdoptions)
	if err != nil {
		return err
	}
	return b.Put([]byte(serverID), raw)
}

// PutAdoption guarda (o sustituye) la adopción de serverID.
func (s *Store) PutAdoption(serverID string, a Adoption) error {
	if serverID == "" || a.ContainerID == "" {
		return errors.New("store: adopción sin servidor o sin contenedor")
	}
	return s.db.Update(func(tx *bbolt.Tx) error { return putAdoption(tx, serverID, a) })
}

// AdoptWithSpec guarda la spec (anulando su lápida, como PutSpec) y la adopción en una transacción:
// nunca queda una adopción sin la spec que la pidió.
func (s *Store) AdoptWithSpec(sp *mcsmv1.ServerSpec, a Adoption) error {
	if sp.GetServerId() == "" || a.ContainerID == "" {
		return errors.New("store: adopción sin servidor o sin contenedor")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := tx.Bucket(bSpecs).Put([]byte(sp.ServerId), raw); err != nil {
			return err
		}
		if err := deleteTombstone(tx, sp.ServerId); err != nil {
			return err
		}
		return putAdoption(tx, sp.ServerId, a)
	})
}

// Adoption devuelve la adopción de serverID, o nil si no hay.
func (s *Store) Adoption(serverID string) (*Adoption, error) {
	var out *Adoption
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bAdoptions)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte(serverID))
		if raw == nil {
			return nil
		}
		var a Adoption
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		out = &a
		return nil
	})
	return out, err
}

// Adoptions devuelve todas las adopciones por server_id.
func (s *Store) Adoptions() (map[string]Adoption, error) {
	out := map[string]Adoption{}
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bAdoptions)
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			var a Adoption
			if err := json.Unmarshal(v, &a); err != nil {
				return err
			}
			out[string(k)] = a
			return nil
		})
	})
	return out, err
}

// AdoptedBy devuelve el servidor que adoptó containerID, o "" si ninguno.
func (s *Store) AdoptedBy(containerID string) (string, error) {
	all, err := s.Adoptions()
	if err != nil {
		return "", err
	}
	for id, a := range all {
		if a.ContainerID == containerID {
			return id, nil
		}
	}
	return "", nil
}

// DeleteAdoption quita la adopción de serverID (idempotente).
func (s *Store) DeleteAdoption(serverID string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		if b := tx.Bucket(bAdoptions); b != nil {
			return b.Delete([]byte(serverID))
		}
		return nil
	})
}
```

- [ ] **Step 5: Adopción en el reconciliador**

`agent/internal/reconcile/adopt.go`:
```go
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// Adopción en caliente de contenedores importados (plan-6, spec §6.7).
//
// Un importado sigue en su contenedor original (sin etiquetas mcsm.*) hasta el primer cambio de
// spec. El registro de adopción del store dice qué contenedor es y con qué versión de spec se
// adoptó. find lo devuelve como contenedor del servidor (Adopted, con mcsm.server_id y mcsm.slug
// sintetizados), así que logs, consola, power, copias y observación funcionan igual. reconcileLocked
// no lo recrea mientras la versión de la spec no supere la de la adopción; con una mayor lo para, lo
// borra (los datos están en el bind) y crea mcsm-<slug> con la misma carpeta de datos.
//
// La spec de un importado lleva "adopt" (lo añade el panel): si falta el registro (ImportAdopt
// perdido, store nuevo), reconcileLocked vuelve a adoptar con las mismas comprobaciones; si el
// original ya no existe crea el gestionado; si existe pero no cuadra, falla sin crear nada.
//
// Orden de locks: lock por servidor → adoptMu → r.mu.

var (
	ErrAdoptNotFound = errors.New("el contenedor a adoptar no existe")
	ErrAdoptConflict = errors.New("el contenedor ya está gestionado")
	ErrAdoptMismatch = errors.New("el contenedor no coincide con la spec")
	ErrAdoptSpec     = errors.New("spec de adopción inválida")
)

// Adopt establece la adopción que pide el panel (ImportAdopt): comprueba el contenedor, lo conecta a
// la red del agente con el alias mcsm-<slug>, guarda spec y adopción en una transacción y reconcilia.
// Es idempotente. Una vez guardada la adopción no devuelve error por la reconciliación (queda en
// Observed): el panel ya no debe retirar el servidor, o el siguiente SyncSpecs borraría el original.
func (r *Reconciler) Adopt(ctx context.Context, sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	if parsed.Adopt == nil {
		return fmt.Errorf("%w: falta adopt", ErrAdoptSpec)
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, r.dataRoot, r.network)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	// adoptMu se suelta antes de reconciliar: reconcileLocked puede llamar a readopt, que lo toma.
	if err := r.recordAdoption(ctx, sp, parsed.Adopt, build.DataDir); err != nil {
		return err
	}
	if err := r.reconcileLocked(ctx, sp.ServerId); err != nil {
		r.log.Warn("reconciliar tras adoptar", "server", sp.Slug, "err", err)
	}
	return nil
}

// recordAdoption comprueba el contenedor y guarda spec y adopción, bajo adoptMu (requiere el lock
// del servidor). Si ya está adoptado por este servidor (reintento del panel con el Ack perdido),
// solo guarda la spec si no es más vieja.
func (r *Reconciler) recordAdoption(ctx context.Context, sp *mcsmv1.ServerSpec, a *spec.Adopt, dataDir string) error {
	r.adoptMu.Lock()
	defer r.adoptMu.Unlock()
	cur, err := r.st.Adoption(sp.ServerId)
	if err != nil {
		return err
	}
	if cur != nil && cur.ContainerID == a.ContainerID {
		stored, err := r.st.GetSpec(sp.ServerId)
		if err != nil {
			return err
		}
		if stored == nil || sp.Version >= stored.Version {
			return r.st.PutSpec(sp)
		}
		return nil
	}
	managed, err := r.findManaged(ctx, sp.ServerId)
	if err != nil {
		return err
	}
	if managed != nil {
		return fmt.Errorf("%w: el servidor ya tiene el contenedor %s", ErrAdoptConflict, managed.Name)
	}
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if err != nil {
		return err
	}
	if err := r.connectAlias(ctx, info, sp.Slug); err != nil {
		return err
	}
	return r.st.AdoptWithSpec(sp, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version})
}

// readopt vuelve a adoptar un importado sin registro (su spec trae adopt). Requiere el lock del
// servidor. Devuelve el contenedor adoptado, o nil si el original ya no existe (se creará el
// gestionado). Cualquier otro fallo para la reconciliación: nunca se crea un segundo contenedor
// sobre los datos de uno que no se pudo comprobar.
func (r *Reconciler) readopt(ctx context.Context, sp *mcsmv1.ServerSpec, a *spec.Adopt, dataDir string) (*docker.Container, error) {
	r.adoptMu.Lock()
	defer r.adoptMu.Unlock()
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if errors.Is(err, ErrAdoptNotFound) {
		r.log.Info("el contenedor original de un importado ya no existe: se crea el gestionado", "server", sp.Slug)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.connectAlias(ctx, info, sp.Slug); err != nil {
		return nil, err
	}
	if err := r.st.PutAdoption(sp.ServerId, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}); err != nil {
		return nil, err
	}
	r.log.Info("importado adoptado de nuevo desde su spec", "server", sp.Slug, "contenedor", info.Name)
	return adoptedContainer(sp.ServerId, sp.Slug, info.ID, info.Name, info.State), nil
}

// verifyAdoptable comprueba que el contenedor existe, no es de MC Server Manager ni de otro
// servidor, usa la imagen itzg, tiene red propia y monta en /data exactamente dataDir. Requiere adoptMu.
func (r *Reconciler) verifyAdoptable(ctx context.Context, serverID, containerID, dataDir string) (*docker.ImportInfo, error) {
	info, err := r.eng.InspectImport(ctx, containerID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, fmt.Errorf("%w: %s", ErrAdoptNotFound, containerID)
	}
	if err != nil {
		return nil, fmt.Errorf("inspeccionar el contenedor a adoptar: %w", err)
	}
	if info.Labels[spec.LabelManaged] == "true" {
		return nil, fmt.Errorf("%w: %s ya es un contenedor de MC Server Manager", ErrAdoptConflict, info.Name)
	}
	if other, err := r.st.AdoptedBy(info.ID); err != nil {
		return nil, err
	} else if other != "" && other != serverID {
		return nil, fmt.Errorf("%w: %s ya lo adoptó otro servidor", ErrAdoptConflict, info.Name)
	}
	if !spec.IsItzgImage(info.Image) {
		return nil, fmt.Errorf("%w: %s no usa la imagen %s (%s)", ErrAdoptMismatch, info.Name, spec.Image, info.Image)
	}
	if m := info.NetworkMode; m == "host" || m == "none" || strings.HasPrefix(m, "container:") {
		return nil, fmt.Errorf("%w: %s usa la red %q; solo se adoptan contenedores con red propia", ErrAdoptMismatch, info.Name, m)
	}
	src := ""
	for _, m := range info.Mounts {
		if m.Destination == "/data" && m.Type == "bind" {
			src = filepath.Clean(m.Source)
		}
	}
	if src != filepath.Clean(dataDir) {
		return nil, fmt.Errorf("%w: el /data de %s es %q y la spec espera %q", ErrAdoptMismatch, info.Name, src, dataDir)
	}
	return info, nil
}

// connectAlias conecta el contenedor a la red del agente con el alias mcsm-<slug> (RCON, ping y
// métricas lo buscan por ese nombre). Si ya está en la red, no hace nada.
func (r *Reconciler) connectAlias(ctx context.Context, info *docker.ImportInfo, slug string) error {
	for _, n := range info.Networks {
		if n == r.network {
			return nil
		}
	}
	if err := r.eng.ConnectNetwork(ctx, r.network, info.ID, []string{spec.ContainerName(slug)}); err != nil {
		return fmt.Errorf("conectar %s a la red %s: %w", info.Name, r.network, err)
	}
	return nil
}

func adoptedContainer(serverID, slug, id, name, state string) *docker.Container {
	return &docker.Container{ID: id, Name: name, State: state, Adopted: true,
		Labels: map[string]string{spec.LabelServerID: serverID, spec.LabelSlug: slug}}
}

// findAdopted devuelve el contenedor adoptado del servidor, o nil si no hay adopción o su
// contenedor ya no existe (reconcileLocked limpia entonces el registro).
func (r *Reconciler) findAdopted(ctx context.Context, serverID string) (*docker.Container, error) {
	ad, err := r.st.Adoption(serverID)
	if err != nil || ad == nil {
		return nil, err
	}
	ins, err := r.eng.Inspect(ctx, ad.ContainerID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspeccionar el contenedor adoptado: %w", err)
	}
	return adoptedContainer(serverID, ad.Slug, ins.ID, ins.Name, ins.State), nil
}

// ServerContainers devuelve los contenedores de los servidores del nodo: los gestionados y los
// adoptados aún sin recrear (Adopted, con etiquetas sintetizadas). Lo usa el muestreador de
// métricas. Un adoptado que ya no existe se omite.
func (r *Reconciler) ServerContainers(ctx context.Context) ([]docker.Container, error) {
	list, err := r.eng.ListManaged(ctx)
	if err != nil {
		return nil, err
	}
	ads, err := r.st.Adoptions()
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, c := range list {
		have[c.Labels[spec.LabelServerID]] = true
	}
	ids := make([]string, 0, len(ads))
	for id := range ads {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if have[id] {
			continue
		}
		ad := ads[id]
		ins, err := r.eng.Inspect(ctx, ad.ContainerID)
		if errors.Is(err, docker.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		list = append(list, *adoptedContainer(id, ad.Slug, ins.ID, ins.Name, ins.State))
	}
	return list, nil
}
```

- [ ] **Step 6: Cambios en `reconciler.go`** (fuera de ancla)

1. En `type Reconciler struct`, debajo de `heldErr …`:
```go
	adoptMu sync.Mutex // plan-6: comprobar y registrar adopciones (un contenedor, un servidor); tras el lock por servidor
```
2. Sustituye `find` por estas dos funciones:
```go
// find devuelve el contenedor del servidor: el gestionado (etiqueta mcsm.server_id) o, si no hay,
// el adoptado (plan-6). nil sin error si no existe.
func (r *Reconciler) find(ctx context.Context, serverID string) (*docker.Container, error) {
	c, err := r.findManaged(ctx, serverID)
	if err != nil || c != nil {
		return c, err
	}
	return r.findAdopted(ctx, serverID)
}

func (r *Reconciler) findManaged(ctx context.Context, serverID string) (*docker.Container, error) {
	list, err := r.eng.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar contenedores: %w", err)
	}
	for i := range list {
		if list[i].Labels[spec.LabelServerID] == serverID {
			return &list[i], nil
		}
	}
	return nil, nil
}

// replace para y borra un contenedor para recrearlo. Siempre Stop (Docker no hace nada sobre uno
// parado): evita decidir con una foto del estado. Los datos están en el bind.
func (r *Reconciler) replace(ctx context.Context, c *docker.Container) error {
	if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("parar: %w", err)
	}
	if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("eliminar: %w", err)
	}
	return nil
}
```
3. En `reconcileLocked`, sustituye desde `existing, err := r.find(ctx, serverID)` hasta el final del bloque `if existing == nil { … }` (el que crea el contenedor) por:
```go
	existing, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	// plan-6: un importado sin registro de adopción (ImportAdopt perdido, store nuevo) se vuelve a
	// adoptar; si su contenedor original ya no existe, se crea el gestionado.
	if existing == nil && parsed.Adopt != nil {
		if existing, err = r.readopt(ctx, sp, parsed.Adopt, build.DataDir); err != nil {
			return err
		}
	}
	switch {
	case existing != nil && existing.Adopted:
		// plan-6: el original sigue mientras la spec no supere la versión de la adopción.
		ad, aerr := r.st.Adoption(serverID)
		if aerr != nil {
			return aerr
		}
		if ad != nil && sp.Version > ad.Version {
			r.log.Info("primer cambio de spec de un importado: se recrea con etiquetas mcsm", "server", sp.Slug, "original", existing.Name)
			if err := r.replace(ctx, existing); err != nil {
				return err
			}
			existing = nil
		}
	case existing != nil && existing.Labels[spec.LabelHash] != build.Hash:
		r.log.Info("spec cambiada, recreando contenedor", "server", sp.Slug)
		if err := r.replace(ctx, existing); err != nil {
			return err
		}
		existing = nil
	}
	if existing == nil {
		// plan-6: una adopción cuyo contenedor ya no está (o se acaba de sustituir) sobra.
		if err := r.st.DeleteAdoption(serverID); err != nil {
			return err
		}
		// plan-6: con dataPath la carpeta es del host y el agente no la ve (solo monta DATA_ROOT);
		// Docker la crea al montar si no existe.
		if parsed.DataPath == "" {
			if err := os.MkdirAll(build.DataDir, 0o755); err != nil {
				return fmt.Errorf("crear directorio de datos: %w", err)
			}
		}
		if err := r.eng.EnsureImage(ctx, build.Config.Image); err != nil {
			return fmt.Errorf("descargar imagen: %w", err)
		}
		id, err := r.eng.Create(ctx, build.Name, build.Config, build.HostConfig, build.Networking)
		if err != nil {
			return fmt.Errorf("crear contenedor: %w", err)
		}
		existing = &docker.Container{ID: id, Name: build.Name, State: "created", Labels: build.Config.Labels}
	}
```
(el `switch` de arrancar/parar y `SetApplied` que siguen no cambian).
4. En `removeLocked`:
   - En la rama `if sp == nil && c == nil {`, justo después de `DeleteTombstone`:
```go
		if err := r.st.DeleteAdoption(serverID); err != nil { // plan-6: su contenedor ya no existe
			return err
		}
```
   - Al principio de `if deleteData {` (antes de `target, err = r.dataPath(slug)`):
```go
		// plan-6: los datos de un importado con dataPath están fuera de DATA_ROOT: no se borran.
		if sp != nil {
			if p, perr := spec.Parse(sp.SpecJson); perr == nil && p.DataPath != "" {
				return fmt.Errorf("los datos de %s están en %s, fuera de DATA_ROOT: el agente no los borra", slug, p.DataPath)
			}
		}
```
   - Justo después del bloque `if c != nil { … Stop … Remove … }`:
```go
	// plan-6: el contenedor del servidor (adoptado o no) ya no existe.
	if err := r.st.DeleteAdoption(serverID); err != nil {
		return err
	}
```
5. En `observeLocked`, el ping usa el slug del contenedor encontrado (el adoptado no tiene etiquetas en Docker):
```go
	if ins.Running && r.status != nil {
		obs.Mc = r.status(ctx, spec.ContainerName(c.Labels[spec.LabelSlug]), uint16(spec.GamePort))
	}
```

- [ ] **Step 7: Comprueba que pasa**

Run: `eval "$(mise env)" && cd agent && gofmt -l ./internal && go vet ./... && go test -race ./internal/store/ ./internal/reconcile/ && go test -race ./...`
Expected: `gofmt -l` sin salida; PASS (también los tests de lápidas, `Hold` y del resto del agente).

- [ ] **Step 8: Commit**

```bash
git add agent/internal/store/adoptions.go agent/internal/store/adoptions_test.go \
  agent/internal/reconcile/adopt.go agent/internal/reconcile/adopt_test.go agent/internal/reconcile/reconciler.go
git commit -m "feat(agent): adopción en caliente de contenedores importados en el reconciliador

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Agente — `ImportScan` e `ImportAdopt`

**Agent:** go-agent-dev

**Files:**
- Create: `agent/internal/importer/scan.go`, `agent/internal/importer/scan_test.go`, `agent/internal/app/import.go`, `agent/internal/app/import_test.go`
- Modify: `agent/internal/app/app.go` (switch de `Handle`, debajo de la ancla `plan-6`)

**Interfaces:**
- Consumes: Task 1 (`mcsmv1.ImportScan*`, `ImportCandidate`, `ImportAdopt`), Task 2 (`spec.IsItzgImage`, `spec.LabelManaged`), Task 3 (`docker.Engine.ListAll/InspectImport/ImageEnv`, `docker.ImportInfo`, `Fake.ImageEnvs`), Task 4 (`Reconciler.Adopt`, `ErrAdopt*`, `store.Adoptions`); de la App: `validSpecMsg`, `errMsg`, `ack`, `a.life`, `a.cfg.DataRoot`, helpers de test `newApp`, `newSink`, `(*sink).waitID`.
- Produces: `importer.Scan(ctx, eng importer.Engine, skip func(containerID string) bool) ([]*mcsmv1.ImportCandidate, error)` (ordenados por nombre; solo itzg, sin `mcsm.managed`, sin los que `skip` descarta; env sin el ENV de la imagen; etiquetas solo de Compose; texto saneado a UTF-8); `importer.UserEnv(containerEnv, imageEnv []string) map[string]string`; `(*App).handleImportScan(ctx, id, send)` → `ImportScanResult{Candidates, DataRoot}` o `Error{io_error}`; `(*App).handleImportAdopt(id, *mcsmv1.ImportAdopt, send)` → `Ack` o `Error` con `invalid_spec | not_found | exists | invalid_request | busy | apply_failed`; `adoptErrCode(err) string`.

- [ ] **Step 1: Tests que fallan**

`agent/internal/importer/scan_test.go`:
```go
package importer

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	"mcsm/agent/internal/docker"
)

func mk(t *testing.T, f *docker.Fake, name, image string, labels map[string]string, env []string, hc *container.HostConfig) string {
	t.Helper()
	id, err := f.Create(context.Background(), name, &container.Config{Image: image, Labels: labels, Env: env}, hc, nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestScanListsOnlyForeignItzg(t *testing.T) {
	ctx := context.Background()
	f := docker.NewFake()
	f.ImageEnvs["itzg/minecraft-server:java21"] = []string{"PATH=/usr/bin", "TYPE=VANILLA", "UID=1000"}
	ext := mk(t, f, "survival", "itzg/minecraft-server:java21",
		map[string]string{"com.docker.compose.project": "casa", "com.docker.compose.service": "survival", "otra": "x"},
		[]string{"PATH=/usr/bin", "TYPE=PAPER", "UID=1000", "EULA=TRUE", "RCON_PASSWORD=s3cr3t-rcon", "MOTD=caf\xe9"},
		&container.HostConfig{
			Binds:         []string{"/home/lobo/mc/survival:/data", "/home/lobo/mc/mods:/mods:ro"},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			Resources:     container.Resources{Memory: 4 << 30, NanoCPUs: 2e9},
			NetworkMode:   "casa_default",
			PortBindings: network.PortMap{
				network.MustParsePort("25565/tcp"): {{HostPort: "25565"}},
				network.MustParsePort("19132/udp"): {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: "19132"}},
			},
		})
	if err := f.Start(ctx, ext); err != nil {
		t.Fatal(err)
	}
	mk(t, f, "mcsm-otro", "itzg/minecraft-server:java21", map[string]string{"mcsm.managed": "true"}, nil, &container.HostConfig{})
	mk(t, f, "web", "nginx:1.27", nil, nil, &container.HostConfig{})
	adopted := mk(t, f, "adoptado", "itzg/minecraft-server", nil, nil, &container.HostConfig{})

	list, err := Scan(ctx, f, func(id string) bool { return id == adopted })
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("candidatos = %v", list)
	}
	c := list[0]
	if c.ContainerId != ext || c.Name != "survival" || c.Image != "itzg/minecraft-server:java21" || c.State != "running" ||
		c.RestartPolicy != "unless-stopped" || c.MemoryLimitBytes != 4<<30 || c.NanoCpus != 2e9 || c.NetworkMode != "casa_default" {
		t.Fatalf("candidato = %+v", c)
	}
	wantEnv := map[string]string{"TYPE": "PAPER", "EULA": "TRUE", "RCON_PASSWORD": "s3cr3t-rcon", "MOTD": "caf�"}
	if !reflect.DeepEqual(c.Env, wantEnv) {
		t.Fatalf("env = %v (sin las variables idénticas a la imagen; UTF-8 saneado)", c.Env)
	}
	if !reflect.DeepEqual(c.Labels, map[string]string{"com.docker.compose.project": "casa", "com.docker.compose.service": "survival"}) {
		t.Fatalf("labels = %v", c.Labels)
	}
	if len(c.Ports) != 2 || c.Ports[0].ContainerPort != 19132 || c.Ports[0].HostIp != "" || c.Ports[1].HostPort != 25565 || c.Ports[1].Proto != "tcp" {
		t.Fatalf("ports = %v", c.Ports)
	}
	if len(c.Mounts) != 2 || c.Mounts[0].Destination != "/data" || !c.Mounts[0].ReadWrite || c.Mounts[1].ReadWrite {
		t.Fatalf("mounts = %v", c.Mounts)
	}
}

func TestScanWithoutImageEnvSendsAll(t *testing.T) {
	f := docker.NewFake()
	mk(t, f, "mc", "itzg/minecraft-server", nil, []string{"PATH=/usr/bin", "TYPE=PAPER"}, &container.HostConfig{})
	list, err := Scan(context.Background(), f, func(string) bool { return false })
	if err != nil || len(list) != 1 || !reflect.DeepEqual(list[0].Env, map[string]string{"PATH": "/usr/bin", "TYPE": "PAPER"}) {
		t.Fatalf("list = %v, %v", list, err)
	}
}

// goneEngine simula un contenedor borrado entre la lista y el inspect.
type goneEngine struct {
	*docker.Fake
	gone string
}

func (g goneEngine) InspectImport(ctx context.Context, id string) (*docker.ImportInfo, error) {
	if id == g.gone {
		return nil, docker.ErrNotFound
	}
	return g.Fake.InspectImport(ctx, id)
}

func TestScanSkipsContainerRemovedMidway(t *testing.T) {
	f := docker.NewFake()
	gone := mk(t, f, "a", "itzg/minecraft-server", nil, nil, &container.HostConfig{})
	keep := mk(t, f, "b", "itzg/minecraft-server", nil, nil, &container.HostConfig{})
	list, err := Scan(context.Background(), goneEngine{f, gone}, func(string) bool { return false })
	if err != nil || len(list) != 1 || list[0].ContainerId != keep {
		t.Fatalf("list = %v, %v", list, err)
	}
}

type failEngine struct{ *docker.Fake }

func (failEngine) ListAll(context.Context) ([]docker.Container, error) { return nil, errors.New("daemon caído") }

func TestScanReportsListError(t *testing.T) {
	if _, err := Scan(context.Background(), failEngine{docker.NewFake()}, func(string) bool { return false }); err == nil {
		t.Fatal("un fallo de Docker se devuelve")
	}
}

func TestUserEnv(t *testing.T) {
	got := UserEnv([]string{"A=1", "B=2", "C=x=y", "MALA", "=v"}, []string{"A=1", "B=3"})
	want := map[string]string{"B": "2", "C": "x=y"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UserEnv = %v", got)
	}
}
```

`agent/internal/app/import_test.go`:
```go
package app

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
)

// foreignItzg crea y arranca un contenedor itzg ajeno con ese bind de /data.
func foreignItzg(t *testing.T, fake *docker.Fake, name, dataSrc string) string {
	t.Helper()
	ctx := context.Background()
	id, err := fake.Create(ctx, name, &container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"EULA=TRUE"}},
		&container.HostConfig{Binds: []string{dataSrc + ":/data"}, PortBindings: network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func adoptJSON(containerID string) []byte {
	return []byte(`{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25570},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","adopt":{"containerId":"` + containerID + `","version":1}}`)
}

func adoptEnv(id uint64, serverID, slug string, js []byte) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ImportAdopt{ImportAdopt: &mcsmv1.ImportAdopt{Server: &mcsmv1.ServerSpec{
		ServerId: serverID, Slug: slug, Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: js,
	}}}}
}

func TestImportScanResult(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	fake.ImageEnvs["itzg/minecraft-server:java21"] = []string{"EULA=TRUE"}
	id := foreignItzg(t, fake, "viejo", "/home/lobo/mc/viejo")
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_ImportScan{ImportScan: &mcsmv1.ImportScan{}}}, s.send)
	res := s.waitID(t, 5).GetImportScanResult()
	if res == nil || res.DataRoot != a.cfg.DataRoot || len(res.Candidates) != 1 || res.Candidates[0].ContainerId != id || len(res.Candidates[0].Env) != 0 {
		t.Fatalf("resultado = %+v", res)
	}
}

func TestImportAdoptAndErrors(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	id := foreignItzg(t, fake, "viejo", filepath.Join(a.cfg.DataRoot, "viejo", "data"))

	a.Handle(ctx, adoptEnv(9, "s1", "viejo", adoptJSON(id)), s.send)
	if e := s.waitID(t, 9); e.GetAck() == nil {
		t.Fatalf("respuesta = %v", e)
	}
	if ad, _ := st.Adoption("s1"); ad == nil || ad.ContainerID != id {
		t.Fatalf("adoption = %+v", ad)
	}
	if got := a.rec.ContainerID(ctx, "s1"); got != id {
		t.Fatalf("ContainerID = %q", got)
	}

	// Escaneo posterior: el adoptado ya no es candidato.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_ImportScan{ImportScan: &mcsmv1.ImportScan{}}}, s.send)
	if res := s.waitID(t, 10).GetImportScanResult(); res == nil || len(res.Candidates) != 0 {
		t.Fatalf("resultado = %+v", res)
	}

	// Otro contenedor itzg (parado) cuyo /data no es el de la spec.
	other, err := fake.Create(ctx, "otro-mc", &container.Config{Image: "itzg/minecraft-server:java21"},
		&container.HostConfig{Binds: []string{"/home/lobo/mc/otro:/data"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		id     uint64
		server string
		slug   string
		js     []byte
		want   string
	}{
		{11, "s2", "otro", adoptJSON("fake0999"), errcode.NotFound},
		{12, "s3", "viejo", adoptJSON(id), errcode.Exists},           // ya adoptado por s1
		{13, "s4", "otro", adoptJSON(other), errcode.InvalidRequest}, // su /data no es DATA_ROOT/otro/data
		{14, "s5", "Mal Slug", adoptJSON(id), errcode.InvalidSpec},
		{15, "s6", "otro", []byte(`{"type":"PAPER"}`), errcode.InvalidSpec},
	}
	for _, c := range cases {
		a.Handle(ctx, adoptEnv(c.id, c.server, c.slug, c.js), s.send)
		e := s.waitID(t, c.id)
		if e.GetError() == nil || e.GetError().Code != c.want {
			t.Errorf("caso %d: respuesta = %v; want %s", c.id, e, c.want)
		}
	}
}
```

- [ ] **Step 2: Comprueba que fallan**

Run: `eval "$(mise env)" && cd agent && go test ./internal/importer/ ./internal/app/ -run 'Scan|UserEnv|ImportScan|ImportAdopt'`
Expected: FAIL de compilación (`undefined: Scan`, `UserEnv`; `a.Handle` responde `unsupported` a los cuerpos nuevos).

- [ ] **Step 3: Implementación**

`agent/internal/importer/scan.go`:
```go
// Package importer describe los contenedores itzg ajenos que se pueden importar (spec §6.7).
package importer

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// Engine es lo que la importación usa de Docker (docker.Engine lo cumple).
type Engine interface {
	ListAll(ctx context.Context) ([]docker.Container, error)
	InspectImport(ctx context.Context, id string) (*docker.ImportInfo, error)
	ImageEnv(ctx context.Context, image string) ([]string, error)
}

var _ Engine = docker.Engine(nil)

// composeLabels son las únicas etiquetas que viajan al panel (avisa de que Compose lo recrearía).
var composeLabels = []string{"com.docker.compose.project", "com.docker.compose.service"}

// Scan devuelve los candidatos a importar, ordenados por nombre: contenedores con la imagen
// itzg/minecraft-server, sin la etiqueta mcsm.managed y que skip no descarte (los ya adoptados). Si
// no se puede leer el ENV de la imagen, el env va completo. Nunca registra el env (lleva secretos).
func Scan(ctx context.Context, eng Engine, skip func(containerID string) bool) ([]*mcsmv1.ImportCandidate, error) {
	list, err := eng.ListAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar contenedores: %w", err)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	var out []*mcsmv1.ImportCandidate
	for _, c := range list {
		if c.Labels[spec.LabelManaged] == "true" || skip(c.ID) {
			continue
		}
		info, err := eng.InspectImport(ctx, c.ID)
		if errors.Is(err, docker.ErrNotFound) {
			continue // borrado entre la lista y el inspect
		}
		if err != nil {
			return nil, fmt.Errorf("inspeccionar %s: %w", c.Name, err)
		}
		if !spec.IsItzgImage(info.Image) || info.Labels[spec.LabelManaged] == "true" {
			continue
		}
		imageEnv, err := eng.ImageEnv(ctx, info.ImageID)
		if err != nil {
			imageEnv = nil
		}
		out = append(out, candidate(info, UserEnv(info.Env, imageEnv)))
	}
	return out, nil
}

// UserEnv devuelve el env del contenedor sin las entradas idénticas a las del ENV de la imagen: lo
// que fijó el usuario. Una variable de la imagen con otro valor sí es del usuario.
func UserEnv(containerEnv, imageEnv []string) map[string]string {
	defaults := make(map[string]bool, len(imageEnv))
	for _, e := range imageEnv {
		defaults[e] = true
	}
	out := map[string]string{}
	for _, e := range containerEnv {
		if defaults[e] {
			continue
		}
		k, v, ok := strings.Cut(e, "=")
		if !ok || k == "" {
			continue
		}
		out[k] = v
	}
	return out
}

// valid sanea texto del contenedor: proto3 rechaza string con UTF-8 inválido y el mensaje entero se perdería.
func valid(s string) string { return strings.ToValidUTF8(s, "�") }

func candidate(info *docker.ImportInfo, env map[string]string) *mcsmv1.ImportCandidate {
	c := &mcsmv1.ImportCandidate{
		ContainerId: info.ID, Name: valid(info.Name), Image: valid(info.Image), State: info.State,
		Env: make(map[string]string, len(env)), RestartPolicy: info.Restart, MemoryLimitBytes: info.Memory,
		NanoCpus: info.NanoCPUs, NetworkMode: valid(info.NetworkMode), Labels: map[string]string{},
	}
	for k, v := range env {
		c.Env[valid(k)] = valid(v)
	}
	for _, k := range composeLabels {
		if v, ok := info.Labels[k]; ok {
			c.Labels[k] = valid(v)
		}
	}
	for _, n := range info.Networks {
		c.Networks = append(c.Networks, valid(n))
	}
	for _, p := range info.Ports {
		c.Ports = append(c.Ports, &mcsmv1.ImportPort{ContainerPort: uint32(p.ContainerPort), Proto: p.Proto, HostIp: p.HostIP, HostPort: uint32(p.HostPort)})
	}
	for _, m := range info.Mounts {
		c.Mounts = append(c.Mounts, &mcsmv1.ImportMount{Type: m.Type, Source: valid(m.Source), Destination: valid(m.Destination), ReadWrite: m.RW, Name: valid(m.Name)})
	}
	return c
}
```

`agent/internal/app/import.go`:
```go
package app

import (
	"context"
	"errors"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/importer"
	"mcsm/agent/internal/reconcile"
)

// Importación de contenedores existentes (plan-6, spec §6.7).

// importScanTimeout acota el escaneo (una lista y un inspect por contenedor del host).
const importScanTimeout = 20 * time.Second

// handleImportScan responde con los candidatos a importar. Solo lee: usa el contexto de la sesión.
func (a *App) handleImportScan(ctx context.Context, id uint64, send func(*mcsmv1.Envelope) error) {
	cctx, cancel := context.WithTimeout(ctx, importScanTimeout)
	defer cancel()
	ads, err := a.st.Adoptions()
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	adopted := make(map[string]bool, len(ads))
	for _, ad := range ads {
		adopted[ad.ContainerID] = true
	}
	list, err := importer.Scan(cctx, a.eng, func(cid string) bool { return adopted[cid] })
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	_ = send(&mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ImportScanResult{ImportScanResult: &mcsmv1.ImportScanResult{
		Candidates: list, DataRoot: a.cfg.DataRoot,
	}}})
}

// handleImportAdopt adopta un contenedor (toca Docker y el store: contexto de vida del agente).
func (a *App) handleImportAdopt(id uint64, m *mcsmv1.ImportAdopt, send func(*mcsmv1.Envelope) error) {
	sp := m.GetServer()
	if err := validSpecMsg(sp); err != nil {
		_ = send(errMsg(id, errcode.InvalidSpec, err))
		return
	}
	if err := a.rec.Adopt(a.life, sp); err != nil {
		_ = send(errMsg(id, adoptErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// adoptErrCode traduce un fallo de Reconciler.Adopt al Error.code del protocolo.
func adoptErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrAdoptNotFound):
		return errcode.NotFound
	case errors.Is(err, reconcile.ErrAdoptConflict):
		return errcode.Exists
	case errors.Is(err, reconcile.ErrAdoptMismatch):
		return errcode.InvalidRequest
	case errors.Is(err, reconcile.ErrAdoptSpec):
		return errcode.InvalidSpec
	case errors.Is(err, reconcile.ErrBusy):
		return errcode.Busy
	default:
		return errcode.ApplyFailed
	}
}
```

`agent/internal/app/app.go`, en el `switch` de `Handle`, debajo de `// ── plan-6 ──`:
```go
	case *mcsmv1.Envelope_ImportScan:
		a.handleImportScan(ctx, env.Id, send) // solo lectura: contexto de la sesión
	case *mcsmv1.Envelope_ImportAdopt:
		a.handleImportAdopt(env.Id, b.ImportAdopt, send) // muta Docker y store: a.life dentro
```

- [ ] **Step 4: Comprueba que pasa**

Run: `eval "$(mise env)" && cd agent && gofmt -l ./internal && go vet ./... && go test -race ./internal/importer/ ./internal/app/ && go test -race ./...`
Expected: `gofmt -l` sin salida; PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/importer agent/internal/app/import.go agent/internal/app/import_test.go agent/internal/app/app.go
git commit -m "feat(agent): ImportScan lista los contenedores itzg ajenos e ImportAdopt los adopta

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agente — métricas de los adoptados y datos fuera de `DATA_ROOT`

**Agent:** go-agent-dev

**Files:**
- Modify: `agent/internal/app/import.go` (adaptador de métricas y `externalData`), `agent/internal/app/metrics.go` (fuera de ancla: `Containers`), `agent/internal/app/files.go` (fuera de ancla: guarda en `handleFiles`), `agent/internal/app/backups.go` (fuera de ancla: guardas en `startBackup`/`startRestore` y código en `backupErrCode`)
- Create: `agent/internal/app/import_guard_test.go`

**Interfaces:**
- Consumes: Task 4 (`Reconciler.ServerContainers`), `stats.Containers` (`ListManaged`, `Stats`), Plan 2 (`a.newSampler`, helpers de test `hostStub`, `rconStub`), Plan 4 (`backupService.target`, `target.spec`, `backupErrCode`, `handleBackupNow/Restore`), Plan 5 (`handleFiles`), Task 1 (`errcode.ExternalData`).
- Produces: `type serverContainers struct{ a *App }` (cumple `stats.Containers`); `var errExternalData`; `(*App).externalData(serverID string) error`; `externalDataSpec(s spec.Spec) error`. `Files*`, `BackupNow` y `BackupRestore` de un servidor con `dataPath` responden `Error{external_data}`; el muestreador mide gestionados y adoptados.

- [ ] **Step 1: Tests que fallan**

`agent/internal/app/import_guard_test.go`:
```go
package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/stats"
)

func TestSamplerMeasuresAdopted(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	id := foreignItzg(t, fake, "viejo", filepath.Join(a.cfg.DataRoot, "viejo", "data"))
	a.Handle(ctx, adoptEnv(1, "s1", "viejo", adoptJSON(id)), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("adoptar: %v", e)
	}
	a.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		return &mcsmv1.McStatus{Online: host == "mcsm-viejo", PlayersOnline: 1, PlayersMax: 20}
	}
	sm := a.newSampler(&hostStub{}, stats.RealClock, func(context.Context, string, uint16, string) (stats.Rcon, error) { return &rconStub{}, nil })
	t0 := time.Date(2026, 10, 12, 10, 0, 5, 0, time.UTC)
	fake.SetStats(id, docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	sm.Sample(ctx, t0)
	fake.SetStats(id, docker.Stats{CPUTotalNs: 2e9, SystemCPUNs: 20e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	b := sm.Sample(ctx, t0.Add(10*time.Second))
	if b == nil || len(b.Servers) != 1 || b.Servers[0].ServerId != "s1" || !b.Servers[0].McOnline || b.Servers[0].PlayersMax != 20 {
		t.Fatalf("lote = %+v: el adoptado se mide y se le hace ping por mcsm-viejo", b)
	}
}

// dataPathSpec es una spec con los datos fuera de DATA_ROOT (sin adopt: el agente crea el gestionado).
const dataPathSpec = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25571},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","dataPath":"/mcsm-test-noexiste/externo/data"}`

func applyDataPathServer(t *testing.T, a *App, s *sink) {
	t.Helper()
	sp := &mcsmv1.ServerSpec{ServerId: "e", Slug: "externo", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_STOPPED, SpecJson: []byte(dataPathSpec)}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("ApplySpec: %v", e)
	}
}

func TestFilesAndBackupsRefusedWithDataPath(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	applyDataPathServer(t, a, s)
	for _, env := range []*mcsmv1.Envelope{
		{Id: 2, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "e", Path: "/"}}},
		{Id: 3, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: "e", JobId: "j1", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_MANUAL}}},
		{Id: 4, Body: &mcsmv1.Envelope_BackupRestore{BackupRestore: &mcsmv1.BackupRestore{ServerId: "e", JobId: "j2", Filename: "externo-20261012T100000.000Z-1.tar.zst"}}},
	} {
		a.Handle(ctx, env, s.send)
		e := s.waitID(t, env.Id)
		if e.GetError() == nil || e.GetError().Code != errcode.ExternalData || !strings.Contains(e.GetError().Message, "/mcsm-test-noexiste/externo/data") {
			t.Errorf("%T: respuesta = %v", env.Body, e)
		}
	}
}
```

- [ ] **Step 2: Comprueba que fallan**

Run: `eval "$(mise env)" && cd agent && go test ./internal/app/ -run 'SamplerMeasuresAdopted|RefusedWithDataPath'`
Expected: FAIL: el lote no trae al adoptado (el muestreador solo ve `mcsm.managed`); `Files*`/`Backup*` responden otro código (`io_error`, `backup_failed`…).

- [ ] **Step 3: Implementación**

Añade a `agent/internal/app/import.go` (amplía su bloque de imports con `"fmt"`, `"mcsm/agent/internal/docker"` y `"mcsm/agent/internal/spec"`):
```go
// serverContainers es lo que mide el muestreador de métricas (stats.Containers): los contenedores
// gestionados y los adoptados, con mcsm.server_id y mcsm.slug (ping a mcsm-<slug>, el alias de red).
type serverContainers struct{ a *App }

func (c serverContainers) ListManaged(ctx context.Context) ([]docker.Container, error) {
	return c.a.rec.ServerContainers(ctx)
}

func (c serverContainers) Stats(ctx context.Context, id string) (docker.Stats, error) {
	return c.a.eng.Stats(ctx, id)
}

// errExternalData: el servidor guarda sus datos fuera de DATA_ROOT (dataPath) y el agente no los ve
// (solo monta DATA_ROOT, spec §6.1): ni copias ni archivos.
var errExternalData = errors.New("datos fuera de DATA_ROOT")

func externalDataSpec(s spec.Spec) error {
	if s.DataPath == "" {
		return nil
	}
	return fmt.Errorf("%w: los datos de este servidor están en %s, fuera de DATA_ROOT, y el agente no los ve; "+
		"no hay copias de seguridad ni archivos. Para tenerlos, para el servidor, mueve esa carpeta a DATA_ROOT/<slug>/data "+
		"y quita dataPath de su configuración", errExternalData, s.DataPath)
}

// externalData es externalDataSpec para un servidor del store; nil si no existe o su spec no se lee
// (de eso responde quien llama).
func (a *App) externalData(serverID string) error {
	sp, err := a.st.GetSpec(serverID)
	if err != nil || sp == nil {
		return nil
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return nil
	}
	return externalDataSpec(parsed)
}
```

`agent/internal/app/metrics.go` (fuera de ancla), en `newSampler`: sustituye `Containers: a.eng,` por:
```go
		Containers: serverContainers{a}, // plan-6: también los importados aún adoptados
```

`agent/internal/app/files.go` (fuera de ancla), en `handleFiles`, justo después del bloque `if req == nil { … }`:
```go
	// plan-6: con dataPath los datos están fuera de DATA_ROOT y el agente no los ve.
	if err := a.externalData(req.GetServerId()); err != nil {
		_ = send(errMsg(env.Id, errcode.ExternalData, err))
		return
	}
```

`agent/internal/app/backups.go` (fuera de ancla):
1. En `startBackup`, sustituye
```go
	if _, err := b.target(serverID); err != nil {
		return err
	}
```
por
```go
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
```
2. En `startRestore`, justo después de `t, err := b.target(serverID)` y su `if err != nil { return err }`:
```go
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
```
3. En `backupErrCode`, antes de `default:`:
```go
	case errors.Is(err, errExternalData): // plan-6
		return errcode.ExternalData
```

- [ ] **Step 4: Comprueba que pasa**

Run: `eval "$(mise env)" && cd agent && gofmt -l ./internal && go vet ./... && go test -race ./...`
Expected: `gofmt -l` sin salida; PASS (también los tests de métricas, archivos y copias de los Planes 2, 4 y 5).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/app/import.go agent/internal/app/import_guard_test.go agent/internal/app/metrics.go agent/internal/app/files.go agent/internal/app/backups.go
git commit -m "feat(agent): métricas de los importados adoptados; sin copias ni archivos con dataPath

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Shared — `dataPath`, tipos y esquemas de la importación

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/data-path.ts`, `panel/packages/shared/src/data-path.test.ts`, `panel/packages/shared/src/import.ts`, `panel/packages/shared/src/import.test.ts`
- Modify: `panel/packages/shared/src/spec.ts` (fuera de ancla: import y los objetos de `specSchema`/`specInputSchema`), `panel/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `proto/fixtures/data-path-cases.json` (Task 2), `specSchema`, `specInputSchema`, `templateSpecSchema`, `specPatchNullError`, `specToTemplate`, `canonicalJson`, `specPatchSchema`, `backupsSchema` (Plan 4, en `baseFields`).
- Produces:
  - `data-path.ts`: `DATA_PATH_MAX_BYTES = 1024`, `DENIED_DATA_PATHS`, `pathWithin(child, parent): boolean`, `dataPathsOverlap(a, b): boolean`, `dataPathError(p): string | null`, `dataPathSchema` (zod string), `dataPathCheck(s, ctx)` (dataPath + `backups.enabled` → issue), `dataPathPatchError(patch, previous): string | null`.
  - `spec.ts`: `Spec` y `SpecInput` con `dataPath?: string`; `TemplateSpec` sin él.
  - `import.ts`: `interface ImportedFrom { containerId; containerName; specVersion: number; importedAt; composeProject; composeService }`, `interface ImportCandidateDto { containerId; containerName; image; state; composeProject; composeService; blockers: string[]; warnings: string[]; hiddenEnv: string[]; proposal: { name; slug; slugLocked: boolean; desiredState: "running" | "stopped"; spec: SpecInput; specError: string | null; dataPath: string | null } }`, `DOCKER_ID_RE`, `importAdoptSchema` (`{containerId, name, slug?, spec, applyNow=false}`), `type ImportAdoptInput`, `sameSpecInput(a, b): boolean`.

- [ ] **Step 1: Tests que fallan**

`panel/packages/shared/src/data-path.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_PATH_MAX_BYTES, dataPathError, dataPathPatchError, dataPathsOverlap, pathWithin } from "./data-path.js";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { specToTemplate } from "./templates.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("data-path-cases.json") as { path: string; ok: boolean }[];

describe("casos compartidos con el agente Go (proto/fixtures/data-path-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [JSON.stringify(c.path), c] as const))("%s", (_name, c) => {
    expect(dataPathError(c.path) === null).toBe(c.ok);
    expect(specSchema.safeParse({ ...base, dataPath: c.path }).success).toBe(c.ok);
  });
  it("longitud en bytes", () => {
    const ok = "/srv/" + "a".repeat(DATA_PATH_MAX_BYTES - 5);
    expect(dataPathError(ok)).toBeNull();
    expect(dataPathError(ok + "a")).not.toBeNull();
  });
  it("vacío no es una ruta (el campo se omite)", () => {
    expect(specSchema.safeParse({ ...base, dataPath: "" }).success).toBe(false);
  });
});

describe("pathWithin / dataPathsOverlap", () => {
  it("compara por tramos, no por texto", () => {
    expect(pathWithin("/srv/mc/a", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc-viejo", "/srv/mc")).toBe(false);
    expect(pathWithin("/srv", "/")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc", "/home/lobo/mc/survival")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc/a", "/home/lobo/mc/b")).toBe(false);
  });
});

describe("dataPath en la spec", () => {
  it("se conserva en specSchema y specInputSchema, no en plantillas", () => {
    expect(specSchema.parse({ ...base, dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(specInputSchema.parse({ dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(templateSpecSchema.parse({ dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
    expect(specToTemplate({ ...base, dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
  });
  it("sin dataPath la spec parseada no gana la clave (no cambia lo que se guarda)", () => {
    expect(specSchema.parse(base)).not.toHaveProperty("dataPath");
  });
  it("no convive con copias programadas", () => {
    const withData = { ...base, dataPath: "/home/lobo/mc/survival" };
    expect(specSchema.safeParse({ ...withData, backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
    expect(specSchema.safeParse({ ...withData, backups: { enabled: false } }).success).toBe(true);
    expect(specInputSchema.safeParse({ dataPath: "/home/lobo/mc/survival", backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
  });
  it("PATCH: null lo quita (permitido); otro valor no", () => {
    expect(specPatchNullError({ dataPath: null })).toBeNull();
    const prev = { dataPath: "/home/lobo/mc/survival" };
    expect(dataPathPatchError({}, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: null }, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/mc/survival" }, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, prev)).not.toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, {})).not.toBeNull();
  });
});
```

`panel/packages/shared/src/import.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { importAdoptSchema, sameSpecInput } from "./import.js";
import { defaultSpecInput } from "./spec.js";

const ID = "a".repeat(64);

describe("importAdoptSchema", () => {
  it("acepta la petición y pone applyNow=false por defecto", () => {
    const r = importAdoptSchema.parse({ containerId: ID, name: " Survival ", spec: { type: "PAPER" } });
    expect(r).toEqual({ containerId: ID, name: "Survival", spec: { type: "PAPER" }, applyNow: false });
  });
  it("rechaza ids que no son de Docker y slugs inválidos", () => {
    expect(importAdoptSchema.safeParse({ containerId: "abc", name: "x", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "x", slug: "Mal", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "", spec: {} }).success).toBe(false);
  });
});

describe("sameSpecInput", () => {
  it("compara tras normalizar con zod", () => {
    expect(sameSpecInput({}, defaultSpecInput())).toBe(true);
    expect(sameSpecInput({ memory: "4G" }, { ...defaultSpecInput(), memory: "4G" })).toBe(true);
  });
  it("ignora dataPath y rconPassword (no los edita el usuario)", () => {
    expect(sameSpecInput({ dataPath: "/home/lobo/mc", rconPassword: "x".repeat(10) }, {})).toBe(true);
  });
  it("detecta un cambio real", () => {
    expect(sameSpecInput({ memory: "4G" }, { memory: "6G" })).toBe(false);
    expect(sameSpecInput({ env: { A: "1" } }, { env: { A: "2" } })).toBe(false);
  });
});
```

- [ ] **Step 2: Comprueba que fallan**

Run: `pnpm --filter @mcsm/shared test`
Expected: FAIL (`Cannot find module './data-path.js'` / `'./import.js'`).

- [ ] **Step 3: Implementación**

`panel/packages/shared/src/data-path.ts`:
```ts
import { z } from "zod";

/**
 * `dataPath` (plan-6, spec §6.7): carpeta del host montada en /data de un servidor importado cuando no
 * es <DATA_ROOT>/<slug>/data. Mismas reglas que agent/internal/spec/adopt.go (ValidateDataPath); los
 * casos de proto/fixtures/data-path-cases.json se prueban en los dos lados. El agente corre como root
 * y el entrypoint de itzg hace chown de /data: nada de zonas del sistema.
 */
export const DATA_PATH_MAX_BYTES = 1024;
const SEGMENT_RE = /^[A-Za-z0-9._@+ -]+$/;
export const DENIED_DATA_PATHS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
  "/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
] as const;

/** ¿`child` es `parent` o cuelga de él? Rutas absolutas limpias; se compara por tramos. */
export function pathWithin(child: string, parent: string): boolean {
  if (parent === "/") return child.startsWith("/");
  return child === parent || child.startsWith(`${parent}/`);
}

export const dataPathsOverlap = (a: string, b: string): boolean => pathWithin(a, b) || pathWithin(b, a);

const encoder = new TextEncoder();

/** Por qué no vale `p` como dataPath, o null. No conoce DATA_ROOT (eso lo comprueban el agente y la importación). */
export function dataPathError(p: string): string | null {
  if (encoder.encode(p).length > DATA_PATH_MAX_BYTES) return `Ruta demasiado larga (máx. ${DATA_PATH_MAX_BYTES} bytes)`;
  if (!p.startsWith("/")) return "Debe ser una ruta absoluta";
  const segs = p.slice(1).split("/");
  if (segs.length < 2) return "Ruta demasiado general: indica al menos dos niveles";
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "Ruta no normalizada: sin //, «.» ni «..», y sin / al final";
    if (!SEGMENT_RE.test(s)) return "Caracteres no admitidos: letras y números ASCII, espacio y . _ @ + -";
  }
  const denied = DENIED_DATA_PATHS.find((d) => pathWithin(p, d));
  return denied ? `Está en una zona del sistema (${denied}): no se monta` : null;
}

export const dataPathSchema = z.string().superRefine((p, ctx) => {
  const e = dataPathError(p);
  if (e) ctx.addIssue({ code: "custom", message: `Carpeta de datos: ${e}` });
});

/** dataPath y copias programadas no conviven: el agente no ve esa carpeta (solo monta DATA_ROOT). Igual que validateImport en Go. */
export function dataPathCheck(s: { dataPath?: string | undefined; backups?: { enabled: boolean } | undefined }, ctx: z.RefinementCtx) {
  if (s.dataPath && s.backups?.enabled) {
    ctx.addIssue({ code: "custom", path: ["backups", "enabled"], message: "Las copias programadas no están disponibles: los datos de este servidor están fuera de DATA_ROOT" });
  }
}

/**
 * PATCH de spec: dataPath solo lo fija la importación (es la carpeta real del contenedor adoptado). El
 * PATCH puede reenviarlo igual o quitarlo con null (vuelve a <DATA_ROOT>/<slug>/data). Mensaje del 400 o null.
 */
export function dataPathPatchError(patch: Record<string, unknown>, previous: { dataPath?: string | undefined }): string | null {
  if (!Object.hasOwn(patch, "dataPath")) return null;
  const v = patch.dataPath;
  if (v === null || v === previous.dataPath) return null;
  return "La carpeta de datos (dataPath) solo la fija la importación de un servidor: no se puede cambiar por aquí";
}
```

`panel/packages/shared/src/spec.ts` (fuera de ancla):
1. Junto a los demás imports del principio:
```ts
import { dataPathCheck, dataPathSchema } from "./data-path.js";
```
2. `specSchema` y `specInputSchema` pasan a ser:
```ts
/** Spec completa, tal y como se persiste y se envía al agente. */
export const specSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port, extra: z.array(portMappingSchema).default([]) }),
    rconPassword: z.string().min(8),
    // plan-6: solo specs de servidor (no está en baseFields: las plantillas no lo llevan).
    dataPath: dataPathSchema.optional(),
  })
  .superRefine(specChecks)
  .superRefine(dataPathCheck);

/** Lo que envía la UI al crear/editar: el panel añade puerto y rconPassword. */
export const specInputSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port.optional(), extra: z.array(portMappingSchema).default([]) }).prefault({}),
    // plan-6: un PATCH lo conserva al fusionar con la spec guardada (si faltara, zod lo descartaría
    // y el servidor se recrearía sobre <DATA_ROOT>/<slug>/data, vacío).
    dataPath: dataPathSchema.optional(),
  })
  .superRefine(specChecks)
  .superRefine(dataPathCheck);
```

`panel/packages/shared/src/import.ts`:
```ts
import { z } from "zod";
import { canonicalJson, specPatchSchema } from "./spec-patch.js";
import { specInputSchema, type SpecInput } from "./spec.js";

/** Origen de un servidor importado (columna servers.imported_from, spec §4). */
export interface ImportedFrom {
  containerId: string;
  containerName: string;
  /** Versión de la spec con la que se adoptó: hasta superarla, el agente sigue el contenedor original. */
  specVersion: number;
  importedAt: string;
  composeProject: string;
  composeService: string;
}

/** Candidato a importar tal y como lo ve el navegador: nunca lleva RCON_PASSWORD ni CF_API_KEY. */
export interface ImportCandidateDto {
  containerId: string;
  containerName: string;
  image: string;
  state: string;
  composeProject: string;
  composeService: string;
  /** Por qué no se puede importar (vacío = se puede). */
  blockers: string[];
  /** Lo que no se conserva o cambia al recrear, y avisos de uso. */
  warnings: string[];
  /** Variables del contenedor que no se muestran porque son secretos. */
  hiddenEnv: string[];
  proposal: {
    name: string;
    slug: string;
    /** Los datos están en <DATA_ROOT>/<slug>/data: cambiar el slug apuntaría a otra carpeta. */
    slugLocked: boolean;
    desiredState: "running" | "stopped";
    /** Spec deducida, sin rconPassword ni dataPath. */
    spec: SpecInput;
    /** Primer error de validación de la spec deducida; con él solo cabe corregirla y «Adoptar y aplicar». */
    specError: string | null;
    /** Carpeta de datos fuera de DATA_ROOT, o null si están en <DATA_ROOT>/<slug>/data. */
    dataPath: string | null;
  };
}

export const DOCKER_ID_RE = /^[0-9a-f]{64}$/;

/** POST /api/nodes/:id/import. `spec` es la SpecInput revisada; el panel ignora dataPath (lo saca del contenedor). */
export const importAdoptSchema = z.object({
  containerId: z.string().regex(DOCKER_ID_RE, "Id de contenedor inválido"),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  spec: specPatchSchema,
  /** false: adopción en caliente (exige la propuesta sin cambios); true: adopta y recrea enseguida con la spec revisada. */
  applyNow: z.boolean().default(false),
});
export type ImportAdoptInput = z.infer<typeof importAdoptSchema>;

function normalized(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const { dataPath: _d, rconPassword: _r, ...rest } = v as Record<string, unknown>;
  const r = specInputSchema.safeParse(rest);
  return r.success ? r.data : rest;
}

/** ¿Misma configuración? Compara tras normalizar con zod, sin dataPath ni rconPassword (no los edita el usuario). */
export function sameSpecInput(a: unknown, b: unknown): boolean {
  return canonicalJson(normalized(a)) === canonicalJson(normalized(b));
}
```

`panel/packages/shared/src/index.ts`, al final:
```ts
export * from "./data-path.js";
export * from "./import.js";
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/shared test && pnpm -r typecheck`
Expected: PASS (también `spec-content.test.ts`, `templates.test.ts` y `backups.test.ts`, que no cambian). El typecheck de api y web sigue limpio: `dataPath` es opcional.

- [ ] **Step 5: Commit**

```bash
git add panel/packages/shared/src/data-path.ts panel/packages/shared/src/data-path.test.ts \
  panel/packages/shared/src/import.ts panel/packages/shared/src/import.test.ts \
  panel/packages/shared/src/spec.ts panel/packages/shared/src/index.ts
git commit -m "feat(shared): dataPath en la spec de servidor y tipos de la importación

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Panel — servidores importados: columna, mensaje al agente y guardas de `dataPath`

**Agent:** panel-api-dev

**Files:**
- Modify: `panel/apps/api/src/db/migrations.ts` (debajo de la ancla `plan-6`), `panel/apps/api/src/servers/repo.ts` (fuera de ancla), `panel/apps/api/src/servers/service.ts` (fuera de ancla), `panel/apps/api/src/servers/spec-message.test.ts`
- Create: `panel/apps/api/src/servers/imported.test.ts`

**Interfaces:**
- Consumes: Task 7 (`ImportedFrom`, `dataPathPatchError`, `Spec.dataPath`), `ServersRepo`, `ServersService` (con `push` público del Plan 4), `toServerSpecMessage`, `toServerDto`.
- Produces: columna `servers.imported_from` (JSON de `ImportedFrom` o NULL); `ServerRow.imported_from?: string | null`; `ServerDto.importedFrom: ImportedFrom | null`; `parseImportedFrom(row): ImportedFrom | null`; `ServersRepo.setImportedFrom(id, from): ServerRow`; `toServerSpecMessage` añade `"adopt": {containerId, version: importedFrom.specVersion}` a la spec de todo importado; `ServersService.checkPorts(nodeId, spec, selfId?)` pasa a ser público. Guardas: crear con `dataPath` → 400; PATCH con otro `dataPath` → 400 (igual o `null` valen); borrar con `deleteData` un servidor con `dataPath` → 400.

- [ ] **Step 1: Tests que fallan**

En `panel/apps/api/src/servers/spec-message.test.ts`, cambia el helper `row` para aceptar campos extra y añade un test:
```ts
const row = (spec: object, extra: Partial<ServerRow> = {}): ServerRow => ({
  id: "s1", node_id: "n1", name: "A", slug: "a", spec: JSON.stringify(spec), spec_version: 3, desired_state: "running",
  observed: null, observed_spec_version: 0, observed_at: null, created_at: "", updated_at: "", ...extra,
});
```
```ts
  it("un importado lleva adopt con el contenedor original y la versión de la adopción; los demás no", () => {
    const from = { containerId: "c".repeat(64), containerName: "viejo", specVersion: 1, importedAt: "", composeProject: "", composeService: "" };
    const imported = row({ type: "PAPER", dataPath: "/home/lobo/mc" }, { imported_from: JSON.stringify(from) });
    expect(sent(toServerSpecMessage(imported, null))).toMatchObject({ adopt: { containerId: "c".repeat(64), version: 1 }, dataPath: "/home/lobo/mc" });
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }), null))).not.toHaveProperty("adopt");
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }, { imported_from: null }), "K3y"))).not.toHaveProperty("adopt");
  });
```

`panel/apps/api/src/servers/imported.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { specSchema } from "@mcsm/shared";
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

const DATA = "/home/lobo/mc/viejo";
/** Un importado con dataPath, insertado como lo hará ImportService (Task 10). */
function imported() {
  const row = app.servers.create({
    nodeId, name: "Viejo", slug: "viejo", desiredState: "running",
    spec: specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25570 }, rconPassword: "abcdefgh", dataPath: DATA }),
  });
  return app.servers.setImportedFrom(row.id, {
    containerId: "c".repeat(64), containerName: "viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z", composeProject: "casa", composeService: "viejo",
  });
}

describe("servidores importados", () => {
  it("la migración 050 deja imported_from en null para los servidores del panel; el DTO lo expone", async () => {
    const s = (await req("POST", "/api/servers", { nodeId, name: "Nuevo" })).json();
    expect(s.importedFrom).toBeNull();
    const row = imported();
    const dto = (await req("GET", `/api/servers/${row.id}`)).json();
    expect(dto.importedFrom).toMatchObject({ containerName: "viejo", specVersion: 1, composeProject: "casa" });
    expect(dto.spec.dataPath).toBe(DATA);
  });

  it("crear un servidor con dataPath da 400 (solo lo fija la importación)", async () => {
    const res = await req("POST", "/api/servers", { nodeId, name: "X", spec: { dataPath: "/home/lobo/otra" } });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH: el formulario conserva dataPath; cambiarlo da 400; null lo quita (versión +1)", async () => {
    const row = imported();
    let res = await req("PATCH", `/api/servers/${row.id}`, { spec: { memory: "3G" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { memory: "3G", dataPath: DATA } });
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: "/home/lobo/otra" } });
    expect(res.statusCode).toBe(400);
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: DATA } });
    expect(res.json().specVersion).toBe(2);
    res = await req("PATCH", `/api/servers/${row.id}`, { spec: { dataPath: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().specVersion).toBe(3);
    expect(res.json().spec).not.toHaveProperty("dataPath");
  });

  it("con dataPath no se pueden programar copias", async () => {
    const row = imported();
    const res = await req("PATCH", `/api/servers/${row.id}`, { spec: { backups: { enabled: true, cron: "0 4 * * *" } } });
    expect(res.statusCode).toBe(400);
  });

  it("borrar con datos un servidor con dataPath da 400; sin datos se borra", async () => {
    const row = imported();
    let res = await req("DELETE", `/api/servers/${row.id}?deleteData=true`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(DATA);
    res = await req("DELETE", `/api/servers/${row.id}?deleteData=false`);
    expect(res.statusCode).toBe(204);
  });

  it("guardar un importado como plantilla no arrastra dataPath", async () => {
    const row = imported();
    const tpl = (await req("POST", "/api/templates", { name: "Del viejo", fromServerId: row.id })).json();
    expect(tpl.spec).not.toHaveProperty("dataPath");
  });
});
```

- [ ] **Step 2: Comprueba que fallan**

Run: `pnpm --filter @mcsm/api test -- src/servers/`
Expected: FAIL (`setImportedFrom is not a function`, sin `importedFrom` en el DTO, sin `adopt` en el mensaje, crear con `dataPath` responde 201).

- [ ] **Step 3: Implementación**

`panel/apps/api/src/db/migrations.ts`, debajo de `// ── plan-6 ──`:
```ts
  {
    // Origen de un servidor importado (spec §4 imported_from): contenedor original, versión de la
    // adopción y proyecto/servicio de Docker Compose. JSON; NULL en los creados por el panel.
    name: "050_servers_imported_from",
    sql: `ALTER TABLE servers ADD COLUMN imported_from TEXT;`,
  },
```

`panel/apps/api/src/servers/repo.ts` (fuera de ancla):
1. Import: `import { usesCurseForge, type ImportedFrom, type Spec } from "@mcsm/shared";`
2. `ServerRow`, último campo:
```ts
  /** plan-6: JSON de ImportedFrom (servidores importados). Opcional en el tipo: filas de tests anteriores a la columna. */
  imported_from?: string | null;
```
3. `ServerDto`, último campo: `importedFrom: ImportedFrom | null;`
4. Debajo de `ServerDto`:
```ts
export function parseImportedFrom(r: Pick<ServerRow, "imported_from">): ImportedFrom | null {
  return r.imported_from ? (JSON.parse(r.imported_from) as ImportedFrom) : null;
}
```
5. En `toServerDto`, añade `importedFrom: parseImportedFrom(r),` junto a `createdAt`/`updatedAt`.
6. `toServerSpecMessage` pasa a ser (misma firma; amplía su comentario con la línea de `adopt`):
```ts
export function toServerSpecMessage(r: ServerRow, curseforgeApiKey: string | null): ServerSpec {
  const spec = JSON.parse(r.spec) as Spec;
  const extra: Record<string, unknown> = {};
  if (curseforgeApiKey && usesCurseForge(spec)) extra.curseforgeApiKey = curseforgeApiKey;
  // plan-6: un importado lleva su contenedor original y la versión de la adopción; el agente lo sigue
  // sin recrearlo mientras spec_version no la supere, y lo vuelve a adoptar si perdió el registro.
  const from = parseImportedFrom(r);
  if (from) extra.adopt = { containerId: from.containerId, version: from.specVersion };
  const json = Object.keys(extra).length > 0 ? JSON.stringify({ ...spec, ...extra }) : r.spec;
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(json),
  });
}
```
7. En `ServersRepo`, después de `bumpVersion`:
```ts
  /** plan-6: marca la fila como importada (ImportService, justo después de create). */
  setImportedFrom(id: string, from: ImportedFrom): ServerRow {
    this.db.prepare("UPDATE servers SET imported_from = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(from), nowIso(), id);
    return this.get(id)!;
  }
```

`panel/apps/api/src/servers/service.ts` (fuera de ancla):
1. Añade `dataPathPatchError` al import de `@mcsm/shared`.
2. `private checkPorts(` → `checkPorts(` con el comentario `/** Puertos de la spec libres en el nodo (lo usa también la importación, plan-6). */`.
3. En `create`, justo después de `this.requireNode(input.nodeId);`:
```ts
    // plan-6: dataPath solo lo fija la importación (es la carpeta real de un contenedor adoptado).
    if (input.spec.dataPath !== undefined) throw new HttpError(400, "La carpeta de datos (dataPath) solo la fija la importación de un servidor");
```
4. En `patch`, justo después de `const previous = JSON.parse(row.spec) as Spec;`:
```ts
      const dpErr = dataPathPatchError(input.spec, previous); // plan-6
      if (dpErr) throw new HttpError(400, dpErr);
```
5. En `remove`, justo después de `const row = this.requireServer(id);`:
```ts
    // plan-6: los datos de un importado con dataPath están fuera de DATA_ROOT; el panel no los borra.
    const dataPath = (JSON.parse(row.spec) as Spec).dataPath;
    if (deleteData && dataPath) {
      throw new HttpError(400, `Los datos de este servidor están en ${dataPath}, fuera de DATA_ROOT: el panel no los borra. Elimínalo sin datos y bórralos a mano si quieres`);
    }
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/api test && pnpm -r typecheck`
Expected: PASS (los tests de servidores, plantillas, copias y archivos siguen en verde).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/db/migrations.ts panel/apps/api/src/servers/repo.ts panel/apps/api/src/servers/service.ts \
  panel/apps/api/src/servers/spec-message.test.ts panel/apps/api/src/servers/imported.test.ts
git commit -m "feat(panel): servidores importados (imported_from, adopt hacia el agente) y guardas de dataPath

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Panel — propuesta de spec a partir de un contenedor

**Agent:** panel-api-dev

**Files:**
- Create: `panel/apps/api/src/import/propose.ts`, `panel/apps/api/src/import/propose.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ImportCandidate`, `ImportCandidateSchema` de `@mcsm/proto`), Task 7 (`dataPathError`, `pathWithin`, `ImportCandidateDto`), de `@mcsm/shared`: `specInputSchema`, `formatZodError`, `slugify`, `memoryToBytes`, `utf8Bytes`, `MAX_STRING_BYTES`, `MEMORY_RE`, `IMAGE_TAG_RE`, `ENV_KEY_RE`, `RESERVED_ENV`, `PROPERTY_KEY_RE`, `RESERVED_PROPS`, `ENTRY_RE`, `URL_RE`, `DIGITS_RE`, `PLAYER_RE`, `CURSEFORGE_API_KEY_RE`, `type SpecInput`.
- Produces: `interface ProposeContext { dataRoot: string; takenSlugs: ReadonlySet<string>; curseforgeConfigured: boolean }`; `interface ImportProposal { name; slug; slugLocked; desiredState; spec: SpecInput; specError: string | null; dataPath: string | null; rconPassword: string | null; curseforgeApiKey: string | null; blockers: string[]; warnings: string[]; hiddenEnv: string[] }` (los dos secretos nunca salen de la API); `proposeImport(c: ImportCandidate, ctx: ProposeContext): ImportProposal` (pura; aplica la tabla «Mapeo contenedor → spec candidata»); `toCandidateDto(c, p): ImportCandidateDto` (sin secretos).

- [ ] **Step 1: Tests que fallan**

`panel/apps/api/src/import/propose.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ImportCandidateSchema } from "@mcsm/proto";
import { proposeImport, toCandidateDto, type ProposeContext } from "./propose.js";

const ROOT = "/srv/minecraft";
const ctx = (over: Partial<ProposeContext> = {}): ProposeContext => ({ dataRoot: ROOT, takenSlugs: new Set(), curseforgeConfigured: false, ...over });
type Init = MessageInitShape<typeof ImportCandidateSchema>;
const cand = (over: Partial<Init> = {}) => create(ImportCandidateSchema, {
  containerId: "c".repeat(64), name: "survival", image: "itzg/minecraft-server:java21", state: "running",
  env: { EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass" },
  ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25565 }],
  mounts: [{ type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true }],
  restartPolicy: "unless-stopped", networkMode: "bridge", networks: ["bridge"], labels: {},
  ...over,
});
const env = (extra: Record<string, string>) => ({ EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass", ...extra });

describe("proposeImport", () => {
  it("contenedor típico de compose con los datos fuera de DATA_ROOT", () => {
    const p = proposeImport(cand({
      env: env({ MOTD: "Hola", USE_AIKAR_FLAGS: "true", CF_API_KEY: "$2a$10$clave" }),
      ports: [
        { containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25570 },
        { containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25570 },
        { containerPort: 19132, proto: "udp", hostIp: "", hostPort: 19132 },
        { containerPort: 25575, proto: "tcp", hostIp: "", hostPort: 25575 },
      ],
      memoryLimitBytes: 5n * 1024n ** 3n, nanoCpus: 2_000_000_000n,
      labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "survival" },
    }), ctx());
    expect(p.blockers).toEqual([]);
    expect(p.dataPath).toBe("/home/lobo/mc/survival");
    expect(p.slugLocked).toBe(false);
    expect(p.slug).toBe("survival");
    expect(p.desiredState).toBe("running");
    expect(p.rconPassword).toBe("s3cr3t-rcon-pass");
    expect(p.curseforgeApiKey).toBe("$2a$10$clave");
    expect(p.hiddenEnv).toEqual(["RCON_PASSWORD", "CF_API_KEY"]);
    expect(p.specError).toBeNull();
    expect(p.spec).toMatchObject({
      imageTag: "java21", type: "PAPER", version: "1.21.4", memory: "4G", restartPolicy: "unless-stopped",
      env: { MOTD: "Hola", USE_AIKAR_FLAGS: "true" }, resources: { cpus: 2, memLimit: "5G" },
      ports: { game: 25570, extra: [{ host: 19132, container: 19132, proto: "udp", label: "" }] },
    });
    expect(p.spec.env).not.toHaveProperty("RCON_PASSWORD");
    expect(p.spec.env).not.toHaveProperty("EULA");
    expect(p.warnings.join(" ")).toMatch(/Compose/);
    expect(p.warnings.join(" ")).toMatch(/DATA_ROOT/);
    expect(p.warnings.join(" ")).toMatch(/25575/);
  });

  it("datos en <DATA_ROOT>/<slug>/data: sin dataPath y slug fijo; ocupado = bloqueo", () => {
    const c = cand({ mounts: [{ type: "bind", source: `${ROOT}/survival/data`, destination: "/data", readWrite: true }] });
    const p = proposeImport(c, ctx());
    expect(p).toMatchObject({ dataPath: null, slugLocked: true, slug: "survival", blockers: [] });
    expect(proposeImport(c, ctx({ takenSlugs: new Set(["survival"]) })).blockers.join(" ")).toMatch(/survival/);
  });

  it("datos dentro de DATA_ROOT con otra forma, o conteniéndolo: bloqueo", () => {
    for (const source of [`${ROOT}/survival`, `${ROOT}/Mundo/data`, "/srv"]) {
      expect(proposeImport(cand({ mounts: [{ type: "bind", source, destination: "/data", readWrite: true }] }), ctx()).blockers).toHaveLength(1);
    }
  });

  it("bloqueos: volumen, sin /data, solo lectura, red host, zona del sistema, sin 25565, SERVER_PORT", () => {
    const blocked = (over: Partial<Init>) => proposeImport(cand(over), ctx()).blockers.length;
    expect(blocked({ mounts: [{ type: "volume", source: "/var/lib/docker/volumes/mc/_data", name: "mc", destination: "/data", readWrite: true }] })).toBe(1);
    expect(blocked({ mounts: [] })).toBe(1);
    expect(blocked({ mounts: [{ type: "bind", source: "/home/lobo/mc", destination: "/data", readWrite: false }] })).toBe(1);
    expect(blocked({ networkMode: "host" })).toBe(1);
    expect(blocked({ mounts: [{ type: "bind", source: "/etc/mc", destination: "/data", readWrite: true }] })).toBe(1);
    expect(blocked({ ports: [{ containerPort: 25566, proto: "tcp", hostIp: "", hostPort: 25566 }] })).toBe(1);
    expect(blocked({ ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 0 }] })).toBe(1);
    expect(blocked({ env: env({ SERVER_PORT: "25570" }) })).toBe(1);
  });

  it("valores por defecto de itzg y avisos de RCON", () => {
    const p = proposeImport(cand({ env: {} }), ctx());
    expect(p.spec).toMatchObject({ type: "VANILLA", version: "LATEST", memory: "1G" });
    expect(p.rconPassword).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ ENABLE_RCON: "false" }) }), ctx()).warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ RCON_PASSWORD: "corta" }) }), ctx()).rconPassword).toBeNull();
  });

  it("whitelist y ops solo pasan a secciones con SYNCHRONIZE; si no, se quedan en env y la spec vale", () => {
    const sync = proposeImport(cand({ env: env({ OPS: "Lobo,Steve", EXISTING_OPS_FILE: "SYNCHRONIZE", WHITELIST: "Lobo\nSteve", EXISTING_WHITELIST_FILE: "synchronize" }) }), ctx());
    expect(sync.spec).toMatchObject({ ops: ["Lobo", "Steve"], whitelist: { enabled: true, players: ["Lobo", "Steve"] } });
    expect(sync.spec.env).toEqual({});
    expect(sync.specError).toBeNull();
    const keep = proposeImport(cand({ env: env({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" }) }), ctx());
    expect(keep.spec).not.toHaveProperty("ops");
    expect(keep.spec).not.toHaveProperty("whitelist");
    expect(keep.spec.env).toEqual({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" });
    expect(keep.specError).toBeNull();
    const bad = proposeImport(cand({ env: env({ OPS: "nombre con espacios", EXISTING_OPS_FILE: "SYNCHRONIZE" }) }), ctx());
    expect(bad.spec).not.toHaveProperty("ops");
    expect(bad.specError).toBeNull();
  });

  it("MODRINTH_PROJECTS va a plugins o a mods según el tipo; una entrada inválida lo deja en env", () => {
    expect(proposeImport(cand({ env: env({ MODRINTH_PROJECTS: "chunky,luckperms" }) }), ctx()).spec.plugins?.modrinthProjects).toEqual(["chunky", "luckperms"]);
    const fabric = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODRINTH_PROJECTS: "lithium\nfabric-api", MODS: "https://x.example/a.jar" }) }), ctx());
    expect(fabric.spec.mods).toEqual({ modrinthProjects: ["lithium", "fabric-api"], curseforgeFiles: [], urls: ["https://x.example/a.jar"] });
    expect(fabric.spec).not.toHaveProperty("plugins");
    const odd = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODS: "/extras/mod.jar" }) }), ctx());
    expect(odd.spec.env).toMatchObject({ MODS: "/extras/mod.jar" });
    expect(odd.spec).not.toHaveProperty("mods");
  });

  it("modpacks: Modrinth, CurseForge por slug y MODPACK_PLATFORM sin TYPE", () => {
    const mr = proposeImport(cand({ env: env({ TYPE: "MODRINTH", MODRINTH_MODPACK: "cobblemon-fabric", MODRINTH_LOADER: "fabric" }) }), ctx());
    expect(mr.spec).toMatchObject({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(mr.specError).toBeNull();
    const cf = proposeImport(cand({ env: env({ TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_FILE_ID: "123" }) }), ctx());
    expect(cf.spec.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10", versionId: "123", loader: "" });
    const viaPlatform = proposeImport(cand({ env: { MODPACK_PLATFORM: "MODRINTH", MODRINTH_MODPACK: "x", RCON_PASSWORD: "s3cr3t-rcon-pass" } }), ctx());
    expect(viaPlatform.spec.type).toBe("MODRINTH");
    expect(viaPlatform.spec.env).not.toHaveProperty("MODPACK_PLATFORM");
    const missing = proposeImport(cand({ env: env({ TYPE: "MODRINTH" }) }), ctx());
    expect(missing.specError).not.toBeNull();
  });

  it("CUSTOM_SERVER_PROPERTIES pasa a properties; las líneas no admitidas se descartan sin mostrar su valor", () => {
    const p = proposeImport(cand({ env: env({ CUSTOM_SERVER_PROPERTIES: "difficulty=hard\nview-distance=12\nrcon.password=supersecreta\nlinea rara\n# comentario" }) }), ctx());
    expect(p.spec.properties).toEqual({ difficulty: "hard", "view-distance": "12" });
    expect(JSON.stringify(p.warnings)).not.toContain("supersecreta");
    expect(p.warnings.join(" ")).toMatch(/rcon\.password/);
  });

  it("memoria, límites, imagen y política de reinicio", () => {
    const p = proposeImport(cand({ env: env({ MEMORY: "1.5G" }), memoryLimitBytes: 512n * 1024n * 1024n, image: "itzg/minecraft-server@sha256:" + "a".repeat(64), restartPolicy: "" }), ctx());
    expect(p.spec).toMatchObject({ memory: "1G", imageTag: "latest", restartPolicy: "no", resources: { memLimit: "" } });
    expect(p.warnings.join(" ")).toMatch(/MEMORY/);
    expect(p.warnings.join(" ")).toMatch(/digest/);
    expect(proposeImport(cand({ memoryLimitBytes: 1536n * 1024n * 1024n, env: env({ MEMORY: "1G" }) }), ctx()).spec.resources.memLimit).toBe("1536M");
    expect(proposeImport(cand({ image: "docker.io/itzg/minecraft-server:java17" }), ctx()).spec.imageTag).toBe("java17");
  });

  it("slug libre sin repetir y estado parado", () => {
    const p = proposeImport(cand({ name: "Survival Mundo", state: "exited" }), ctx({ takenSlugs: new Set(["survival-mundo"]) }));
    expect(p).toMatchObject({ name: "Survival Mundo", slug: "survival-mundo-2", desiredState: "stopped" });
  });

  it("variables con nombre inválido se descartan con aviso", () => {
    const p = proposeImport(cand({ env: env({ "1MAL": "x", "OK_VAR": "y" }) }), ctx());
    expect(p.spec.env).toEqual({ OK_VAR: "y" });
    expect(p.warnings.join(" ")).toMatch(/1MAL/);
  });
});

describe("toCandidateDto", () => {
  it("nunca lleva los secretos", () => {
    const c = cand({ env: env({ CF_API_KEY: "$2a$10$clave", CUSTOM_SERVER_PROPERTIES: "rcon.password=supersecreta" }), labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "mc" } });
    const dto = toCandidateDto(c, proposeImport(c, ctx()));
    const json = JSON.stringify(dto);
    for (const secret of ["s3cr3t-rcon-pass", "$2a$10$clave", "supersecreta"]) expect(json).not.toContain(secret);
    expect(dto).toMatchObject({ containerId: "c".repeat(64), containerName: "survival", composeProject: "casa", composeService: "mc", hiddenEnv: ["RCON_PASSWORD", "CF_API_KEY"] });
    expect(dto.proposal).not.toHaveProperty("rconPassword");
    expect(dto.proposal).not.toHaveProperty("curseforgeApiKey");
  });
});
```

- [ ] **Step 2: Comprueba que fallan**

Run: `pnpm --filter @mcsm/api test -- src/import/propose.test.ts`
Expected: FAIL (`Cannot find module './propose.js'`).

- [ ] **Step 3: Implementación**

`panel/apps/api/src/import/propose.ts`:
```ts
import type { ImportCandidate } from "@mcsm/proto";
import {
  CURSEFORGE_API_KEY_RE, DIGITS_RE, ENTRY_RE, ENV_KEY_RE, IMAGE_TAG_RE, MAX_STRING_BYTES, MEMORY_RE, PLAYER_RE, PROPERTY_KEY_RE,
  RESERVED_ENV, RESERVED_PROPS, URL_RE, dataPathError, formatZodError, memoryToBytes, pathWithin, slugify, specInputSchema, utf8Bytes,
  type ImportCandidateDto, type SpecInput,
} from "@mcsm/shared";

/**
 * Candidato del agente → spec propuesta (spec §6.7). Pura: la usan el listado y la adopción (que
 * vuelve a escanear y recalcula, para no fiarse del navegador). Tabla de reglas: «Mapeo contenedor →
 * spec candidata» del Plan 6. Los secretos (RCON_PASSWORD, CF_API_KEY) solo salen en rconPassword y
 * curseforgeApiKey, que nunca van al navegador (toCandidateDto), y ningún aviso repite valores.
 */
export interface ProposeContext {
  /** DATA_ROOT del agente (ImportScanResult.dataRoot). */
  dataRoot: string;
  /** Slugs ya usados en el nodo. */
  takenSlugs: ReadonlySet<string>;
  /** Hay API key de CurseForge en Ajustes. */
  curseforgeConfigured: boolean;
}

export interface ImportProposal {
  name: string;
  slug: string;
  slugLocked: boolean;
  desiredState: "running" | "stopped";
  spec: SpecInput;
  specError: string | null;
  dataPath: string | null;
  rconPassword: string | null;
  curseforgeApiKey: string | null;
  blockers: string[];
  warnings: string[];
  hiddenEnv: string[];
}

const GAME_PORT = 25565;
const RCON_PORT = 25575;
const PLUGIN_TYPES = new Set(["PAPER", "PURPUR", "SPIGOT", "FOLIA", "BUKKIT", "PUFFERFISH", "LEAF"]);
const PLATFORMS = new Set(["MODRINTH", "AUTO_CURSEFORGE", "FTBA"]);
const RESTART = new Set(["no", "always", "unless-stopped", "on-failure"]);
const SECRET_ENV = ["RCON_PASSWORD", "CF_API_KEY"] as const;
export const COMPOSE_PROJECT = "com.docker.compose.project";
export const COMPOSE_SERVICE = "com.docker.compose.service";
const SLUG_DATA_RE = /^\/([a-z0-9][a-z0-9-]{0,39})\/data$/;

const truthy = (v: string | undefined) => v !== undefined && /^(true|1|yes|on)$/i.test(v.trim());
const falsy = (v: string | undefined) => v !== undefined && /^(false|0|no|off)$/i.test(v.trim());
/** Lista de itzg: separada por comas o saltos de línea. */
const splitList = (v: string) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function imageTag(ref: string, warn: (m: string) => void): string {
  const rest = ref.replace(/^docker\.io\//, "").slice("itzg/minecraft-server".length);
  if (rest.startsWith("@")) {
    warn("La imagen está fijada por digest: al recrearlo se usará la etiqueta latest (revisa la versión de Java en «Versión y mods»)");
    return "latest";
  }
  if (rest.startsWith(":")) {
    const tag = rest.slice(1).split("@")[0] ?? "";
    if (IMAGE_TAG_RE.test(tag)) return tag;
    warn(`La etiqueta de imagen «${tag}» no es válida para el panel: al recrearlo se usará latest`);
  }
  return "latest";
}

function memLimitText(bytes: bigint): string {
  const MiB = 1024n * 1024n;
  const GiB = 1024n * MiB;
  return bytes % GiB === 0n ? `${bytes / GiB}G` : `${(bytes + MiB - 1n) / MiB}M`;
}

export function proposeImport(c: ImportCandidate, ctx: ProposeContext): ImportProposal {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const env: Record<string, string> = { ...c.env };
  const take = (k: string): string | undefined => { const v = env[k]; delete env[k]; return v; };
  const hiddenEnv = SECRET_ENV.filter((k) => k in env);
  const root = ctx.dataRoot.replace(/\/+$/, "") || "/";

  // Red.
  const mode = c.networkMode;
  if (mode === "host" || mode === "none" || mode.startsWith("container:")) {
    blockers.push(`Usa la red «${mode}»: solo se importan contenedores con red propia (bridge o una red de usuario)`);
  }

  // /data.
  let slugLocked = false;
  let lockedSlug = "";
  let dataPath: string | null = null;
  const data = c.mounts.find((m) => m.destination === "/data");
  if (!data) blockers.push("No monta /data: el mundo vive dentro del contenedor y se perdería al recrearlo. Monta una carpeta del host en /data y vuelve a buscar");
  else if (data.type !== "bind") blockers.push(`Su /data es un volumen de Docker («${data.name || data.source}»): solo se importan carpetas del host montadas en /data`);
  else if (!data.readWrite) blockers.push("Su /data es de solo lectura");
  else {
    const src = data.source;
    const m = pathWithin(src, root) ? SLUG_DATA_RE.exec(src.slice(root === "/" ? 0 : root.length)) : null;
    if (m) {
      slugLocked = true;
      lockedSlug = m[1]!;
    } else if (pathWithin(src, root) || pathWithin(root, src)) {
      blockers.push(`Los datos están en ${src}, que ${pathWithin(src, root) ? "está dentro de" : "contiene"} DATA_ROOT (${root}) sin ser ${root}/<slug>/data: muévelos a ${root}/<slug>/data o fuera de DATA_ROOT y vuelve a buscar`);
    } else {
      const err = dataPathError(src);
      if (err) blockers.push(`No se puede usar ${src} como carpeta de datos: ${err}`);
      else {
        dataPath = src;
        warn(`Los datos quedan fuera de DATA_ROOT (${src}): este servidor no tendrá copias de seguridad ni navegador de archivos. Para tenerlos, para el contenedor y mueve la carpeta a ${root}/<slug>/data antes de importar`);
      }
    }
  }
  for (const m of c.mounts) if (m.destination !== "/data") warn(`El montaje ${m.source || m.name} → ${m.destination} no se conserva al recrear el contenedor`);

  // Puertos.
  let game: number | undefined;
  const extra: { host: number; container: number; proto: "tcp" | "udp"; label: string }[] = [];
  const seen = new Set<string>();
  for (const p of c.ports) {
    if (p.containerPort === GAME_PORT && p.proto === "tcp") {
      if (p.hostPort === 0) continue;
      game ??= p.hostPort;
      if (p.hostIp) warn(`El puerto ${p.hostPort} solo escucha en ${p.hostIp}: al recrearlo se publicará en todas las interfaces`);
      continue;
    }
    if (p.containerPort === RCON_PORT) {
      warn("Publica RCON (25575) en el host: al recrearlo dejará de publicarse (el panel usa RCON por la red interna)");
      continue;
    }
    if (p.hostPort === 0 || (p.proto !== "tcp" && p.proto !== "udp")) continue;
    const key = `${p.hostPort}/${p.containerPort}/${p.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({ host: p.hostPort, container: p.containerPort, proto: p.proto as "tcp" | "udp", label: "" });
  }
  if (game === undefined) blockers.push("No publica el puerto 25565/tcp en un puerto fijo del host (ports: \"<puerto>:25565\"): el panel gestiona así el puerto de juego");
  const serverPort = take("SERVER_PORT");
  if (serverPort !== undefined && serverPort.trim() !== String(GAME_PORT)) {
    blockers.push(`El servidor escucha en SERVER_PORT=${serverPort} dentro del contenedor; el panel solo gestiona 25565`);
  }

  // RCON y secretos.
  take("EULA");
  const rconEnv = take("RCON_PASSWORD");
  const rconOk = rconEnv !== undefined && rconEnv.length >= 8 && utf8Bytes(rconEnv) <= MAX_STRING_BYTES;
  const rconOff = falsy(take("ENABLE_RCON"));
  const rconPort = take("RCON_PORT");
  const rconPortOk = rconPort === undefined || rconPort.trim() === String(RCON_PORT);
  if (!rconOk || rconOff || !rconPortOk) {
    const why = rconOff ? "el contenedor tiene RCON desactivado" : !rconPortOk ? `usa RCON_PORT=${rconPort}` : "no fija RCON_PASSWORD (o tiene menos de 8 caracteres)";
    warn(`La consola de comandos (RCON) no funcionará hasta el primer «Guardar y aplicar»: ${why}. Al recrearlo el panel activa RCON con ${rconOk ? "la misma contraseña" : "una contraseña nueva"}`);
  }
  const cfKey = take("CF_API_KEY");
  let curseforgeApiKey: string | null = null;
  if (cfKey !== undefined) {
    if (ctx.curseforgeConfigured) warn("El contenedor trae su propia CF_API_KEY: al recrearlo se usará la API key de CurseForge de Ajustes");
    else if (CURSEFORGE_API_KEY_RE.test(cfKey)) {
      curseforgeApiKey = cfKey;
      warn("La CF_API_KEY del contenedor se guardará en Ajustes al importarlo si el servidor usa CurseForge (no hay ninguna configurada)");
    } else warn("La CF_API_KEY del contenedor no es válida y se descarta");
  }

  // Tipo, versión y memoria.
  let type = (take("TYPE") ?? "").trim().toUpperCase();
  const platform = env.MODPACK_PLATFORM?.trim().toUpperCase();
  if (platform && PLATFORMS.has(platform) && (type === "" || type === "VANILLA")) {
    type = platform;
    delete env.MODPACK_PLATFORM;
  }
  if (!type) type = "VANILLA";
  const version = (take("VERSION") ?? "").trim() || "LATEST";
  const memRaw = take("MEMORY")?.trim();
  let memory = "1G";
  if (memRaw) {
    if (MEMORY_RE.test(memRaw)) memory = memRaw;
    else warn(`MEMORY=${memRaw} no tiene el formato del panel (4G, 512M): se propone 1G; revísalo en «Recursos»`);
  }

  // Modpack.
  let modpack: SpecInput["modpack"];
  if (type === "MODRINTH" && env.MODRINTH_MODPACK !== undefined) {
    modpack = {
      platform: "MODRINTH", slugOrUrl: take("MODRINTH_MODPACK")!.trim(), versionId: take("MODRINTH_VERSION")?.trim() ?? "",
      loader: (take("MODRINTH_LOADER")?.trim().toLowerCase() ?? "") as NonNullable<SpecInput["modpack"]>["loader"],
    };
  } else if (type === "AUTO_CURSEFORGE" && (env.CF_SLUG !== undefined || env.CF_PAGE_URL !== undefined)) {
    const slug = take("CF_SLUG");
    const page = slug === undefined ? take("CF_PAGE_URL") : undefined;
    modpack = { platform: "AUTO_CURSEFORGE", slugOrUrl: (slug ?? page ?? "").trim(), versionId: take("CF_FILE_ID")?.trim() ?? "", loader: "" };
  } else if (type === "FTBA" && env.FTB_MODPACK_ID !== undefined) {
    modpack = { platform: "FTBA", slugOrUrl: take("FTB_MODPACK_ID")!.trim(), versionId: take("FTB_MODPACK_VERSION_ID")?.trim() ?? "", loader: "" };
  }

  // Mods y plugins: solo si todas las entradas valen (si no, la variable se queda en env tal cual).
  const moveList = (key: string, re: RegExp): string[] | undefined => {
    const v = env[key];
    if (v === undefined) return undefined;
    const items = splitList(v);
    if (!items.every((i) => re.test(i))) return undefined;
    delete env[key];
    return items;
  };
  const pluginsKind = PLUGIN_TYPES.has(type);
  const modrinth = moveList("MODRINTH_PROJECTS", ENTRY_RE);
  const cfFiles = moveList("CURSEFORGE_FILES", ENTRY_RE);
  const modUrls = moveList("MODS", URL_RE);
  const pluginUrls = moveList("PLUGINS", URL_RE);
  const spiget = moveList("SPIGET_RESOURCES", DIGITS_RE);
  let mods: SpecInput["mods"];
  let plugins: SpecInput["plugins"];
  if ((modrinth && !pluginsKind) || cfFiles || modUrls) {
    mods = { modrinthProjects: !pluginsKind ? (modrinth ?? []) : [], curseforgeFiles: cfFiles ?? [], urls: modUrls ?? [] };
  }
  if ((modrinth && pluginsKind) || pluginUrls || spiget) {
    plugins = { modrinthProjects: pluginsKind ? (modrinth ?? []) : [], spigetResources: spiget ?? [], urls: pluginUrls ?? [] };
  }

  // Propiedades.
  const properties: Record<string, string> = {};
  const custom = take("CUSTOM_SERVER_PROPERTIES");
  if (custom !== undefined) {
    const dropped: string[] = [];
    for (const raw of custom.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      const k = i > 0 ? line.slice(0, i).trim() : "";
      if (!k || !PROPERTY_KEY_RE.test(k) || RESERVED_PROPS.has(k)) {
        dropped.push(k && PROPERTY_KEY_RE.test(k) ? k : "(línea sin clave=valor válida)"); // nunca el valor: puede ser rcon.password
        continue;
      }
      properties[k] = line.slice(i + 1).trim();
    }
    if (dropped.length) warn(`De CUSTOM_SERVER_PROPERTIES se descartan: ${dropped.join(", ")}`);
  }

  // Jugadores: secciones solo si el contenedor ya sincroniza el fichero (si no, borrarían lo añadido desde el juego).
  let whitelist: SpecInput["whitelist"];
  let ops: string[] | undefined;
  if (env.EXISTING_WHITELIST_FILE?.trim().toUpperCase() === "SYNCHRONIZE" && env.WHITELIST_FILE === undefined
    && (env.WHITELIST !== undefined || env.ENABLE_WHITELIST !== undefined)
    && !("white-list" in properties) && !("enforce-whitelist" in properties)) {
    const players = env.WHITELIST !== undefined ? splitList(env.WHITELIST) : [];
    const en = env.ENABLE_WHITELIST;
    const enabled = truthy(en) || (en === undefined && players.length > 0);
    const coherent = en === undefined || truthy(en) || (falsy(en) && players.length === 0);
    if (coherent && players.every((p) => PLAYER_RE.test(p))) {
      whitelist = { enabled, players };
      delete env.WHITELIST;
      delete env.ENABLE_WHITELIST;
      delete env.EXISTING_WHITELIST_FILE;
    }
  }
  if (env.EXISTING_OPS_FILE?.trim().toUpperCase() === "SYNCHRONIZE" && env.OPS_FILE === undefined && env.OPS !== undefined) {
    const list = splitList(env.OPS);
    if (list.every((p) => PLAYER_RE.test(p))) {
      ops = list;
      delete env.OPS;
      delete env.EXISTING_OPS_FILE;
    }
  }
  if (env.WHITELIST !== undefined || env.OPS !== undefined) {
    warn("La whitelist y los operadores se quedan en variables de entorno (Avanzado) porque el contenedor no sincroniza esos ficheros: así no se pierde lo añadido desde el juego");
  }

  // Resto del env.
  const passEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k) || RESERVED_ENV.has(k)) {
      warn(`La variable ${k} no se puede conservar y se descarta`);
      continue;
    }
    passEnv[k] = v;
  }

  // Reinicio y recursos.
  let restartPolicy = c.restartPolicy || "no";
  if (!RESTART.has(restartPolicy)) {
    warn(`Política de reinicio «${restartPolicy}» desconocida: se propone unless-stopped`);
    restartPolicy = "unless-stopped";
  }
  const cpus = Math.round(Number(c.nanoCpus) / 1e7) / 100;
  let memLimit = "";
  if (c.memoryLimitBytes > 0n) {
    memLimit = memLimitText(c.memoryLimitBytes);
    if (memoryToBytes(memLimit) < memoryToBytes(memory)) {
      warn(`El límite de memoria de Docker (${memLimit}) es menor que MEMORY (${memory}): se quita (el agente pone memoria + 1G)`);
      memLimit = "";
    }
  } else {
    warn("Docker no limita su memoria: al recrearlo se limitará a MEMORY + 1G");
  }

  // Nombre, slug y estado.
  const project = c.labels[COMPOSE_PROJECT] ?? "";
  const service = c.labels[COMPOSE_SERVICE] ?? "";
  if (project) {
    warn(`Lo creó Docker Compose (proyecto «${project}», servicio «${service}»): antes del primer «Guardar y aplicar», quita ese servicio del compose (o no vuelvas a hacer «docker compose up»), o Compose volverá a crear el contenedor original junto al del panel`);
  }
  const name = (c.name || service || "Servidor importado").slice(0, 60);
  let slug: string;
  if (slugLocked) {
    slug = lockedSlug;
    if (ctx.takenSlugs.has(slug)) blockers.push(`Ya hay un servidor «${slug}» en este nodo y los datos de este contenedor están en ${root}/${slug}/data`);
  } else {
    slug = uniqueSlug(slugify(c.name || service), ctx.takenSlugs);
  }
  const desiredState = c.state === "running" || c.state === "restarting" ? "running" : "stopped";

  const raw = {
    imageTag: imageTag(c.image, warn), type, version, memory, properties, env: passEnv,
    resources: { cpus, memLimit }, restartPolicy, ports: { ...(game !== undefined ? { game } : {}), extra },
    ...(modpack ? { modpack } : {}), ...(mods ? { mods } : {}), ...(plugins ? { plugins } : {}),
    ...(whitelist ? { whitelist } : {}), ...(ops ? { ops } : {}),
  };
  const parsed = specInputSchema.safeParse(raw);
  return {
    name, slug, slugLocked, desiredState,
    spec: parsed.success ? parsed.data : (raw as unknown as SpecInput),
    specError: parsed.success ? null : formatZodError(parsed.error),
    dataPath, rconPassword: rconOk ? rconEnv! : null, curseforgeApiKey, blockers, warnings, hiddenEnv,
  };
}

/** DTO para el navegador: sin rconPassword ni curseforgeApiKey. */
export function toCandidateDto(c: ImportCandidate, p: ImportProposal): ImportCandidateDto {
  return {
    containerId: c.containerId, containerName: c.name, image: c.image, state: c.state,
    composeProject: c.labels[COMPOSE_PROJECT] ?? "", composeService: c.labels[COMPOSE_SERVICE] ?? "",
    blockers: p.blockers, warnings: p.warnings, hiddenEnv: p.hiddenEnv,
    proposal: { name: p.name, slug: p.slug, slugLocked: p.slugLocked, desiredState: p.desiredState, spec: p.spec, specError: p.specError, dataPath: p.dataPath },
  };
}
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/api test -- src/import/propose.test.ts && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/import/propose.ts panel/apps/api/src/import/propose.test.ts
git commit -m "feat(panel): spec propuesta a partir de un contenedor itzg existente

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Panel — `ImportService` y rutas de Nodos → Importar

**Agent:** panel-api-dev

**Files:**
- Create: `panel/apps/api/src/import/service.ts`, `panel/apps/api/src/import/routes.ts`, `panel/apps/api/src/import/import.test.ts`
- Modify: `panel/apps/api/src/app.ts` (import arriba, fuera de ancla; registro debajo de la ancla `plan-6`)

**Interfaces:**
- Consumes: Task 7 (`importAdoptSchema`, `ImportAdoptInput`, `ImportCandidateDto`, `ImportedFrom`, `sameSpecInput`, `dataPathsOverlap`), Task 8 (`parseImportedFrom`, `ServersRepo.setImportedFrom`, `ServersService.checkPorts`, `toServerSpecMessage` con `adopt`), Task 9 (`proposeImport`, `toCandidateDto`, `COMPOSE_PROJECT`, `COMPOSE_SERVICE`), `AgentConn.request`, `AgentError`, `AgentErrorCode`, `agentErrorToHttp`, `HttpError`, `app.serversService.push` (público desde el Plan 4), `app.curseforge`, `randomToken`, `nowIso`, `FakeAgent` (`connect`, `handshake`, `waitFor`, `send`, `ack`, `close`).
- Produces:
  - `GET /api/nodes/:id/import/candidates` → `ImportCandidateDto[]` (404 nodo, 409 desconectado, errores del agente vía `agentErrorToHttp`).
  - `POST /api/nodes/:id/import` cuerpo `ImportAdoptInput` → 201 `ServerDto` (con secretos, como crear). 404 si el contenedor ya no es candidato; 409 por bloqueo, cambios sin `applyNow`, slug o puerto ocupados, carpeta compartida; 400 por spec o slug fijo; 504 si la adopción queda sin confirmar (la fila se conserva).
  - `app.importService: ImportService` con `candidates(nodeId)` y `adopt(nodeId, input)`.

- [ ] **Step 1: Tests que fallan**

`panel/apps/api/src/import/import.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportCandidateSchema } from "@mcsm/proto";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const ID = "a".repeat(64);
const DATA_ROOT = "/srv/minecraft";
type Cand = MessageInitShape<typeof ImportCandidateSchema>;
const candidate = (over: Partial<Cand> = {}): Cand => ({
  containerId: ID, name: "survival", image: "itzg/minecraft-server:java21", state: "running",
  env: { EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass", CF_API_KEY: "cf-secreta-123", MOTD: "Hola" },
  ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25565 }],
  mounts: [{ type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true, name: "" }],
  restartPolicy: "unless-stopped", memoryLimitBytes: 0n, nanoCpus: 0n, networkMode: "bridge", networks: ["bridge"],
  labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "survival" },
  ...over,
});

const get = (u: string) => app.inject({ method: "GET", url: u, headers: { cookie } });
const post = (u: string, payload: object) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;

async function online() {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  return agent;
}
/** Contesta el siguiente ImportScan con estos candidatos. */
async function answerScan(agent: FakeAgent, cands: Cand[] = [candidate()]) {
  const scan = await agent.waitFor("importScan");
  agent.send({ id: scan.id, body: { case: "importScanResult", value: { dataRoot: DATA_ROOT, candidates: cands } } });
}
async function listCandidates(agent: FakeAgent, cands?: Cand[]) {
  const res = get(`/api/nodes/${nodeId}/import/candidates`);
  await answerScan(agent, cands);
  return res;
}

describe("Nodos → Importar", () => {
  it("sin sesión 401; con el nodo desconectado 409; nodo inexistente 404", async () => {
    expect((await app.inject({ method: "GET", url: `/api/nodes/${nodeId}/import/candidates` })).statusCode).toBe(401);
    expect((await get(`/api/nodes/${nodeId}/import/candidates`)).statusCode).toBe(409);
    expect((await get("/api/nodes/no-existe/import/candidates")).statusCode).toBe(404);
  });

  it("los candidatos llevan la propuesta y nunca los secretos", async () => {
    const agent = await online();
    const res = await listCandidates(agent);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("s3cr3t-rcon-pass");
    expect(res.body).not.toContain("cf-secreta-123");
    const [c] = res.json();
    expect(c).toMatchObject({
      containerId: ID, containerName: "survival", blockers: [], hiddenEnv: ["RCON_PASSWORD", "CF_API_KEY"], composeProject: "casa",
      proposal: { slug: "survival", slugLocked: false, desiredState: "running", dataPath: "/home/lobo/mc/survival", specError: null,
        spec: { type: "PAPER", version: "1.21.4", memory: "4G", env: { MOTD: "Hola" }, ports: { game: 25565, extra: [] } } },
    });
    agent.close();
  });

  it("adopción en caliente: servidor v1 importado e ImportAdopt con adopt y la contraseña RCON del contenedor", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", slug: "survival", spec: c.proposal.spec });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    if (adopt.body.case !== "importAdopt") throw new Error("esperaba importAdopt");
    const sp = adopt.body.value.server!;
    expect(sp.version).toBe(1n);
    expect(sp.slug).toBe("survival");
    expect(sp.desiredState).toBe(1); // RUNNING
    const json = decode(sp.specJson);
    expect(json).toMatchObject({ adopt: { containerId: ID, version: 1 }, rconPassword: "s3cr3t-rcon-pass", dataPath: "/home/lobo/mc/survival", type: "PAPER" });
    expect(json).not.toHaveProperty("curseforgeApiKey"); // PAPER no usa CurseForge
    agent.ack(adopt.id);
    const res = await adopting;
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: "survival", specVersion: 1, desiredState: "running",
      importedFrom: { containerId: ID, containerName: "survival", specVersion: 1, composeProject: "casa", composeService: "survival" },
    });
    expect((await get("/api/settings/curseforge")).json()).toEqual({ configured: false });
    // Ya importado: deja de ser candidato aunque el agente lo siga listando.
    expect((await listCandidates(agent)).json()).toEqual([]);
    agent.close();
  });

  it("con cambios en la spec, la adopción en caliente da 409 y no crea nada ni pide nada al agente", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: { ...c.proposal.spec, memory: "6G" } });
    await answerScan(agent);
    const res = await adopting;
    expect(res.statusCode).toBe(409);
    expect((await get("/api/servers")).json()).toEqual([]);
    agent.close();
  });

  it("Adoptar y aplicar: tras el Ack, versión 2 por ApplySpec (el agente recrea) con la spec revisada", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: { ...c.proposal.spec, memory: "6G" }, applyNow: true });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    agent.ack(adopt.id);
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error("esperaba applySpec");
    expect(apply.body.value.server!.version).toBe(2n);
    expect(decode(apply.body.value.server!.specJson)).toMatchObject({ memory: "6G", adopt: { containerId: ID, version: 1 } });
    agent.ack(apply.id);
    expect((await adopting).json()).toMatchObject({ specVersion: 2, spec: { memory: "6G" } });
    agent.close();
  });

  it("si el agente rechaza la adopción, el servidor no se queda en el panel", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    agent.send({ id: adopt.id, body: { case: "error", value: { code: "invalid_request", message: "el /data no coincide" } } });
    const res = await adopting;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("el /data no coincide");
    expect((await get("/api/servers")).json()).toEqual([]);
    agent.close();
  });

  it("si la conexión cae a mitad, el servidor importado se conserva (la adopción se completa al reconectar)", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    await agent.waitFor("importAdopt");
    agent.close();
    const res = await adopting;
    expect(res.statusCode).toBe(504);
    const servers = (await get("/api/servers")).json();
    expect(servers).toHaveLength(1);
    expect(servers[0].importedFrom.containerId).toBe(ID);
  });

  it("datos en DATA_ROOT/<slug>/data: el slug es fijo", async () => {
    const agent = await online();
    const inRoot = candidate({ mounts: [{ type: "bind", source: `${DATA_ROOT}/survival/data`, destination: "/data", readWrite: true, name: "" }] });
    const [c] = (await listCandidates(agent, [inRoot])).json();
    expect(c.proposal).toMatchObject({ slugLocked: true, dataPath: null });
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", slug: "otro", spec: c.proposal.spec });
    await answerScan(agent, [inRoot]);
    expect((await adopting).statusCode).toBe(400);
    agent.close();
  });

  it("dos servidores no comparten carpeta de datos", async () => {
    app.servers.create({
      nodeId, name: "Otro", slug: "otro", desiredState: "stopped",
      spec: specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25599 }, rconPassword: "abcdefgh", dataPath: "/home/lobo/mc" }),
    });
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    const res = await adopting;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Otro");
    agent.close();
  });

  it("un contenedor que ya no aparece en el escaneo da 404", async () => {
    const agent = await online();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: {} });
    await answerScan(agent, []);
    expect((await adopting).statusCode).toBe(404);
    agent.close();
  });

  it("la CF_API_KEY de un servidor de CurseForge pasa a Ajustes si no había ninguna y viaja al agente", async () => {
    const agent = await online();
    const cf = candidate({ env: { TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_API_KEY: "$2a$10$clave-cf", RCON_PASSWORD: "s3cr3t-rcon-pass" } });
    const list = await listCandidates(agent, [cf]);
    expect(list.body).not.toContain("clave-cf");
    const [c] = list.json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec });
    await answerScan(agent, [cf]);
    const adopt = await agent.waitFor("importAdopt");
    if (adopt.body.case !== "importAdopt") throw new Error("esperaba importAdopt");
    expect(decode(adopt.body.value.server!.specJson)).toMatchObject({ curseforgeApiKey: "$2a$10$clave-cf" });
    agent.ack(adopt.id);
    expect((await adopting).statusCode).toBe(201);
    expect(app.curseforge.get()).toBe("$2a$10$clave-cf");
    agent.close();
  });
});
```

- [ ] **Step 2: Comprueba que fallan**

Run: `pnpm --filter @mcsm/api test -- src/import/import.test.ts`
Expected: FAIL (404 en las rutas: aún no existen).

- [ ] **Step 3: Implementación**

`panel/apps/api/src/import/service.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ImportCandidate } from "@mcsm/proto";
import {
  dataPathsOverlap, formatZodError, sameSpecInput, specInputSchema, specSchema, specSizeError, usesCurseForge,
  type ImportAdoptInput, type ImportCandidateDto, type ImportedFrom, type Spec,
} from "@mcsm/shared";
import { AgentError, type AgentConn } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { randomToken } from "../lib/tokens.js";
import { parseImportedFrom, toServerDto, toServerSpecMessage, type ServerDto } from "../servers/repo.js";
import { COMPOSE_PROJECT, COMPOSE_SERVICE, proposeImport, toCandidateDto, type ImportProposal } from "./propose.js";

const SCAN_TIMEOUT_MS = 30_000;
const ADOPT_TIMEOUT_MS = 60_000;

interface Scanned { candidate: ImportCandidate; proposal: ImportProposal }

/** Importación de servidores existentes (spec §6.7, §7 ImportService). */
export class ImportService {
  constructor(private app: FastifyInstance) {}

  private conn(nodeId: string): AgentConn {
    if (!this.app.nodes.get(nodeId)) throw new HttpError(404, "Nodo no encontrado");
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return conn;
  }

  /** ImportScan + propuesta de cada candidato. Fuera los contenedores ya importados en este nodo. */
  private async scan(nodeId: string, conn: AgentConn): Promise<Scanned[]> {
    let res;
    try {
      res = await conn.request({ case: "importScan", value: {} }, SCAN_TIMEOUT_MS);
    } catch (e) {
      throw agentErrorToHttp(e, "El agente no pudo listar los contenedores");
    }
    if (res.body.case !== "importScanResult") throw new HttpError(502, "Respuesta inesperada del agente");
    const { candidates, dataRoot } = res.body.value;
    const rows = this.app.servers.list(nodeId);
    const imported = new Set(rows.map((r) => parseImportedFrom(r)?.containerId).filter((id): id is string => !!id));
    const ctx = { dataRoot, takenSlugs: new Set(rows.map((r) => r.slug)), curseforgeConfigured: this.app.curseforge.get() !== null };
    return candidates.filter((c) => !imported.has(c.containerId)).map((c) => ({ candidate: c, proposal: proposeImport(c, ctx) }));
  }

  async candidates(nodeId: string): Promise<ImportCandidateDto[]> {
    const conn = this.conn(nodeId);
    return (await this.scan(nodeId, conn)).map(({ candidate, proposal }) => toCandidateDto(candidate, proposal));
  }

  /**
   * Adopta un candidato. Vuelve a escanear (no se fía de lo que mandó el navegador): dataPath, la
   * contraseña RCON y la key de CurseForge salen del contenedor. Sin applyNow exige la propuesta sin
   * cambios (la spec v1 describe el contenedor que sigue en marcha); con applyNow sube a v2 tras el Ack.
   */
  async adopt(nodeId: string, input: ImportAdoptInput): Promise<ServerDto> {
    const conn = this.conn(nodeId);
    const found = (await this.scan(nodeId, conn)).find((s) => s.candidate.containerId === input.containerId);
    if (!found) throw new HttpError(404, "Ese contenedor ya no se puede importar: no existe, ya lo gestiona el panel o ya se importó");
    const { candidate: c, proposal: p } = found;
    if (p.blockers.length > 0) throw new HttpError(409, p.blockers[0]!);

    const { dataPath: _fromBrowser, ...edited } = input.spec; // dataPath sale del contenedor, nunca del navegador
    const parsed = specInputSchema.safeParse(edited);
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    if (!input.applyNow && (p.specError !== null || !sameSpecInput(p.spec, parsed.data))) {
      throw new HttpError(409, "La configuración no es la del contenedor: adoptarlo sin pararlo exige la propuesta sin cambios. Usa «Adoptar y aplicar» (recrea el contenedor) o deshaz los cambios");
    }

    const slug = input.slug ?? p.slug;
    if (p.slugLocked && slug !== p.slug) throw new HttpError(400, `El slug tiene que ser «${p.slug}»: los datos ya están en DATA_ROOT/${p.slug}/data`);
    if (this.app.servers.getBySlug(nodeId, slug)) throw new HttpError(409, `Ya existe un servidor con slug "${slug}" en este nodo`);
    if (p.dataPath) {
      for (const r of this.app.servers.list(nodeId)) {
        const other = (JSON.parse(r.spec) as Spec).dataPath;
        if (other && dataPathsOverlap(other, p.dataPath)) throw new HttpError(409, `El servidor «${r.name}» ya usa esa carpeta de datos (${other})`);
      }
    }
    const full = specSchema.safeParse({
      ...parsed.data,
      ports: { game: parsed.data.ports.game ?? p.spec.ports.game, extra: parsed.data.ports.extra },
      rconPassword: p.rconPassword ?? randomToken(),
      ...(p.dataPath ? { dataPath: p.dataPath } : {}),
    });
    if (!full.success) throw new HttpError(400, formatZodError(full.error));
    const tooBig = specSizeError(full.data);
    if (tooBig) throw new HttpError(400, tooBig);
    this.app.serversService.checkPorts(nodeId, full.data);

    // La key de CurseForge del contenedor pasa a Ajustes si no había ninguna. Sin reaplicar a los demás
    // servidores (recrearlos por importar uno sorprendería): la recibirán en su próximo cambio.
    if (p.curseforgeApiKey && usesCurseForge(full.data) && this.app.curseforge.get() === null) {
      this.app.curseforge.set(p.curseforgeApiKey);
    }

    const created = this.app.servers.create({ nodeId, name: input.name, slug, spec: full.data, desiredState: p.desiredState });
    const from: ImportedFrom = {
      containerId: c.containerId, containerName: c.name, specVersion: created.spec_version, importedAt: nowIso(),
      composeProject: c.labels[COMPOSE_PROJECT] ?? "", composeService: c.labels[COMPOSE_SERVICE] ?? "",
    };
    let row = this.app.servers.setImportedFrom(created.id, from);
    try {
      await conn.request({ case: "importAdopt", value: { server: toServerSpecMessage(row, this.app.curseforge.get()) } }, ADOPT_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Timeout || e.code === AgentErrorCode.Disconnected)) {
        // Puede que el agente lo adoptara: borrar la fila haría que el próximo SyncSpecs retirara el servidor
        // y borrara el contenedor original. Se conserva: al reconectar, su spec (con adopt) completa la adopción.
        this.app.log.warn({ nodeId, serverId: row.id, code: e.code }, "ImportAdopt sin confirmar; el servidor importado se conserva");
        throw new HttpError(504, "El agente no confirmó la adopción a tiempo. El servidor queda importado y la adopción se completará cuando el nodo responda: revisa su estado en unos segundos");
      }
      this.app.servers.delete(row.id);
      throw agentErrorToHttp(e, "El agente no pudo adoptar el contenedor");
    }
    if (input.applyNow) {
      row = this.app.servers.bumpVersion(row.id);
      void this.app.serversService.push(row);
    }
    return toServerDto(row, { includeSecrets: true });
  }
}
```

`panel/apps/api/src/import/routes.ts`:
```ts
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { importAdoptSchema } from "@mcsm/shared";
import { ImportService } from "./service.js";

/** Nodos → Importar (spec §6.7, §8). Decora el servicio en la raíz y registra las rutas encapsuladas. */
export const importRoutes = fp(async function importRoutes(root: FastifyInstance) {
  const svc = new ImportService(root);
  root.decorate("importService", svc);
  await root.register(async (app) => {
    app.get<{ Params: { id: string } }>("/api/nodes/:id/import/candidates", async (req) => svc.candidates(req.params.id));
    app.post<{ Params: { id: string } }>("/api/nodes/:id/import", async (req, reply) =>
      reply.code(201).send(await svc.adopt(req.params.id, importAdoptSchema.parse(req.body))));
  });
});

declare module "fastify" {
  interface FastifyInstance { importService: ImportService }
}
```

`panel/apps/api/src/app.ts`: arriba, con los demás imports (fuera de ancla), `import { importRoutes } from "./import/routes.js";`; y debajo de `// ── plan-6 ──`:
```ts
  await app.register(importRoutes);
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/api test && pnpm -r typecheck`
Expected: PASS (toda la API).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/import/service.ts panel/apps/api/src/import/routes.ts panel/apps/api/src/import/import.test.ts panel/apps/api/src/app.ts
git commit -m "feat(panel): ImportService y rutas para importar servidores existentes de un nodo

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — lógica de la importación y avisos del servidor importado

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/lib/import.ts`, `panel/apps/web/src/lib/import.test.ts`, `panel/apps/web/src/hooks/use-import.ts`
- Modify: `panel/apps/web/src/lib/api.ts` (fuera de ancla: `ServerDto.importedFrom`)

**Interfaces:**
- Consumes: Task 7 (`ImportCandidateDto`, `ImportedFrom`, `sameSpecInput`, `SpecInput.dataPath`), `EditableSpec` (`lib/spec-edit.ts`), `api`, `apiPath`, `ServerDto`.
- Produces:
  - `ServerDto.importedFrom: ImportedFrom | null` en `lib/api.ts`.
  - `interface ReviewState { name: string; slug: string; spec: EditableSpec }`; `initialReview(c): ReviewState`; `isPristine(c, spec): boolean`; `adoptBlock(c, r, { fieldErrors, specError, applyNow }): string | null`; `adoptRequest(c, r, applyNow)` → cuerpo de `POST /api/nodes/:id/import`; `isAdopted(server): boolean`; `importNotices(server): string[]`; `candidateStateLabel(state): string`.
  - `useImportCandidates(nodeId)` (query `["import-candidates", nodeId]`, sin reintentos ni refresco automático).

- [ ] **Step 1: Tests que fallan**

`panel/apps/web/src/lib/import.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ImportCandidateDto, type ImportedFrom } from "@mcsm/shared";
import type { ObservedDto, ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";
import { adoptBlock, adoptRequest, candidateStateLabel, importNotices, initialReview, isAdopted, isPristine } from "./import";

const ID = "a".repeat(64);
const spec: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", memory: "4G", env: { MOTD: "Hola" }, ports: { game: 25565, extra: [] } };
const cand = (over: Partial<ImportCandidateDto> = {}, proposal: Partial<ImportCandidateDto["proposal"]> = {}): ImportCandidateDto => ({
  containerId: ID, containerName: "survival", image: "itzg/minecraft-server:java21", state: "running", composeProject: "casa", composeService: "survival",
  blockers: [], warnings: [], hiddenEnv: ["RCON_PASSWORD"],
  proposal: { name: "survival", slug: "survival", slugLocked: false, desiredState: "running", spec, specError: null, dataPath: "/home/lobo/mc/survival", ...proposal },
  ...over,
});
const noErrors = { fieldErrors: {}, specError: null };

describe("revisión de un candidato", () => {
  it("empieza con la propuesta y sin cambios", () => {
    const c = cand();
    const r = initialReview(c);
    expect(r).toEqual({ name: "survival", slug: "survival", spec });
    expect(isPristine(c, r.spec)).toBe(true);
    expect(isPristine(c, { ...r.spec, memory: "6G" })).toBe(false);
    expect(isPristine(cand({}, { specError: "type: falta el modpack" }), r.spec)).toBe(false);
  });

  it("bloqueos en orden: candidato, nombre, slug, campos, spec y cambios sin aplicar", () => {
    const c = cand();
    const r = initialReview(c);
    expect(adoptBlock(cand({ blockers: ["Su /data es un volumen"] }), r, { ...noErrors, applyNow: false })).toBe("Su /data es un volumen");
    expect(adoptBlock(c, { ...r, name: "  " }, { ...noErrors, applyNow: false })).toMatch(/nombre/);
    expect(adoptBlock(c, { ...r, slug: "Mal" }, { ...noErrors, applyNow: false })).toMatch(/[Ss]lug/);
    expect(adoptBlock(c, r, { fieldErrors: { "sf-memory": "x" }, specError: null, applyNow: false })).toMatch(/1 campo/);
    expect(adoptBlock(c, r, { fieldErrors: {}, specError: "memory: inválida", applyNow: true })).toBe("memory: inválida");
    const changed = { ...r, spec: { ...r.spec, memory: "6G" } };
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: false })).toMatch(/Adoptar y aplicar/);
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: true })).toBeNull();
    expect(adoptBlock(c, r, { ...noErrors, applyNow: false })).toBeNull();
  });

  it("la petición no lleva dataPath, ni slug si está fijo", () => {
    const c = cand();
    const r = { ...initialReview(c), name: " Survival ", spec: { ...spec, dataPath: "/otra" } };
    expect(adoptRequest(c, r, false)).toEqual({ containerId: ID, name: "Survival", slug: "survival", spec, applyNow: false });
    expect(adoptRequest(cand({}, { slugLocked: true }), initialReview(c), true)).toEqual({ containerId: ID, name: "survival", spec, applyNow: true });
  });

  it("estados en castellano", () => {
    expect(candidateStateLabel("running")).toBe("En marcha");
    expect(candidateStateLabel("exited")).toBe("Parado");
    expect(candidateStateLabel("raro")).toBe("raro");
  });
});

describe("avisos de un servidor importado", () => {
  const from: ImportedFrom = { containerId: ID, containerName: "survival", specVersion: 1, importedAt: "", composeProject: "casa", composeService: "survival" };
  const observed = (containerId: string) => ({ containerId } as ObservedDto);
  const server = (over: Partial<ServerDto>): Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec"> =>
    ({ slug: "survival", importedFrom: null, observed: null, spec: { ...spec, ports: { game: 25565, extra: [] } }, ...over } as ServerDto);

  it("adoptado: sigue en el original, se recreará y avisa de Compose y de dataPath", () => {
    const s = server({ importedFrom: from, observed: observed(ID), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(true);
    const n = importNotices(s);
    expect(n).toHaveLength(3);
    expect(n[0]).toMatch(/mcsm-survival/);
    expect(n[1]).toMatch(/Compose/);
    expect(n[2]).toMatch(/\/home\/lobo\/mc\/survival/);
  });

  it("ya recreado: solo el aviso de dataPath; un servidor normal no tiene avisos", () => {
    const s = server({ importedFrom: from, observed: observed("b".repeat(64)), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(false);
    expect(importNotices(s)).toHaveLength(1);
    expect(importNotices(server({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: Comprueba que fallan**

Run: `pnpm --filter @mcsm/web test -- src/lib/import.test.ts`
Expected: FAIL (`Cannot find module './import'`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/lib/api.ts` (fuera de ancla), en `interface ServerDto`, añade:
```ts
  /** plan-6: origen de un servidor importado (null si lo creó el panel). */
  importedFrom: import("@mcsm/shared").ImportedFrom | null;
```

`panel/apps/web/src/lib/import.ts`:
```ts
import { sameSpecInput, type ImportCandidateDto } from "@mcsm/shared";
import type { ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";

/** Lo que el usuario revisa antes de adoptar un contenedor (Nodos → Importar). */
export interface ReviewState { name: string; slug: string; spec: EditableSpec }

export function initialReview(c: ImportCandidateDto): ReviewState {
  return { name: c.proposal.name, slug: c.proposal.slug, spec: c.proposal.spec };
}

/** ¿La spec revisada es la deducida del contenedor, y esta es válida? Solo entonces se adopta sin parar. */
export function isPristine(c: ImportCandidateDto, spec: EditableSpec): boolean {
  return c.proposal.specError === null && sameSpecInput(c.proposal.spec, spec);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Por qué no se puede adoptar (null = se puede). `applyNow`: «Adoptar y aplicar» (recrea enseguida);
 * si no, «Adoptar sin parar», que exige la propuesta sin cambios. `specError`: validateSpec de la revisión.
 */
export function adoptBlock(
  c: ImportCandidateDto, r: ReviewState,
  o: { fieldErrors: Readonly<Record<string, string>>; specError: string | null; applyNow: boolean },
): string | null {
  if (c.blockers.length > 0) return c.blockers[0]!;
  if (!r.name.trim()) return "Escribe un nombre";
  if (!SLUG_RE.test(r.slug)) return "Slug inválido: minúsculas, números y guiones (máx. 40)";
  const n = Object.keys(o.fieldErrors).length;
  if (n > 0) return `Corrige ${n} ${n === 1 ? "campo con error" : "campos con error"}`;
  if (o.specError) return o.specError;
  if (!o.applyNow && !isPristine(c, r.spec)) {
    return c.proposal.specError
      ? "La configuración del contenedor no es válida tal cual: corrígela y usa «Adoptar y aplicar»"
      : "Has cambiado la configuración: usa «Adoptar y aplicar» (recrea el contenedor) o deshaz los cambios";
  }
  return null;
}

/** Cuerpo de POST /api/nodes/:id/import. dataPath no viaja (el panel lo saca del contenedor) ni el slug fijo. */
export function adoptRequest(c: ImportCandidateDto, r: ReviewState, applyNow: boolean) {
  const { dataPath: _fromContainer, ...spec } = r.spec;
  return { containerId: c.containerId, name: r.name.trim(), ...(c.proposal.slugLocked ? {} : { slug: r.slug }), spec, applyNow };
}

/** El servidor sigue en el contenedor original que se importó (aún sin recrear). */
export function isAdopted(s: Pick<ServerDto, "importedFrom" | "observed">): boolean {
  return !!s.importedFrom && !!s.observed && s.observed.containerId === s.importedFrom.containerId;
}

/** Avisos para la cabecera de la página del servidor. */
export function importNotices(s: Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec">): string[] {
  const out: string[] = [];
  const from = s.importedFrom;
  if (from && isAdopted(s)) {
    out.push(`Importado de «${from.containerName}»: sigue en su contenedor original hasta el primer «Guardar y aplicar», que lo recreará como mcsm-${s.slug} (parada breve; el mundo no se toca) y borrará el contenedor original.`);
    if (from.composeProject) {
      out.push(`Viene de Docker Compose (proyecto «${from.composeProject}», servicio «${from.composeService}»): quita ese servicio del compose antes de aplicar cambios, o Compose volverá a crearlo.`);
    }
  }
  if (s.spec.dataPath) {
    out.push(`Los datos están en ${s.spec.dataPath}, fuera de DATA_ROOT: este servidor no tiene copias de seguridad ni navegador de archivos.`);
  }
  return out;
}

const STATES: Record<string, string> = {
  running: "En marcha", exited: "Parado", created: "Creado", restarting: "Reiniciando", paused: "En pausa", dead: "Muerto",
};
export const candidateStateLabel = (state: string): string => STATES[state] ?? state;
```

`panel/apps/web/src/hooks/use-import.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import type { ImportCandidateDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** Candidatos a importar de un nodo: se piden al abrir la página y con «Volver a buscar» (cada escaneo inspecciona Docker). */
export function useImportCandidates(nodeId: string) {
  return useQuery({
    queryKey: ["import-candidates", nodeId],
    queryFn: () => api.get<ImportCandidateDto[]>(apiPath`/api/nodes/${nodeId}/import/candidates`),
    retry: false, refetchOnWindowFocus: false, staleTime: 0,
  });
}
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/web test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/lib/import.ts panel/apps/web/src/lib/import.test.ts panel/apps/web/src/hooks/use-import.ts panel/apps/web/src/lib/api.ts
git commit -m "feat(web): lógica de revisión de importaciones y avisos de servidores importados

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — Nodos → Importar y avisos en la página del servidor

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/routes/import.tsx`, `panel/apps/web/src/components/import-notices.tsx`, `panel/apps/web/src/components/import-notices.test.tsx`
- Modify: `panel/apps/web/src/router.tsx` (import arriba fuera de ancla; ruta e hijo debajo de las anclas `plan-6`), `panel/apps/web/src/routes/nodes.tsx` (fuera de ancla: botón «Importar»), `panel/apps/web/src/routes/server.tsx` (fuera de ancla: una línea en la cabecera)

**Interfaces:**
- Consumes: Task 11 (`initialReview`, `isPristine`, `adoptBlock`, `adoptRequest`, `candidateStateLabel`, `importNotices`, `useImportCandidates`), `SpecForm` y `SpecFormErrors` (Plan 3), `Field` (`spec-form/fields.tsx`), `ConfirmDialog` (Plan 5), `validateSpec`, `useNodes`, `api`, `apiPath`, `ApiError`, `ServerDto`, componentes shadcn `Button`, `Card`, `Input`.
- Produces: ruta `/nodes/$nodeId/import` (`importRoute`, componente `ImportPage`); `ImportNotices({ server })`; enlace «Importar» en cada fila de Nodos.

- [ ] **Step 1: Test que falla**

`panel/apps/web/src/components/import-notices.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { defaultSpecInput } from "@mcsm/shared";
import type { ServerDto } from "@/lib/api";
import { ImportNotices } from "./import-notices";

const ID = "a".repeat(64);
const base = {
  id: "s1", nodeId: "n1", name: "Survival", slug: "survival", specVersion: 1, desiredState: "running", observedSpecVersion: 1,
  observedAt: null, createdAt: "", updatedAt: "", observed: null, importedFrom: null,
  spec: { ...defaultSpecInput(), ports: { game: 25565, extra: [] } },
} as unknown as ServerDto;

describe("ImportNotices (render en servidor)", () => {
  it("un servidor del panel no pinta nada", () => {
    expect(renderToString(<ImportNotices server={base} />)).toBe("");
  });
  it("un importado aún adoptado explica la recreación y el dataPath", () => {
    const s = {
      ...base,
      observed: { containerId: ID } as ServerDto["observed"],
      importedFrom: { containerId: ID, containerName: "mc-viejo", specVersion: 1, importedAt: "", composeProject: "", composeService: "" },
      spec: { ...base.spec, dataPath: "/home/lobo/mc/survival" },
    } as ServerDto;
    const html = renderToString(<ImportNotices server={s} />);
    expect(html).toContain("mc-viejo");
    expect(html).toContain("mcsm-survival");
    expect(html).toContain("/home/lobo/mc/survival");
  });
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `pnpm --filter @mcsm/web test -- src/components/import-notices.test.tsx`
Expected: FAIL (`Cannot find module './import-notices'`).

- [ ] **Step 3: Implementación**

`panel/apps/web/src/components/import-notices.tsx`:
```tsx
import { Info } from "lucide-react";
import type { ServerDto } from "@/lib/api";
import { importNotices } from "@/lib/import";

/** Avisos de un servidor importado (cabecera de su página): adopción pendiente, Compose y datos fuera de DATA_ROOT. */
export function ImportNotices({ server }: { server: ServerDto }) {
  const notes = importNotices(server);
  if (notes.length === 0) return null;
  return (
    <div data-testid="import-notices" className="mt-2 flex max-w-3xl flex-col gap-1 rounded-md border border-sky-900 bg-sky-950/30 p-2 text-sm text-sky-200">
      {notes.map((n) => <p key={n} className="flex gap-2"><Info className="mt-0.5 size-4 shrink-0" />{n}</p>)}
    </div>
  );
}
```

`panel/apps/web/src/routes/import.tsx`:
```tsx
import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Loader2, RefreshCw } from "lucide-react";
import type { ImportCandidateDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SpecForm, type SpecFormErrors } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { useNodes } from "@/hooks/use-nodes";
import { useImportCandidates } from "@/hooks/use-import";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";
import { validateSpec } from "@/lib/spec-edit";
import { adoptBlock, adoptRequest, candidateStateLabel, initialReview, isPristine, type ReviewState } from "@/lib/import";

/** Nodos → Importar (spec §8): contenedores itzg del nodo que el panel aún no gestiona. */
export function ImportPage() {
  const { nodeId } = useParams({ from: "/app/nodes/$nodeId/import" });
  const nodes = useNodes();
  const node = nodes.data?.find((n) => n.id === nodeId);
  const q = useImportCandidates(nodeId);
  const [selected, setSelected] = useState<ImportCandidateDto | null>(null);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Importar en «{node?.name ?? "…"}»</h1>
          <p className="text-sm text-muted-foreground">Contenedores de itzg/minecraft-server de este nodo que el panel aún no gestiona. Se adoptan sin pararlos.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" asChild><Link to="/nodes">Volver a Nodos</Link></Button>
          <Button variant="secondary" disabled={q.isFetching} onClick={() => { setSelected(null); void q.refetch(); }}>
            {q.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Volver a buscar
          </Button>
        </div>
      </div>
      {q.isPending && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Buscando contenedores…</p>}
      {q.isError && <p role="alert" className="text-sm text-red-400">{q.error.message}</p>}
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground">No hay contenedores de itzg/minecraft-server sin gestionar en este nodo.</p>}
      {selected
        ? <ImportReview key={selected.containerId} nodeId={nodeId} candidate={selected} onCancel={() => setSelected(null)} />
        : <div className="grid gap-3 lg:grid-cols-2">{q.data?.map((c) => <CandidateCard key={c.containerId} c={c} onReview={() => setSelected(c)} />)}</div>}
    </div>
  );
}

function CandidateCard({ c, onReview }: { c: ImportCandidateDto; onReview: () => void }) {
  const p = c.proposal;
  return (
    <Card data-testid="import-candidate">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{c.containerName}</div>
            <div className="text-xs text-muted-foreground">
              <code>{c.image}</code> · {candidateStateLabel(c.state)}{c.composeProject ? ` · compose ${c.composeProject}/${c.composeService}` : ""}
            </div>
          </div>
          <Button size="sm" disabled={c.blockers.length > 0} onClick={onReview}>Revisar e importar</Button>
        </div>
        <div className="text-sm text-muted-foreground">
          {p.spec.type} {p.spec.version} · {p.spec.memory} · puerto {p.spec.ports.game ?? "—"} · datos <code>{p.dataPath ?? `DATA_ROOT/${p.slug}/data`}</code>
        </div>
        {c.blockers.map((b) => <p key={b} className="flex gap-2 text-sm text-red-400"><Ban className="mt-0.5 size-4 shrink-0" />{b}</p>)}
        {c.warnings.map((w) => <p key={w} className="flex gap-2 text-sm text-amber-400"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}
      </CardContent>
    </Card>
  );
}

function ImportReview({ nodeId, candidate: c, onCancel }: { nodeId: string; candidate: ImportCandidateDto; onCancel: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [review, setReview] = useState<ReviewState>(() => initialReview(c));
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [confirmApply, setConfirmApply] = useState(false);
  const specError = validateSpec(review.spec, "server");
  const adopt = useMutation({
    mutationFn: (applyNow: boolean) => api.post<ServerDto>(apiPath`/api/nodes/${nodeId}/import`, adoptRequest(c, review, applyNow)),
    onSuccess: (dto) => {
      setConfirmApply(false);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["import-candidates", nodeId] });
      void navigate({ to: "/servers/$serverId", params: { serverId: dto.id } });
    },
  });
  const hotBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: false });
  const applyBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: true });
  const err = adopt.error instanceof ApiError ? adopt.error.message : adopt.error ? "Error inesperado" : null;

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="imp-name" label="Nombre"><Input id="imp-name" value={review.name} maxLength={60} onChange={(e) => setReview((r) => ({ ...r, name: e.target.value }))} /></Field>
      <Field id="imp-slug" label="Slug" hint={c.proposal.slugLocked ? `Fijo: los datos ya están en DATA_ROOT/${c.proposal.slug}/data.` : `El contenedor gestionado se llamará mcsm-${review.slug}.`}>
        <Input id="imp-slug" className="font-mono" value={review.slug} maxLength={40} disabled={c.proposal.slugLocked} onChange={(e) => setReview((r) => ({ ...r, slug: e.target.value }))} />
      </Field>
      <div className="text-sm text-muted-foreground">
        Datos: <code>{c.proposal.dataPath ?? `DATA_ROOT/${review.slug}/data`}</code> · {c.proposal.desiredState === "running" ? "en marcha" : "parado"}
      </div>
      {c.hiddenEnv.length > 0 && <p className="text-xs text-muted-foreground">No se muestran (secretos): {c.hiddenEnv.join(", ")}. RCON_PASSWORD se conserva como contraseña RCON.</p>}
    </div>
  );

  return (
    <div className="flex max-w-5xl flex-col gap-4" data-testid="import-review">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Revisar «{c.containerName}»</h2>
        <Button variant="ghost" disabled={adopt.isPending} onClick={onCancel}>Volver a la lista</Button>
      </div>
      {c.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-300">
          {c.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</li>)}
        </ul>
      )}
      {c.proposal.specError && <p role="alert" className="text-sm text-red-400">La configuración deducida no es válida tal cual ({c.proposal.specError}): corrígela y usa «Adoptar y aplicar».</p>}
      <SpecForm value={review.spec} onChange={(spec) => setReview((r) => ({ ...r, spec }))} onError={setErrors} mode="server" general={general} />
      {err && !confirmApply && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={adopt.isPending || hotBlock !== null} aria-describedby={hotBlock ? "imp-hot-why" : undefined} onClick={() => adopt.mutate(false)}>
          {adopt.isPending && !confirmApply ? "Adoptando…" : "Adoptar sin parar"}
        </Button>
        <Button variant="secondary" disabled={adopt.isPending || applyBlock !== null} onClick={() => { adopt.reset(); setConfirmApply(true); }}>Adoptar y aplicar ahora</Button>
        {hotBlock
          ? <span id="imp-hot-why" className="text-sm text-muted-foreground">{hotBlock}</span>
          : isPristine(c, review.spec) && <span className="text-sm text-muted-foreground">El contenedor sigue en marcha; se recreará con el primer «Guardar y aplicar».</span>}
      </div>
      <ConfirmDialog
        open={confirmApply}
        title={`Adoptar y aplicar «${review.name.trim() || c.containerName}»`}
        description={`Se adopta el contenedor y enseguida se recrea como mcsm-${review.slug} con esta configuración: el servidor se para un momento y el contenedor original se borra (el mundo no se toca).`}
        confirmLabel="Adoptar y aplicar"
        pending={adopt.isPending}
        error={confirmApply ? err : null}
        onConfirm={() => adopt.mutate(true)}
        onCancel={() => setConfirmApply(false)}
      />
    </div>
  );
}
```

`panel/apps/web/src/router.tsx`:
1. Import (fuera de ancla, junto a los demás): `import { ImportPage } from "./routes/import";`
2. Debajo de la **primera** `// ── plan-6 ──` (definiciones):
```tsx
export const importRoute = createRoute({ getParentRoute: () => appRoute, path: "/nodes/$nodeId/import", component: ImportPage });
```
3. Debajo de la `// ── plan-6 ──` de `appRoute.addChildren([…])`:
```tsx
    importRoute,
```

`panel/apps/web/src/routes/nodes.tsx` (fuera de ancla):
1. Import: `import { Link } from "@tanstack/react-router";`
2. Sustituye la última celda de cada fila (la del botón de eliminar) por:
```tsx
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {/* plan-6: Nodos → Importar */}
                  <Button size="sm" variant="secondary" asChild><Link to="/nodes/$nodeId/import" params={{ nodeId: n.id }}>Importar</Link></Button>
                  <Button size="sm" variant="ghost" aria-label={`Eliminar nodo ${n.name}`} title="Eliminar" disabled={del.isPending} onClick={() => { if (confirm(`¿Eliminar el nodo "${n.name}"? Solo es posible si no tiene servidores.`)) del.mutate(n.id); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
```
(Si el Plan 5 ya sustituyó ese `confirm` por `ConfirmDialog`, conserva su botón tal cual y solo añade el enlace «Importar» delante, dentro del mismo `div`.)

`panel/apps/web/src/routes/server.tsx` (fuera de ancla): import `import { ImportNotices } from "@/components/import-notices";` y, en la cabecera, justo después de la línea `{o?.error && <p …>{o.error}</p>}`:
```tsx
          <ImportNotices server={s} />
```

- [ ] **Step 4: Comprueba que pasa**

Run: `pnpm --filter @mcsm/web test && pnpm -r typecheck && pnpm --filter @mcsm/web build`
Expected: PASS y build sin errores. Comprueba con `grep -n "plan-6" panel/apps/web/src/router.tsx` que la ruta y el hijo quedaron cada uno bajo su ancla.

- [ ] **Step 5: Revisión visual (humano)**

El navegador automatizado no abre `localhost`: deja anotado en el informe que la revisión visual (lista de candidatos, revisión con `SpecForm`, botones y avisos de la página del servidor) se hace en la Task 13 a mano.

- [ ] **Step 6: Commit**

```bash
git add panel/apps/web/src/routes/import.tsx panel/apps/web/src/components/import-notices.tsx panel/apps/web/src/components/import-notices.test.tsx \
  panel/apps/web/src/router.tsx panel/apps/web/src/routes/nodes.tsx panel/apps/web/src/routes/server.tsx
git commit -m "feat(web): Nodos → Importar con revisión antes de adoptar y avisos del servidor importado

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Verificación extremo a extremo y criterios de aceptación

**Agent:** infra-dev (Docker real; si algo falla sin causa obvia, `debugger`)

**Files:**
- Modify (solo si hay desviaciones): este plan, como nota al pie de esta tarea.

**Interfaces:**
- Consumes: todo el plan; `deploy/panel.Dockerfile`, `deploy/docker-compose.dev.yml` (agente en Docker, red externa `mcsm`).
- Produces: evidencia de la aceptación del README de planes (Plan 6): *los servidores actuales del compose aparecen como candidatos, se adoptan sin parada y muestran logs/jugadores; el primer «Guardar y aplicar» los recrea con etiquetas `mcsm.*` y el mismo directorio de datos.*

Reglas: solo recursos `mcsm-test-*` (proyectos compose `mcsm-test-p6` y `mcsm-test-externo`, contenedores `mcsm-test-panel`, `mcsm-test-externo-orig` y, tras la recreación, `mcsm-test-externo`; imagen `mcsm-test-panel:e2e`), y se borran al final. Los servidores reales del usuario **aparecerán como candidatos**: se miran, no se adoptan ni se tocan. Antes de empezar, `docker ps -a --filter name=mcsm-test-` debe salir vacío (si no, BLOCKED). Firewall de esta máquina: un contenedor no alcanza al host, así que el panel corre como contenedor `mcsm-test-panel` en la red `mcsm` y el agente usa `PANEL_URL=http://mcsm-test-panel:8080`. Las esperas (`until …; do sleep …; done`) se lanzan con la herramienta Monitor.

- [ ] **Step 1: Verificación automática completa**

Run: `eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=$(git merge-base HEAD feat/wave-a)" && (cd agent && go vet ./... && go test -race ./... && go test -tags integration -run 'TestMobyImport' ./internal/docker/) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build`
Expected: todo en verde.

- [ ] **Step 2: El servidor «externo» (un compose como los del usuario)**

```bash
export E2E=$PWD/deploy/data/test-plan6 B=http://localhost:8080
export J=$E2E/cookies.txt
mkdir -p $E2E/panel $E2E/mc $E2E/externo/data
cat > $E2E/externo/compose.yml <<'EOF'
name: mcsm-test-externo
services:
  mc:
    image: itzg/minecraft-server:java21
    container_name: mcsm-test-externo-orig
    environment:
      EULA: "TRUE"
      TYPE: VANILLA
      VERSION: "1.21.4"
      MEMORY: 1G
      RCON_PASSWORD: externo-rcon-123
      CF_API_KEY: e2e-cf-key-falsa-plan6
      MOTD: Servidor externo plan 6
      OPS: Lobo
      EXISTING_OPS_FILE: SYNCHRONIZE
      USE_AIKAR_FLAGS: "true"
    ports: ["25598:25565"]
    volumes: ["./data:/data"]
    restart: unless-stopped
EOF
docker compose -f $E2E/externo/compose.yml up -d
until docker logs mcsm-test-externo-orig 2>&1 | grep -q 'Done ('; do sleep 5; done
docker exec mcsm-test-externo-orig sh -c 'echo plan6 > /data/marcador-e2e'
SEED=$(docker exec mcsm-test-externo-orig rcon-cli seed); echo "$SEED"
ORIG=$(docker inspect -f '{{.Id}}' mcsm-test-externo-orig)
BEFORE=$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' mcsm-test-externo-orig); echo "$BEFORE"
```
Expected: el servidor llega a `Done (`; `SEED` es `Seed: [<número>]`.

- [ ] **Step 3: Panel (contenedor) y agente**

```bash
docker network inspect mcsm >/dev/null 2>&1 || { docker network create mcsm && touch $E2E/created-network; }
docker build -f deploy/panel.Dockerfile -t mcsm-test-panel:e2e .
docker run -d --name mcsm-test-panel --network mcsm --user "$(id -u):$(id -g)" -v $E2E/panel:/data -p 8080:8080 \
  -e PANEL_PUBLIC_URL=http://mcsm-test-panel:8080 mcsm-test-panel:e2e
until curl -sf $B/api/health >/dev/null; do sleep 1; done
curl -s -c $J -H 'content-type: application/json' -d '{"password":"e2e-plan6-pass"}' $B/api/auth/setup
TOKEN=$(curl -s -b $J -H 'content-type: application/json' -d "{\"nameHint\":\"test-plan6\",\"dataRoot\":\"$E2E/mc\"}" $B/api/nodes/enrollment-tokens | jq -r .token)
printf 'services:\n  agent:\n    environment:\n      PANEL_URL: http://mcsm-test-panel:8080\n' > $E2E/agent-override.yml
ENROLL_TOKEN=$TOKEN DATA_ROOT=$E2E/mc docker compose -p mcsm-test-p6 -f deploy/docker-compose.dev.yml -f $E2E/agent-override.yml up -d --build
until [ "$(curl -s -b $J $B/api/nodes | jq -r '.[0].status')" = online ]; do sleep 2; done
NODE=$(curl -s -b $J $B/api/nodes | jq -r '.[0].id')
```
Expected: el nodo pasa a `online` en segundos.

- [ ] **Step 4: Aceptación 1 — aparecen como candidatos, sin secretos**

```bash
curl -s -b $J $B/api/nodes/$NODE/import/candidates > $E2E/candidatos.json
jq -r '.[] | "\(.containerName)\t\(.image)\t\(.blockers | length) bloqueos"' $E2E/candidatos.json
grep -c -e 'externo-rcon-123' -e 'e2e-cf-key-falsa-plan6' $E2E/candidatos.json
jq '.[] | select(.containerName=="mcsm-test-externo-orig") | {blockers, hiddenEnv, p: .proposal | {slug, slugLocked, desiredState, dataPath, specError, type: .spec.type, version: .spec.version, memory: .spec.memory, game: .spec.ports.game, ops: .spec.ops, env: .spec.env}}' $E2E/candidatos.json
```
Expected: la lista incluye `mcsm-test-externo-orig` **y los servidores itzg reales del usuario** (compruébalo con él; no se tocan); `grep -c` → `0`; para el externo: `blockers: []`, `hiddenEnv: ["RCON_PASSWORD","CF_API_KEY"]`, `slugLocked: false`, `desiredState: "running"`, `dataPath: "$E2E/externo/data"`, `specError: null`, `VANILLA`, `1.21.4`, `1G`, `game: 25598`, `ops: ["Lobo"]` y `env` con `MOTD` y `USE_AIKAR_FLAGS` (sin `OPS`, `RCON_PASSWORD` ni `CF_API_KEY`).

- [ ] **Step 5: Aceptación 2 — adopción sin parada, logs y jugadores**

```bash
SPEC=$(jq -c '.[] | select(.containerName=="mcsm-test-externo-orig") | .proposal.spec' $E2E/candidatos.json)
SID=$(curl -s -b $J -H 'content-type: application/json' \
  -d "{\"containerId\":\"$ORIG\",\"name\":\"Test externo\",\"slug\":\"test-externo\",\"spec\":$SPEC}" \
  $B/api/nodes/$NODE/import | tee $E2E/adopt.json | jq -r .id)
jq -c '{specVersion, importedFrom: .importedFrom.containerName}' $E2E/adopt.json
[ "$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' mcsm-test-externo-orig)" = "$BEFORE" ] && echo SIN_PARADA
docker inspect -f '{{json .NetworkSettings.Networks.mcsm.Aliases}}' mcsm-test-externo-orig
until [ "$(curl -s -b $J $B/api/servers/$SID | jq -r '.observed.mc.online')" = true ]; do sleep 3; done
curl -s -b $J $B/api/servers/$SID | jq -c '{c: .observed.containerId[0:12], state: .observed.state, players: "\(.observed.mc.playersOnline)/\(.observed.mc.playersMax)", applied: .observedSpecVersion}'
curl -s -b $J -H 'content-type: application/json' -d '{"command":"list"}' $B/api/servers/$SID/command
```
Logs por el WebSocket del navegador (cliente mínimo con el `ws` de la API):
```bash
cat > $E2E/logs.cjs <<'EOF'
const WebSocket = require("ws");
const [url, cookie, sid] = process.argv.slice(2);
const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers: { cookie } });
let n = 0;
setTimeout(() => { console.log(`LINEAS ${n}`); process.exit(n > 0 ? 0 : 1); }, 8000);
ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", topic: `server:${sid}:logs` })));
ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "log" && n++ === 0) console.log(m.line); });
EOF
NODE_PATH=$PWD/panel/apps/api/node_modules node $E2E/logs.cjs $B "$(awk '$6=="mcsm_session"{print $6"="$7}' $J)" $SID
```
Métricas (tras ~40 s):
```bash
until [ "$(curl -s -b $J "$B/api/servers/$SID/metrics?range=1h" | jq '[.playersMax[] | select(. != null)] | length')" -ge 2 ]; do sleep 10; done && echo METRICAS
```
Expected: `{"specVersion":1,"importedFrom":"mcsm-test-externo-orig"}`; `SIN_PARADA`; los alias de `mcsm` incluyen `"mcsm-test-externo"`; el servidor `running`, `0/20` jugadores, `applied: 1` y el `containerId` empieza por el de `$ORIG`; el comando `list` responde `There are 0 of a max of 20 players online…`; el script imprime una línea del log y `LINEAS <n>` con n > 0; aparece `METRICAS`.

- [ ] **Step 6: Límites con `dataPath`**

```bash
curl -s -w ' %{http_code}\n' -b $J "$B/api/servers/$SID/files?path=/"
curl -s -w ' %{http_code}\n' -b $J -X POST $B/api/servers/$SID/backups
curl -s -w ' %{http_code}\n' -b $J -X PATCH -H 'content-type: application/json' -d '{"enabled":true,"cron":"0 4 * * *"}' $B/api/servers/$SID/backups/schedule
curl -s -w ' %{http_code}\n' -b $J -X DELETE "$B/api/servers/$SID?deleteData=true"
curl -s -b $J $B/api/settings/curseforge
```
Expected: archivos y copia → `409` con «fuera de DATA_ROOT»; programar copias → `400`; borrar con datos → `400` (el servidor sigue); `{"configured":false}` (VANILLA no usa CurseForge: la key del contenedor no se guarda).

- [ ] **Step 7: Aceptación 3 — el primer «Guardar y aplicar» recrea con `mcsm.*` y los mismos datos**

```bash
curl -s -b $J -X PATCH -H 'content-type: application/json' -d '{"spec":{"memory":"1536M"}}' $B/api/servers/$SID | jq -c '{specVersion, memory: .spec.memory, dataPath: .spec.dataPath}'
until ! docker inspect mcsm-test-externo-orig >/dev/null 2>&1 && docker inspect mcsm-test-externo >/dev/null 2>&1; do sleep 2; done
docker inspect mcsm-test-externo --format '{{json .Config.Labels}} {{json .HostConfig.Binds}} {{json .HostConfig.PortBindings}}'
docker inspect mcsm-test-externo --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(MEMORY|RCON_PASSWORD|OPS|EXISTING_OPS_FILE|MOTD|USE_AIKAR_FLAGS|CF_API_KEY|TYPE)=' | sort
until docker logs mcsm-test-externo 2>&1 | grep -q 'Done ('; do sleep 5; done
docker exec mcsm-test-externo cat /data/marcador-e2e
curl -s -b $J -H 'content-type: application/json' -d '{"command":"seed"}' $B/api/servers/$SID/command
until [ "$(curl -s -b $J $B/api/servers/$SID | jq -r '.observedSpecVersion')" = 2 ]; do sleep 2; done
curl -s -b $J $B/api/servers/$SID | jq -c '{c: .observed.containerId[0:12], state: .observed.state, importedFrom: .importedFrom.containerId[0:12]}'
```
Expected: `{"specVersion":2,"memory":"1536M","dataPath":"$E2E/externo/data"}`; el original desaparece y existe `mcsm-test-externo`; etiquetas `mcsm.managed=true`, `mcsm.server_id=$SID`, `mcsm.slug=test-externo`, `mcsm.spec_hash`, `mcsm.spec_version=2`; bind `["$E2E/externo/data:/data"]`; puerto `25598`; env exactamente:
```
EXISTING_OPS_FILE=SYNCHRONIZE
MEMORY=1536M
MOTD=Servidor externo plan 6
OPS=Lobo
RCON_PASSWORD=externo-rcon-123
TYPE=VANILLA
USE_AIKAR_FLAGS=true
```
(sin `CF_API_KEY`); el marcador imprime `plan6`; el `seed` por la API coincide con `$SEED` (mismo mundo); el servidor vuelve a `running` con otro `containerId` (distinto del de `importedFrom`).

- [ ] **Step 8: Recorrido por la web (humano)**

El navegador automatizado no abre `localhost:8080`: pide al usuario que, en `http://localhost:8080` (contraseña `e2e-plan6-pass`), compruebe y anota lo que diga:
1. **Nodos**: cada fila tiene «Importar»; la página lista los candidatos con avisos (ámbar) y bloqueos (rojo); sus servidores reales del compose aparecen.
2. **Revisar e importar** de un candidato (sin adoptar): se ve `SpecForm` con la propuesta; cambiar la memoria deshabilita «Adoptar sin parar» y explica por qué; «Volver a la lista».
3. **Test externo**: tras el Step 7 la cabecera solo muestra el aviso de datos fuera de DATA_ROOT; la consola muestra el log en vivo; el Resumen tiene gráficas con jugadores.

- [ ] **Step 9: Limpieza**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -b $J -X DELETE "$B/api/servers/$SID?deleteData=false"     # 204: borra mcsm-test-externo
docker compose -f $E2E/externo/compose.yml down
docker compose -p mcsm-test-p6 -f deploy/docker-compose.dev.yml -f $E2E/agent-override.yml down -v
docker rm -f mcsm-test-panel && docker rmi mcsm-test-panel:e2e
[ -f $E2E/created-network ] && docker network rm mcsm
docker run --rm --name mcsm-test-cleanup -v "$E2E:/x" alpine rm -rf /x/mc /x/panel /x/externo   # ficheros de uid 1000/root
rm -rf "$E2E"
docker ps -a --filter name=mcsm-test --format '{{.Names}}'
docker volume ls --filter name=mcsm-test --format '{{.Name}}'
```
Expected: `204`; sin contenedores, volúmenes ni imágenes `mcsm-test*`. Los contenedores del usuario siguen como estaban.

- [ ] **Step 10: Cierre**

Si algo se desvió del plan (avisos, mapeo de variables, comportamiento de la web), anótalo al pie de esta tarea y commitea solo esa nota:
```bash
git add docs/superpowers/plans/2026-10-12-06-importacion.md
git commit -m "docs: notas de verificación del plan 6

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Sin desviaciones, no hay commit.

**Notas de la verificación (E2E combinada de los Planes 6 y 7 sobre `feat/wave-b`, 2026-10-12).** Informe completo en `.superpowers/sdd/wave-b-e2e-report.md`.
- Montaje: un solo nodo en el Docker del host (`mcsm-test-agent-a`, `docker run`, no el compose `mcsm-test-p6`), compartido con la E2E del Plan 7: dos agentes sobre el mismo Docker se verían los contenedores. Directorio de trabajo en el scratchpad (`/tmp`), no en `deploy/data`.
- **Bug encontrado y arreglado (9f2d104):** la consola de un importado aún adoptado mostraba los 8 bytes de cabecera del multiplexado de Docker delante de cada línea, y sin marca de tiempo. Los contenedores de Compose no tienen TTY; los que crea el agente, sí. `Moby.Logs` separa stdout y stderr con `stdcopy` cuando el contenedor no tiene TTY. Test de integración: `TestMobyLogsWithoutTTY`.
- Step 4: con los datos en `/tmp`, la propuesta añade el aviso de carpeta temporal (f7a5972). En la máquina no había servidores itzg del usuario: solo salieron los de prueba. Un contenedor con `./mods:/data/mods` aparece con un bloqueo, y `POST …/import` da 409 con ese texto (6ed31e3).
- Step 6: los 409 de archivos y de copia dicen «datos fuera de DATA_ROOT: … elimina el servidor sin borrar datos, mueve esa carpeta a DATA_ROOT/<slug>/data y vuelve a importarlo» (d82c0b5). Un PATCH con otro `dataPath` o con `null` da 400; con el mismo valor no cambia la versión. Crear un servidor con `dataPath` da 400.
- Step 7: `HostConfig.Binds` es `null` y `/data` va en `HostConfig.Mounts` (`{"Type":"bind","Source":"<dataPath>","Target":"/data"}`), por el arreglo M3 (5d1740c). Con la carpeta apartada, recrear falla («bind source path does not exist»): no se crea una carpeta vacía y el panel lo muestra en `observed.error`. Al devolver la carpeta, el contenedor se crea solo (unos 20 s).
- H1 (a54989f): se cambió el `dataPath` en la BD del panel a otra carpeta. El `ApplySpec` se rechaza («carpeta de datos sin verificar … no se monta») y el contenedor no se toca. El PATCH responde 200 (el push es asíncrono): el rechazo solo se ve en el log del panel y en `observedSpecVersion`, que no avanza.
- Step 8 (web): pendiente del humano, porque el navegador automatizado no abre `localhost:8080`.

---

## Cierre del plan

Con la Task 13 en verde, el sistema cumple el paso 8 del orden de construcción de la spec (§13) y la aceptación del Plan 6. Antes de fusionar la oleada B:

- Revisión de rama con `final-reviewer` y **`security-auditor`** (superficie nueva: `dataPath` como bind arbitrario con un entrypoint que corre como root; contenedores ajenos inspeccionados y conectados a la red `mcsm`; secretos de los candidatos).
- Notas para `CLAUDE.md` (las añade el controlador):
  - Importados: el agente sigue el contenedor original por el registro `store.Adoption` hasta que `spec_version` supere `Adoption.Version`; `reconcile.find` devuelve el adoptado con `Adopted=true` y etiquetas sintetizadas. Todo lo que busque «el contenedor del servidor» usa `find`/`Container`/`ServerContainers`, nunca `ListManaged` a pelo. Orden de locks: lock por servidor → `adoptMu` → `r.mu`; `Adopt` suelta `adoptMu` antes de reconciliar.
  - `toServerSpecMessage` añade `adopt {containerId, version}` a la spec de todo servidor con `imported_from`: si el agente pierde el registro, lo reconstruye sin crear un segundo contenedor sobre el mismo mundo.
  - `dataPath` solo lo fija la importación (crear → 400; PATCH: mismo valor o `null`); no está en `baseFields` (las plantillas no lo llevan); siempre fuera de `DATA_ROOT`; con él, `Files*`/`BackupNow`/`BackupRestore` → `external_data` (409), sin copias programadas y sin «borrar con datos». Validación Go/zod con `proto/fixtures/data-path-cases.json`.
  - Un `ImportAdopt` con `timeout`/`disconnected` conserva la fila del panel (504): borrarla haría que `SyncSpecs` retirara el servidor y borrara el contenedor original.
- Puntos de contacto con los otros planes de la oleada B:
  - **Plan 7 (migración):** un servidor con `dataPath` no tiene copias (`external_data`): la migración debe rechazarlo con un mensaje claro (o pedir antes mover los datos a `DATA_ROOT` y quitar `dataPath`). El servidor creado en destino no hereda `imported_from` (sin `adopt`) ni `dataPath`.
  - **Plan 8 (mc-router):** las etiquetas `mc-router.host` solo existen en contenedores creados por el agente: un importado aún adoptado no entra por mc-router hasta su primera recreación (avisarlo en la UI de mc-router). `routes/nodes.tsx` también lo toca el Plan 8 (conflicto trivial en la celda de acciones).
  - `docker.Engine` gana cuatro métodos: los envoltorios de test que incrusten `*docker.Fake` los heredan; uno que implemente `Engine` a mano tendrá que añadirlos.
- Pendiente para el Plan 9: README («Importar servidores existentes»: quitar el servicio del compose, `RCON_PASSWORD` explícita para tener consola antes de recrear, mover los datos a `DATA_ROOT/<slug>/data` para tener copias y archivos) y un mando en la UI para quitar `dataPath` tras mover los datos (hoy solo por API: `PATCH {spec:{dataPath:null}}`).
