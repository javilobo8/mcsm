# Coordinación de planes en paralelo

Los planes 2–5 se escriben y ejecutan **en paralelo**, cada uno en su propia rama y
worktree (`feat/plan-N`, `.worktrees/plan-N`), partiendo de la rama integrada del
Plan 1. Los planes 6–8 van en una segunda oleada, cuando 2–5 estén fusionados; el 9
cierra. Para que las fusiones sean mecánicas, cada plan solo escribe en sus rangos y
anclas reservados en los ficheros compartidos.

| Oleada | Planes | Base |
|---|---|---|
| A | 2 Métricas · 3 Configuración y plantillas · 4 Backups · 5 Archivos | Plan 1 integrado |
| B | 6 Importación · 7 Migración · 8 mc-router | Oleada A fusionada |
| C | 9 Pruebas de interfaz y pulido | Oleada B fusionada |

## Rangos reservados

| Plan | `Envelope.body` (números de campo) | Migraciones (`name`) |
|---|---|---|
| 1 | 10–23 (usados) | `001_*`, `002_*` (usadas) |
| 2 Métricas | 30–39 | `010_*`–`019_*` |
| 3 Configuración y plantillas | 40–49 | `020_*`–`029_*` |
| 4 Backups (incluye jobs) | 50–69 | `030_*`–`039_*` |
| 5 Archivos y transferencias | 70–89 | `040_*`–`049_*` |
| 6 Importación | 90–99 | `050_*`–`059_*` |
| 7 Migración | 100–109 | `060_*`–`069_*` |
| 8 mc-router | 110–119 | `070_*`–`079_*` |
| 9 Pulido (StreamDropped, RotateToken, Ajustes) | 120–129 | `080_*`–`089_*` |

Los mensajes protobuf nuevos (no los campos del oneof) llevan nombres propios del
área (`MetricBatch`, `BackupNow`, `FilesList`…) y se declaran **al final** de
`proto/mcsm/v1/agent.proto` dentro del bloque de comentario de su plan.

## Anclas

En cada fichero compartido hay un comentario-ancla por plan
(`// ── plan-N ──` o `-- plan-N` en SQL). Un plan añade sus líneas **solo debajo de
su ancla**. Ficheros con anclas:

- `proto/mcsm/v1/agent.proto`: oneof `body` y zona de mensajes.
- `panel/apps/api/src/db/migrations.ts`: array `migrations`.
- `panel/apps/api/src/app.ts`: registro de plugins/rutas y decoraciones.
- `panel/apps/api/src/agents/service.ts`: despacho de mensajes no solicitados del agente.
- `agent/internal/app/app.go`: `switch` de `Handle` y arranque de bucles de fondo.
- `panel/apps/web/src/router.tsx`: árbol de rutas.
- `panel/apps/web/src/routes/server.tsx`: pestañas del detalle de servidor.
- `agent/internal/spec/spec.go` (struct `Spec`, `Validate`, `BuildContainer`) y
  `panel/packages/shared/src/spec.ts` (esquema zod): campos nuevos de la spec.

Las anclas se crean en un commit de preparación justo antes de lanzar la oleada; al
escribir un plan, asume que existen y di en cada paso "debajo de la ancla `plan-N`".

## Propiedad de áreas (para no pisarse)

- **Plan 2** es dueño de métricas: muestreo en el agente, tabla `metric_samples`,
  endpoints de métricas, gráficas en el Resumen y tarjetas de nodo.
- **Plan 3** es dueño del formulario de configuración por secciones
  (`server-config-form.tsx` y lo que lo sustituya), del asistente de nuevo servidor y
  de plantillas. Los campos de spec `modpack`, `mods`, `plugins`, `whitelist`, `ops`.
  **No** crea sección de Backups en el formulario.
- **Plan 4** es dueño de backups y jobs: campo de spec `backups`, paquete `backup` del
  agente, tablas `backups`/`jobs`, `JobService`, pestañas Backups e Historial y página
  Jobs. La programación de backups (cron, retención) se edita **en la pestaña
  Backups** (PATCH de `spec.backups`), no en el formulario del Plan 3.
- **Plan 5** es dueño de archivos y de las transferencias HTTP
  (`/agent/transfer/:id`, staging del panel). El Plan 4 **no** implementa descarga de
  backups por transferencia: deja el botón "Descargar" para cuando exista el mecanismo
  del Plan 5 (la oleada B lo conecta). Si el Plan 4 necesita algo del Plan 5, lo
  declara como dependencia para la oleada B en vez de duplicarlo.
- Ninguno toca `panel/apps/api/src/auth/**` ni el guard de sesión.

## Código generado

`agent/gen/**` y `panel/packages/proto-ts/src/gen/**` no se fusionan a mano: tras
cada fusión se regeneran con `pnpm gen` y se commitean. `pnpm-lock.yaml`: tras
fusionar, `pnpm install` y commit.

## Tras fusionar una oleada

`buf lint`, `buf breaking --against` la rama base, verificación completa de
`CLAUDE.md`, y revisión de rama con `final-reviewer`.
