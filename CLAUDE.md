# MC Server Manager

Gestor web self-hosted, de un solo administrador, para servidores Minecraft Java que
corren con `itzg/minecraft-server` en varias máquinas de la LAN. Un **panel**
(TypeScript: API Fastify + web React) y un **agente** Go por nodo que reconcilia Docker
y se conecta al panel por WebSocket con protobuf.

- Spec (autoridad): `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`
- Planes: `docs/superpowers/plans/README.md` (hoja de ruta de los planes 1–9) y un
  fichero por plan detallado (`2026-10-12-NN-<nombre>.md`).

## Estructura

```
agent/            Go module mcsm/agent (cmd/agent, internal/*)
panel/            workspace pnpm: apps/api, apps/web, packages/shared, packages/proto-ts
proto/            .proto, fuente única del protocolo (buf)
deploy/           docker-compose de despliegue
docs/             spec, plan, notas
.claude/agents/   subagentes del proyecto (ver "Agentes")
```

## Comandos

Toolchain: Go 1.27.2 y buf 1.73.0 vía `mise` (ejecuta `eval "$(mise env)"` en la raíz
antes de `go`/`buf`); Node 26 y pnpm 12 globales.

```bash
pnpm install                       # dependencias del workspace del panel
pnpm gen                           # buf generate → agent/gen y panel/packages/proto-ts/src/gen (se commitea)
pnpm lint:proto                    # buf lint
(cd agent && go build ./... && go vet ./... && go test ./...)
(cd agent && go test -race ./...)  # paquetes con goroutines
(cd agent && go test -tags integration ./...)   # contra Docker real (lento)
pnpm typecheck && pnpm test        # todos los paquetes del panel
pnpm --filter @mcsm/web build      # build de la web
pnpm dev:api                       # panel en :8080
pnpm dev:web                       # web en :5173 (proxy a :8080)
```

### Verificación completa (antes de cerrar un plan)

`eval "$(mise env)" && pnpm lint:proto && (cd agent && go vet ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build`

## Convenciones

- Commits: conventional commits en español (`feat(agent): …`, `fix(panel): …`,
  `test(web): …`, `docs: …`), pequeños. Línea final de co-autoría con el modelo que
  escribió el cambio: `Co-Authored-By: Claude Opus 5.5|Sonnet 5.5|Haiku 5.5
  <noreply@anthropic.com>` (sustituye la de `Claude Fable 5.1` que traen los planes).
  Nunca `git push`, nunca reescribir historia, nunca `--no-verify`.
- TDD en todo lo que tenga lógica. Salida de tests limpia.
- No editar código generado (`buf generate`); se regenera.
- Mensajes de UI y de error en castellano; identificadores de código en inglés.
- Panel: TypeScript `strict`, ESM, `node:sqlite` con SQL a mano (sin ORM, sin
  dependencias nativas), zod 4 compartido en `panel/packages/shared`.
- Agente: dependencias externas tras interfaces con fakes, `context` en todo I/O,
  `slog`, reloj inyectable, `-race` limpio.

## Docker en la máquina de desarrollo

Hay contenedores ajenos al proyecto en esta máquina. Tests y pruebas manuales solo
crean/tocan recursos con prefijo `mcsm-test-` o etiqueta `mcsm.test=true`, y los
limpian. Prohibido `docker system prune`, borrados masivos o tocar contenedores ajenos.

## Agentes

Definidos en `.claude/agents/`. Regla general: **Haiku** para lo mecánico y para
resumir, **Sonnet** para implementar y revisar tareas, **Opus** para diseñar, depurar
lo difícil, lo concurrente y las revisiones finales y de seguridad.

| Agente | Modelo | Cuándo |
|---|---|---|
| `architect` | Opus | Dictámenes de conflicto, desbloquear BLOCKED, trocear tareas, cambios de protocolo |
| `systems-expert` | Opus | Concurrencia/streaming/estado distribuido (conn WS, reconciliador, logs, transferencias, backup/restore, migración, NodeRegistry); rescate en rondas de fix 4-5 |
| `debugger` | Opus | Tests que fallan sin causa obvia, intermitencias, `-race`, integración/E2E |
| `final-reviewer` | Opus | Revisión de rama completa al cerrar un bloque o el plan |
| `security-auditor` | Opus | Auth, tokens, archivos, transferencias, socket Docker; antes de desplegar |
| `plan-writer` | Opus | Detallar los planes 2–9 de la hoja de ruta a partir del código existente |
| `go-agent-dev` | Sonnet | Tareas Go del agente con requisitos claros |
| `panel-api-dev` | Sonnet | API Fastify, SQLite, servicios, rutas, WS, agente falso |
| `web-ui-dev` | Sonnet | Web React/shadcn/TanStack |
| `infra-dev` | Sonnet | Dockerfiles, compose, buf, CI, integración Docker real, Playwright |
| `task-reviewer` | Sonnet | Revisión por tarea (spec + calidad) |
| `mechanical-dev` | Haiku | Tareas cuyo brief trae el código completo, scaffolding, config, codegen |
| `re-reviewer` | Haiku | Re-revisión acotada de arreglos pequeños |
| `test-runner` | Haiku | Ejecutar suites/lint/build y resumir fallos |
| `docs-writer` | Haiku | README, guías de despliegue y uso |

### Flujo de trabajo con el plan

Se ejecuta con `superpowers:subagent-driven-development`. Por cada tarea:

1. Elegir implementador: brief con código completo → `mechanical-dev`; Go →
   `go-agent-dev`; API → `panel-api-dev`; web → `web-ui-dev`; Docker/CI/E2E →
   `infra-dev`; concurrencia, streaming o protocolo vivo → `systems-expert`.
2. Revisión con `task-reviewer` (o `security-auditor` además, si la tarea toca auth,
   tokens, archivos o transferencias).
3. Arreglos: rondas 1-3 reanudan al implementador; rondas 4-5 pasan a
   `systems-expert` o `debugger` (un nivel por encima). Re-revisión con `re-reviewer`
   si el arreglo es pequeño, `task-reviewer` si no.
4. BLOCKED/NEEDS_CONTEXT o conflicto con la spec → `architect`.
5. Al cerrar cada plan: `test-runner` con la verificación completa, `final-reviewer`
   (y `security-auditor` si el plan tocó superficie sensible), integrar la rama, y
   `plan-writer` detalla el siguiente plan de la hoja de ruta.

Pistas independientes (p. ej. agente Go y panel TS) pueden ir en paralelo, cada una en
su propio worktree bajo `.worktrees/` (ignorado por git) y con conjuntos de ficheros
disjuntos; nunca dos implementadores a la vez sobre el mismo working tree.

## Notas aprendidas

(El controlador añade aquí trampas de librerías y decisiones que los agentes deben
conocer.)

- Versiones del Plan 1 que no existen en npm: `vitest ^4.3.0` → usa `^4.1.11`;
  `@fastify/static ^8.4.0` → usa `^8.3.0`. El resto de versiones del plan existen.
- Fastify: decora servicios/repos (`app.nodes`, `app.servers`, `app.agents`,
  `app.events`, `app.serversService`…) en `buildApp()` o con `fastify-plugin`; nunca
  dentro de un plugin encapsulado (quedan invisibles para el resto). Las rutas sí van
  encapsuladas. Errores HTTP: lanza `HttpError` (`panel/apps/api/src/lib/http.ts`; también
  re-exportado desde `servers/service.ts`) y deja que el manejador global (registrado en
  `buildApp`) responda `{ error: "mensaje en castellano" }`: 5xx genéricos ("Error interno")
  salvo 502/504; ZodError → 400; un `AgentError` se traduce con `agentErrorToHttp` (502 con
  el texto del agente/Docker, spec §10). No hace falta `setErrorHandler` propio.
- Códigos de `Error.code` del agente: catálogo en el comentario de `message Error`
  (`agent.proto`), constantes en `agent/internal/errcode` y
  `panel/apps/api/src/agents/error-codes.ts`; un código nuevo va a los tres sitios y, si no
  es 502, a la tabla de `agentErrorToHttp`. El agente responde `unsupported` a cuerpos que no
  conoce y nunca contesta a un Ack/Error.
- `AgentConn.ready`: ninguna petición sale al agente antes del Ack de `SyncSpecs`;
  `request`/`openStream` esperan solas (plazo vencido retenida → `syncing`, 409). El agente
  confirma `SyncSpecs` tras guardar en el store y reconcilia en segundo plano.
- Guard de sesión: decide por la ruta enrutada (`req.routeOptions.url`), no por
  `req.url` (los paths percent-encoded saltaban la auth). Allowlist pública exacta.
- `@fastify/websocket` se registra una sola vez en toda la app (antes de `authPlugin`).
- Migraciones: nunca edites una aplicada; añade una nueva al array (se aplican por
  nombre, en orden del array).
- Protocolo agente↔panel: solo `ack`/`error`/`commandResult` con `id≠0` resuelven
  peticiones del panel; los mensajes no solicitados del agente van con `id=0`.
  `AgentConn.request/openStream` fallan al instante con `AgentError("disconnected")`.
  `openStream` registra el stream antes de pedirlo.
- Agente: usa `rec.Apply(ctx, spec)` (guarda de versión + PutSpec + Reconcile bajo el
  lock por servidor), nunca PutSpec+Reconcile a mano; `rec.Remove` borra la spec
  dentro del lock. El observer del reconciliador se invoca con el lock tomado: no
  reentrar. RCON con cliente Source propio (`internal/mc`), no `mcutil/rcon`.
- Agente: las operaciones que mutan Docker o disco usan el contexto de vida del agente
  (`App.life`), no el `ctx` de la sesión WS que recibe `Handle`; el de la sesión es solo
  para streams de logs y comandos RCON cuyo resultado va a esa sesión; las
  transferencias (escriben en disco) usan `App.life`. `send` sigue ligado a la sesión.
- Agente: `Power` solo persiste el estado deseado si la acción Docker tiene éxito. El
  `Hello` lleva `spec_versions` y `desired_states`; el panel reenvía en `SyncSpecs` lo que
  difiera en cualquiera de los dos (`specDiffers`).
- `BuildContainer` y `mcsm.spec_hash`: cambiar su salida recrea **todos** los contenedores
  al actualizar el agente. El hash se calcula sobre `hashInput` (forma canónica propia +
  `hashSchema`); lo que se añada al contenedor debe entrar en `hashInput`, y los campos
  nuevos de spec deben dejar el hash igual cuando vienen vacíos (`omitempty`, nada en el
  env). `TestHashGolden` fija el hash de la fixture. Contenedores con `CapDrop ALL` + el
  mínimo de itzg, `no-new-privileges`, `PidsLimit` 4096 y memoria `memory + 1G` sin
  `memLimit`.
- Web: toda ruta de la API con valores se construye con `apiPath` (`lib/api.ts`), que
  codifica cada valor: ``api.get(apiPath`/api/servers/${id}`)``.
- Fake de Docker (`internal/docker/fake.go`): semántica real (puertos se enlazan en
  Start; Kill sobre parado = conflicto). Mantén `CreateErr`, `Calls`, `Pulled`.
- WS del navegador: `log_reset {serverId}` precede a la cola de líneas al (re)abrir
  (la consola se vacía), `log_dropped {serverId,count}`, `error {message}`,
  `stream_closed`. La web invalida sus queries en `realtime.onReconnect`.
- Web: shadcn se usa con `pnpm dlx shadcn@3.8.5` (variante Radix), nunca `@latest`.
  `cn` = clsx + tailwind-merge. Tests con vitest (`pnpm --filter @mcsm/web test`).
- Validación de spec (Go y zod idénticas): nombres de env `^[A-Za-z_][A-Za-z0-9_]*$`
  y reservadas; memoria `^[1-9]\d*[MmGg]$`; puertos extra sin container 25575;
  properties con clave `^[a-z0-9][a-z0-9._-]*$`, sin saltos de línea y sin
  `server-port`/`enable-rcon`/`rcon.port`/`rcon.password`; `imageTag`
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, por defecto `latest`. Slug autogenerado repetido
  → sufijo `-2`, `-3`…
- Tests sin `time.Sleep`/`setTimeout` para sincronizar: relojes y planificadores
  inyectables.
- Web: el panel se sirve por HTTP en la LAN (sin contexto seguro): nada de
  `crypto.randomUUID()` ni APIs que exijan HTTPS sin fallback; ids con
  `crypto.getRandomValues`.

- PATCH de spec = merge de primer nivel: `null` solo borra secciones opcionales; `null` en una
  clave obligatoria es 400. Una sección ausente ≠ presente y vacía (`[]` emite SYNCHRONIZE).
  Una sección presente (ops/whitelist) prohíbe en `env` las variables que genera.
- Topes de la spec iguales en Go y zod (listas ≤ 1000, strings ≤ 4 KiB, URLs ≤ 2 KiB) y
  spec serializada ≤ 64 KiB en el panel tras el merge. Divergencias Go/zod solo en la
  dirección segura (zod igual o más estricto) y con fixture compartida en `proto/fixtures/`.
- `toServerSpecMessage(row, curseforgeApiKey)`: la key es obligatoria en todo emisor de
  `ApplySpec`/`SyncSpecs` (si falta, los servidores CurseForge se recrean en bucle).
- Web: un `<form>` dentro de un diálogo anidado en otro formulario hace `stopPropagation`
  en su submit (React propaga por el árbol aunque el diálogo esté en un portal).
- `routes/server.tsx` tiene DOS anclas por plan: la primera (dentro de `<TabsList>`) solo
  para `TabsTrigger`; la segunda (tras `</TabsList>` y el último `TabsContent`) para
  `TabsContent`. Comprueba con `grep -n` que ningún `TabsContent` queda dentro de `TabsList`.
- Web: vitest corre en node sin jsdom; la lógica de UI va en funciones puras con test. Cachés
  con `mergeIntoCached` y, al resincronizar formularios, no pisar ediciones sin guardar
  (decisión pura con test, patrón `shouldResyncNumber`).
- Relojes: el panel acepta el `ts` del agente con ±45 s (`MAX_CLOCK_SKEW_SECONDS` en shared);
  la frescura en la web se mide con la hora de llegada local.
- Cron: solo ASCII imprimible y espacio/tab, igual en Go y zod (fixture `cron-cases.json`).
- E2E con Docker en esta máquina: nftables descarta contenedor → host, así que todo va en
  contenedores. `bash deploy/e2e/run.sh` (proyecto `mcsm-test-e2e`, panel en 18080, puertos
  de juego 26600–26620, nodo B en `docker:dind` unido a la red de los servidores, Playwright
  en su contenedor) corre la suite de `panel/apps/e2e` y deja capturas en
  `panel/apps/e2e/screenshots/` (así se hacen las comprobaciones visuales: Claude in Chrome no
  abre `localhost:8080`). En esta máquina hay PRODUCCIÓN del usuario (`mcsm-panel-1`,
  `mcsm-agent-1`, `mcsm-agent`, red `mcsm`, volúmenes `mcsm_*`, puertos 8080 y 25565–25600):
  compara `docker ps -a`/`network ls`/`volume ls` antes y después de cualquier prueba.
- Tras cada fusión busca duplicados que git no marca: claves YAML repetidas (`docker compose
  config`), flags repetidos en snippets, `var`/`const` homónimas en un paquete Go, tests
  duplicados; y compara `pnpm gen` con lo commiteado.
- Archivos (`Files*`) que escriben responden `busy` si `rec.Held(id)`. Protocolo `fileWrites`:
  la mutación hace `enter` antes de mirar `Held`; la restauración hace `Hold` antes de
  `drained` (≤ 10 s, si no drena → busy). Toda operación nueva que escriba en `data`
  (importación, migración) usa el mismo contador y la misma comprobación.
- Copias: los temporales de subida (`files.TempGlob` = `.mcsm-tmp-` + 16 hex, `files.IsTempName`)
  quedan fuera siempre, también con un `Excluder` nil; un `.mcsm-tmp-x` del usuario es normal. Toda sección de la spec cambia vía `serversService.patch` (p. ej. la programación es
  `patch(id, {spec:{backups}})`), nunca `servers.updateSpec` directo desde otro servicio.
- Cierre del agente: esperas en paralelo con `waitAll`, total ≤ 25 s frente a
  `stop_grace_period: 30s` / `--stop-timeout 30`; una espera nueva entra en `waitAll`.
- Avisos de copias (`BackupCreated`/`BackupDeleted`/inventario) van por la `outbox` FIFO, no
  por el `send` de la sesión; lo encolado puede llegar tras el siguiente `Hello`: no
  interpretes un mensaje no solicitado con el estado de la sesión actual sin correlacionarlo.
  El panel aplica la vía negativa del inventario (borradas/perdidas) solo si
  `BackupInventory.request_id` coincide con su último `BackupList` del nodo y a filas con
  `created_at < since`; el periódico (0) o uno viejo solo aplican lo positivo. Los ids de
  envelope del panel salen de `AgentHub.allocateId` (no se repiten entre sesiones); para
  correlacionar, `conn.requestTracked`.
- Reserva y jobs: como mucho 2 copias/restauraciones por nodo (`withSlot`, antes de
  `save-off`/`Stop`); mientras esperan, el servidor sigue reservado (Power 409, Files busy).
  Sondas de Docker en operaciones peligrosas con `rec.Container` (devuelve error), nunca
  `ContainerID`.
  `reconcile.ErrBusy` es neutro («servidor ocupado o reservado»): envuélvelo con
  `reconcile.Busy(reason)`; `rec.HeldReason(id)` da el motivo de la reserva.
- Espacio: lo que escribe mucho en el nodo (copias, restauraciones, importación, migración)
  exige estimación + `max(5 %, 256 MiB)` libres y vigila durante la escritura.
- Topes encadenados: `maxPayload` 4 MiB ↔ inventario 3 MiB ↔ `readLimit` del agente 4 MiB ↔
  spec 64 KiB ↔ `FilesReadResult` 2 MiB. Si cambia uno, revisa los demás.
- Plantillas: `templateSpecSchema = {...baseFields}`; toda sección nueva viaja en plantillas
  salvo que se excluya en `specToTemplate` (`dataPath` va fuera de `baseFields`).
- Web: el contenido de cada pestaña del servidor lleva `key={s.id}`; todo formulario con
  estado sucio registra `useTabGuard` (y `useBlocker`); los diálogos con `<form>` usan
  `dialogSubmit`.
- Verificación completa: añade `buf breaking --against ".git#ref=master"` (funciona en
  worktrees) y `go vet -tags integration ./...`.
- Docker 29.7.2: tras un `start` fallido por el puerto, el siguiente arranca **sin publicar
  puertos** (aunque se pare y se vuelva a arrancar). Por eso `startOrDiscard` (arrancar,
  comprobar `Inspect.PortsMissing` y, si falla, borrar para recrear; nunca un `Adopted`) y el
  fake lo reproduce. Todo `Start` nuevo de un servidor pasa por `startOrDiscard`.
- mc-router con autoscale arranca y para contenedores por su cuenta e **ignora `Hold`**: lo que
  reserve un servidor bajo demanda (restauración, copia en frío, bloqueo) lo aparca con
  `rec.Park`. mc-router **no despierta contenedores que nunca arrancaron**: un bajo demanda
  recién creado o recreado se arranca (él lo duerme); por eso no se migra uno bajo demanda
  (Park + liberar lo arrancaría en el origen).
- Router: hash propio en `mcsm.router_hash` (no toca `mcsm.spec_hash`) e imagen fijada por
  digest (`router.ImageRef()`); subir de versión = tag + digest nuevos.
- Logs de contenedores sin TTY (importados adoptados): Docker los multiplexa; `Moby.Logs` mira
  `Config.Tty` y los separa con `stdcopy` (`demuxLogs`).
- E2E con `docker:dind`: monta su tmpfs en `/tmp` y tapa los binds de rutas bajo `/tmp`; usa
  `deploy/data` para el `DATA_ROOT` de los nodos dind.
- Tras cada fusión, también `go vet -tags integration ./...` (los tests de integración no
  compilan en `go vet` normal y ahí aparecen los duplicados).
- Copias en caliente: `CreateRequest.Running` obligatorio (mismo ID y `StartedAt` del contenedor
  al cerrar el tar y antes del `.json`); un fichero que cambia mientras se lee →
  `ErrSourceChanged`; una copia fallida (también con `save-on` fallido) nunca deja fichero ni se
  anuncia. Ventana residual conocida: un stop que empieza durante el tar con Minecraft aún
  guardando en ambas comprobaciones (para servidores bajo demanda, preferir copias en frío).
- Bucles de crash (§10): el motor del agente va envuelto (`crashloop.Engine`) y cada
  Stop/Kill/Remove, y cada parada que el proxy deja hacer a mc-router, anota en
  `crashloop.Intents` una intención que absorbe UN `die` de ese contenedor (3 min). Cuentan los
  `die` con exit ≠ 0 no pedidos y sin reserva; >3 en 1 h → `CrashLoopStop` retiene (bucket
  `crash_latch`, atado a la versión) hasta Power start/restart o versión nueva; `StartGen`
  descarta paradas en cola tras un Arrancar o una versión nueva. El panel pone el deseado en
  parado si el `ts` del `crash_loop` es posterior a `servers.desired_changed_at` (todo cambio de
  `desired_state` actualiza esa columna).
- `Event` (Envelope 24) es no solicitado (id = 0) y sale por la cola `App.events` (outbox): sin
  conexión se pierde; lo importante queda también en `Observed.error`. Kinds en `agent.proto`;
  el panel añade `token_rotated`. Envelope 24/120/121 y migraciones 080–082 ya están usados.
- mc-router nunca recibe el socket de Docker: monta de solo lectura el DIRECTORIO
  `<DATA_ROOT>/.mcsm-router/` y habla con el socket filtrado del agente (`dockerproxy`: solo
  contenedores con `mc-router.host`, sin cuerpos, API ≥ 1.24, start/stop por `routerPolicy`) y
  se reconecta solo si el agente se reinicia. Tocar binds/cmd del router cambia
  `mcsm.router_hash` (se recrea una vez al actualizar).
- Panel: escrituras bajo `/api/` con `Origin` ajeno → 403 (sin `Origin` pasan: agente, curl).
  URL pública y rango de puertos salen de `app.settings` (`SettingsService`), nunca de
  `config.publicUrl`/`config.gamePortRange`. Cambiar la contraseña borra todas las sesiones,
  da cookie nueva y cierra sus WS con 4401 (la web usa `expectSessionChange` y
  `holdUnauthorized` durante la mutación). Rotación de token: hash pendiente guardado antes de
  enviar `RotateToken`, promovido en la primera conexión con él.
- Hora del agente: las filas (jobs, eventos) se crean con la hora del PANEL; la del agente solo
  en `started_at`/`finished_at`/`agentAt`, saneada con `lib/time.ts`.
- save-on pendiente: reintento en segundo plano con `rec.TryHold` (nunca espera al lock), RCON
  ≤ 5 s y backoff 30 s → 5 min.
