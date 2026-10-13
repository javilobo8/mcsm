# MC Server Manager — Diseño

Fecha: 2026-10-12
Estado: borrador aprobado conversacionalmente, pendiente de revisión escrita

## 1. Objetivo

Aplicación self-hosted, de un solo usuario (administrador), para gestionar desde una web
interna todos los servidores de Minecraft Java que corren con la imagen
`itzg/minecraft-server` en varias máquinas de la LAN doméstica.

Debe permitir, sin tocar nunca la línea de comandos:

- Crear, editar, arrancar, parar, reiniciar y borrar servidores en cualquier nodo.
- Configurar absolutamente todo lo que la imagen itzg permite (tipo, versión, mods,
  modpacks, memoria, propiedades, whitelist, ops, puertos, etc.).
- Ver estado, jugadores conectados, uso de CPU/RAM y gráficas de los últimos 7 días.
- Ver logs en vivo y enviar comandos de consola.
- Navegar y editar los archivos del servidor.
- Hacer, programar, restaurar y descargar backups.
- Guardar plantillas, clonar servidores, migrar servidores entre nodos.
- Dar de alta nuevos nodos con un token, importar servidores itzg ya existentes.
- Desplegar opcionalmente `mc-router` para entrar por hostname.

Fuera de alcance (YAGNI): multiusuario y permisos, acceso desde Internet, Bedrock,
Kubernetes/Swarm, Prometheus/Grafana, backups a la nube. El diseño no los impide, pero
no se construyen.

## 2. Decisiones ya tomadas

| Tema | Decisión |
|---|---|
| Topología | Panel y nodos en la misma LAN. Sin TLS público. El agente inicia la conexión. |
| Stack | Agente en Go. Panel (API + web) en TypeScript sobre Node 26 y pnpm. |
| Modelo del agente | Reconciliador: el panel envía specs deseadas, el agente reconcilia Docker y reporta estado real. |
| Instalación del agente | Contenedor Docker con `/var/run/docker.sock` montado. |
| Base de datos del panel | SQLite (un fichero) vía el módulo nativo `node:sqlite` de Node 26, SQL a mano y migraciones SQL numeradas. Sin ORM ni dependencias nativas. |
| Store local del agente | bbolt (fichero único) en un volumen del contenedor del agente. |
| Protocolo | Protobuf definido con `buf`, binario sobre un WebSocket por agente. HTTP saliente del agente para transferencias grandes. |
| Backups | Nativos en el agente (RCON save-off/save-all, tar.zst, save-on). Destino: disco local del nodo. |
| Migración | Backup en origen → transferencia vía panel → restauración en destino → verificación → borrado en origen. |
| Servidores existentes | Importación asistida: el agente detecta contenedores itzg no gestionados y el panel propone una spec. |
| Red de jugadores | Un puerto por servidor; `mc-router` opcional desplegable por nodo. |
| Métricas | En vivo + histórico 7 días en SQLite. Sin Prometheus. |
| Archivos | Gestor completo confinado al directorio de datos de cada servidor. |
| Autenticación web | Una contraseña de administrador, sesión por cookie. |

## 3. Arquitectura

```
┌─────────────────────────── Máquina principal ───────────────────────────┐
│  panel (contenedor)                                                      │
│   ├─ API HTTP (Fastify)        ← navegador (REST + WS)                   │
│   ├─ WS /agent  (protobuf)     ← agentes (conexión saliente de cada nodo)│
│   ├─ HTTP /agent/transfer      ← agentes (subida/bajada en streaming)    │
│   ├─ SQLite  (/data/panel.db)                                            │
│   └─ Web estática (React)                                                │
│  agent (contenedor)  ── docker.sock ── contenedores itzg del nodo        │
└──────────────────────────────────────────────────────────────────────────┘
┌──────── Nodo B ────────┐   ┌──────── Nodo C ────────┐
│ agent ── docker.sock   │   │ agent ── docker.sock   │
│   └─ itzg x N          │   │   └─ itzg x N          │
└────────────────────────┘   └────────────────────────┘
```

- El panel es la **única fuente de verdad** de la configuración. El agente guarda una
  copia de las specs de su nodo solo para poder trabajar sin panel (reconciliar, hacer
  backups programados, reiniciar). Esa copia se sobreescribe siempre con lo que diga el
  panel al reconectar.
- Cada nodo tiene un **agente** y solo uno. El agente gestiona únicamente los
  contenedores que llevan sus etiquetas (`mcsm.managed=true`, `mcsm.server_id=<uuid>`).
- El agente **nunca escucha** en la red. Todo tráfico es saliente hacia el panel.
- La máquina principal corre también un agente para poder gestionar sus propios
  servidores con el mismo mecanismo que el resto.

### 3.1 Estructura del repositorio (monorepo)

```
mc-server-manager/
├─ agent/                    Go module `mcsm/agent`
│  ├─ cmd/agent/             main
│  ├─ internal/
│  │  ├─ conn/               WebSocket cliente, reconexión, multiplexado de streams
│  │  ├─ store/              bbolt: credenciales, specs, estado de backups
│  │  ├─ docker/             wrapper del SDK Docker (interfaz + impl + fake)
│  │  ├─ reconcile/          bucle de reconciliación spec↔contenedor
│  │  ├─ mc/                 ping de estado (SLP) y cliente RCON
│  │  ├─ logs/               seguimiento de logs y fan-out a suscriptores
│  │  ├─ stats/              muestreo de stats de contenedor y host
│  │  ├─ files/              operaciones de archivos confinadas
│  │  ├─ backup/             crear, listar, restaurar, programar, podar
│  │  ├─ importer/           detección de contenedores itzg no gestionados
│  │  └─ jobs/               ejecución de jobs largos con progreso
│  └─ Dockerfile
├─ panel/
│  ├─ apps/api/              Fastify + Drizzle + WS; sirve la web en producción
│  ├─ apps/web/              React + Vite + Tailwind + shadcn/ui + TanStack Query/Router
│  └─ packages/proto-ts/     tipos TS generados por buf
├─ proto/                    ficheros .proto (fuente única del protocolo)
├─ buf.yaml, buf.gen.yaml
├─ deploy/
│  └─ docker-compose.yml     panel + agente local
├─ docs/superpowers/specs/
└─ README.md
```

## 4. Modelo de datos (panel, SQLite)

Todas las tablas usan `id` UUIDv7 como texto, `created_at`/`updated_at` en ISO 8601.

**nodes**
- `name`, `token_hash` (SHA-256 del token permanente), `data_root` (ej. `/srv/minecraft`,
  ruta en el host del nodo), `agent_version`, `docker_version`, `last_seen_at`,
  `status` (`online|offline|degraded`), `host_info` JSON (CPUs, RAM total, disco total
  del `data_root`), `settings` JSON (rango de puertos permitido, intervalo de stats).

**enrollment_tokens**
- `token_hash`, `node_name_hint`, `expires_at` (15 min), `used_at`. Un solo uso.

**servers**
- `node_id`, `name`, `slug` (único por nodo, usado en la ruta de datos y nombre de
  contenedor `mcsm-<slug>`), `spec` JSON (ver 4.1), `spec_version` (entero, +1 por
  cambio), `desired_state` (`running|stopped`), `observed` JSON (último estado reportado:
  container_id, state, health, uptime, versión MC detectada, jugadores, error de
  reconciliación si lo hay), `observed_spec_version` (qué versión ha aplicado ya el agente),
  `imported_from` JSON nullable (nombre y id del contenedor original).

**templates**
- `name`, `description`, `spec` JSON (misma forma que servers.spec pero sin puertos ni
  rcon_password; los rellena el panel al instanciar), `source_server_id` nullable.

**backups**
- `server_id`, `node_id`, `filename`, `size_bytes`, `sha256`, `spec_version`,
  `trigger` (`manual|scheduled|pre_migration|pre_restore`), `status`
  (`running|ok|failed|deleted`), `started_at`, `finished_at`, `error`.

**jobs**
- `type` (`create_server|apply_spec|backup|restore|migrate|import|...`; el router no es un
  job: ver `router_deployments`),
  `server_id` nullable, `node_id`, `status` (`queued|running|ok|failed|cancelled`),
  `progress` (0-100), `message`, `log` (texto acumulado), `payload` JSON,
  `started_at`, `finished_at`.

**metric_samples**
- `scope` (`server|node`), `scope_id`, `ts` (epoch segundos, redondeado a 10 s),
  `cpu_pct`, `mem_bytes`, `mem_limit_bytes`, `net_rx_bytes`, `net_tx_bytes`,
  `disk_bytes` (solo nodo), `players_online`, `players_max`, `tps` nullable
  (si el servidor lo expone por RCON en Paper/Purpur), `ping_ms`.
- Índice `(scope, scope_id, ts)`. Retención: 7 días a 10 s. No se agrega en la BD;
  la API agrega al vuelo por minuto/5 min según el rango pedido. Con ~10 servidores
  esto son unos 600k filas, asumible en SQLite.

**settings** (clave/valor): hash de la contraseña de admin, secreto de sesión, URL del
panel que se incrusta en el comando de alta, API key de CurseForge opcional (global, se
inyecta como `CF_API_KEY` en los servidores que lo pidan), preferencias de UI.

**router_deployments** (mc-router por nodo; implementado en el Plan 8)
- `node_id` (clave, borrado en cascada con el nodo), `spec` JSON
  `{enabled, port (25565), autoscale, autoscaleDownAfterMinutes (1-1440, 10), autoscaleAllowPlayers: [nombre|UUID] (≤ 1000)}`,
  `observed` JSON (último `RouterObserved`: configurado, estado, contenedor, imagen, puerto,
  autoscale, error y la spec que tiene el agente), `observed_at`, `updated_at`.
- Sin «default backend» ni mapeos adicionales: cada servidor entra por **un** hostname de su
  spec (4.1). Sin fila = router sin configurar (desactivado).
- El autoscale es **por nodo**, no por servidor: con él, mc-router arranca al entrar un jugador
  y para tras los minutos sin jugadores **todos** los servidores del nodo con hostname activo
  («bajo demanda»). `autoscaleAllowPlayers` limita quién los despierta
  (`-auto-scale-allow-deny`); vacía = cualquiera que llegue al puerto.

### 4.1 Forma de `spec` de servidor

```jsonc
{
  "image": "itzg/minecraft-server",
  "imageTag": "java21",                 // java8 | java17 | java21 | java25 | latest
  "type": "PAPER",                      // VANILLA, PAPER, PURPUR, SPIGOT, FABRIC, FORGE, NEOFORGE, QUILT, ... o AUTO_CURSEFORGE/MODRINTH vía modpack
  "version": "1.21.4",                  // o LATEST / SNAPSHOT
  "memory": "4G",
  "modpack": {                          // opcional
    "platform": "MODRINTH" | "AUTO_CURSEFORGE" | "FTBA",
    "slugOrUrl": "...", "versionId": "...", "loader": "fabric"
  },
  "mods": { "modrinthProjects": ["lithium", "ferritecore:beta"], "curseforgeFiles": [], "urls": [] },
  "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [] },
  "properties": { "motd": "...", "difficulty": "normal", "max-players": 10, ... },  // → server.properties vía env itzg
  "whitelist": { "enabled": true, "players": ["Lobo"] },
  "ops": ["Lobo"],
  "env": { "USE_AIKAR_FLAGS": "true", "ENABLE_AUTOPAUSE": "false" },  // extra libre, gana sobre lo generado
  "ports": { "game": 25565, "extra": [ { "host": 19132, "container": 19132, "proto": "udp", "label": "Geyser" } ] },
  "resources": { "cpus": 2.0, "memLimit": "5G" },   // límites Docker; memLimit >= memory + 1G por defecto
  "restartPolicy": "unless-stopped",
  "rconPassword": "<generado por el panel>",        // RCON nunca se publica en el host
  "backups": { "enabled": true, "cron": "0 4 * * *", "keepDays": 7, "keepCount": 10, "excludes": ["*.jar","cache","logs","*.tmp"], "onlyIfPlayersSince": true },
  "router": { "enabled": true, "hostname": "survival.lan" }   // opcional; un hostname por servidor (RFC 1123, minúsculas)
}
```

El **agente** transforma la spec en una `ContainerConfig` + `HostConfig` determinista:
nombre `mcsm-<slug>`, etiquetas `mcsm.*`, bind `<data_root>/<slug>/data:/data`, env
generado (TYPE, VERSION, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,
propiedades mapeadas a sus variables itzg), puertos, límites, política de reinicio, y
etiquetas `mc-router.host=<hostname>` y `mc-router.network=<red del agente>` solo si
`router.enabled` (sin sección, o desactivada, el contenedor y su hash no cambian). La función
es pura y se prueba con tablas de casos. Un hash de ese resultado se guarda en la etiqueta
`mcsm.spec_hash` para detectar drift sin comparar campo a campo.

`router` (Plan 8): el hostname es único por nodo entre los servidores con el router activo
(contando las migraciones abiertas hacia ese nodo) y el panel lo valida con la misma regex que
el agente (fixture `router-hostname-cases.json`). Cada servidor conserva su puerto propio. Las
plantillas no llevan `router` y la importación tampoco lo adopta: se activa después en
Configuración → Red (un adoptado no tiene etiquetas hasta que se recrea).

## 5. Protocolo panel ↔ agente

### 5.1 Transporte

- Un WebSocket por agente: `GET /agent/ws` con cabecera `Authorization: Bearer <node token>`.
  Mensajes binarios protobuf. Ping/pong cada 15 s; se considera caído a los 45 s.
- Reconexión del agente con backoff exponencial 1 s → 30 s con jitter.
- Transferencias grandes por HTTP saliente del agente con el mismo token:
  - `PUT /agent/transfer/{transferId}` cuerpo en streaming (subida de backup o archivo al panel).
  - `GET /agent/transfer/{transferId}` descarga en streaming.
  - El panel usa un directorio de *staging* para transferencias; los archivos que suben
    los usuarios desde el navegador van navegador → panel → agente (streaming, sin
    guardar en disco cuando es posible).

### 5.2 Envelope

```proto
message Envelope {
  uint64 id = 1;            // id de petición; las respuestas lo repiten
  uint64 stream_id = 2;     // 0 si no es un stream
  oneof body { ...mensajes... }
}
```

Tipos de intercambio:
- **Request/Response**: `id` nuevo, una respuesta con el mismo `id`, o `Error{code, message}`.
- **Stream**: quien abre indica `stream_id`; los frames llevan ese `stream_id`;
  `StreamClose{stream_id, reason}` cierra en cualquier dirección. Control de flujo
  simple: el agente descarta frames de logs si el buffer de salida supera 1 MiB y
  envía `StreamDropped{count}`.

### 5.3 Mensajes principales

Agente → panel:
- `Hello{agent_version, docker_version, host_info, spec_versions: map<server_id, version>}` al conectar.
- `Enroll{enrollment_token, name_hint}` → `EnrollResult{node_token, node_id}` (solo la primera vez, por HTTP `POST /agent/enroll`, no por WS).
- `ServerObserved{server_id, observed}` cada vez que cambia el estado real (eventos Docker) y, como mínimo, cada 30 s.
- `MetricSample{...}` cada 10 s por servidor y por nodo (en un solo mensaje agrupado).
- `JobProgress{job_id, progress, message, log_chunk, status}`.
- `BackupCreated{...}`, `BackupDeleted{...}` para backups programados sin intervención del panel.
- `Event{level, server_id?, kind, message, ts}` para incidencias (`crash`, `oom`, `crash_loop`, `crash_loop_failed`,
  `drift`, `save_on_pending`, `save_on_resumed`). No hay suscripción: el agente los envía no solicitados (id = 0) por
  su propia cola; sin conexión se pierden (lo importante queda también en `observed.error`).

Panel → agente:
- `SyncSpecs{servers: [ServerSpec{server_id, slug, version, desired_state, spec}], removed_ids}` tras `Hello`, con solo lo que difiere, y después `ApplySpec{...}` por cada cambio.
- `PowerAction{server_id, action: start|stop|restart|kill}`.
- `SendCommand{server_id, command}` → `CommandResult{output}` (RCON).
- `SubscribeLogs{server_id, tail}` → stream `LogLine{ts, line}`.
- `Files*`: `List`, `Stat`, `Read{path, max_bytes}`, `Write{path, content}`, `Mkdir`,
  `Rename`, `Delete`, `Download{path} → transfer_id`, `Upload{path, transfer_id}`.
- `BackupNow{server_id, job_id}`, `BackupList{server_id}`, `BackupRestore{server_id, backup_id, job_id}`,
  `BackupDelete`, `BackupPush{backup_id, transfer_id}` (sube al panel), `BackupPull{transfer_id, server_id}` (descarga desde el panel al nodo).
- `ImportScan{}` → `ImportCandidates{[container_id, name, env, ports, mounts, image]}`;
  `ImportAdopt{container_id, server_id, slug}`.
- `RouterApply{spec}` / `RouterRemove{}` (el agente responde con `RouterObserved`, no solicitado,
  tras cada reconciliación del router).
- `PullImage{ref, job_id}`.

### 5.4 Idempotencia y versiones

- Toda operación mutante lleva un `job_id` o un `spec_version`. El agente guarda en
  bbolt el último `spec_version` aplicado por servidor y el estado de cada `job_id`
  conocido; si recibe un duplicado, responde con el resultado guardado.
- El panel nunca asume éxito: la UI muestra `spec_version` deseada vs `observed_spec_version`
  y marca "aplicando…" mientras difieran.

## 6. El agente en detalle

### 6.1 Arranque

1. Lee config de env: `PANEL_URL`, `ENROLL_TOKEN` (solo la primera vez), `DATA_ROOT`
   (ruta host, p. ej. `/srv/minecraft`), `AGENT_DATA=/var/lib/mcsm-agent`.
2. Si no hay token en bbolt, hace `POST /agent/enroll`; guarda `node_token` y `node_id`.
3. Abre el WS, envía `Hello` con las versiones de spec que tiene.
4. Arranca en paralelo: reconciliador, observador de eventos Docker, muestreador de
   stats, planificador de backups, gestor de logs.

Montajes del contenedor del agente: `/var/run/docker.sock`, `<DATA_ROOT>:<DATA_ROOT>`
(misma ruta dentro y fuera para que los binds que crea coincidan con lo que ve), un
volumen para `AGENT_DATA`, y `/proc:/host/proc:ro` con `HOST_PROC=/host/proc` para
métricas de host con gopsutil.

### 6.2 Reconciliación

Bucle disparado por: cambio de spec, evento Docker relevante (`die`, `start`, `destroy`,
`health_status`), y un tick cada 30 s. Para cada servidor:

1. Buscar contenedor por etiqueta `mcsm.server_id`.
2. No existe y `desired_state=running|stopped` → crear directorio de datos (si no
   existe), `docker pull` si falta la imagen, crear contenedor; arrancar si `running`.
3. Existe con `spec_hash` distinto → parada limpia (`stop` con timeout 60 s, la imagen
   itzg hace `save-all`/`stop` por RCON al recibir SIGTERM), `rm`, recrear, arrancar
   si procedía. Los datos no se tocan (están en el bind).
4. Existe, hash igual, pero estado ≠ deseado → `start`/`stop`.
5. Reportar `ServerObserved`. Si una acción falla (puerto ocupado, imagen inexistente,
   sin espacio), guardar el error en `observed.error` y reintentar con backoff
   (máx. cada 5 min) hasta que la spec cambie.
   Docker 29.7.2: tras un `start` fallido por el puerto, el siguiente arranca **sin publicar
   puertos**. Por eso un arranque que falla, o que deja el contenedor sin sus puertos, lo borra
   (`startOrDiscard`; los datos están en el bind) y la siguiente pasada lo recrea (`Power` lo
   recrea al momento); nunca el contenedor original de un importado (solo se informa). Uno en
   marcha sin sus puertos (lo arrancó otro: la política de reinicio, mc-router) se informa en
   `observed.error` y «Reiniciar» lo recrea.

Los contenedores con etiquetas `mcsm.*` que no estén en ninguna spec se **paran y
borran** solo si el panel los incluyó en `removed_ids`; nunca por iniciativa propia del
agente, para que un store corrupto no destruya nada.

### 6.3 Logs y consola

- Un `docker logs --follow --tail N` por servidor abierto bajo demanda al primer
  suscriptor y cerrado 30 s después del último. Fan-out en memoria a los `stream_id`
  suscritos; buffer circular de las últimas 500 líneas para servir el `tail` al instante.
- Comandos por RCON nativo (cliente Go pequeño, protocolo Source RCON) contra la IP
  interna del contenedor en la red de Docker y `RCON_PORT` 25575; no se publica en el host.

### 6.4 Métricas

Cada 10 s: `docker stats` one-shot por contenedor gestionado (CPU %, memoria, red) y un
Server List Ping al puerto de juego dentro de la red Docker (online/max/versión/latencia).
En Paper/Purpur, `tps` vía RCON cada 30 s. Host: CPU, RAM, uso del disco donde vive
`DATA_ROOT`. Se agrupa en un `MetricSample` por envío.

### 6.5 Backups

- Formato: `<slug>-<ISO ts>-<spec_version>.tar.zst` en `<DATA_ROOT>/<slug>/backups/`.
- Procedimiento: si el servidor está en marcha, RCON `save-off`, `save-all flush`,
  esperar 3 s; tar con exclusiones; `save-on` (en `defer`, también si falla); sha256;
  escribir fichero `.json` de metadatos junto al tar. Si el servidor está parado, tar directo.
- Programación con la expresión cron de la spec, en el propio agente (librería `robfig/cron`).
  `onlyIfPlayersSince`: se omite si nadie se ha conectado desde el último backup.
- Poda tras cada backup según `keepDays` y `keepCount`.
- Restauración: parar servidor, renombrar `data` a `data.pre-restore-<ts>` (se conserva
  como seguridad y se registra como backup `pre_restore`), extraer, arrancar. Nunca se
  borra el directorio previo automáticamente; la UI ofrece borrarlo después.

### 6.6 Archivos

Raíz confinada: `<DATA_ROOT>/<slug>/data`. Toda ruta se resuelve con `filepath.Clean`
y se exige que el resultado tenga la raíz como prefijo tras resolver symlinks
(`filepath.EvalSymlinks`). Límite de 2 MiB para lectura/escritura inline; más grande,
por transferencia. Las escrituras son atómicas (fichero temporal + rename).

### 6.7 Importación

`ImportScan` lista contenedores cuya imagen empiece por `itzg/minecraft-server` y sin
etiqueta `mcsm.managed`. Para cada uno devuelve inspect reducido. El panel genera una
spec candidata: env → campos conocidos, resto a `env`; puerto `25565/tcp` → `ports.game`;
bind de `/data` → se propone `slug` y, si el bind no está bajo `DATA_ROOT`, la spec
guarda `dataPath` explícito (campo opcional que anula la ruta por defecto). Al adoptar,
el agente añade las etiquetas renombrando el contenedor a `mcsm-<slug>` solo cuando
el usuario pida el primer cambio de spec; mientras tanto se gestiona por `imported_from.container_id`.

## 7. El panel en detalle

- **Fastify 5** con `@fastify/websocket`, `@fastify/cookie` (cookie de sesión firmada que apunta a una fila de `sessions`),
  `@fastify/static` para la web compilada. Validación de entrada con **zod**; los tipos de
  spec se comparten con la web desde `packages/proto-ts` y un paquete `packages/shared`
  con los esquemas zod de spec y la función que valida combinaciones (p. ej. `modpack`
  solo con `type` compatible).
- **Servicios**: `NodeRegistry` (conexiones WS activas; sin cola de mensajes para nodos
  desconectados: la enmienda del 2026-10-12 la sustituye por `SyncSpecs` al reconectar, que
  entrega versión y estado deseado de cada servidor), `SpecService` (versionado, diff, asignación de puertos
  libres por nodo dentro del rango configurado), `JobService`, `BackupService`,
  `MigrationService`, `MetricsService` (ingesta por lotes, purga cada hora, agregación
  en consulta), `ImportService`, `RouterService`, `TemplateService`.
- **API REST** `/api/*` para CRUD y acciones; **WS** `/ws` para el navegador con
  suscripciones (`server:<id>:logs`, `server:<id>:observed`, `node:<id>:metrics`, `jobs`).
- **Migración** (`MigrationService`): job con pasos visibles: (1) parar en origen si
  el usuario lo pide o si está en marcha, (2) backup `pre_migration`, (3) `BackupPush`
  origen→panel y `BackupPull` panel→destino en paralelo (streaming, sin tocar disco del
  panel salvo buffer), (4) crear spec en destino con puerto libre, (5) `BackupRestore`,
  (6) arrancar y esperar `health=healthy` o 5 min, (7) `removed_ids` en origen y borrado
  del directorio de datos de origen **solo** si el usuario marcó "borrar origen"; por
  defecto se conserva renombrado `data.migrated-<ts>`.
  Con el router (Plan 8): el puerto del router del destino no se propone; el hostname tiene que
  estar libre en el destino (al planificar y otra vez, sin `await`, justo antes del commit, igual
  que el puerto del router); un servidor con hostname **no se migra** (409) si el router del
  origen tiene autoscale, porque mc-router lo arrancaría en el origen entre la parada y la
  retirada (el agente también rechaza esa copia `pre_migration`); y tras migrar el DNS del
  hostname tiene que apuntar al destino (la pestaña Migrar lo avisa).
- **Router** (`RouterService`, Plan 8): la fila de `router_deployments` es la verdad. Cada
  cambio se envía al momento (`RouterApply` si está activo, `RouterRemove` si no), en cadena por
  nodo, y tras cada handshake se reenvía; un `RouterObserved` con router que el panel no quiere
  provoca un `RouterRemove`. No hay job `deploy_router`. Activar en un agente sin soporte
  (`unsupported`) no se guarda (409). El puerto del router no se reparte ni se puede publicar
  en el nodo, y no se activa en uno ocupado por un servidor o reservado por una migración hacia
  el nodo, ni con autoscale mientras salga de él una migración de un servidor con hostname. Un
  nodo con el router activo (o retirándose, conectado) no se borra.
  - En el agente, un contenedor `mcsm-router` de `itzg/mc-router` **fijado por digest**
    (`1.47.1@sha256:…`) con `-in-docker`, en la red de los servidores. Desde el Plan 9 no recibe
    el socket de Docker: monta, de solo lectura, el directorio del socket filtrado del agente
    (`<DATA_ROOT>/.mcsm-router/docker.sock`, `-docker-socket`), un proxy de lista blanca que solo
    deja ping, versión, info, listar e inspeccionar (sin `Config.Env`) los contenedores con
    `mc-router.host`, seguir sus eventos y arrancar o parar servidores de este agente con hostname
    que no estén reservados (ni, para arrancar, retenidos por bucle de crash); nada con cuerpo ni
    con API < 1.24. Montar el directorio (no el fichero) deja que mc-router se reconecte solo al
    socket nuevo de cada arranque del agente; si el proxy no puede escuchar, el agente lo reintenta
    (1–30 s) y el error se ve en el estado del router. Endurecido: usuario 65532 (dueño del socket,
    0600), `CapDrop ALL`, `no-new-privileges`, raíz de solo lectura, 256 MiB y 256 procesos,
    `-connection-rate-limit 10`, logs `json-file` con rotación. Hash propio en
    `mcsm.router_hash` (independiente de `mcsm.spec_hash`): un cambio lo recrea (no tiene
    estado). Se reconcilia al arrancar, cada 30 s y con sus eventos; un arranque fallido o en
    marcha sin publicar su puerto (Docker 29.7.2) lo borra y lo recrea.
  - Bajo demanda (autoscale): el reconciliador crea y recrea el contenedor pero no impone el
    estado deseado (lo hace mc-router; `Power` sí manda), salvo que un contenedor que nunca
    arrancó se arranca, porque mc-router no lo vería; él lo duerme tras los minutos sin
    jugadores. La reserva (`Hold`) solo frena al agente: mientras una restauración, una copia
    en frío o un bloqueo sin `data` reservan un servidor bajo demanda, el agente lo **aparca**
    (`Park`: lo para y borra el contenedor; los datos están en el bind) y al liberar la reserva
    lo recrea.

## 8. Interfaz web

Páginas:
- **Dashboard**: tarjetas de nodos (online, CPU/RAM/disco) y tabla de servidores
  (estado, jugadores, versión, nodo, puerto, acciones rápidas).
- **Servidor**: pestañas *Resumen* (estado, jugadores, gráficas 1h/24h/7d, acciones),
  *Consola* (logs en vivo + entrada de comandos, filtro), *Configuración* (formulario por
  secciones que edita la spec: General, Versión y mods, Propiedades, Jugadores, Red,
  Recursos, Backups, Avanzado/env libre; botón "Aplicar" muestra el diff y recrea),
  *Archivos*, *Backups*, *Historial* (jobs y eventos).
- **Nuevo servidor**: asistente en 3 pasos (plantilla o desde cero → nodo y nombre → revisar).
- **Plantillas**: lista, crear, editar, duplicar, "crear servidor desde plantilla".
- **Nodos**: lista, alta (muestra `docker run` con token), detalle con métricas,
  servidores, mc-router (activar, puerto, autoscale con sus minutos y la lista de jugadores que
  despiertan servidores; estado en vivo), importación de contenedores. El hostname de cada
  servidor va en Configuración → Red.
- **Jobs**: lista global con progreso y log.
- **Ajustes**: contraseña, URL del panel, API key de CurseForge, rango de puertos por defecto.

Estilo: shadcn/ui, modo oscuro por defecto, denso pero legible; es una herramienta de
administración, no una landing.

## 9. Seguridad (ámbito LAN, un usuario)

- Login con contraseña (hash `scrypt` de `node:crypto`, sin dependencias nativas), cookie `HttpOnly`, `SameSite=Strict`. Rate-limit en login.
- Tokens de nodo: 32 bytes aleatorios, hash SHA-256 en BD (entropía alta, no necesita KDF lento), comparación en tiempo constante.
  Rotación desde la UI (el panel envía `RotateToken`, el agente guarda el nuevo y reconecta).
- Tokens de alta: un solo uso, 15 min.
- El agente valida que el `server_id` de cualquier operación de archivos/backup pertenece
  a su nodo. Rutas confinadas (6.6). Nombres de slug restringidos a `[a-z0-9-]{1,40}`.
- `rconPassword` no se muestra en la UI por defecto (botón revelar) y no viaja al navegador en listados.
- El socket de Docker da root efectivo en el nodo (lo tiene el agente); se documenta claramente en el README.
  mc-router no lo recibe: usa el socket filtrado del agente (§7).

## 10. Manejo de errores

- **Nodo desconectado**: la UI lo marca; los cambios de spec se guardan con versión
  nueva y se entregan en el `SyncSpecs` al reconectar. Acciones inmediatas (power,
  consola, archivos) fallan con mensaje claro en vez de encolarse.
- **Fallo al aplicar spec**: `observed.error` visible en la tarjeta del servidor con el
  texto de Docker (puerto ocupado, imagen inválida, memoria). El agente reintenta con backoff.
- **Crash del servidor MC**: evento `die` con exit code ≠ 0 que nadie pidió → `Event` `crash` y, si
  `restartPolicy` lo permite, Docker lo reinicia. Cada parada pedida (Stop/Kill/Remove del agente o
  parada que el proxy deja hacer a mc-router) explica un solo `die` de ese contenedor en los 3 min
  siguientes; no cuentan los de un servidor reservado ni los de contenedores sin la spec del agente.
  Con más de 3 en una hora el agente lo para y lo **retiene** (guardado en su store): ni el
  reconciliador, ni Docker, ni mc-router lo arrancan hasta un **Arrancar** manual o una versión
  nueva de la spec; emite `Event` `crash_loop` y el panel pone su estado deseado en parado. Un OOM
  emite `Event` `oom`.
- **Backup fallido**: `save-on` garantizado en `defer`; job marcado `failed` con causa;
  el fichero parcial se borra.
- **Migración fallida**: cualquier paso fallido deja el origen intacto y arrancado como
  estaba; se limpia lo creado en destino; el job lo explica paso a paso.
- **Panel reiniciado a mitad de job**: los jobs `running` pasan a `failed` con
  "interrumpido" al arrancar, salvo backups, que el agente reporta al reconectar.

## 11. Pruebas

- **Agente (Go)**: unitarias para `spec → ContainerConfig` (tablas), confinamiento de
  rutas, cliente RCON (contra un servidor RCON falso), ping SLP (contra respuesta
  grabada), reconciliador (con `docker.Fake` que simula estados), planificador de
  backups y poda (con reloj inyectable). Integración (`go test -tags integration`)
  contra el Docker real: crear un servidor itzg `VANILLA` pequeño, esperar healthy,
  comando RCON, backup, restaurar, borrar.
- **Panel (TS)**: Vitest para servicios (asignación de puertos, versionado, diff de
  spec, migración con agentes simulados sobre el mismo protocolo), rutas HTTP con
  `fastify.inject`, y un *agente falso en TS* que implementa el protocolo para probar
  reconexión y `SyncSpecs`.
- **Web**: Playwright sobre `docker-compose` de pruebas con panel + agente real + un
  servidor itzg: login, crear servidor, ver logs, enviar comando, backup, restaurar.
- **Protocolo**: `buf lint` y `buf breaking` en CI.

## 12. Despliegue

`deploy/docker-compose.yml`:

```yaml
services:
  panel:
    image: mcsm-panel:latest   # construida desde panel/ con `docker compose build`
    ports: ["8080:8080"]
    volumes: ["panel-data:/data"]
    environment: { PANEL_PUBLIC_URL: "http://192.168.1.10:8080" }
  agent:
    image: mcsm-agent:latest   # construida desde agent/
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/minecraft:/srv/minecraft
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    environment:
      PANEL_URL: http://panel:8080
      ENROLL_TOKEN: "<pegar de la UI>"
      DATA_ROOT: /srv/minecraft
      HOST_PROC: /host/proc
```

En nodos adicionales solo el servicio `agent`, con `PANEL_URL` apuntando a la IP del panel.
La UI genera el bloque exacto con el token al dar de alta un nodo.

## 13. Orden de construcción propuesto

1. Protocolo (`proto/`) + esqueleto de agente y panel + alta de nodo + `Hello`.
2. Spec → contenedor, reconciliador, power actions, estado observado. Primera UI: nodos y servidores.
3. Logs y consola RCON.
4. Métricas en vivo e histórico.
5. Formulario completo de configuración de spec (todas las secciones) y plantillas.
6. Backups (manual, programado, restaurar, descargar).
7. Archivos.
8. Importación de contenedores existentes.
9. Migración entre nodos.
10. mc-router.
11. Compose de despliegue, imágenes, README.

Cada paso deja el sistema usable y probado antes del siguiente.

## 14. Notas de implementación verificadas (2026-10-12)

- Cliente Docker en Go: módulos `github.com/moby/moby/client` v0.6.x y `github.com/moby/moby/api` v1.56.x
  (el antiguo `github.com/docker/docker` está obsoleto desde Docker 29). Las llamadas toman
  structs de opciones: `ContainerCreate(ctx, ContainerCreateOptions{...})`, `ContainerList(ctx, ContainerListOptions{All: true, Filters: ...})`.
- Los contenedores de servidor se crean con `Tty: true` y `OpenStdin: true` (como en los ejemplos
  oficiales de itzg). Así `ContainerLogs` devuelve texto plano sin cabeceras de multiplexado.
- Los contenedores de servidor se conectan a una red Docker de usuario llamada `mcsm` a la que
  también pertenece el agente; el agente alcanza RCON y el ping de estado por nombre DNS
  `mcsm-<slug>` en el puerto interno 25565/25575. El puerto de juego interno es siempre 25565;
  `ports.game` es el puerto del host.
- Las `properties` de la spec se pasan a la imagen con `CUSTOM_SERVER_PROPERTIES` (pares
  `clave=valor` separados por salto de línea), que admite cualquier clave de `server.properties`.
- Ping de estado: `github.com/mcstatus-io/mcutil/v4` (`status.Modern` con `ReceiveLimitBytes` y `Ping: true`).
  RCON: cliente Source RCON propio en `agent/internal/mc` (enmienda 2026-10-12: `mcutil/rcon` v4.3.1
  tiene una carrera de datos entre `Login` y `Close`, escribe por stdout e ignora `context`).
- WebSocket en Go: `github.com/coder/websocket`. Store del agente: `go.etcd.io/bbolt`.
- Protobuf: `buf` 1.73 con plugins remotos `buf.build/protocolbuffers/go` y `buf.build/bufbuild/es` (v2, `@bufbuild/protobuf` 2.16).
- Toolchain fijada en `mise.toml`: Go 1.27.2, buf 1.73.0; Node 26 y pnpm 12 ya instalados globalmente.
