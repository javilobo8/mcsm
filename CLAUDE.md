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
