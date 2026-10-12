# Planes de implementación — hoja de ruta

La spec (`docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`) se construye en planes
secuenciales. Cada plan deja el sistema usable y probado. Los planes 2 en adelante se detallan
(con la misma granularidad que el Plan 1) cuando el anterior está integrado, porque sus tareas
dependen de la forma final del código que exista entonces; aquí se fija su alcance, su orden y
sus criterios de aceptación para que no haya que volver a diseñar.

| # | Plan | Spec | Estado |
|---|------|------|--------|
| 1 | [Fundamentos](2026-10-12-01-fundamentos.md): protocolo, agente reconciliador, panel con nodos/servidores, logs y consola, UI básica, despliegue | §3, §4, §5, §6.1–6.3, §7, §8, §9, §10, §12 | hecho (rama `feat/plan-1`) |
| 2 | [Métricas](2026-10-12-02-metricas.md) | §4 `metric_samples`, §6.4, §8 (gráficas) | hecho (rama `feat/wave-a`) |
| 3 | [Configuración completa y plantillas](2026-10-12-03-configuracion-plantillas.md) | §4.1 completa, §4 `templates`, §8 (formulario por secciones, asistente) | hecho (rama `feat/wave-a`) |
| 4 | [Backups](2026-10-12-04-backups.md) | §4 `backups`/`jobs`, §6.5, §7 `JobService`/`BackupService`, §8 (pestañas Backups e Historial) | hecho (rama `feat/wave-a`) |
| 5 | [Archivos](2026-10-12-05-archivos.md) | §6.6, transferencias HTTP §5.1, §8 (pestaña Archivos) | hecho (rama `feat/wave-a`) |
| 6 | [Importación de servidores existentes](2026-10-12-06-importacion.md) | §6.7, §7 `ImportService`, §8 (Nodos → Importar) | escrito |
| 7 | [Migración entre nodos](2026-10-12-07-migracion.md) | §7 `MigrationService` | escrito |
| 8 | mc-router | §4 `router_deployments`, §7 `RouterService` | pendiente |
| 9 | Pruebas de interfaz y pulido | §11 (Playwright), §8 (Ajustes) | pendiente |

Ejecución en oleadas paralelas: ver [COORDINATION.md](COORDINATION.md).

## Plan 2 — Métricas

Alcance: el agente añade `MetricSample` (CPU %, memoria, red, jugadores, ping, TPS en Paper/Purpur
vía RCON `tps`) cada 10 s para servidores en marcha y para el host (gopsutil: CPU, RAM, disco de
`DATA_ROOT`). El panel ingesta por lotes en `metric_samples`, purga a 7 días cada hora, y expone
`GET /api/servers/:id/metrics?range=1h|24h|7d` y `GET /api/nodes/:id/metrics` agregando al vuelo
(10 s / 1 min / 5 min). La UI añade gráficas (jugadores, CPU, RAM) en el Resumen del servidor y
tarjetas de nodo con CPU/RAM/disco en vivo.
Aceptación: con un servidor en marcha 2 minutos, la gráfica de 1 h muestra ≥ 10 puntos; tras
reiniciar el panel, el histórico sigue; la tabla no supera ~70k filas por servidor/semana.
Protocolo: nuevo mensaje `MetricBatch` en `agent.proto` (`buf breaking` debe pasar).

## Plan 3 — Configuración completa y plantillas

Alcance: la spec crece con `modpack`, `mods`, `plugins`, `whitelist`, `ops` (§4.1) y el
`BuildContainer` del agente los traduce a `MODPACK_PLATFORM`, `MODRINTH_MODPACK`, `CF_SLUG`/`CF_PAGE_URL`,
`CF_API_KEY` (global desde Ajustes), `MODRINTH_PROJECTS`, `SPIGET_RESOURCES`, `MODS`/`PLUGINS` (URLs),
`WHITELIST`, `ENABLE_WHITELIST`, `OPS`, con validación cruzada (modpack ↔ tipo compatible).
Formulario por secciones (General, Versión y mods, Propiedades con campos tipados para las ~20
más usadas, Jugadores, Red con puertos extra, Recursos, Backups (placeholder hasta el Plan 4),
Avanzado) y vista de diff antes de aplicar. Plantillas: tabla `templates`, CRUD, "guardar como
plantilla", "crear desde plantilla", duplicar; asistente de nuevo servidor en 3 pasos.
Aceptación: crear un servidor Fabric con `MODRINTH_PROJECTS=lithium` arranca y la consola muestra
la descarga del mod; una plantilla reproduce un servidor idéntico salvo nombre, puerto y RCON.

## Plan 4 — Backups

Alcance: en el agente, paquete `backup` (tar.zst con `klauspost/compress`, `save-off`/`save-all
flush`/`save-on` con `defer`, exclusiones, metadatos `.json`, sha256, poda por días/cantidad,
programación `robfig/cron` desde la spec, `onlyIfPlayersSince`), restauración con renombrado
`data.pre-restore-<ts>`, mensajes `BackupNow/List/Restore/Delete` + `BackupCreated` + `JobProgress`.
Panel: tablas `backups` y `jobs`, `JobService` genérico con progreso y log, descarga vía
`GET /agent/transfer/:id` ↔ `BackupPush`. UI: pestaña Backups (lista, crear ahora, restaurar,
descargar, borrar) y página Jobs.
Aceptación: backup manual de un mundo en marcha sin que el servidor se quede con autosave
desactivado (verificar con `save-on` en logs); restaurar deja el mundo anterior renombrado;
programado a `* * * * *` genera un fichero por minuto y respeta `keepCount`.

## Plan 5 — Archivos

Alcance: `Files*` en el agente con confinamiento (`EvalSymlinks` + prefijo), escrituras atómicas,
límite inline 2 MiB, subida/bajada en streaming por `/agent/transfer`. UI: navegador de `/data`,
editor de texto (CodeMirror 6) para `.properties/.yml/.json/.toml/.txt`, subir, descargar,
renombrar, borrar, crear carpeta.
Aceptación: una ruta `../../etc/passwd` devuelve 400; subir un `.jar` de 50 MB a `mods/` funciona
y el servidor lo carga al reiniciar.

## Plan 6 — Importación

Alcance: `ImportScan`/`ImportCandidates`/`ImportAdopt`; el panel construye la spec candidata
(env conocidas → campos; resto → `env`; puerto `25565/tcp`; bind `/data` → `dataPath` explícito si
no cuelga de `DATA_ROOT`, campo nuevo opcional en la spec y en `BuildContainer`). UI en Nodos →
Importar con revisión y edición antes de adoptar. Adopción en caliente (sin recrear): el agente
sigue el contenedor por `imported_from.container_id` hasta el primer cambio de spec.
Aceptación: tus servidores actuales del compose aparecen como candidatos, se adoptan sin parada y
muestran logs/jugadores; el primer "Guardar y aplicar" los recrea con etiquetas `mcsm.*` y el
mismo directorio de datos.

## Plan 7 — Migración

Alcance: `MigrationService` como job de 7 pasos (§7) reutilizando backup/transfer/restore; UI
"Migrar a otro nodo" con selección de nodo, puerto propuesto, opción "borrar origen".
Aceptación: migrar un mundo de 500 MB entre dos nodos de la LAN con el servidor parado conserva
el mundo y la spec (versión +1, puerto nuevo si colisiona); si el destino falla al arrancar, el
origen queda intacto y arrancado.

## Plan 8 — mc-router

Alcance: tabla `router_deployments`, `RouterApply/RouterRemove` en el agente (contenedor
`itzg/mc-router` con `-in-docker` y socket montado, puerto 25565 del host), etiquetas
`mc-router.host` en los servidores con `router.enabled`, autoscale opcional. UI en Nodos.
Aceptación: con DNS local `*.lan` apuntando al nodo, `survival.lan` y `creativo.lan` entran por
25565 a servidores distintos.

## Plan 9 — Pruebas de interfaz y pulido

Alcance: detección de bucles de crash (§10: >3 reinicios por hora → parar y avisar) y mensaje `Event` del agente (§5.3, campo 24 del `Envelope`) con su vista en la web; Playwright sobre `deploy/docker-compose.yml` + agente real: login, crear servidor, consola,
backup y restauración, migración entre dos agentes en la misma máquina (dos `DATA_ROOT`). Página de
Ajustes (contraseña, URL pública, API key de CurseForge, rango de puertos). Rotación de token de nodo.
Aceptación: la suite E2E pasa en CI local en < 15 min; `pnpm test`, `go test ./...` y `buf breaking`
en verde.
