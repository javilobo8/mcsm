# MC Server Manager — Plan 1: Fundamentos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel web + agente Go funcionando de extremo a extremo: alta de nodo por token, crear/editar/arrancar/parar/borrar servidores itzg desde la web, ver estado y jugadores, logs en vivo y consola RCON.

**Architecture:** Monorepo con `agent/` (Go, reconciliador sobre el socket Docker, conexión WebSocket saliente) y `panel/` (Fastify + `node:sqlite` como fuente de verdad, web React). El protocolo panel↔agente se define en Protobuf (`proto/`) y se genera con `buf` para Go y TypeScript. Cada servidor tiene una *spec* JSON versionada; el agente la convierte en un contenedor determinista y la reconcilia.

**Tech Stack:** Go 1.27.2, `github.com/moby/moby/client` v0.6, `github.com/coder/websocket`, `go.etcd.io/bbolt`, `github.com/mcstatus-io/mcutil/v4`; Node 26, pnpm 12, Fastify 5, `@fastify/websocket`, `node:sqlite`, zod 4, `@bufbuild/protobuf` 2; React 19, Vite 8, Tailwind 4, shadcn/ui, TanStack Router + Query; buf 1.73.

**Spec:** `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (secciones 3, 4, 5, 6.1–6.3, 7, 8, 9, 10, 12 y 14; el resto queda para los planes siguientes, ver `docs/superpowers/plans/README.md`).

## Global Constraints

- Toolchain fijada en `mise.toml`: `go = "1.27.2"`, `buf = "1.73.0"`. Node 26.x y pnpm 12.x globales. Ejecuta siempre `eval "$(mise env)"` (o usa los shims de mise) antes de `go`/`buf`.
- Módulo Go: `mcsm/agent`. Código generado en `agent/gen/mcsm/v1` (paquete `mcsmv1`) y `panel/packages/proto-ts/src/gen`. **El código generado se commitea.**
- Etiquetas Docker reservadas: `mcsm.managed`, `mcsm.server_id`, `mcsm.slug`, `mcsm.spec_version`, `mcsm.spec_hash`. Nombre de contenedor: `mcsm-<slug>`. Slug: `^[a-z0-9][a-z0-9-]{0,39}$`.
- Red Docker de usuario: `mcsm` (env `MCSM_NETWORK`). Puerto interno de juego 25565, RCON interno 25575 (nunca publicado).
- Directorio de datos de un servidor en el nodo: `<DATA_ROOT>/<slug>/data`, montado en `/data`. `DATA_ROOT` por defecto `/srv/minecraft` y se monta en el agente con la **misma ruta** dentro y fuera.
- Variables de entorno reservadas que la spec no puede sobreescribir vía `env`: `EULA`, `TYPE`, `VERSION`, `MEMORY`, `ENABLE_RCON`, `RCON_PASSWORD`, `RCON_PORT`, `SERVER_PORT`, `CUSTOM_SERVER_PROPERTIES`.
- Contenedores con `Tty: true`, `OpenStdin: true`. Parada limpia con timeout 60 s.
- Panel: un solo usuario; contraseña con `scrypt` de `node:crypto`; cookie `mcsm_session` firmada, `HttpOnly`, `SameSite=Strict`; sesiones 30 días. Tokens de nodo y de alta: 32 bytes aleatorios en base64url, SHA-256 hex en BD. Tokens de alta caducan a los 15 min y son de un solo uso.
- Rango de puertos de juego por nodo por defecto: 25565–25600.
- Mensajes de la UI y de error en castellano. Identificadores de código en inglés.
- Commits pequeños con Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`) y la línea `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Nombre de servidor con espacios, mayúsculas o acentos** ("Supervivencia 2024 ñ") → el slug debe ser `supervivencia-2024-n`, nunca una petición rechazada por el agente. Test en Task 14 (`slugify`) y Task 2 (el agente rechaza slugs inválidos).
2. **Puerto ocupado por un contenedor no gestionado** (tu compose actual) → el asignador no lo sabe; Docker falla al crear y el error debe aparecer en `observed.error` y en la tarjeta del servidor, no desaparecer. Test en Task 6 (fallo de `Create` → `Observed.Error` y reintento con backoff) y Task 14 (asignador evita puertos de otros servidores del nodo).
3. **Reconexión del agente con una consola abierta** → el navegador recibe `{type:"stream_closed"}` y se resuscribe al volver el nodo; sin líneas duplicadas ni consola congelada. Test en Task 15.
4. **`env` libre intentando pisar `RCON_PASSWORD` o `TYPE`** → rechazado en validación (panel y agente), porque rompería la consola o el tipo declarado. Test en Task 2 (Go y zod).
5. **`memLimit` menor que `memory`** (JVM 4G con límite 2G) → el contenedor moriría por OOM en bucle; se rechaza en validación. Test en Task 2.

---

## Estructura de archivos

```
mise.toml                         (ya existe)
.gitignore
package.json                      raíz pnpm (scripts gen/typecheck/test)
pnpm-workspace.yaml
buf.yaml / buf.gen.yaml
proto/mcsm/v1/agent.proto         protocolo
proto/fixtures/spec-example.json  fixture compartida Go/TS

agent/go.mod
agent/cmd/agent/main.go
agent/gen/mcsm/v1/agent.pb.go     generado
agent/internal/spec/spec.go       Spec + validación + BuildContainer
agent/internal/store/store.go     bbolt
agent/internal/docker/engine.go   interfaz Engine + tipos
agent/internal/docker/moby.go     implementación real
agent/internal/docker/fake.go     fake para tests
agent/internal/mc/mc.go           Status (SLP) + Rcon
agent/internal/reconcile/reconciler.go
agent/internal/logs/hub.go
agent/internal/conn/client.go     WebSocket cliente + reconexión
agent/internal/conn/enroll.go     alta HTTP
agent/internal/app/app.go         wiring + Handler
agent/internal/app/config.go
agent/Dockerfile

panel/tsconfig.base.json
panel/packages/proto-ts/{package.json,tsconfig.json,src/index.ts,src/gen/...}
panel/packages/shared/{package.json,tsconfig.json,src/index.ts,src/spec.ts,src/spec.test.ts,src/slug.ts}
panel/apps/api/{package.json,tsconfig.json,vitest.config.ts}
panel/apps/api/src/main.ts
panel/apps/api/src/app.ts          buildApp()
panel/apps/api/src/config.ts
panel/apps/api/src/lib/{ids.ts,time.ts,tokens.ts}
panel/apps/api/src/db/{db.ts,migrations.ts,db.test.ts}
panel/apps/api/src/auth/{password.ts,repo.ts,plugin.ts,routes.ts,auth.test.ts}
panel/apps/api/src/nodes/{repo.ts,routes.ts,nodes.test.ts}
panel/apps/api/src/agents/{hub.ts,service.ts,routes.ts,agents.test.ts}
panel/apps/api/src/servers/{repo.ts,service.ts,routes.ts,servers.test.ts}
panel/apps/api/src/realtime/{hub.ts,routes.ts,realtime.test.ts}
panel/apps/api/test/fake-agent.ts  agente falso en TS para tests
panel/apps/web/...                 Vite + React

deploy/panel.Dockerfile
deploy/docker-compose.yml          panel + agente local (producción casera)
deploy/docker-compose.node.yml     solo agente (nodos adicionales)
deploy/docker-compose.dev.yml      agente en Docker contra panel en el host
README.md
```

---

### Task 1: Esqueleto del monorepo y protocolo

**Files:**
- Create: `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `buf.yaml`, `buf.gen.yaml`, `proto/mcsm/v1/agent.proto`, `agent/go.mod`, `agent/cmd/agent/main.go`, `panel/tsconfig.base.json`, `panel/packages/proto-ts/{package.json,tsconfig.json,src/index.ts}`

**Interfaces:**
- Produces: paquete Go `mcsmv1 "mcsm/agent/gen/mcsm/v1"` y paquete npm `@mcsm/proto` con los tipos `Envelope`, `Hello`, `HelloAck`, `ServerSpec`, `SyncSpecs`, `ApplySpec`, `RemoveServer`, `PowerAction`, `PowerActionType`, `SendCommand`, `CommandResult`, `SubscribeLogs`, `LogLine`, `StreamClose`, `McStatus`, `Observed`, `ServerObserved`, `Ack`, `Error`, `DesiredState`, `HostInfo`.

- [ ] **Step 1: Ficheros raíz**

`.gitignore`:
```
node_modules/
dist/
agent/bin/
*.db
*.db-wal
*.db-shm
.env
/data/
deploy/data/
coverage/
```

`package.json`:
```json
{
  "name": "mcsm",
  "private": true,
  "packageManager": "pnpm@12.10.1",
  "scripts": {
    "gen": "buf generate",
    "lint:proto": "buf lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "dev:api": "pnpm --filter @mcsm/api dev",
    "dev:web": "pnpm --filter @mcsm/web dev"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - panel/apps/*
  - panel/packages/*
```

`buf.yaml`:
```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

`buf.gen.yaml`:
```yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: mcsm/agent/gen
plugins:
  - remote: buf.build/protocolbuffers/go:v1.36.12
    out: agent/gen
    opt: paths=source_relative
  - remote: buf.build/bufbuild/es:v2.16.0
    out: panel/packages/proto-ts/src/gen
    opt: target=ts
```

- [ ] **Step 2: Protocolo**

`proto/mcsm/v1/agent.proto`:
```proto
syntax = "proto3";

package mcsm.v1;

// Envelope es el único tipo que viaja por el WebSocket. `id` identifica una
// petición y su respuesta; `stream_id` agrupa los frames de un stream.
message Envelope {
  uint64 id = 1;
  uint64 stream_id = 2;
  oneof body {
    Hello hello = 10;
    HelloAck hello_ack = 11;
    SyncSpecs sync_specs = 12;
    ApplySpec apply_spec = 13;
    RemoveServer remove_server = 14;
    PowerAction power_action = 15;
    SendCommand send_command = 16;
    CommandResult command_result = 17;
    SubscribeLogs subscribe_logs = 18;
    LogLine log_line = 19;
    StreamClose stream_close = 20;
    ServerObserved server_observed = 21;
    Ack ack = 22;
    Error error = 23;
  }
}

message HostInfo {
  string hostname = 1;
  uint32 cpus = 2;
  uint64 mem_total_bytes = 3;
  string os = 4;
  string arch = 5;
}

message Hello {
  string agent_version = 1;
  string docker_version = 2;
  HostInfo host = 3;
  map<string, uint64> spec_versions = 4;
}

message HelloAck {
  string node_id = 1;
}

enum DesiredState {
  DESIRED_STATE_UNSPECIFIED = 0;
  DESIRED_STATE_RUNNING = 1;
  DESIRED_STATE_STOPPED = 2;
}

message ServerSpec {
  string server_id = 1;
  string slug = 2;
  uint64 version = 3;
  DesiredState desired_state = 4;
  bytes spec_json = 5;
}

message SyncSpecs {
  repeated ServerSpec servers = 1;
  repeated string removed_ids = 2;
}

message ApplySpec {
  ServerSpec server = 1;
}

message RemoveServer {
  string server_id = 1;
  bool delete_data = 2;
}

enum PowerActionType {
  POWER_ACTION_TYPE_UNSPECIFIED = 0;
  POWER_ACTION_TYPE_START = 1;
  POWER_ACTION_TYPE_STOP = 2;
  POWER_ACTION_TYPE_RESTART = 3;
  POWER_ACTION_TYPE_KILL = 4;
}

message PowerAction {
  string server_id = 1;
  PowerActionType action = 2;
}

message SendCommand {
  string server_id = 1;
  string command = 2;
}

message CommandResult {
  string output = 1;
}

// Respuesta: Ack con envelope.stream_id = envelope.id de la petición.
message SubscribeLogs {
  string server_id = 1;
  uint32 tail = 2;
}

message LogLine {
  string server_id = 1;
  int64 ts_unix_ms = 2;
  string line = 3;
}

message StreamClose {
  string reason = 1;
}

message McStatus {
  bool online = 1;
  uint32 players_online = 2;
  uint32 players_max = 3;
  string version = 4;
  uint32 latency_ms = 5;
}

message Observed {
  string container_id = 1;
  string state = 2; // missing|created|running|restarting|exited|dead|paused
  string health = 3; // ""|starting|healthy|unhealthy
  int64 started_at_unix = 4;
  int32 exit_code = 5;
  uint64 applied_version = 6;
  string error = 7;
  McStatus mc = 8;
}

message ServerObserved {
  string server_id = 1;
  Observed observed = 2;
  int64 ts_unix_ms = 3;
}

message Ack {}

message Error {
  string code = 1;
  string message = 2;
}
```

- [ ] **Step 3: Módulo Go y main mínimo**

`agent/go.mod`:
```
module mcsm/agent

go 1.27.2
```

`agent/cmd/agent/main.go` (provisional; Task 9 lo sustituye):
```go
package main

import (
	"fmt"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func main() {
	fmt.Println("mcsm-agent", (&mcsmv1.Hello{}).ProtoReflect().Descriptor().FullName())
}
```

- [ ] **Step 4: Paquete TS del protocolo**

`panel/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`panel/packages/proto-ts/package.json`:
```json
{
  "name": "@mcsm/proto",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "echo no tests" },
  "dependencies": { "@bufbuild/protobuf": "^2.16.0" },
  "devDependencies": { "typescript": "^5.9.0" }
}
```

`panel/packages/proto-ts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`panel/packages/proto-ts/src/index.ts`:
```ts
export * from "./gen/mcsm/v1/agent_pb.js";
```

- [ ] **Step 5: Generar y compilar**

```bash
cd /home/lobo/dev/mc-server-manager && eval "$(mise env)"
buf lint && buf generate
ls agent/gen/mcsm/v1/agent.pb.go panel/packages/proto-ts/src/gen/mcsm/v1/agent_pb.ts
cd agent && go mod tidy && go build ./... && go run ./cmd/agent
cd .. && pnpm install && pnpm --filter @mcsm/proto typecheck
```
Expected: `buf lint` sin salida; `go run` imprime `mcsm-agent mcsm.v1.Hello`; typecheck sin errores.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: esqueleto del monorepo y protocolo protobuf v1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Spec de servidor (Go y TS) y construcción determinista del contenedor

**Files:**
- Create: `agent/internal/spec/spec.go`, `agent/internal/spec/spec_test.go`, `proto/fixtures/spec-example.json`, `panel/packages/shared/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/spec.ts,src/spec.test.ts}`

**Interfaces:**
- Produces (Go): `spec.Spec`, `spec.Parse([]byte) (Spec, error)`, `(Spec).Validate() error`, `spec.Meta{ServerID, Slug string; Version uint64}`, `spec.Build{Name string; Config *container.Config; HostConfig *container.HostConfig; Networking *network.NetworkingConfig; DataDir, Hash string}`, `spec.BuildContainer(meta Meta, s Spec, dataRoot, networkName string) (*Build, error)`, `spec.ContainerName(slug string) string`, constantes `LabelManaged`, `LabelServerID`, `LabelSlug`, `LabelVersion`, `LabelHash`, `GamePort=25565`, `RconPort=25575`, `ReservedEnv`.
- Produces (TS, `@mcsm/shared`): `specSchema`, `specInputSchema`, `type Spec`, `type SpecInput`, `RESERVED_ENV`, `defaultSpecInput()`.

- [ ] **Step 1: Fixture compartida**

`proto/fixtures/spec-example.json`:
```json
{
  "imageTag": "java21",
  "type": "PAPER",
  "version": "1.21.4",
  "memory": "4G",
  "properties": { "motd": "Servidor de casa", "max-players": "10", "difficulty": "normal" },
  "env": { "USE_AIKAR_FLAGS": "true" },
  "ports": { "game": 25565, "extra": [ { "host": 19132, "container": 19132, "proto": "udp", "label": "Geyser" } ] },
  "resources": { "cpus": 2, "memLimit": "5G" },
  "restartPolicy": "unless-stopped",
  "rconPassword": "s3cretpassw0rd"
}
```

- [ ] **Step 2: Test Go (falla)**

`agent/internal/spec/spec_test.go`:
```go
package spec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadFixture(t *testing.T) Spec {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "fixtures", "spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var meta = Meta{ServerID: "0190a1b2-0000-7000-8000-000000000001", Slug: "survival", Version: 3}

func TestBuildContainerBasics(t *testing.T) {
	s := loadFixture(t)
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "mcsm-survival" {
		t.Errorf("name = %q", b.Name)
	}
	if b.DataDir != "/srv/minecraft/survival/data" {
		t.Errorf("dataDir = %q", b.DataDir)
	}
	if b.Config.Image != "itzg/minecraft-server:java21" {
		t.Errorf("image = %q", b.Config.Image)
	}
	if !b.Config.Tty || !b.Config.OpenStdin {
		t.Error("tty/openstdin deben ser true")
	}
	if got := b.HostConfig.Binds; len(got) != 1 || got[0] != "/srv/minecraft/survival/data:/data" {
		t.Errorf("binds = %v", got)
	}
	if b.Config.Labels[LabelManaged] != "true" || b.Config.Labels[LabelServerID] != meta.ServerID ||
		b.Config.Labels[LabelSlug] != "survival" || b.Config.Labels[LabelVersion] != "3" || b.Config.Labels[LabelHash] != b.Hash {
		t.Errorf("labels = %v", b.Config.Labels)
	}
	if _, ok := b.Networking.EndpointsConfig["mcsm"]; !ok {
		t.Error("falta la red mcsm")
	}
	if b.HostConfig.RestartPolicy.Name != "unless-stopped" {
		t.Errorf("restart = %q", b.HostConfig.RestartPolicy.Name)
	}
	if b.HostConfig.Resources.Memory != 5*1024*1024*1024 || b.HostConfig.Resources.NanoCPUs != 2e9 {
		t.Errorf("resources = %+v", b.HostConfig.Resources)
	}
}

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestBuildContainerEnv(t *testing.T) {
	s := loadFixture(t)
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	env := envMap(b.Config.Env)
	want := map[string]string{
		"EULA": "TRUE", "TYPE": "PAPER", "VERSION": "1.21.4", "MEMORY": "4G",
		"ENABLE_RCON": "true", "RCON_PASSWORD": "s3cretpassw0rd", "RCON_PORT": "25575", "SERVER_PORT": "25565",
		"USE_AIKAR_FLAGS": "true",
		"CUSTOM_SERVER_PROPERTIES": "difficulty=normal\nmax-players=10\nmotd=Servidor de casa",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	for i := 1; i < len(b.Config.Env); i++ {
		if b.Config.Env[i-1] > b.Config.Env[i] {
			t.Fatalf("env no está ordenado: %v", b.Config.Env)
		}
	}
}

func TestBuildContainerPorts(t *testing.T) {
	s := loadFixture(t)
	s.Ports.Game = 25570
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	var seen []string
	for p, binds := range b.HostConfig.PortBindings {
		seen = append(seen, p.String()+"->"+binds[0].HostPort)
	}
	if len(seen) != 2 {
		t.Fatalf("bindings = %v", seen)
	}
	joined := strings.Join(seen, ",")
	if !strings.Contains(joined, "25565/tcp->25570") || !strings.Contains(joined, "19132/udp->19132") {
		t.Errorf("bindings = %v", seen)
	}
	if _, ok := b.HostConfig.PortBindings[mustPort("25575/tcp")]; ok {
		t.Error("RCON no debe publicarse")
	}
}

func TestHashStability(t *testing.T) {
	s := loadFixture(t)
	a, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if a.Hash != b.Hash {
		t.Error("el hash debe ser determinista")
	}
	m2 := meta
	m2.Version = 99
	c, _ := BuildContainer(m2, s, "/srv/minecraft", "mcsm")
	if c.Hash != a.Hash {
		t.Error("cambiar solo la versión no debe cambiar el hash")
	}
	s.Memory = "6G"
	s.Resources.MemLimit = "7G"
	d, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if d.Hash == a.Hash {
		t.Error("cambiar la memoria debe cambiar el hash")
	}
}

func TestValidation(t *testing.T) {
	base := loadFixture(t)
	cases := []struct {
		name string
		mut  func(*Spec, *Meta)
		want string
	}{
		{"slug inválido", func(_ *Spec, m *Meta) { m.Slug = "Mi Server" }, "slug"},
		{"env reservada", func(s *Spec, _ *Meta) { s.Env["RCON_PASSWORD"] = "x" }, "reservada"},
		{"env TYPE reservada", func(s *Spec, _ *Meta) { s.Env["TYPE"] = "FORGE" }, "reservada"},
		{"memoria inválida", func(s *Spec, _ *Meta) { s.Memory = "muchos" }, "memory"},
		{"memLimit menor que memory", func(s *Spec, _ *Meta) { s.Resources.MemLimit = "2G" }, "memLimit"},
		{"puerto fuera de rango", func(s *Spec, _ *Meta) { s.Ports.Game = 70000 }, "puerto"},
		{"proto inválido", func(s *Spec, _ *Meta) { s.Ports.Extra[0].Proto = "icmp" }, "proto"},
		{"rcon vacío", func(s *Spec, _ *Meta) { s.RconPassword = "" }, "rconPassword"},
		{"restart inválido", func(s *Spec, _ *Meta) { s.RestartPolicy = "siempre" }, "restartPolicy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			s.Env = map[string]string{}
			for k, v := range base.Env {
				s.Env[k] = v
			}
			s.Ports.Extra = append([]PortMapping(nil), base.Ports.Extra...)
			m := meta
			tc.mut(&s, &m)
			_, err := BuildContainer(m, s, "/srv/minecraft", "mcsm")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want que contenga %q", err, tc.want)
			}
		})
	}
}

func TestDefaults(t *testing.T) {
	s, err := Parse([]byte(`{"type":"VANILLA","version":"LATEST","memory":"2G","ports":{"game":25565},"rconPassword":"abcdefgh"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.Config.Image != "itzg/minecraft-server:latest" {
		t.Errorf("image = %q", b.Config.Image)
	}
	if b.HostConfig.RestartPolicy.Name != "unless-stopped" {
		t.Errorf("restart por defecto = %q", b.HostConfig.RestartPolicy.Name)
	}
	if b.HostConfig.Resources.Memory != 0 {
		t.Error("sin memLimit no debe haber límite")
	}
}
```

- [ ] **Step 3: Ejecutar (debe fallar)**

```bash
cd agent && go test ./internal/spec/
```
Expected: FAIL, "undefined: Parse" etc.

- [ ] **Step 4: Implementación**

`agent/internal/spec/spec.go`:
```go
// Package spec define la especificación de un servidor y su traducción
// determinista a una configuración de contenedor Docker.
package spec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	units "github.com/docker/go-units"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

const (
	LabelManaged  = "mcsm.managed"
	LabelServerID = "mcsm.server_id"
	LabelSlug     = "mcsm.slug"
	LabelVersion  = "mcsm.spec_version"
	LabelHash     = "mcsm.spec_hash"

	Image    = "itzg/minecraft-server"
	GamePort = 25565
	RconPort = 25575
)

// ReservedEnv son variables que genera el agente y que `env` no puede pisar.
var ReservedEnv = map[string]bool{
	"EULA": true, "TYPE": true, "VERSION": true, "MEMORY": true, "ENABLE_RCON": true,
	"RCON_PASSWORD": true, "RCON_PORT": true, "SERVER_PORT": true, "CUSTOM_SERVER_PROPERTIES": true,
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

var restartPolicies = map[string]container.RestartPolicyMode{
	"":                container.RestartPolicyUnlessStopped,
	"unless-stopped":  container.RestartPolicyUnlessStopped,
	"always":          container.RestartPolicyAlways,
	"no":              container.RestartPolicyDisabled,
	"on-failure":      container.RestartPolicyOnFailure,
}

type Spec struct {
	ImageTag      string            `json:"imageTag"`
	Type          string            `json:"type"`
	Version       string            `json:"version"`
	Memory        string            `json:"memory"`
	Properties    map[string]string `json:"properties"`
	Env           map[string]string `json:"env"`
	Ports         Ports             `json:"ports"`
	Resources     Resources         `json:"resources"`
	RestartPolicy string            `json:"restartPolicy"`
	RconPassword  string            `json:"rconPassword"`
}

type Ports struct {
	Game  int           `json:"game"`
	Extra []PortMapping `json:"extra"`
}

type PortMapping struct {
	Host      int    `json:"host"`
	Container int    `json:"container"`
	Proto     string `json:"proto"`
	Label     string `json:"label"`
}

type Resources struct {
	Cpus     float64 `json:"cpus"`
	MemLimit string  `json:"memLimit"`
}

type Meta struct {
	ServerID string
	Slug     string
	Version  uint64
}

type Build struct {
	Name       string
	Config     *container.Config
	HostConfig *container.HostConfig
	Networking *network.NetworkingConfig
	DataDir    string
	Hash       string
}

func Parse(b []byte) (Spec, error) {
	var s Spec
	if err := json.Unmarshal(b, &s); err != nil {
		return Spec{}, fmt.Errorf("spec JSON inválido: %w", err)
	}
	return s, s.Validate()
}

func (s Spec) Validate() error {
	if s.Type == "" {
		return fmt.Errorf("spec: type es obligatorio")
	}
	if s.Version == "" {
		return fmt.Errorf("spec: version es obligatoria")
	}
	memBytes, err := units.RAMInBytes(s.Memory)
	if err != nil || memBytes <= 0 {
		return fmt.Errorf("spec: memory inválida %q", s.Memory)
	}
	if s.Resources.MemLimit != "" {
		lim, err := units.RAMInBytes(s.Resources.MemLimit)
		if err != nil || lim <= 0 {
			return fmt.Errorf("spec: memLimit inválido %q", s.Resources.MemLimit)
		}
		if lim < memBytes {
			return fmt.Errorf("spec: memLimit (%s) no puede ser menor que memory (%s)", s.Resources.MemLimit, s.Memory)
		}
	}
	if s.Resources.Cpus < 0 {
		return fmt.Errorf("spec: cpus no puede ser negativo")
	}
	if !validPort(s.Ports.Game) {
		return fmt.Errorf("spec: puerto de juego fuera de rango: %d", s.Ports.Game)
	}
	for _, pm := range s.Ports.Extra {
		if !validPort(pm.Host) || !validPort(pm.Container) {
			return fmt.Errorf("spec: puerto extra fuera de rango: %+v", pm)
		}
		if pm.Proto != "tcp" && pm.Proto != "udp" {
			return fmt.Errorf("spec: proto inválido %q (tcp|udp)", pm.Proto)
		}
	}
	if len(s.RconPassword) < 8 {
		return fmt.Errorf("spec: rconPassword debe tener al menos 8 caracteres")
	}
	if _, ok := restartPolicies[s.RestartPolicy]; !ok {
		return fmt.Errorf("spec: restartPolicy inválida %q", s.RestartPolicy)
	}
	for k := range s.Env {
		if ReservedEnv[k] {
			return fmt.Errorf("spec: la variable %s es reservada y no puede sobreescribirse", k)
		}
	}
	return nil
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

func ContainerName(slug string) string { return "mcsm-" + slug }

// BuildContainer traduce la spec a una configuración de contenedor. Es una
// función pura: misma entrada, misma salida, mismo Hash.
func BuildContainer(meta Meta, s Spec, dataRoot, networkName string) (*Build, error) {
	if !slugRe.MatchString(meta.Slug) {
		return nil, fmt.Errorf("slug inválido %q", meta.Slug)
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	tag := s.ImageTag
	if tag == "" {
		tag = "latest"
	}
	dataDir := filepath.Join(dataRoot, meta.Slug, "data")
	name := ContainerName(meta.Slug)

	exposed := network.PortSet{}
	bindings := network.PortMap{}
	game := mustPort(fmt.Sprintf("%d/tcp", GamePort))
	exposed[game] = struct{}{}
	bindings[game] = []network.PortBinding{{HostPort: strconv.Itoa(s.Ports.Game)}}
	for _, pm := range s.Ports.Extra {
		p := mustPort(fmt.Sprintf("%d/%s", pm.Container, pm.Proto))
		exposed[p] = struct{}{}
		bindings[p] = append(bindings[p], network.PortBinding{HostPort: strconv.Itoa(pm.Host)})
	}

	cfg := &container.Config{
		Image:        Image + ":" + tag,
		Env:          s.envList(),
		Tty:          true,
		OpenStdin:    true,
		ExposedPorts: exposed,
		Labels: map[string]string{
			LabelManaged:  "true",
			LabelServerID: meta.ServerID,
			LabelSlug:     meta.Slug,
		},
	}
	host := &container.HostConfig{
		Binds:         []string{dataDir + ":/data"},
		PortBindings:  bindings,
		RestartPolicy: container.RestartPolicy{Name: restartPolicies[s.RestartPolicy]},
	}
	if s.Resources.MemLimit != "" {
		host.Resources.Memory, _ = units.RAMInBytes(s.Resources.MemLimit)
	}
	if s.Resources.Cpus > 0 {
		host.Resources.NanoCPUs = int64(s.Resources.Cpus * 1e9)
	}
	net := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}

	hash := hashOf(name, cfg, host)
	cfg.Labels[LabelHash] = hash
	cfg.Labels[LabelVersion] = strconv.FormatUint(meta.Version, 10)

	return &Build{Name: name, Config: cfg, HostConfig: host, Networking: net, DataDir: dataDir, Hash: hash}, nil
}

func (s Spec) envList() []string {
	m := map[string]string{
		"EULA":          "TRUE",
		"TYPE":          s.Type,
		"VERSION":       s.Version,
		"MEMORY":        s.Memory,
		"ENABLE_RCON":   "true",
		"RCON_PASSWORD": s.RconPassword,
		"RCON_PORT":     strconv.Itoa(RconPort),
		"SERVER_PORT":   strconv.Itoa(GamePort),
	}
	if len(s.Properties) > 0 {
		keys := make([]string, 0, len(s.Properties))
		for k := range s.Properties {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		lines := make([]string, 0, len(keys))
		for _, k := range keys {
			lines = append(lines, k+"="+s.Properties[k])
		}
		m["CUSTOM_SERVER_PROPERTIES"] = strings.Join(lines, "\n")
	}
	for k, v := range s.Env {
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func hashOf(name string, cfg *container.Config, host *container.HostConfig) string {
	b, _ := json.Marshal(struct {
		Name string
		Cfg  *container.Config
		Host *container.HostConfig
	}{name, cfg, host})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16]
}

func mustPort(s string) network.Port { return network.MustParsePort(s) }
```

- [ ] **Step 5: Ejecutar (debe pasar)**

```bash
cd agent && go get github.com/moby/moby/api@v1.56.1 github.com/moby/moby/client@v0.6.2 github.com/docker/go-units@v0.5.0 && go mod tidy && go test ./internal/spec/ -v
```
Expected: PASS en todos los subtests. Si `container.RestartPolicyOnFailure` u otra constante no existe con ese nombre, consulta `go doc github.com/moby/moby/api/types/container.RestartPolicyMode` y ajusta.

- [ ] **Step 6: Paquete TS `@mcsm/shared` — test (falla)**

`panel/packages/shared/package.json`:
```json
{
  "name": "@mcsm/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "zod": "^4.6.0" },
  "devDependencies": { "typescript": "^5.9.0", "vitest": "^4.3.0", "@types/node": "^26.0.0" }
}
```
`panel/packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }
```
`panel/packages/shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

`panel/packages/shared/src/spec.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema, defaultSpecInput } from "./spec.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("specSchema", () => {
  it("acepta la fixture compartida sin cambios", () => {
    const parsed = specSchema.parse(fixture);
    expect(parsed).toEqual(fixture);
  });
  it("rechaza env reservadas", () => {
    expect(() => specSchema.parse({ ...fixture, env: { RCON_PASSWORD: "x" } })).toThrow(/reservada/);
  });
  it("rechaza memLimit menor que memory", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "2G" } })).toThrow(/memLimit/);
  });
  it("rechaza memoria con formato raro", () => {
    expect(() => specSchema.parse({ ...fixture, memory: "4 gigas" })).toThrow();
  });
  it("rechaza rconPassword corta", () => {
    expect(() => specSchema.parse({ ...fixture, rconPassword: "abc" })).toThrow();
  });
});

describe("specInputSchema", () => {
  it("rellena defaults y no exige rconPassword ni puerto", () => {
    const parsed = specInputSchema.parse({ type: "VANILLA", version: "LATEST" });
    expect(parsed.memory).toBe("2G");
    expect(parsed.imageTag).toBe("java21");
    expect(parsed.ports.extra).toEqual([]);
    expect(parsed.ports.game).toBeUndefined();
    expect(parsed.restartPolicy).toBe("unless-stopped");
    expect(parsed.resources).toEqual({ cpus: 0, memLimit: "" });
  });
  it("defaultSpecInput valida", () => {
    expect(() => specInputSchema.parse(defaultSpecInput())).not.toThrow();
  });
});
```

- [ ] **Step 7: Implementación zod**

`panel/packages/shared/src/spec.ts`:
```ts
import { z } from "zod";

export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
]);

const memory = z.string().regex(/^\d+[MmGg]$/, "Formato de memoria inválido (ej. 4G, 512M)");
const port = z.number().int().min(1).max(65535);

export function memoryToBytes(m: string): number {
  const n = Number(m.slice(0, -1));
  return /g$/i.test(m) ? n * 1024 ** 3 : n * 1024 ** 2;
}

export const portMappingSchema = z.object({
  host: port,
  container: port,
  proto: z.enum(["tcp", "udp"]),
  label: z.string().max(40).default(""),
});

const envSchema = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Nombre de variable inválido"), z.string())
  .refine((env) => !Object.keys(env).some((k) => RESERVED_ENV.has(k)), {
    message: "Contiene una variable reservada (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES)",
  });

const resourcesSchema = z.object({
  cpus: z.number().min(0).default(0),
  memLimit: z.union([z.literal(""), memory]).default(""),
});

const baseFields = {
  imageTag: z.string().min(1).default("java21"),
  type: z.string().min(1).default("PAPER"),
  version: z.string().min(1).default("LATEST"),
  memory: memory.default("2G"),
  properties: z.record(z.string(), z.string()).default({}),
  env: envSchema.default({}),
  resources: resourcesSchema.prefault({}),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
};

function memLimitCheck(s: { memory: string; resources: { memLimit: string } }, ctx: z.RefinementCtx) {
  if (s.resources.memLimit && memoryToBytes(s.resources.memLimit) < memoryToBytes(s.memory)) {
    ctx.addIssue({ code: "custom", path: ["resources", "memLimit"], message: "memLimit no puede ser menor que memory" });
  }
}

/** Spec completa, tal y como se persiste y se envía al agente. */
export const specSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port, extra: z.array(portMappingSchema).default([]) }),
    rconPassword: z.string().min(8),
  })
  .superRefine(memLimitCheck);

/** Lo que envía la UI al crear/editar: el panel añade puerto y rconPassword. */
export const specInputSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port.optional(), extra: z.array(portMappingSchema).default([]) }).prefault({}),
  })
  .superRefine(memLimitCheck);

export type Spec = z.infer<typeof specSchema>;
export type SpecInput = z.infer<typeof specInputSchema>;

export function defaultSpecInput(): SpecInput {
  return specInputSchema.parse({});
}
```

`panel/packages/shared/src/index.ts`:
```ts
export * from "./spec.js";
```

- [ ] **Step 8: Ejecutar**

```bash
pnpm install && pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/shared typecheck
```
Expected: 7 tests PASS. Si zod 4 no expone `.prefault`, sustituye por `.default(() => resourcesSchema.parse({}))`.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(spec): spec de servidor validada en Go y TS con construcción determinista del contenedor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Store local del agente (bbolt)

**Files:**
- Create: `agent/internal/store/store.go`, `agent/internal/store/store_test.go`

**Interfaces:**
- Produces: `store.Open(path string) (*Store, error)`, `(*Store).Close() error`, `store.Credentials{NodeID, Token string}`, `(*Store).Credentials() (*Credentials, error)` (nil, nil si no hay), `(*Store).SaveCredentials(Credentials) error`, `(*Store).PutSpec(*mcsmv1.ServerSpec) error`, `(*Store).GetSpec(id string) (*mcsmv1.ServerSpec, error)` (nil, nil si no existe), `(*Store).ListSpecs() ([]*mcsmv1.ServerSpec, error)`, `(*Store).DeleteSpec(id string) error`, `(*Store).SpecVersions() (map[string]uint64, error)`, `(*Store).SetApplied(id string, v uint64) error`, `(*Store).Applied(id string) (uint64, error)`.

- [ ] **Step 1: Test (falla)**

`agent/internal/store/store_test.go`:
```go
package store

import (
	"path/filepath"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCredentials(t *testing.T) {
	s := open(t)
	c, err := s.Credentials()
	if err != nil || c != nil {
		t.Fatalf("esperaba nil,nil; got %v,%v", c, err)
	}
	if err := s.SaveCredentials(Credentials{NodeID: "n1", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	c, _ = s.Credentials()
	if c == nil || c.NodeID != "n1" || c.Token != "tok" {
		t.Fatalf("got %+v", c)
	}
}

func TestSpecs(t *testing.T) {
	s := open(t)
	if sp, _ := s.GetSpec("missing"); sp != nil {
		t.Fatal("GetSpec de id inexistente debe devolver nil")
	}
	a := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(`{"x":1}`)}
	b := &mcsmv1.ServerSpec{ServerId: "b", Slug: "beta", Version: 5}
	for _, sp := range []*mcsmv1.ServerSpec{a, b} {
		if err := s.PutSpec(sp); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.GetSpec("a")
	if got.Slug != "alpha" || got.Version != 2 || string(got.SpecJson) != `{"x":1}` || got.DesiredState != mcsmv1.DesiredState_DESIRED_STATE_RUNNING {
		t.Fatalf("got %+v", got)
	}
	list, _ := s.ListSpecs()
	if len(list) != 2 {
		t.Fatalf("len = %d", len(list))
	}
	vers, _ := s.SpecVersions()
	if vers["a"] != 2 || vers["b"] != 5 {
		t.Fatalf("vers = %v", vers)
	}
	if err := s.SetApplied("a", 2); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Applied("a"); v != 2 {
		t.Fatalf("applied = %d", v)
	}
	if v, _ := s.Applied("b"); v != 0 {
		t.Fatalf("applied b = %d, want 0", v)
	}
	if err := s.DeleteSpec("a"); err != nil {
		t.Fatal(err)
	}
	if sp, _ := s.GetSpec("a"); sp != nil {
		t.Fatal("a debería haberse borrado")
	}
	if v, _ := s.Applied("a"); v != 0 {
		t.Fatal("DeleteSpec debe borrar también applied")
	}
}
```

- [ ] **Step 2: Ejecutar (falla)**

```bash
cd agent && go test ./internal/store/
```

- [ ] **Step 3: Implementación**

`agent/internal/store/store.go`:
```go
// Package store persiste credenciales, specs y versiones aplicadas en bbolt.
package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

var (
	bMeta    = []byte("meta")
	bSpecs   = []byte("specs")
	bApplied = []byte("applied")

	kNodeID = []byte("node_id")
	kToken  = []byte("node_token")
)

type Store struct{ db *bbolt.DB }

type Credentials struct {
	NodeID string
	Token  string
}

func Open(path string) (*Store, error) {
	db, err := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, fmt.Errorf("store: abrir %s: %w", path, err)
	}
	err = db.Update(func(tx *bbolt.Tx) error {
		for _, b := range [][]byte{bMeta, bSpecs, bApplied} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Credentials() (*Credentials, error) {
	var c *Credentials
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bMeta)
		id, tok := b.Get(kNodeID), b.Get(kToken)
		if id == nil || tok == nil {
			return nil
		}
		c = &Credentials{NodeID: string(id), Token: string(tok)}
		return nil
	})
	return c, err
}

func (s *Store) SaveCredentials(c Credentials) error {
	if c.NodeID == "" || c.Token == "" {
		return errors.New("store: credenciales vacías")
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bMeta)
		if err := b.Put(kNodeID, []byte(c.NodeID)); err != nil {
			return err
		}
		return b.Put(kToken, []byte(c.Token))
	})
}

func (s *Store) PutSpec(sp *mcsmv1.ServerSpec) error {
	if sp.GetServerId() == "" {
		return errors.New("store: spec sin server_id")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bSpecs).Put([]byte(sp.ServerId), raw)
	})
}

func (s *Store) GetSpec(id string) (*mcsmv1.ServerSpec, error) {
	var out *mcsmv1.ServerSpec
	err := s.db.View(func(tx *bbolt.Tx) error {
		raw := tx.Bucket(bSpecs).Get([]byte(id))
		if raw == nil {
			return nil
		}
		sp := &mcsmv1.ServerSpec{}
		if err := proto.Unmarshal(raw, sp); err != nil {
			return err
		}
		out = sp
		return nil
	})
	return out, err
}

func (s *Store) ListSpecs() ([]*mcsmv1.ServerSpec, error) {
	var out []*mcsmv1.ServerSpec
	err := s.db.View(func(tx *bbolt.Tx) error {
		return tx.Bucket(bSpecs).ForEach(func(_, raw []byte) error {
			sp := &mcsmv1.ServerSpec{}
			if err := proto.Unmarshal(raw, sp); err != nil {
				return err
			}
			out = append(out, sp)
			return nil
		})
	})
	return out, err
}

func (s *Store) DeleteSpec(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := tx.Bucket(bSpecs).Delete([]byte(id)); err != nil {
			return err
		}
		return tx.Bucket(bApplied).Delete([]byte(id))
	})
}

func (s *Store) SpecVersions() (map[string]uint64, error) {
	list, err := s.ListSpecs()
	if err != nil {
		return nil, err
	}
	out := make(map[string]uint64, len(list))
	for _, sp := range list {
		out[sp.ServerId] = sp.Version
	}
	return out, nil
}

func (s *Store) SetApplied(id string, v uint64) error {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, v)
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bApplied).Put([]byte(id), buf)
	})
}

func (s *Store) Applied(id string) (uint64, error) {
	var v uint64
	err := s.db.View(func(tx *bbolt.Tx) error {
		raw := tx.Bucket(bApplied).Get([]byte(id))
		if len(raw) == 8 {
			v = binary.BigEndian.Uint64(raw)
		}
		return nil
	})
	return v, err
}
```

- [ ] **Step 4: Ejecutar**

```bash
cd agent && go get go.etcd.io/bbolt@v1.5.0 && go mod tidy && go test ./internal/store/ -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): store bbolt de credenciales, specs y versiones aplicadas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Motor Docker (interfaz, implementación moby, fake)

**Files:**
- Create: `agent/internal/docker/engine.go`, `agent/internal/docker/moby.go`, `agent/internal/docker/fake.go`, `agent/internal/docker/fake_test.go`, `agent/internal/docker/moby_integration_test.go`

**Interfaces:**
- Produces:
```go
type Container struct { ID, Name, State string; Labels map[string]string }
type Inspect struct { ID, Name, State string; Running bool; Health string; ExitCode int; StartedAt time.Time; Labels map[string]string }
type Event struct { Action, ContainerID string; Labels map[string]string }
var ErrNotFound = errors.New("docker: no encontrado")
type Engine interface {
	Version(ctx context.Context) (string, error)
	EnsureNetwork(ctx context.Context, name string) error
	EnsureImage(ctx context.Context, ref string) error
	ListManaged(ctx context.Context) ([]Container, error)
	Inspect(ctx context.Context, id string) (*Inspect, error)
	Create(ctx context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeout time.Duration) error
	Kill(ctx context.Context, id string) error
	Remove(ctx context.Context, id string) error
	Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error)
	Events(ctx context.Context) (<-chan Event, <-chan error)
}
func NewMoby() (*Moby, error)
func NewFake() *Fake   // + campos públicos para inspección en tests
```

- [ ] **Step 1: Interfaz**

`agent/internal/docker/engine.go`:
```go
// Package docker aísla el SDK de Docker tras una interfaz pequeña y testeable.
package docker

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

var ErrNotFound = errors.New("docker: no encontrado")

type Container struct {
	ID     string
	Name   string
	State  string
	Labels map[string]string
}

type Inspect struct {
	ID        string
	Name      string
	State     string
	Running   bool
	Health    string
	ExitCode  int
	StartedAt time.Time
	Labels    map[string]string
}

type Event struct {
	Action      string
	ContainerID string
	Labels      map[string]string
}

type Engine interface {
	Version(ctx context.Context) (string, error)
	EnsureNetwork(ctx context.Context, name string) error
	EnsureImage(ctx context.Context, ref string) error
	ListManaged(ctx context.Context) ([]Container, error)
	Inspect(ctx context.Context, id string) (*Inspect, error)
	Create(ctx context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeout time.Duration) error
	Kill(ctx context.Context, id string) error
	Remove(ctx context.Context, id string) error
	// Logs sigue la salida del contenedor (follow) empezando por las últimas `tail` líneas,
	// con timestamps RFC3339Nano al inicio de cada línea.
	Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error)
	// Events emite eventos de contenedores con la etiqueta mcsm.managed=true hasta que ctx termina.
	Events(ctx context.Context) (<-chan Event, <-chan error)
}
```

- [ ] **Step 2: Test del fake (falla)**

`agent/internal/docker/fake_test.go`:
```go
package docker

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
)

func TestFakeLifecycle(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	if err := f.EnsureImage(ctx, "itzg/minecraft-server:java21"); err != nil {
		t.Fatal(err)
	}
	if f.Pulled[0] != "itzg/minecraft-server:java21" {
		t.Fatalf("pulled = %v", f.Pulled)
	}
	id, err := f.Create(ctx, "mcsm-a", &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "a"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := f.ListManaged(ctx)
	if len(list) != 1 || list[0].ID != id || list[0].State != "created" || list[0].Name != "mcsm-a" {
		t.Fatalf("list = %+v", list)
	}
	if err := f.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	ins, _ := f.Inspect(ctx, id)
	if !ins.Running || ins.State != "running" {
		t.Fatalf("inspect = %+v", ins)
	}
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	ins, _ = f.Inspect(ctx, id)
	if ins.Running || ins.State != "exited" {
		t.Fatalf("inspect tras stop = %+v", ins)
	}
	if err := f.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Inspect(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if f.Calls[len(f.Calls)-1] != "Remove "+id {
		t.Fatalf("calls = %v", f.Calls)
	}
}

func TestFakeCreateErrorAndNameConflict(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	f.CreateErr = errors.New("puerto ocupado")
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("esperaba error")
	}
	f.CreateErr = nil
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("nombre duplicado debe fallar")
	}
}

func TestFakeLogsAndEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := NewFake()
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.server_id": "a"}}, &container.HostConfig{}, nil)
	rc, err := f.Logs(ctx, id, 10)
	if err != nil {
		t.Fatal(err)
	}
	go f.WriteLog(id, "2026-10-12T00:00:00.000000000Z [Server] Done\n")
	buf := make([]byte, 128)
	n, _ := rc.Read(buf)
	if string(buf[:n]) != "2026-10-12T00:00:00.000000000Z [Server] Done\n" {
		t.Fatalf("log = %q", buf[:n])
	}
	rc.Close()
	if _, err := io.ReadAll(rc); err == nil {
		// cerrado: el siguiente Read devuelve error o EOF; cualquiera vale
	}
	evs, _ := f.Events(ctx)
	go f.EmitEvent(Event{Action: "die", ContainerID: id, Labels: map[string]string{"mcsm.server_id": "a"}})
	select {
	case ev := <-evs:
		if ev.Action != "die" || ev.ContainerID != id {
			t.Fatalf("ev = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("sin evento")
	}
}
```

- [ ] **Step 3: Fake**

`agent/internal/docker/fake.go`:
```go
package docker

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// Fake es un Engine en memoria para tests. Los campos exportados permiten
// inspeccionar llamadas e inyectar fallos.
type Fake struct {
	mu         sync.Mutex
	seq        int
	Containers map[string]*FakeContainer
	Images     map[string]bool
	Networks   map[string]bool
	Pulled     []string
	Calls      []string
	CreateErr  error
	StartErr   error
	logPipes   map[string][]*io.PipeWriter
	events     []chan Event
}

type FakeContainer struct {
	ID         string
	Name       string
	State      string
	Health     string
	ExitCode   int
	StartedAt  time.Time
	Config     *container.Config
	HostConfig *container.HostConfig
	Net        *network.NetworkingConfig
}

func NewFake() *Fake {
	return &Fake{Containers: map[string]*FakeContainer{}, Images: map[string]bool{}, Networks: map[string]bool{}, logPipes: map[string][]*io.PipeWriter{}}
}

func (f *Fake) record(format string, args ...any) {
	f.Calls = append(f.Calls, fmt.Sprintf(format, args...))
}

func (f *Fake) Version(context.Context) (string, error) { return "fake-29.0", nil }

func (f *Fake) EnsureNetwork(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Networks[name] = true
	f.record("EnsureNetwork %s", name)
	return nil
}

func (f *Fake) EnsureImage(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.Images[ref] {
		f.Images[ref] = true
		f.Pulled = append(f.Pulled, ref)
	}
	f.record("EnsureImage %s", ref)
	return nil
}

func (f *Fake) ListManaged(context.Context) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Container
	for _, c := range f.Containers {
		if c.Config != nil && c.Config.Labels["mcsm.managed"] == "true" {
			out = append(out, Container{ID: c.ID, Name: c.Name, State: c.State, Labels: c.Config.Labels})
		}
	}
	return out, nil
}

func (f *Fake) Inspect(_ context.Context, id string) (*Inspect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.Containers[id]
	if !ok {
		return nil, ErrNotFound
	}
	labels := map[string]string{}
	if c.Config != nil {
		labels = c.Config.Labels
	}
	return &Inspect{ID: c.ID, Name: c.Name, State: c.State, Running: c.State == "running", Health: c.Health, ExitCode: c.ExitCode, StartedAt: c.StartedAt, Labels: labels}, nil
}

func (f *Fake) Create(_ context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Create %s", name)
	if f.CreateErr != nil {
		return "", f.CreateErr
	}
	for _, c := range f.Containers {
		if c.Name == name {
			return "", fmt.Errorf("conflict: el nombre %q ya está en uso", name)
		}
	}
	f.seq++
	id := fmt.Sprintf("fake%04d", f.seq)
	f.Containers[id] = &FakeContainer{ID: id, Name: name, State: "created", Config: cfg, HostConfig: host, Net: net}
	return id, nil
}

func (f *Fake) Start(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Start %s", id)
	if f.StartErr != nil {
		return f.StartErr
	}
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	c.State, c.StartedAt, c.Health = "running", time.Now(), "starting"
	return nil
}

func (f *Fake) Stop(_ context.Context, id string, timeout time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Stop %s %s", id, timeout)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	c.State, c.Health, c.ExitCode = "exited", "", 0
	return nil
}

func (f *Fake) Kill(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Kill %s", id)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	c.State, c.Health, c.ExitCode = "exited", "", 137
	return nil
}

func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Remove %s", id)
	if _, ok := f.Containers[id]; !ok {
		return ErrNotFound
	}
	delete(f.Containers, id)
	for _, w := range f.logPipes[id] {
		w.Close()
	}
	delete(f.logPipes, id)
	return nil
}

func (f *Fake) Logs(_ context.Context, id string, tail int) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Logs %s %d", id, tail)
	if _, ok := f.Containers[id]; !ok {
		return nil, ErrNotFound
	}
	r, w := io.Pipe()
	f.logPipes[id] = append(f.logPipes[id], w)
	return r, nil
}

// WriteLog empuja una línea a todos los lectores de Logs del contenedor.
func (f *Fake) WriteLog(id, line string) {
	f.mu.Lock()
	ws := append([]*io.PipeWriter(nil), f.logPipes[id]...)
	f.mu.Unlock()
	for _, w := range ws {
		_, _ = io.WriteString(w, line)
	}
}

func (f *Fake) Events(ctx context.Context) (<-chan Event, <-chan error) {
	ch := make(chan Event, 16)
	errs := make(chan error, 1)
	f.mu.Lock()
	f.events = append(f.events, ch)
	f.mu.Unlock()
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, c := range f.events {
			if c == ch {
				f.events = append(f.events[:i], f.events[i+1:]...)
				break
			}
		}
	}()
	return ch, errs
}

// EmitEvent entrega un evento a todos los suscriptores de Events.
func (f *Fake) EmitEvent(ev Event) {
	f.mu.Lock()
	chans := append([]chan Event(nil), f.events...)
	f.mu.Unlock()
	for _, c := range chans {
		c <- ev
	}
}

// SetHealth permite a los tests simular el healthcheck.
func (f *Fake) SetHealth(id, health string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.Health = health
	}
}
```

- [ ] **Step 4: Ejecutar tests del fake**

```bash
cd agent && go test ./internal/docker/ -run Fake -v
```
Expected: PASS.

- [ ] **Step 5: Implementación real**

`agent/internal/docker/moby.go`:
```go
package docker

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// Moby implementa Engine sobre github.com/moby/moby/client.
type Moby struct{ cli *client.Client }

func NewMoby() (*Moby, error) {
	cli, err := client.New(client.FromEnv)
	if err != nil {
		return nil, fmt.Errorf("docker: crear cliente: %w", err)
	}
	return &Moby{cli: cli}, nil
}

func (m *Moby) Version(ctx context.Context) (string, error) {
	v, err := m.cli.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return "", err
	}
	return v.Version, nil
}

func (m *Moby) EnsureNetwork(ctx context.Context, name string) error {
	if _, err := m.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{}); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return err
	}
	_, err := m.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: "bridge"})
	return err
}

func (m *Moby) EnsureImage(ctx context.Context, ref string) error {
	if _, err := m.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return err
	}
	resp, err := m.cli.ImagePull(ctx, ref, client.ImagePullOptions{})
	if err != nil {
		return fmt.Errorf("docker: pull %s: %w", ref, err)
	}
	defer resp.Close()
	return resp.Wait(ctx)
}

func (m *Moby) ListManaged(ctx context.Context) ([]Container, error) {
	res, err := m.cli.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: client.Filters{}.Add("label", "mcsm.managed=true"),
	})
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

func (m *Moby) Inspect(ctx context.Context, id string) (*Inspect, error) {
	res, err := m.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c := res.Container
	out := &Inspect{ID: c.ID, Name: strings.TrimPrefix(c.Name, "/")}
	if c.Config != nil {
		out.Labels = c.Config.Labels
	}
	if c.State != nil {
		out.State = string(c.State.Status)
		out.Running = c.State.Running
		out.ExitCode = c.State.ExitCode
		if c.State.Health != nil {
			out.Health = string(c.State.Health.Status)
		}
		if t, err := time.Parse(time.RFC3339Nano, c.State.StartedAt); err == nil && t.Unix() > 0 {
			out.StartedAt = t
		}
	}
	return out, nil
}

func (m *Moby) Create(ctx context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error) {
	res, err := m.cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: cfg, HostConfig: host, NetworkingConfig: net})
	if err != nil {
		return "", err
	}
	return res.ID, nil
}

func (m *Moby) Start(ctx context.Context, id string) error {
	_, err := m.cli.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return notFound(err)
}

func (m *Moby) Stop(ctx context.Context, id string, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	_, err := m.cli.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &secs})
	return notFound(err)
}

func (m *Moby) Kill(ctx context.Context, id string) error {
	_, err := m.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: "SIGKILL"})
	return notFound(err)
}

func (m *Moby) Remove(ctx context.Context, id string) error {
	_, err := m.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true})
	return notFound(err)
}

func (m *Moby) Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error) {
	rc, err := m.cli.ContainerLogs(ctx, id, client.ContainerLogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true, Tail: strconv.Itoa(tail),
	})
	if err != nil {
		return nil, notFound(err)
	}
	return rc, nil
}

func (m *Moby) Events(ctx context.Context) (<-chan Event, <-chan error) {
	res := m.cli.Events(ctx, client.EventsListOptions{
		Filters: client.Filters{}.Add("type", "container").Add("label", "mcsm.managed=true"),
	})
	out := make(chan Event, 32)
	errs := make(chan error, 1)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-res.Err:
				if err != nil {
					errs <- err
				}
				return
			case msg := <-res.Messages:
				out <- Event{Action: string(msg.Action), ContainerID: msg.Actor.ID, Labels: msg.Actor.Attributes}
			}
		}
	}()
	return out, errs
}

func notFound(err error) error {
	if err != nil && cerrdefs.IsNotFound(err) {
		return ErrNotFound
	}
	return err
}
```

- [ ] **Step 6: Test de integración (etiqueta `integration`, Docker real)**

`agent/internal/docker/moby_integration_test.go`:
```go
//go:build integration

package docker

import (
	"bufio"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

func TestMobyLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if v, err := m.Version(ctx); err != nil || v == "" {
		t.Fatalf("version: %q %v", v, err)
	}
	if err := m.EnsureNetwork(ctx, "mcsm-test"); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	name := "mcsm-inttest"
	if old, err := m.ListManaged(ctx); err == nil {
		for _, c := range old {
			if c.Name == name {
				_ = m.Remove(ctx, c.ID)
			}
		}
	}
	id, err := m.Create(ctx, name,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sh", "-c", "echo hola; sleep 300"}, Tty: true, Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "int"}},
		&container.HostConfig{},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"mcsm-test": {}}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	ins, err := m.Inspect(ctx, id)
	if err != nil || !ins.Running || ins.Name != name {
		t.Fatalf("inspect = %+v, %v", ins, err)
	}
	rc, err := m.Logs(ctx, id, 10)
	if err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(rc).ReadString('\n')
	rc.Close()
	if !strings.Contains(line, "hola") || !strings.Contains(line, "T") {
		t.Fatalf("log sin timestamp o sin contenido: %q", line)
	}
	list, _ := m.ListManaged(ctx)
	found := false
	for _, c := range list {
		found = found || c.ID == id
	}
	if !found {
		t.Fatal("ListManaged no devuelve el contenedor")
	}
	if err := m.Stop(ctx, id, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	ins, _ = m.Inspect(ctx, id)
	if ins.Running {
		t.Fatal("debería estar parado")
	}
	if err := m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Inspect(ctx, id); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 7: Ejecutar**

```bash
cd agent && go get github.com/containerd/errdefs@v1.0.0 && go mod tidy && go vet ./... && go test ./internal/docker/ && go test -tags integration ./internal/docker/ -run TestMobyLifecycle -v
```
Expected: ambos PASS. Si `ContainerStopOptions.Timeout` no es `*int`, mira `go doc github.com/moby/moby/client.ContainerStopOptions` y ajusta el tipo.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(agent): motor Docker con interfaz Engine, implementación moby y fake para tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Ping de estado y RCON

**Files:**
- Create: `agent/internal/mc/mc.go`, `agent/internal/mc/mc_test.go`

**Interfaces:**
- Produces: `mc.Status(ctx context.Context, host string, port uint16) *mcsmv1.McStatus` (nunca falla: si no responde, `Online=false`), `mc.Rcon(ctx context.Context, host string, port uint16, password, command string) (string, error)`, `type mc.StatusFunc = func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus`.

- [ ] **Step 1: Test con servidor RCON falso (falla)**

`agent/internal/mc/mc_test.go`:
```go
package mc

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// fakeRcon implementa lo justo del protocolo Source RCON:
// paquete = int32 longitud, int32 id, int32 tipo, cuerpo\0, \0
func fakeRcon(t *testing.T, password string) (host string, port uint16) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				authed := false
				for {
					var size int32
					if err := binary.Read(c, binary.LittleEndian, &size); err != nil {
						return
					}
					buf := make([]byte, size)
					if _, err := io.ReadFull(c, buf); err != nil {
						return
					}
					id := int32(binary.LittleEndian.Uint32(buf[0:4]))
					typ := int32(binary.LittleEndian.Uint32(buf[4:8]))
					body := string(buf[8 : len(buf)-2])
					write := func(id, typ int32, body string) {
						payload := make([]byte, 0, 10+len(body))
						payload = binary.LittleEndian.AppendUint32(payload, uint32(id))
						payload = binary.LittleEndian.AppendUint32(payload, uint32(typ))
						payload = append(payload, body...)
						payload = append(payload, 0, 0)
						_ = binary.Write(c, binary.LittleEndian, int32(len(payload)))
						c.Write(payload)
					}
					switch typ {
					case 3: // login
						if body == password {
							authed = true
							write(id, 2, "")
						} else {
							write(-1, 2, "")
						}
					case 2: // command
						if !authed {
							return
						}
						write(id, 0, "ok:"+body)
					}
				}
			}(conn)
		}
	}()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(p)
	return "127.0.0.1", uint16(n)
}

func TestRcon(t *testing.T) {
	host, port := fakeRcon(t, "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := Rcon(ctx, host, port, "secret", "list")
	if err != nil {
		t.Fatal(err)
	}
	if out != "ok:list" {
		t.Fatalf("out = %q", out)
	}
	if _, err := Rcon(ctx, host, port, "wrong", "list"); err == nil {
		t.Fatal("contraseña incorrecta debe fallar")
	}
}

func TestStatusOffline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	st := Status(ctx, "127.0.0.1", 1) // nadie escucha
	if st.Online {
		t.Fatal("debería estar offline")
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("el ping no debe tardar más que su timeout")
	}
}
```

- [ ] **Step 2: Implementación**

`agent/internal/mc/mc.go`:
```go
// Package mc habla con el servidor de Minecraft: ping de estado y RCON.
package mc

import (
	"context"
	"fmt"
	"time"

	"github.com/mcstatus-io/mcutil/v4/options"
	"github.com/mcstatus-io/mcutil/v4/rcon"
	"github.com/mcstatus-io/mcutil/v4/status"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

const statusTimeout = 3 * time.Second

type StatusFunc = func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus

// Status hace un Server List Ping. Nunca devuelve error: un servidor que no
// responde se reporta como Online=false.
func Status(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	st, err := status.Modern(ctx, host, port, options.StatusModern{Timeout: statusTimeout})
	if err != nil || st == nil {
		return &mcsmv1.McStatus{Online: false}
	}
	out := &mcsmv1.McStatus{
		Online:    true,
		Version:   st.Version.NameClean,
		LatencyMs: uint32(st.Latency.Milliseconds()),
	}
	if st.Players.Online != nil {
		out.PlayersOnline = uint32(*st.Players.Online)
	}
	if st.Players.Max != nil {
		out.PlayersMax = uint32(*st.Players.Max)
	}
	return out
}

// Rcon ejecuta un comando y devuelve la salida.
func Rcon(ctx context.Context, host string, port uint16, password, command string) (string, error) {
	c, err := rcon.Dial(host, port, options.RCON{Timeout: 5 * time.Second})
	if err != nil {
		return "", fmt.Errorf("rcon: conectar: %w", err)
	}
	defer c.Close()
	if err := c.Login(password); err != nil {
		return "", fmt.Errorf("rcon: login: %w", err)
	}
	out, err := c.Execute(ctx, command)
	if err != nil {
		return "", fmt.Errorf("rcon: ejecutar: %w", err)
	}
	return out, nil
}
```
Nota: comprueba con `go doc github.com/mcstatus-io/mcutil/v4/response.Players` si `Online`/`Max` son punteros o enteros, y con `go doc .../options.StatusModern` el nombre del campo de timeout; ajusta las cuatro líneas afectadas.

- [ ] **Step 3: Ejecutar**

```bash
cd agent && go get github.com/mcstatus-io/mcutil/v4@v4.3.1 && go mod tidy && go test ./internal/mc/ -v
```
Expected: PASS (dos tests).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(agent): ping de estado y cliente RCON

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Reconciliador

**Files:**
- Create: `agent/internal/reconcile/reconciler.go`, `agent/internal/reconcile/reconciler_test.go`

**Interfaces:**
- Consumes: `store.Store`, `docker.Engine`, `spec.BuildContainer`, `mc.StatusFunc`.
- Produces:
```go
type Observer func(serverID string, obs *mcsmv1.Observed)
type Reconciler struct { ... }
func New(st *store.Store, eng docker.Engine, dataRoot, network string, status mc.StatusFunc, obs Observer) *Reconciler
func (r *Reconciler) ReconcileAll(ctx context.Context)
func (r *Reconciler) Reconcile(ctx context.Context, serverID string) error
func (r *Reconciler) Remove(ctx context.Context, serverID string, deleteData bool) error
func (r *Reconciler) Power(ctx context.Context, serverID string, action mcsmv1.PowerActionType) error
func (r *Reconciler) Observe(ctx context.Context, serverID string) *mcsmv1.Observed
func (r *Reconciler) ContainerID(ctx context.Context, serverID string) string   // "" si no existe
const StopTimeout = 60 * time.Second
```
Semántica: `Reconcile` serializa por servidor (un mutex por id). Tras un fallo, `ReconcileAll` no reintenta ese servidor hasta `retryAt` (backoff 30 s · 2^n, máx. 5 min). `Power` actualiza `DesiredState` en el store antes de actuar. `Observe` siempre invoca al `Observer`.

- [ ] **Step 1: Test (falla)**

`agent/internal/reconcile/reconciler_test.go`:
```go
package reconcile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

const specJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

type recorder struct {
	mu  sync.Mutex
	obs map[string]*mcsmv1.Observed
}

func (r *recorder) fn(id string, o *mcsmv1.Observed) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.obs[id] = o
}

func (r *recorder) get(id string) *mcsmv1.Observed {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.obs[id]
}

func stubStatus(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
	return &mcsmv1.McStatus{Online: true, PlayersOnline: 2, PlayersMax: 10, Version: "1.21.4"}
}

func setup(t *testing.T) (*Reconciler, *store.Store, *docker.Fake, *recorder, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	rec := &recorder{obs: map[string]*mcsmv1.Observed{}}
	root := filepath.Join(dir, "data")
	r := New(st, fake, root, "mcsm", stubStatus, rec.fn)
	r.now = func() time.Time { return time.Unix(1_000_000, 0) }
	return r, st, fake, rec, root
}

func put(t *testing.T, st *store.Store, id, slug string, v uint64, desired mcsmv1.DesiredState, js string) {
	t.Helper()
	if err := st.PutSpec(&mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: desired, SpecJson: []byte(js)}); err != nil {
		t.Fatal(err)
	}
}

func calls(f *docker.Fake, prefix string) int {
	n := 0
	for _, c := range f.Calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func TestCreateAndStart(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha", "data")); err != nil {
		t.Fatal("debe crear el directorio de datos")
	}
	if fake.Pulled[0] != "itzg/minecraft-server:java21" {
		t.Fatalf("pulled = %v", fake.Pulled)
	}
	list, _ := fake.ListManaged(context.Background())
	if len(list) != 1 || list[0].Name != "mcsm-alpha" || list[0].State != "running" {
		t.Fatalf("list = %+v", list)
	}
	obs := rec.get("a")
	if obs == nil || obs.State != "running" || obs.AppliedVersion != 1 || obs.Error != "" || !obs.Mc.Online || obs.Mc.PlayersOnline != 2 {
		t.Fatalf("obs = %+v", obs)
	}
}

func TestCreateStopped(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if calls(fake, "Start") != 0 {
		t.Fatal("no debe arrancar un servidor deseado parado")
	}
	if rec.get("a").State != "created" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
}

func TestNoopWhenUnchanged(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	before := len(fake.Calls)
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON) // misma spec, otra versión
	_ = r.Reconcile(context.Background(), "a")
	if calls(fake, "Create") != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("no debería recrear; calls tras la 1ª: %v", fake.Calls[before:])
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
}

func TestRecreateWhenSpecChanges(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	changed := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, changed)
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(fake.Calls, ";")
	if !strings.Contains(joined, "Stop fake0001 1m0s;Remove fake0001;EnsureImage itzg/minecraft-server:java21;Create mcsm-alpha;Start fake0002") {
		t.Fatalf("secuencia inesperada: %v", fake.Calls)
	}
}

func TestStartWhenStoppedButDesiredRunning(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	id := r.ContainerID(context.Background(), "a")
	_ = fake.Stop(context.Background(), id, time.Second) // alguien lo paró a mano
	_ = r.Reconcile(context.Background(), "a")
	ins, _ := fake.Inspect(context.Background(), id)
	if !ins.Running {
		t.Fatal("debe volver a arrancarlo")
	}
}

func TestErrorIsObservedAndRetriedWithBackoff(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	fake.CreateErr = errors.New("driver failed programming external connectivity: port is already allocated")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err == nil {
		t.Fatal("esperaba error")
	}
	if !strings.Contains(rec.get("a").Error, "already allocated") || rec.get("a").State != "missing" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
	n := calls(fake, "Create")
	r.ReconcileAll(context.Background()) // dentro del backoff: no reintenta
	if calls(fake, "Create") != n {
		t.Fatal("no debe reintentar antes de retryAt")
	}
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	fake.CreateErr = nil
	r.ReconcileAll(context.Background())
	if calls(fake, "Create") != n+1 || rec.get("a").Error != "" || rec.get("a").State != "running" {
		t.Fatalf("tras el backoff debe reintentar y limpiar el error: %+v calls=%v", rec.get("a"), fake.Calls)
	}
}

func TestRemove(t *testing.T) {
	r, st, fake, _, root := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if err := r.Remove(context.Background(), "a", false); err != nil {
		t.Fatal(err)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("debe borrar el contenedor")
	}
	if _, err := os.Stat(filepath.Join(root, "alpha")); err != nil {
		t.Fatal("sin deleteData el directorio se conserva")
	}
	put(t, st, "b", "beta", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(context.Background(), "b")
	_ = r.Remove(context.Background(), "b", true)
	if _, err := os.Stat(filepath.Join(root, "beta")); !os.IsNotExist(err) {
		t.Fatal("con deleteData el directorio se borra")
	}
}

func TestPowerUpdatesDesiredState(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if err := r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
	sp, _ := st.GetSpec("a")
	if sp.DesiredState != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatal("STOP debe persistir desired=stopped")
	}
	_ = r.Reconcile(context.Background(), "a") // no debe volver a arrancarlo
	if rec.get("a").State != "exited" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
	_ = r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART)
	if rec.get("a").State != "running" || calls(fake, "Start") != 2 {
		t.Fatalf("restart: obs=%+v calls=%v", rec.get("a"), fake.Calls)
	}
	_ = r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL)
	if rec.get("a").State != "exited" || rec.get("a").ExitCode != 137 {
		t.Fatalf("kill: obs=%+v", rec.get("a"))
	}
}

func TestObserveMissingSpec(t *testing.T) {
	r, _, _, _, _ := setup(t)
	obs := r.Observe(context.Background(), "nope")
	if obs.State != "missing" {
		t.Fatalf("obs = %+v", obs)
	}
}
```

- [ ] **Step 2: Ejecutar (falla)**

```bash
cd agent && go test ./internal/reconcile/
```

- [ ] **Step 3: Implementación**

`agent/internal/reconcile/reconciler.go`:
```go
// Package reconcile mantiene los contenedores Docker iguales a las specs del store.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const (
	StopTimeout  = 60 * time.Second
	baseBackoff  = 30 * time.Second
	maxBackoff   = 5 * time.Minute
)

type Observer func(serverID string, obs *mcsmv1.Observed)

type Reconciler struct {
	st       *store.Store
	eng      docker.Engine
	dataRoot string
	network  string
	status   mc.StatusFunc
	observer Observer
	log      *slog.Logger

	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	retryAt map[string]time.Time
	fails   map[string]int
	now     func() time.Time
}

func New(st *store.Store, eng docker.Engine, dataRoot, network string, status mc.StatusFunc, obs Observer) *Reconciler {
	if obs == nil {
		obs = func(string, *mcsmv1.Observed) {}
	}
	return &Reconciler{
		st: st, eng: eng, dataRoot: dataRoot, network: network, status: status, observer: obs,
		log:   slog.Default().With("component", "reconcile"),
		locks: map[string]*sync.Mutex{}, retryAt: map[string]time.Time{}, fails: map[string]int{},
		now:   time.Now,
	}
}

func (r *Reconciler) lock(id string) func() {
	r.mu.Lock()
	m, ok := r.locks[id]
	if !ok {
		m = &sync.Mutex{}
		r.locks[id] = m
	}
	r.mu.Unlock()
	m.Lock()
	return m.Unlock
}

// ReconcileAll recorre todas las specs, saltando las que están en backoff.
func (r *Reconciler) ReconcileAll(ctx context.Context) {
	specs, err := r.st.ListSpecs()
	if err != nil {
		r.log.Error("listar specs", "err", err)
		return
	}
	for _, sp := range specs {
		r.mu.Lock()
		until, waiting := r.retryAt[sp.ServerId]
		r.mu.Unlock()
		if waiting && r.now().Before(until) {
			continue
		}
		if err := r.Reconcile(ctx, sp.ServerId); err != nil {
			r.log.Warn("reconciliar", "server", sp.Slug, "err", err)
		}
	}
}

// Reconcile aplica la spec de un servidor y siempre publica el estado observado.
func (r *Reconciler) Reconcile(ctx context.Context, serverID string) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	defer func() {
		obs := r.observeLocked(ctx, serverID)
		if err != nil {
			obs.Error = err.Error()
			r.markFailure(serverID)
		} else {
			r.clearFailure(serverID)
		}
		r.observer(serverID, obs)
	}()

	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return nil
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return err
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, r.dataRoot, r.network)
	if err != nil {
		return err
	}
	wantRunning := sp.DesiredState == mcsmv1.DesiredState_DESIRED_STATE_RUNNING

	existing, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if existing != nil && existing.Labels[spec.LabelHash] != build.Hash {
		r.log.Info("spec cambiada, recreando contenedor", "server", sp.Slug)
		if existing.State == "running" || existing.State == "restarting" || existing.State == "paused" {
			if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return fmt.Errorf("parar: %w", err)
			}
		}
		if err := r.eng.Remove(ctx, existing.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("eliminar: %w", err)
		}
		existing = nil
	}
	if existing == nil {
		if err := os.MkdirAll(build.DataDir, 0o755); err != nil {
			return fmt.Errorf("crear directorio de datos: %w", err)
		}
		if err := r.eng.EnsureImage(ctx, build.Config.Image); err != nil {
			return err
		}
		id, err := r.eng.Create(ctx, build.Name, build.Config, build.HostConfig, build.Networking)
		if err != nil {
			return fmt.Errorf("crear contenedor: %w", err)
		}
		existing = &docker.Container{ID: id, Name: build.Name, State: "created", Labels: build.Config.Labels}
	}
	switch {
	case wantRunning && existing.State != "running" && existing.State != "restarting":
		if err := r.eng.Start(ctx, existing.ID); err != nil {
			return fmt.Errorf("arrancar: %w", err)
		}
	case !wantRunning && (existing.State == "running" || existing.State == "restarting" || existing.State == "paused"):
		if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil {
			return fmt.Errorf("parar: %w", err)
		}
	}
	return r.st.SetApplied(serverID, sp.Version)
}

// Remove para y borra el contenedor; con deleteData borra también <dataRoot>/<slug>.
func (r *Reconciler) Remove(ctx context.Context, serverID string, deleteData bool) error {
	unlock := r.lock(serverID)
	defer unlock()
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c != nil {
		if c.State == "running" {
			_ = r.eng.Stop(ctx, c.ID, StopTimeout)
		}
		if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return err
		}
	}
	if deleteData {
		sp, _ := r.st.GetSpec(serverID)
		slug := ""
		if sp != nil {
			slug = sp.Slug
		} else if c != nil {
			slug = c.Labels[spec.LabelSlug]
		}
		if slug != "" {
			if err := os.RemoveAll(filepath.Join(r.dataRoot, slug)); err != nil {
				return fmt.Errorf("borrar datos: %w", err)
			}
		}
	}
	r.clearFailure(serverID)
	return nil
}

// Power actualiza el estado deseado en el store y ejecuta la acción.
func (r *Reconciler) Power(ctx context.Context, serverID string, action mcsmv1.PowerActionType) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	defer func() {
		obs := r.observeLocked(ctx, serverID)
		if err != nil {
			obs.Error = err.Error()
		}
		r.observer(serverID, obs)
	}()
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return fmt.Errorf("servidor %s desconocido", serverID)
	}
	desired := sp.DesiredState
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START, mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART:
		desired = mcsmv1.DesiredState_DESIRED_STATE_RUNNING
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP, mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		desired = mcsmv1.DesiredState_DESIRED_STATE_STOPPED
	default:
		return fmt.Errorf("acción desconocida %v", action)
	}
	if desired != sp.DesiredState {
		sp.DesiredState = desired
		if err := r.st.PutSpec(sp); err != nil {
			return err
		}
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c == nil {
		return fmt.Errorf("el contenedor no existe todavía; aplica la spec primero")
	}
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START:
		if c.State != "running" {
			return r.eng.Start(ctx, c.ID)
		}
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP:
		if c.State == "running" || c.State == "restarting" || c.State == "paused" {
			return r.eng.Stop(ctx, c.ID, StopTimeout)
		}
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART:
		if c.State == "running" {
			if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil {
				return err
			}
		}
		return r.eng.Start(ctx, c.ID)
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		if c.State == "running" || c.State == "restarting" || c.State == "paused" {
			return r.eng.Kill(ctx, c.ID)
		}
	}
	return nil
}

// Observe calcula el estado real y lo publica.
func (r *Reconciler) Observe(ctx context.Context, serverID string) *mcsmv1.Observed {
	unlock := r.lock(serverID)
	obs := r.observeLocked(ctx, serverID)
	unlock()
	r.observer(serverID, obs)
	return obs
}

func (r *Reconciler) ContainerID(ctx context.Context, serverID string) string {
	c, err := r.find(ctx, serverID)
	if err != nil || c == nil {
		return ""
	}
	return c.ID
}

func (r *Reconciler) observeLocked(ctx context.Context, serverID string) *mcsmv1.Observed {
	obs := &mcsmv1.Observed{State: "missing", Mc: &mcsmv1.McStatus{}}
	obs.AppliedVersion, _ = r.st.Applied(serverID)
	c, err := r.find(ctx, serverID)
	if err != nil {
		obs.Error = err.Error()
		return obs
	}
	if c == nil {
		return obs
	}
	ins, err := r.eng.Inspect(ctx, c.ID)
	if err != nil {
		if errors.Is(err, docker.ErrNotFound) {
			return obs
		}
		obs.Error = err.Error()
		return obs
	}
	obs.ContainerId = ins.ID
	obs.State = ins.State
	obs.Health = ins.Health
	obs.ExitCode = int32(ins.ExitCode)
	if !ins.StartedAt.IsZero() {
		obs.StartedAtUnix = ins.StartedAt.Unix()
	}
	if ins.Running && r.status != nil {
		obs.Mc = r.status(ctx, spec.ContainerName(ins.Labels[spec.LabelSlug]), uint16(spec.GamePort))
	}
	return obs
}

func (r *Reconciler) find(ctx context.Context, serverID string) (*docker.Container, error) {
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

func (r *Reconciler) markFailure(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := r.fails[id]
	wait := baseBackoff << n
	if wait > maxBackoff || wait <= 0 {
		wait = maxBackoff
	}
	r.fails[id] = n + 1
	r.retryAt[id] = r.now().Add(wait)
}

func (r *Reconciler) clearFailure(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.fails, id)
	delete(r.retryAt, id)
}
```

- [ ] **Step 4: Ejecutar**

```bash
cd agent && go vet ./... && go test ./internal/reconcile/ -v
```
Expected: 9 tests PASS. Los nombres de los `Calls` del fake deben coincidir exactamente con la secuencia esperada en `TestRecreateWhenSpecChanges`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): reconciliador de specs contra Docker con backoff y acciones de power

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Hub de logs

**Files:**
- Create: `agent/internal/logs/hub.go`, `agent/internal/logs/hub_test.go`

**Interfaces:**
- Consumes: `docker.Engine.Logs`.
- Produces:
```go
type Line struct { TS time.Time; Text string }
type Hub struct { ... }
func NewHub(eng docker.Engine) *Hub
func (h *Hub) Subscribe(serverID, containerID string, tail int) (<-chan Line, func(), error)
func (h *Hub) Reset(serverID string)       // cierra el follower (p. ej. contenedor recreado)
func (h *Hub) SetGrace(d time.Duration)    // por defecto 30 s
```
El canal devuelto se cierra cuando el follower muere (EOF del stream, `Reset`, contenedor borrado). El suscriptor nuevo recibe primero el buffer circular (hasta 500 líneas) y luego las nuevas. Si el `containerID` cambia respecto al follower actual, el follower viejo se cierra y se abre uno nuevo.

- [ ] **Step 1: Test (falla)**

`agent/internal/logs/hub_test.go`:
```go
package logs

import (
	"context"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	"mcsm/agent/internal/docker"
)

func newFakeWithContainer(t *testing.T) (*docker.Fake, string) {
	f := docker.NewFake()
	id, err := f.Create(context.Background(), "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return f, id
}

func recv(t *testing.T, ch <-chan Line) Line {
	t.Helper()
	select {
	case l, ok := <-ch:
		if !ok {
			t.Fatal("canal cerrado")
		}
		return l
	case <-time.After(2 * time.Second):
		t.Fatal("timeout esperando línea")
	}
	return Line{}
}

func TestSubscribeParsesTimestamps(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, err := h.Subscribe("a", id, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id, "2026-10-12T10:00:00.123456789Z [10:00:00] [Server thread/INFO]: Done (3.2s)!\n")
	l := recv(t, ch)
	if l.Text != "[10:00:00] [Server thread/INFO]: Done (3.2s)!" {
		t.Fatalf("text = %q", l.Text)
	}
	if l.TS.UTC().Format(time.RFC3339) != "2026-10-12T10:00:00Z" {
		t.Fatalf("ts = %v", l.TS)
	}
}

func TestReplayAndSharedFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch1, unsub1, _ := h.Subscribe("a", id, 100)
	defer unsub1()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id, "2026-10-12T10:00:00Z uno\n2026-10-12T10:00:01Z dos\n")
	recv(t, ch1)
	recv(t, ch1)
	ch2, unsub2, _ := h.Subscribe("a", id, 100)
	defer unsub2()
	if got := recv(t, ch2).Text; got != "uno" {
		t.Fatalf("replay[0] = %q", got)
	}
	if got := recv(t, ch2).Text; got != "dos" {
		t.Fatalf("replay[1] = %q", got)
	}
	calls := 0
	for _, c := range f.Calls {
		if len(c) >= 4 && c[:4] == "Logs" {
			calls++
		}
	}
	if calls != 1 {
		t.Fatalf("debe compartir un único follower; Logs llamado %d veces", calls)
	}
}

func TestGraceClosesFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(20 * time.Millisecond)
	_, unsub, _ := h.Subscribe("a", id, 10)
	unsub()
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	_, alive := h.followers["a"]
	h.mu.Unlock()
	if alive {
		t.Fatal("el follower debe cerrarse pasado el periodo de gracia")
	}
}

func TestResetClosesSubscribers(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	defer unsub()
	h.Reset("a")
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("esperaba canal cerrado")
		}
	case <-time.After(time.Second):
		t.Fatal("el canal debería cerrarse tras Reset")
	}
}

func TestContainerIDChangeReopens(t *testing.T) {
	f, id := newFakeWithContainer(t)
	id2, _ := f.Create(context.Background(), "mcsm-b", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	h := NewHub(f)
	_, unsub1, _ := h.Subscribe("a", id, 10)
	defer unsub1()
	ch2, unsub2, _ := h.Subscribe("a", id2, 10)
	defer unsub2()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id2, "2026-10-12T10:00:00Z nuevo\n")
	if got := recv(t, ch2).Text; got != "nuevo" {
		t.Fatalf("got %q", got)
	}
}
```

- [ ] **Step 2: Implementación**

`agent/internal/logs/hub.go`:
```go
// Package logs sigue los logs de los contenedores y los reparte a suscriptores.
package logs

import (
	"bufio"
	"context"
	"strings"
	"sync"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	ringSize   = 500
	subBuffer  = 1024
	defaultGrace = 30 * time.Second
)

type Line struct {
	TS   time.Time
	Text string
}

type Hub struct {
	eng       docker.Engine
	mu        sync.Mutex
	followers map[string]*follower
	grace     time.Duration
}

type follower struct {
	hub         *Hub
	serverID    string
	containerID string
	cancel      context.CancelFunc
	mu          sync.Mutex
	ring        []Line
	subs        map[int]chan Line
	nextSub     int
	closed      bool
	graceTimer  *time.Timer
}

func NewHub(eng docker.Engine) *Hub {
	return &Hub{eng: eng, followers: map[string]*follower{}, grace: defaultGrace}
}

func (h *Hub) SetGrace(d time.Duration) { h.grace = d }

func (h *Hub) Subscribe(serverID, containerID string, tail int) (<-chan Line, func(), error) {
	h.mu.Lock()
	f, ok := h.followers[serverID]
	if ok && f.containerID != containerID {
		f.close()
		delete(h.followers, serverID)
		ok = false
	}
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		rc, err := h.eng.Logs(ctx, containerID, tail)
		if err != nil {
			cancel()
			h.mu.Unlock()
			return nil, nil, err
		}
		f = &follower{hub: h, serverID: serverID, containerID: containerID, cancel: cancel, subs: map[int]chan Line{}}
		h.followers[serverID] = f
		go f.run(ctx, rc)
	}
	h.mu.Unlock()
	return f.subscribe()
}

func (h *Hub) Reset(serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.followers[serverID]; ok {
		f.close()
		delete(h.followers, serverID)
	}
}

func (f *follower) subscribe() (<-chan Line, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	ch := make(chan Line, subBuffer)
	for _, l := range f.ring {
		ch <- l
	}
	if f.closed {
		close(ch)
		return ch, func() {}, nil
	}
	id := f.nextSub
	f.nextSub++
	f.subs[id] = ch
	var once sync.Once
	unsub := func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			delete(f.subs, id)
			if len(f.subs) == 0 && !f.closed {
				f.graceTimer = time.AfterFunc(f.hub.grace, func() {
					f.mu.Lock()
					idle := len(f.subs) == 0
					f.mu.Unlock()
					if idle {
						f.hub.Reset(f.serverID)
					}
				})
			}
		})
	}
	return ch, unsub, nil
}

func (f *follower) run(ctx context.Context, rc interface {
	Read([]byte) (int, error)
	Close() error
}) {
	defer rc.Close()
	go func() { <-ctx.Done(); rc.Close() }()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		f.publish(parseLine(sc.Text()))
	}
	f.hub.Reset(f.serverID)
}

func (f *follower) publish(l Line) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ring) == ringSize {
		copy(f.ring, f.ring[1:])
		f.ring = f.ring[:ringSize-1]
	}
	f.ring = append(f.ring, l)
	for _, ch := range f.subs {
		select {
		case ch <- l:
		default: // suscriptor lento: se descarta la línea para no bloquear al resto
		}
	}
}

func (f *follower) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.closed = true
	f.cancel()
	for id, ch := range f.subs {
		close(ch)
		delete(f.subs, id)
	}
}

// parseLine separa el timestamp RFC3339Nano que añade Docker ("2026-...Z texto").
// Las líneas de TTY pueden traer \r al final; se elimina.
func parseLine(raw string) Line {
	raw = strings.TrimRight(raw, "\r")
	ts, rest, ok := strings.Cut(raw, " ")
	if ok {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			return Line{TS: t, Text: rest}
		}
	}
	return Line{TS: time.Now(), Text: raw}
}
```

- [ ] **Step 3: Ejecutar**

```bash
cd agent && go vet ./... && go test ./internal/logs/ -race -v
```
Expected: 5 tests PASS sin carreras.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(agent): hub de logs con follower compartido, buffer circular y periodo de gracia

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Conexión al panel (alta HTTP + WebSocket con reconexión)

**Files:**
- Create: `agent/internal/conn/enroll.go`, `agent/internal/conn/client.go`, `agent/internal/conn/conn_test.go`

**Interfaces:**
- Produces:
```go
type EnrollResult struct { NodeID string `json:"nodeId"`; NodeToken string `json:"nodeToken"` }
func Enroll(ctx context.Context, panelURL, enrollToken, nameHint, agentVersion string) (*EnrollResult, error)

type Handler interface { Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) }
type HelloFunc func(ctx context.Context) *mcsmv1.Hello
type Options struct { PanelURL, Token string; Hello HelloFunc; Handler Handler; OnDisconnect func(); Log *slog.Logger }
func NewClient(o Options) *Client
func (c *Client) Run(ctx context.Context)          // bucle de reconexión hasta ctx.Done()
func (c *Client) Send(ctx context.Context, env *mcsmv1.Envelope) error  // ErrNotConnected si no hay sesión
func (c *Client) Connected() bool
var ErrNotConnected = errors.New("conn: sin conexión con el panel")
```
Protocolo: `GET <panel>/agent/ws` con `Authorization: Bearer <token>`; el primer mensaje enviado es `Envelope{id:1, hello}`. Mensajes binarios protobuf. Ping cada 15 s; límite de lectura 4 MiB. Backoff 1 s → 30 s con jitter ±20 %.

- [ ] **Step 1: Test (falla)**

`agent/internal/conn/conn_test.go`:
```go
package conn

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestEnroll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/enroll" || r.Method != http.MethodPost {
			t.Errorf("ruta %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["enrollToken"] != "ENR" || body["nameHint"] != "nas" || body["agentVersion"] != "0.1.0" {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"nodeId": "n1", "nodeToken": "TOK"})
	}))
	defer srv.Close()
	res, err := Enroll(context.Background(), srv.URL, "ENR", "nas", "0.1.0")
	if err != nil || res.NodeID != "n1" || res.NodeToken != "TOK" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if _, err := Enroll(context.Background(), srv.URL, "BAD", "nas", "0.1.0"); err == nil {
		t.Fatal("token inválido debe fallar")
	}
}

type captureHandler struct {
	mu   sync.Mutex
	envs []*mcsmv1.Envelope
}

func (h *captureHandler) Handle(_ context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	h.mu.Lock()
	h.envs = append(h.envs, env)
	h.mu.Unlock()
	if env.GetPowerAction() != nil {
		_ = send(&mcsmv1.Envelope{Id: env.Id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}})
	}
}

// fakePanel acepta WebSockets, verifica el token, lee el Hello y deja
// que el test dirija la conversación.
type fakePanel struct {
	t        *testing.T
	srv      *httptest.Server
	conns    int32
	gotHello chan *mcsmv1.Hello
	ws       chan *websocket.Conn
}

func newFakePanel(t *testing.T) *fakePanel {
	fp := &fakePanel{t: t, gotHello: make(chan *mcsmv1.Hello, 4), ws: make(chan *websocket.Conn, 4)}
	fp.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/ws" || r.Header.Get("Authorization") != "Bearer TOK" {
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		atomic.AddInt32(&fp.conns, 1)
		_, data, err := c.Read(r.Context())
		if err != nil {
			return
		}
		env := &mcsmv1.Envelope{}
		_ = proto.Unmarshal(data, env)
		fp.gotHello <- env.GetHello()
		fp.ws <- c
		<-r.Context().Done()
	}))
	t.Cleanup(fp.srv.Close)
	return fp
}

func TestClientHelloDispatchAndReconnect(t *testing.T) {
	fp := newFakePanel(t)
	h := &captureHandler{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := NewClient(Options{
		PanelURL: fp.srv.URL, Token: "TOK", Handler: h,
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{AgentVersion: "0.1.0", SpecVersions: map[string]uint64{"a": 3}} },
	})
	c.backoffMin, c.backoffMax = 10*time.Millisecond, 50*time.Millisecond
	go c.Run(ctx)

	var hello *mcsmv1.Hello
	select {
	case hello = <-fp.gotHello:
	case <-time.After(3 * time.Second):
		t.Fatal("sin Hello")
	}
	if hello.AgentVersion != "0.1.0" || hello.SpecVersions["a"] != 3 {
		t.Fatalf("hello = %+v", hello)
	}
	ws := <-fp.ws
	if !c.Connected() {
		t.Fatal("debería estar conectado")
	}

	// panel → agente: PowerAction; el handler responde Ack con el mismo id
	req := &mcsmv1.Envelope{Id: 42, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a"}}}
	raw, _ := proto.Marshal(req)
	if err := ws.Write(ctx, websocket.MessageBinary, raw); err != nil {
		t.Fatal(err)
	}
	rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
	_, data, err := ws.Read(rctx)
	rcancel()
	if err != nil {
		t.Fatal(err)
	}
	resp := &mcsmv1.Envelope{}
	_ = proto.Unmarshal(data, resp)
	if resp.Id != 42 || resp.GetAck() == nil {
		t.Fatalf("resp = %+v", resp)
	}

	// el panel cierra: el agente debe reconectar y volver a saludar
	ws.Close(websocket.StatusGoingAway, "reinicio")
	select {
	case <-fp.gotHello:
	case <-time.After(3 * time.Second):
		t.Fatal("no reconectó")
	}
	if atomic.LoadInt32(&fp.conns) < 2 {
		t.Fatalf("conns = %d", fp.conns)
	}
}

func TestSendWithoutConnection(t *testing.T) {
	c := NewClient(Options{PanelURL: "http://127.0.0.1:1", Token: "x", Handler: &captureHandler{}, Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	if err := c.Send(context.Background(), &mcsmv1.Envelope{}); err != ErrNotConnected {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 2: Implementación de alta**

`agent/internal/conn/enroll.go`:
```go
// Package conn gestiona la comunicación saliente del agente con el panel.
package conn

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type EnrollResult struct {
	NodeID    string `json:"nodeId"`
	NodeToken string `json:"nodeToken"`
}

// Enroll canjea un token de alta de un solo uso por credenciales permanentes.
func Enroll(ctx context.Context, panelURL, enrollToken, nameHint, agentVersion string) (*EnrollResult, error) {
	body, _ := json.Marshal(map[string]string{"enrollToken": enrollToken, "nameHint": nameHint, "agentVersion": agentVersion})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(panelURL, "/")+"/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("enroll: el panel respondió %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var out EnrollResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("enroll: respuesta inválida: %w", err)
	}
	if out.NodeID == "" || out.NodeToken == "" {
		return nil, fmt.Errorf("enroll: respuesta incompleta")
	}
	return &out, nil
}
```

- [ ] **Step 3: Implementación del cliente WebSocket**

`agent/internal/conn/client.go`:
```go
package conn

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

var ErrNotConnected = errors.New("conn: sin conexión con el panel")

type Handler interface {
	Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error)
}

type HelloFunc func(ctx context.Context) *mcsmv1.Hello

type Options struct {
	PanelURL     string
	Token        string
	Hello        HelloFunc
	Handler      Handler
	OnDisconnect func()
	Log          *slog.Logger
}

type Client struct {
	opts       Options
	log        *slog.Logger
	backoffMin time.Duration
	backoffMax time.Duration

	mu        sync.Mutex
	ws        *websocket.Conn
	connected atomic.Bool
}

func NewClient(o Options) *Client {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Client{opts: o, log: o.Log.With("component", "conn"), backoffMin: time.Second, backoffMax: 30 * time.Second}
}

func (c *Client) Connected() bool { return c.connected.Load() }

func (c *Client) Send(ctx context.Context, env *mcsmv1.Envelope) error {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return ErrNotConnected
	}
	raw, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return ws.Write(wctx, websocket.MessageBinary, raw)
}

// Run mantiene la sesión viva hasta que ctx termina.
func (c *Client) Run(ctx context.Context) {
	wait := c.backoffMin
	for {
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.log.Warn("sesión terminada", "err", err, "reintento_en", wait)
		}
		jitter := time.Duration(rand.Int64N(int64(wait)/5+1)) - wait/10
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait + jitter):
		}
		wait *= 2
		if wait > c.backoffMax {
			wait = c.backoffMax
		}
		if err == nil {
			wait = c.backoffMin
		}
	}
}

func wsURL(panelURL string) string {
	u := strings.TrimRight(panelURL, "/")
	u = strings.Replace(u, "http://", "ws://", 1)
	u = strings.Replace(u, "https://", "wss://", 1)
	return u + "/agent/ws"
}

func (c *Client) session(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, _, err := websocket.Dial(dctx, wsURL(c.opts.PanelURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.opts.Token}},
	})
	cancel()
	if err != nil {
		return err
	}
	ws.SetReadLimit(4 << 20)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()
	c.connected.Store(true)
	defer func() {
		c.connected.Store(false)
		c.mu.Lock()
		c.ws = nil
		c.mu.Unlock()
		ws.Close(websocket.StatusNormalClosure, "bye")
		if c.opts.OnDisconnect != nil {
			c.opts.OnDisconnect()
		}
	}()

	if err := c.Send(sctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_Hello{Hello: c.opts.Hello(sctx)}}); err != nil {
		return err
	}
	c.log.Info("conectado al panel", "url", c.opts.PanelURL)

	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				pctx, pc := context.WithTimeout(sctx, 10*time.Second)
				err := ws.Ping(pctx)
				pc()
				if err != nil {
					c.log.Warn("ping fallido", "err", err)
					ws.Close(websocket.StatusGoingAway, "ping timeout")
					return
				}
			}
		}
	}()

	for {
		_, data, err := ws.Read(sctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure || websocket.CloseStatus(err) == websocket.StatusGoingAway {
				return nil
			}
			return err
		}
		env := &mcsmv1.Envelope{}
		if err := proto.Unmarshal(data, env); err != nil {
			c.log.Warn("mensaje inválido", "err", err)
			continue
		}
		go c.opts.Handler.Handle(sctx, env, func(e *mcsmv1.Envelope) error { return c.Send(sctx, e) })
	}
}
```

- [ ] **Step 4: Ejecutar**

```bash
cd agent && go get github.com/coder/websocket@v1.8.15 && go mod tidy && go vet ./... && go test ./internal/conn/ -race -v
```
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): alta por token y cliente WebSocket con reconexión y ping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Aplicación del agente, `main` y Dockerfile

**Files:**
- Create: `agent/internal/app/config.go`, `agent/internal/app/app.go`, `agent/internal/app/app_test.go`, `agent/Dockerfile`, `agent/.dockerignore`
- Modify: `agent/cmd/agent/main.go`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `app.Config`, `app.LoadConfig() (Config, error)`, `app.Run(ctx, cfg Config, log *slog.Logger) error`, `app.New(cfg, st, eng, log) *App` (para tests), `(*App).Handle(...)` implementa `conn.Handler`.

Comportamiento de `Handle`:
| Mensaje | Acción | Respuesta |
|---|---|---|
| `HelloAck` | log | — |
| `SyncSpecs` | `PutSpec` de cada uno; `Remove(id,false)+DeleteSpec` de `removed_ids`; `ReconcileAll` | `Ack` |
| `ApplySpec` | `PutSpec`; `Reconcile` | `Ack` o `Error{code:"apply_failed"}` |
| `RemoveServer` | `Remove(id, delete_data)`; `DeleteSpec`; `hub.Reset` | `Ack` o `Error` |
| `PowerAction` | `Power` | `Ack` o `Error{code:"power_failed"}` |
| `SendCommand` | `mc.Rcon(mcsm-<slug>, 25575, pw, cmd)` | `CommandResult` o `Error{code:"rcon_failed"}` |
| `SubscribeLogs` | abre stream (stream_id = id) | `Ack{stream_id}` y luego `LogLine{stream_id}`… |
| `StreamClose` | cancela el stream | — |

Bucles de fondo: eventos Docker → `Observe` del servidor afectado (y `hub.Reset` en `destroy`); ticker 10 s → `Observe` de todos; ticker 30 s → `ReconcileAll`. Al desconectar, se cancelan todos los streams.

- [ ] **Step 1: Config**

`agent/internal/app/config.go`:
```go
package app

import (
	"errors"
	"os"
)

type Config struct {
	PanelURL    string
	EnrollToken string
	NameHint    string
	DataRoot    string
	AgentData   string
	Network     string
	Version     string
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func LoadConfig(version string) (Config, error) {
	host, _ := os.Hostname()
	cfg := Config{
		PanelURL:    os.Getenv("PANEL_URL"),
		EnrollToken: os.Getenv("ENROLL_TOKEN"),
		NameHint:    getenv("NODE_NAME", host),
		DataRoot:    getenv("DATA_ROOT", "/srv/minecraft"),
		AgentData:   getenv("AGENT_DATA", "/var/lib/mcsm-agent"),
		Network:     getenv("MCSM_NETWORK", "mcsm"),
		Version:     version,
	}
	if cfg.PanelURL == "" {
		return cfg, errors.New("PANEL_URL es obligatoria")
	}
	return cfg, nil
}
```

- [ ] **Step 2: Test del handler (falla)**

`agent/internal/app/app_test.go`:
```go
package app

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

const specJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

type sink struct {
	mu   sync.Mutex
	envs []*mcsmv1.Envelope
	ch   chan *mcsmv1.Envelope
}

func newSink() *sink { return &sink{ch: make(chan *mcsmv1.Envelope, 64)} }

func (s *sink) send(e *mcsmv1.Envelope) error {
	s.mu.Lock()
	s.envs = append(s.envs, e)
	s.mu.Unlock()
	s.ch <- e
	return nil
}

func (s *sink) next(t *testing.T) *mcsmv1.Envelope {
	t.Helper()
	select {
	case e := <-s.ch:
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("sin respuesta")
		return nil
	}
}

func newApp(t *testing.T) (*App, *docker.Fake, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	cfg := Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}
	a := New(cfg, st, fake, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	return a, fake, st
}

func specMsg(id, slug string, v uint64) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
}

func TestSyncSpecsAndObserved(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}}}}, s.send)
	var sawObserved, sawAck bool
	for i := 0; i < 2; i++ {
		e := s.next(t)
		if e.GetServerObserved() != nil && e.GetServerObserved().ServerId == "a" && e.GetServerObserved().Observed.State == "running" {
			sawObserved = true
		}
		if e.Id == 7 && e.GetAck() != nil {
			sawAck = true
		}
	}
	if !sawObserved || !sawAck {
		t.Fatalf("observed=%v ack=%v", sawObserved, sawAck)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 {
		t.Fatal("debe haber creado el contenedor")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("la spec debe quedar en el store")
	}
	// removed_ids borra contenedor y spec
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 8, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{RemovedIds: []string{"a"}}}}, s.send)
	for {
		e := s.next(t)
		if e.Id == 8 {
			break
		}
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("debe haber borrado el contenedor")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("la spec debe borrarse")
	}
}

func TestApplySpecErrorIsReported(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	fake.CreateErr = context.DeadlineExceeded
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	for {
		e := s.next(t)
		if e.Id == 9 {
			if e.GetError() == nil || e.GetError().Code != "apply_failed" {
				t.Fatalf("resp = %+v", e)
			}
			return
		}
	}
}

func TestSubscribeLogsStream(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	for e := s.next(t); e.Id != 1; e = s.next(t) {
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: "a", Tail: 50}}}, s.send)
	ack := s.next(t)
	if ack.Id != 5 || ack.StreamId != 5 || ack.GetAck() == nil {
		t.Fatalf("ack = %+v", ack)
	}
	time.Sleep(30 * time.Millisecond)
	id := a.rec.ContainerID(ctx, "a")
	fake.WriteLog(id, "2026-10-12T10:00:00Z Done!\n")
	for {
		e := s.next(t)
		if e.GetLogLine() != nil {
			if e.StreamId != 5 || e.GetLogLine().Line != "Done!" || e.GetLogLine().ServerId != "a" {
				t.Fatalf("line = %+v", e)
			}
			break
		}
	}
	a.Handle(ctx, &mcsmv1.Envelope{StreamId: 5, Body: &mcsmv1.Envelope_StreamClose{StreamClose: &mcsmv1.StreamClose{}}}, s.send)
	time.Sleep(20 * time.Millisecond)
	a.mu.Lock()
	_, open := a.streams[5]
	a.mu.Unlock()
	if open {
		t.Fatal("StreamClose debe cancelar el stream")
	}
}

func TestHelloCarriesVersions(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 4))
	h := a.hello(context.Background())
	if h.SpecVersions["a"] != 4 || h.AgentVersion != "test" {
		t.Fatalf("hello = %+v", h)
	}
}
```

- [ ] **Step 3: Implementación**

`agent/internal/app/app.go`:
```go
// Package app conecta todas las piezas del agente.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/mem"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/conn"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/logs"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

type App struct {
	cfg    Config
	st     *store.Store
	eng    docker.Engine
	rec    *reconcile.Reconciler
	hub    *logs.Hub
	log    *slog.Logger
	status mc.StatusFunc
	rcon   func(ctx context.Context, host string, port uint16, password, command string) (string, error)

	mu      sync.Mutex
	send    func(*mcsmv1.Envelope) error
	streams map[uint64]context.CancelFunc
}

func New(cfg Config, st *store.Store, eng docker.Engine, log *slog.Logger) *App {
	a := &App{cfg: cfg, st: st, eng: eng, log: log, status: mc.Status, rcon: mc.Rcon, streams: map[uint64]context.CancelFunc{}}
	a.send = func(*mcsmv1.Envelope) error { return conn.ErrNotConnected }
	a.rec = reconcile.New(st, eng, cfg.DataRoot, cfg.Network, func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
		return a.status(ctx, host, port)
	}, a.onObserved)
	a.hub = logs.NewHub(eng)
	return a
}

// Run es el punto de entrada del binario.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	if err := os.MkdirAll(cfg.AgentData, 0o700); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(cfg.AgentData, "agent.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	eng, err := docker.NewMoby()
	if err != nil {
		return err
	}
	if _, err := eng.Version(ctx); err != nil {
		return fmt.Errorf("no se puede hablar con Docker (¿está montado /var/run/docker.sock?): %w", err)
	}
	if err := eng.EnsureNetwork(ctx, cfg.Network); err != nil {
		return fmt.Errorf("crear red %s: %w", cfg.Network, err)
	}

	creds, err := st.Credentials()
	if err != nil {
		return err
	}
	if creds == nil {
		if cfg.EnrollToken == "" {
			return fmt.Errorf("este agente no está dado de alta: define ENROLL_TOKEN (se genera en Nodos → Añadir nodo)")
		}
		log.Info("dando de alta el nodo en el panel", "panel", cfg.PanelURL)
		res, err := conn.Enroll(ctx, cfg.PanelURL, cfg.EnrollToken, cfg.NameHint, cfg.Version)
		if err != nil {
			return err
		}
		creds = &store.Credentials{NodeID: res.NodeID, Token: res.NodeToken}
		if err := st.SaveCredentials(*creds); err != nil {
			return err
		}
		log.Info("nodo dado de alta", "node_id", res.NodeID)
	}

	a := New(cfg, st, eng, log)
	client := conn.NewClient(conn.Options{
		PanelURL: cfg.PanelURL, Token: creds.Token, Hello: a.hello, Handler: a, Log: log,
		OnDisconnect: a.cancelAllStreams,
	})
	a.send = func(e *mcsmv1.Envelope) error { return client.Send(ctx, e) }

	go a.eventLoop(ctx)
	go a.tickers(ctx)
	a.rec.ReconcileAll(ctx)
	client.Run(ctx)
	return nil
}

func (a *App) hello(ctx context.Context) *mcsmv1.Hello {
	vers, _ := a.st.SpecVersions()
	dv, _ := a.eng.Version(ctx)
	host, _ := os.Hostname()
	info := &mcsmv1.HostInfo{Hostname: host, Cpus: uint32(runtime.NumCPU()), Os: runtime.GOOS, Arch: runtime.GOARCH}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemTotalBytes = vm.Total
	}
	return &mcsmv1.Hello{AgentVersion: a.cfg.Version, DockerVersion: dv, Host: info, SpecVersions: vers}
}

func (a *App) onObserved(serverID string, obs *mcsmv1.Observed) {
	_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_ServerObserved{ServerObserved: &mcsmv1.ServerObserved{
		ServerId: serverID, Observed: obs, TsUnixMs: time.Now().UnixMilli(),
	}}})
}

func ack(id uint64) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}
}

func errMsg(id uint64, code string, err error) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: code, Message: err.Error()}}}
}

// Handle implementa conn.Handler.
func (a *App) Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_HelloAck:
		a.log.Info("panel confirmó la sesión", "node_id", b.HelloAck.NodeId)

	case *mcsmv1.Envelope_SyncSpecs:
		for _, sp := range b.SyncSpecs.Servers {
			if err := a.st.PutSpec(sp); err != nil {
				a.log.Error("guardar spec", "err", err)
			}
		}
		for _, id := range b.SyncSpecs.RemovedIds {
			if err := a.rec.Remove(ctx, id, false); err != nil {
				a.log.Warn("eliminar servidor retirado", "id", id, "err", err)
			}
			_ = a.st.DeleteSpec(id)
			a.hub.Reset(id)
		}
		a.rec.ReconcileAll(ctx)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_ApplySpec:
		sp := b.ApplySpec.Server
		if err := a.st.PutSpec(sp); err != nil {
			_ = send(errMsg(env.Id, "store_failed", err))
			return
		}
		if err := a.rec.Reconcile(ctx, sp.ServerId); err != nil {
			_ = send(errMsg(env.Id, "apply_failed", err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_RemoveServer:
		if err := a.rec.Remove(ctx, b.RemoveServer.ServerId, b.RemoveServer.DeleteData); err != nil {
			_ = send(errMsg(env.Id, "remove_failed", err))
			return
		}
		_ = a.st.DeleteSpec(b.RemoveServer.ServerId)
		a.hub.Reset(b.RemoveServer.ServerId)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_PowerAction:
		if err := a.rec.Power(ctx, b.PowerAction.ServerId, b.PowerAction.Action); err != nil {
			_ = send(errMsg(env.Id, "power_failed", err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_SendCommand:
		sp, err := a.st.GetSpec(b.SendCommand.ServerId)
		if err != nil || sp == nil {
			_ = send(errMsg(env.Id, "unknown_server", fmt.Errorf("servidor desconocido")))
			return
		}
		parsed, err := spec.Parse(sp.SpecJson)
		if err != nil {
			_ = send(errMsg(env.Id, "bad_spec", err))
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		out, err := a.rcon(cctx, spec.ContainerName(sp.Slug), uint16(spec.RconPort), parsed.RconPassword, b.SendCommand.Command)
		cancel()
		if err != nil {
			_ = send(errMsg(env.Id, "rcon_failed", err))
			return
		}
		_ = send(&mcsmv1.Envelope{Id: env.Id, Body: &mcsmv1.Envelope_CommandResult{CommandResult: &mcsmv1.CommandResult{Output: out}}})

	case *mcsmv1.Envelope_SubscribeLogs:
		a.startLogStream(ctx, env.Id, b.SubscribeLogs, send)

	case *mcsmv1.Envelope_StreamClose:
		a.mu.Lock()
		if cancel, ok := a.streams[env.StreamId]; ok {
			cancel()
			delete(a.streams, env.StreamId)
		}
		a.mu.Unlock()

	default:
		a.log.Warn("mensaje no soportado", "type", fmt.Sprintf("%T", env.Body))
	}
}

func (a *App) startLogStream(parent context.Context, streamID uint64, req *mcsmv1.SubscribeLogs, send func(*mcsmv1.Envelope) error) {
	ctx, cancel := context.WithCancel(parent)
	a.mu.Lock()
	if old, ok := a.streams[streamID]; ok {
		old()
	}
	a.streams[streamID] = cancel
	a.mu.Unlock()
	_ = send(&mcsmv1.Envelope{Id: streamID, StreamId: streamID, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}})

	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.streams, streamID)
			a.mu.Unlock()
		}()
		tail := int(req.Tail)
		for ctx.Err() == nil {
			cid := a.rec.ContainerID(ctx, req.ServerId)
			if cid == "" {
				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Second):
					continue
				}
			}
			ch, unsub, err := a.hub.Subscribe(req.ServerId, cid, tail)
			if err != nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Second):
					continue
				}
			}
			tail = 0 // tras una reconexión al contenedor no repetimos el histórico
			for {
				select {
				case <-ctx.Done():
					unsub()
					return
				case line, ok := <-ch:
					if !ok {
						unsub()
						goto reopen
					}
					_ = send(&mcsmv1.Envelope{StreamId: streamID, Body: &mcsmv1.Envelope_LogLine{LogLine: &mcsmv1.LogLine{
						ServerId: req.ServerId, TsUnixMs: line.TS.UnixMilli(), Line: line.Text,
					}}})
				}
			}
		reopen:
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}()
}

func (a *App) cancelAllStreams() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, cancel := range a.streams {
		cancel()
		delete(a.streams, id)
	}
}

func (a *App) eventLoop(ctx context.Context) {
	for ctx.Err() == nil {
		events, errs := a.eng.Events(ctx)
	loop:
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-errs:
				a.log.Warn("stream de eventos Docker cortado", "err", err)
				break loop
			case ev, ok := <-events:
				if !ok {
					break loop
				}
				id := ev.Labels[spec.LabelServerID]
				if id == "" {
					continue
				}
				if ev.Action == "destroy" {
					a.hub.Reset(id)
				}
				switch ev.Action {
				case "start", "die", "stop", "kill", "destroy", "oom", "health_status: healthy", "health_status: unhealthy", "restart":
					a.rec.Observe(ctx, id)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func (a *App) tickers(ctx context.Context) {
	observe := time.NewTicker(10 * time.Second)
	reconcile := time.NewTicker(30 * time.Second)
	defer observe.Stop()
	defer reconcile.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-observe.C:
			specs, _ := a.st.ListSpecs()
			for _, sp := range specs {
				a.rec.Observe(ctx, sp.ServerId)
			}
		case <-reconcile.C:
			a.rec.ReconcileAll(ctx)
		}
	}
}
```

`agent/cmd/agent/main.go`:
```go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"mcsm/agent/internal/app"
)

var version = "dev"

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	cfg, err := app.LoadConfig(version)
	if err != nil {
		log.Error("configuración inválida", "err", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("mcsm-agent arrancando", "version", version, "panel", cfg.PanelURL, "data_root", cfg.DataRoot)
	if err := app.Run(ctx, cfg, log); err != nil {
		log.Error("el agente terminó con error", "err", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 4: Ejecutar tests**

```bash
cd agent && go get github.com/shirou/gopsutil/v4@v4.26.9 && go mod tidy && go vet ./... && go test ./... -race
```
Expected: todos los paquetes PASS.

- [ ] **Step 5: Dockerfile**

`agent/.dockerignore`:
```
bin/
*_test.go
```

`agent/Dockerfile`:
```dockerfile
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/mcsm-agent ./cmd/agent

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/mcsm-agent /usr/local/bin/mcsm-agent
ENV DATA_ROOT=/srv/minecraft AGENT_DATA=/var/lib/mcsm-agent MCSM_NETWORK=mcsm
VOLUME ["/var/lib/mcsm-agent"]
ENTRYPOINT ["mcsm-agent"]
```

```bash
cd agent && docker build -t mcsm-agent:dev --build-arg VERSION=dev . && docker run --rm mcsm-agent:dev; echo "exit=$?"
```
Expected: la imagen se construye; al ejecutar sin `PANEL_URL` sale con código 2 y el mensaje "PANEL_URL es obligatoria".

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): aplicación completa del agente con handler, bucles de observación y Dockerfile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Panel API — esqueleto, configuración y base de datos

**Files:**
- Create: `panel/apps/api/{package.json,tsconfig.json,vitest.config.ts}`, `panel/apps/api/src/{config.ts,app.ts,main.ts}`, `panel/apps/api/src/lib/{ids.ts,time.ts,tokens.ts}`, `panel/apps/api/src/db/{db.ts,migrations.ts,db.test.ts}`

**Interfaces:**
- Produces: `openDb(path: string): Db` (`Db = DatabaseSync` de `node:sqlite`, con migraciones aplicadas), `migrate(db)`, `newId(): string` (UUID v7), `nowIso(): string`, `randomToken(): string`, `hashToken(t: string): string`, `buildApp(opts: { db: Db; logger?: boolean }): Promise<FastifyInstance>` (las tasks siguientes añaden rutas dentro de `buildApp`).

- [ ] **Step 1: Paquete**

`panel/apps/api/package.json`:
```json
{
  "name": "@mcsm/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.16.0",
    "@fastify/cookie": "^11.1.0",
    "@fastify/rate-limit": "^11.2.0",
    "@fastify/static": "^8.4.0",
    "@fastify/websocket": "^11.3.0",
    "@mcsm/proto": "workspace:*",
    "@mcsm/shared": "workspace:*",
    "fastify": "^5.12.0",
    "tsx": "^4.23.0",
    "uuid": "^14.0.0",
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^26.0.0",
    "@types/ws": "^8.18.0",
    "typescript": "^5.9.0",
    "vitest": "^4.3.0",
    "ws": "^8.22.0"
  }
}
```
`panel/apps/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src", "test"] }
```
`panel/apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 15000, pool: "forks" } });
```

- [ ] **Step 2: Utilidades**

`panel/apps/api/src/lib/ids.ts`:
```ts
import { v7 as uuidv7 } from "uuid";
export const newId = (): string => uuidv7();
```
`panel/apps/api/src/lib/time.ts`:
```ts
export const nowIso = (): string => new Date().toISOString();
export const plusSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
```
`panel/apps/api/src/lib/tokens.ts`:
```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export const randomToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
```

- [ ] **Step 3: Test de BD (falla)**

`panel/apps/api/src/db/db.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDb, migrate } from "./db.js";

describe("db", () => {
  it("aplica las migraciones y es idempotente", () => {
    const db = openDb(":memory:");
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    for (const t of ["enrollment_tokens", "nodes", "schema_migrations", "servers", "sessions", "settings"]) {
      expect(tables).toContain(t);
    }
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(applied.n).toBeGreaterThan(0);
  });
  it("activa foreign keys", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO servers (id,node_id,name,slug,spec,created_at,updated_at) VALUES ('s','no-node','n','n','{}','t','t')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
```

- [ ] **Step 4: Implementación**

`panel/apps/api/src/db/migrations.ts`:
```ts
export interface Migration { name: string; sql: string }

export const migrations: Migration[] = [
  {
    name: "001_init",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  data_root TEXT NOT NULL DEFAULT '/srv/minecraft',
  status TEXT NOT NULL DEFAULT 'offline',
  agent_version TEXT,
  docker_version TEXT,
  host_info TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name_hint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_version INTEGER NOT NULL DEFAULT 1,
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  observed TEXT,
  observed_spec_version INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, slug)
);
CREATE INDEX servers_node_idx ON servers(node_id);
`,
  },
];
```

`panel/apps/api/src/db/db.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
```

`panel/apps/api/src/config.ts`:
```ts
export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  publicUrl: (process.env.PANEL_PUBLIC_URL ?? "").replace(/\/$/, ""),
  webDist: process.env.WEB_DIST ?? "",
  sessionTtlSeconds: 30 * 24 * 3600,
  enrollTtlSeconds: 15 * 60,
  gamePortRange: { from: 25565, to: 25600 },
};
export type Config = typeof config;
```

`panel/apps/api/src/app.ts` (base; las tasks 11–15 añaden registros donde se indica):
```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db/db.js";
import { config, type Config } from "./config.js";

export interface AppOptions { db: Db; logger?: boolean; config?: Partial<Config> }

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const cfg: Config = { ...config, ...opts.config };
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate("db", opts.db);
  app.decorate("config", cfg);

  app.get("/api/health", async () => ({ ok: true }));

  // Task 11: await app.register(authPlugin); await app.register(authRoutes);
  // Task 12: await app.register(nodeRoutes);
  // Task 13: app.decorate("agents", new AgentHub()); await app.register(agentRoutes);
  // Task 14: await app.register(serverRoutes);
  // Task 15: await app.register(realtimeRoutes);
  // Task 19: estáticos de la web si cfg.webDist
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
}
```

`panel/apps/api/src/main.ts`:
```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db/db.js";

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, "panel.db"));
const app = await buildApp({ db, logger: true });
await app.listen({ host: config.host, port: config.port });
app.log.info(`panel escuchando en http://${config.host}:${config.port}`);
```

- [ ] **Step 5: Ejecutar**

```bash
pnpm install && pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck
```
Expected: 2 tests PASS, sin errores de tipos. Si `node:sqlite` emite un aviso experimental en consola, ignóralo (en Node 26 es estable).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): esqueleto Fastify, configuración y SQLite con migraciones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Autenticación (contraseña única y sesión por cookie)

**Files:**
- Create: `panel/apps/api/src/auth/{password.ts,repo.ts,plugin.ts,routes.ts,auth.test.ts}`
- Modify: `panel/apps/api/src/app.ts`

**Interfaces:**
- Produces: `hashPassword(p): Promise<string>`, `verifyPassword(p, hash): Promise<boolean>`; `AuthRepo` con `getSetting/setSetting`, `createSession()`, `getSession(id)`, `deleteSession(id)`, `purgeExpired()`; plugin `authPlugin` que decora `request.sessionId` y protege `/api/*` y `/ws` (excepto `/api/health`, `/api/auth/status`, `/api/auth/setup`, `/api/auth/login`); rutas `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`. Nombre de la cookie: `mcsm_session`. Clave de settings: `admin_password_hash`, `session_secret`.

- [ ] **Step 1: Test (falla)**

`panel/apps/api/src/auth/auth.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
beforeEach(async () => { app = await buildApp({ db: openDb(":memory:") }); await app.ready(); });
afterEach(async () => { await app.close(); });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((c) => c.name === "mcsm_session");
  return c ? `${c.name}=${c.value}` : "";
};

describe("auth", () => {
  it("sin contraseña configurada, status lo indica y setup crea sesión", async () => {
    let res = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.json()).toEqual({ configured: false, authenticated: false });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^mcsm_session=/);
    res = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true, authenticated: true });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "otra" } });
    expect(res.statusCode).toBe(409);
  });

  it("login correcto e incorrecto, logout y rutas protegidas", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    let res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "POST", url: "/api/auth/logout" }); // protegida y ya existente en esta task
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    res = await app.inject({ method: "GET", url: "/api/health", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json().authenticated).toBe(false);
  });

  it("rechaza contraseñas cortas en setup", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "1234" } });
    expect(res.statusCode).toBe(400);
  });
});
```
(Se usa `/api/auth/logout` como ruta protegida porque ya existe en esta task; `/api/nodes` llega en la Task 12.)

- [ ] **Step 2: Implementación**

`panel/apps/api/src/auth/password.ts`:
```ts
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, n: number) => Promise<Buffer>;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64url"), KEYLEN);
  const expected = Buffer.from(keyB64, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
```

`panel/apps/api/src/auth/repo.ts`:
```ts
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso, plusSeconds } from "../lib/time.js";

export class AuthRepo {
  constructor(private db: Db) {}
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  createSession(ttlSeconds: number): string {
    const id = newId();
    this.db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").run(id, nowIso(), plusSeconds(ttlSeconds));
    return id;
  }
  getSession(id: string): boolean {
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id) as { expires_at: string } | undefined;
    return !!row && row.expires_at > nowIso();
  }
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  purgeExpired(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  }
}
```

`panel/apps/api/src/auth/plugin.ts`:
```ts
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthRepo } from "./repo.js";
import { randomToken } from "../lib/tokens.js";

export const SESSION_COOKIE = "mcsm_session";
const PUBLIC = new Set(["/api/health", "/api/auth/status", "/api/auth/setup", "/api/auth/login"]);

async function plugin(app: FastifyInstance) {
  const repo = new AuthRepo(app.db);
  let secret = repo.getSetting("session_secret");
  if (!secret) {
    secret = randomToken();
    repo.setSetting("session_secret", secret);
  }
  await app.register(cookie, { secret });
  app.decorate("auth", repo);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value && repo.getSession(unsigned.value)) {
        req.sessionId = unsigned.value;
      }
    }
    const protectedPath = (path.startsWith("/api/") && !PUBLIC.has(path)) || path === "/ws";
    if (protectedPath && !req.sessionId) {
      return reply.code(401).send({ error: "No autenticado" });
    }
  });
}

export const authPlugin = fp(plugin, { name: "auth" });

declare module "fastify" {
  interface FastifyInstance { auth: AuthRepo }
  interface FastifyRequest { sessionId: string | null }
}
```

`panel/apps/api/src/auth/routes.ts`:
```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_COOKIE } from "./plugin.js";

const passwordBody = z.object({ password: z.string().min(8, "Mínimo 8 caracteres").max(200) });

export async function authRoutes(app: FastifyInstance) {
  await app.register(rateLimit, { global: false });

  const setCookie = (reply: FastifyReply, sessionId: string) =>
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: "/", httpOnly: true, sameSite: "strict", signed: true, maxAge: app.config.sessionTtlSeconds,
    });

  app.get("/api/auth/status", async (req) => ({
    configured: app.auth.getSetting("admin_password_hash") !== null,
    authenticated: req.sessionId !== null,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (app.auth.getSetting("admin_password_hash")) return reply.code(409).send({ error: "La contraseña ya está configurada" });
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" });
    app.auth.setSetting("admin_password_hash", await hashPassword(parsed.data.password));
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = passwordBody.safeParse(req.body);
    const stored = app.auth.getSetting("admin_password_hash");
    if (!parsed.success || !stored || !(await verifyPassword(parsed.data.password, stored))) {
      return reply.code(401).send({ error: "Contraseña incorrecta" });
    }
    app.auth.purgeExpired();
    setCookie(reply, app.auth.createSession(app.config.sessionTtlSeconds));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) app.auth.deleteSession(req.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
```

En `app.ts`, sustituye el comentario de la Task 11 por:
```ts
  await app.register(authPlugin);
  await app.register(authRoutes);
```
con los imports `import { authPlugin } from "./auth/plugin.js"; import { authRoutes } from "./auth/routes.js";`. Añade `fastify-plugin` a `dependencies` (`"fastify-plugin": "^5.1.0"`).

- [ ] **Step 3: Ejecutar**

```bash
pnpm install && pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck
```
Expected: tests de auth y db PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(api): autenticación con contraseña única, sesiones y cookie firmada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Nodos y alta de agentes

**Files:**
- Create: `panel/apps/api/src/nodes/{repo.ts,routes.ts,nodes.test.ts}`
- Modify: `panel/apps/api/src/app.ts`

**Interfaces:**
- Produces: `NodeRow { id, name, data_root, status, agent_version, docker_version, host_info, last_seen_at, created_at }`, `NodesRepo` con `list()`, `get(id)`, `findByTokenHash(hash)`, `create({name, tokenHash, dataRoot})`, `rename(id, name)`, `setDataRoot(id, dataRoot)`, `setStatus(id, status, extra?)`, `touch(id)`, `delete(id)`, `createEnrollmentToken(nameHint, ttl)`, `consumeEnrollmentToken(tokenPlain)`; rutas `GET /api/nodes`, `PATCH /api/nodes/:id`, `DELETE /api/nodes/:id`, `POST /api/nodes/enrollment-tokens`, `POST /agent/enroll` (sin sesión; devuelve `{nodeId, nodeToken}`).
- `toNodeDto(row)`: `{ id, name, dataRoot, status, agentVersion, dockerVersion, hostInfo (objeto o null), lastSeenAt, createdAt }`.

- [ ] **Step 1: Test (falla)**

`panel/apps/api/src/nodes/nodes.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:"), config: { publicUrl: "http://panel.lan:8080" } });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

describe("nodos y alta", () => {
  it("genera token de alta con docker run y lo canjea una sola vez", async () => {
    let res = await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } });
    expect(res.statusCode).toBe(200);
    const { token, dockerRun, expiresAt } = res.json();
    expect(token).toHaveLength(43);
    expect(dockerRun).toContain("ENROLL_TOKEN=" + token);
    expect(dockerRun).toContain("PANEL_URL=http://panel.lan:8080");
    expect(dockerRun).toContain("/var/run/docker.sock");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint: "nas", agentVersion: "0.1.0" } });
    expect(res.statusCode).toBe(200);
    const { nodeId, nodeToken } = res.json();
    expect(nodeId).toBeTruthy();
    expect(nodeToken).toHaveLength(43);

    res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: token, nameHint: "nas", agentVersion: "0.1.0" } });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } });
    const nodes = res.json();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: nodeId, name: "nas", status: "offline", dataRoot: "/srv/minecraft" });
    expect(nodes[0].tokenHash).toBeUndefined();
  });

  it("desambigua nombres repetidos y rechaza tokens inventados", async () => {
    for (const expected of ["nas", "nas-2"]) {
      const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
      const res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "x" } });
      expect(res.statusCode).toBe(200);
      const nodes = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json();
      expect(nodes.map((n: any) => n.name)).toContain(expected);
    }
    const res = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: "nope", nameHint: "x", agentVersion: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("renombra, cambia data_root y borra", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "a" } })).json().token;
    const { nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "a", agentVersion: "x" } })).json();
    let res = await app.inject({ method: "PATCH", url: `/api/nodes/${nodeId}`, headers: { cookie }, payload: { name: "salon", dataRoot: "/mnt/mc" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "salon", dataRoot: "/mnt/mc" });
    res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } });
    expect(res.json()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implementación**

`panel/apps/api/src/nodes/repo.ts`:
```ts
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso, plusSeconds } from "../lib/time.js";
import { hashToken, randomToken } from "../lib/tokens.js";

export interface NodeRow {
  id: string; name: string; token_hash: string; data_root: string; status: string;
  agent_version: string | null; docker_version: string | null; host_info: string | null;
  last_seen_at: string | null; created_at: string;
}

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: string; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: Record<string, unknown> | null; lastSeenAt: string | null; createdAt: string;
}

export const toNodeDto = (r: NodeRow): NodeDto => ({
  id: r.id, name: r.name, dataRoot: r.data_root, status: r.status, agentVersion: r.agent_version, dockerVersion: r.docker_version,
  hostInfo: r.host_info ? JSON.parse(r.host_info) : null, lastSeenAt: r.last_seen_at, createdAt: r.created_at,
});

export class NodesRepo {
  constructor(private db: Db) {}

  list(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes ORDER BY created_at").all() as NodeRow[];
  }
  get(id: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined) ?? null;
  }
  findByTokenHash(hash: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE token_hash = ?").get(hash) as NodeRow | undefined) ?? null;
  }
  nameExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM nodes WHERE name = ?").get(name);
  }
  create(input: { name: string; tokenHash: string; dataRoot?: string }): NodeRow {
    const id = newId();
    this.db.prepare("INSERT INTO nodes (id, name, token_hash, data_root, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.name, input.tokenHash, input.dataRoot ?? "/srv/minecraft", nowIso());
    return this.get(id)!;
  }
  rename(id: string, name: string): void {
    this.db.prepare("UPDATE nodes SET name = ? WHERE id = ?").run(name, id);
  }
  setDataRoot(id: string, dataRoot: string): void {
    this.db.prepare("UPDATE nodes SET data_root = ? WHERE id = ?").run(dataRoot, id);
  }
  setStatus(id: string, status: "online" | "offline", extra?: { agentVersion?: string; dockerVersion?: string; hostInfo?: unknown }): void {
    this.db.prepare(`UPDATE nodes SET status = ?, last_seen_at = ?,
        agent_version = COALESCE(?, agent_version), docker_version = COALESCE(?, docker_version), host_info = COALESCE(?, host_info)
      WHERE id = ?`)
      .run(status, nowIso(), extra?.agentVersion ?? null, extra?.dockerVersion ?? null, extra?.hostInfo ? JSON.stringify(extra.hostInfo) : null, id);
  }
  touch(id: string): void {
    this.db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(nowIso(), id);
  }
  markAllOffline(): void {
    this.db.prepare("UPDATE nodes SET status = 'offline'").run();
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  }

  createEnrollmentToken(nameHint: string, ttlSeconds: number): { token: string; expiresAt: string } {
    const token = randomToken();
    const expiresAt = plusSeconds(ttlSeconds);
    this.db.prepare("INSERT INTO enrollment_tokens (id, token_hash, name_hint, expires_at) VALUES (?, ?, ?, ?)")
      .run(newId(), hashToken(token), nameHint, expiresAt);
    return { token, expiresAt };
  }
  /** Devuelve el name_hint si el token es válido, lo marca usado; null si no. */
  consumeEnrollmentToken(token: string): string | null {
    const row = this.db.prepare("SELECT id, name_hint, expires_at, used_at FROM enrollment_tokens WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; name_hint: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || row.expires_at <= nowIso()) return null;
    this.db.prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
    return row.name_hint;
  }
}
```

`panel/apps/api/src/nodes/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NodesRepo, toNodeDto } from "./repo.js";
import { hashToken, randomToken } from "../lib/tokens.js";

const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u, "Nombre inválido");

export function dockerRunSnippet(publicUrl: string, token: string, dataRoot = "/srv/minecraft"): string {
  return [
    "docker network create mcsm 2>/dev/null || true",
    "docker run -d --name mcsm-agent --restart unless-stopped \\",
    "  --network mcsm \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${dataRoot}:${dataRoot} \\`,
    "  -v mcsm-agent-data:/var/lib/mcsm-agent \\",
    "  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \\",
    `  -e PANEL_URL=${publicUrl} \\`,
    `  -e ENROLL_TOKEN=${token} \\`,
    `  -e DATA_ROOT=${dataRoot} \\`,
    "  mcsm-agent:latest",
  ].join("\n");
}

export async function nodeRoutes(app: FastifyInstance) {
  const repo = new NodesRepo(app.db);
  app.decorate("nodes", repo);

  app.get("/api/nodes", async () => repo.list().map(toNodeDto));

  app.post("/api/nodes/enrollment-tokens", async (req, reply) => {
    const body = z.object({ nameHint: nameSchema.default("nodo"), dataRoot: z.string().startsWith("/").default("/srv/minecraft") }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const publicUrl = app.config.publicUrl || `http://${req.hostname}`;
    const { token, expiresAt } = repo.createEnrollmentToken(body.data.nameHint, app.config.enrollTtlSeconds);
    return { token, expiresAt, dockerRun: dockerRunSnippet(publicUrl, token, body.data.dataRoot) };
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Nodo no encontrado" });
    const body = z.object({ name: nameSchema.optional(), dataRoot: z.string().startsWith("/").optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    if (body.data.name && body.data.name !== node.name) {
      if (repo.nameExists(body.data.name)) return reply.code(409).send({ error: "Ya existe un nodo con ese nombre" });
      repo.rename(node.id, body.data.name);
    }
    if (body.data.dataRoot) repo.setDataRoot(node.id, body.data.dataRoot);
    return toNodeDto(repo.get(node.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Nodo no encontrado" });
    try {
      repo.delete(node.id);
    } catch (e) {
      return reply.code(409).send({ error: "El nodo tiene servidores; bórralos o mígralos antes" });
    }
    return reply.code(204).send();
  });

  // Sin sesión: lo llama el agente con el token de alta.
  app.post("/agent/enroll", async (req, reply) => {
    const body = z.object({ enrollToken: z.string().min(10), nameHint: z.string().optional(), agentVersion: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Petición inválida" });
    const hint = repo.consumeEnrollmentToken(body.data.enrollToken);
    if (hint === null) return reply.code(401).send({ error: "Token de alta inválido, caducado o ya usado" });
    let name = hint;
    for (let i = 2; repo.nameExists(name); i++) name = `${hint}-${i}`;
    const nodeToken = randomToken();
    const node = repo.create({ name, tokenHash: hashToken(nodeToken) });
    if (body.data.agentVersion) repo.setStatus(node.id, "offline", { agentVersion: body.data.agentVersion });
    req.log.info({ nodeId: node.id, name }, "nodo dado de alta");
    return { nodeId: node.id, nodeToken };
  });
}

declare module "fastify" {
  interface FastifyInstance { nodes: NodesRepo }
}
```

En `app.ts`: `await app.register(nodeRoutes);` con su import.

- [ ] **Step 3: Ejecutar**

```bash
pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(api): nodos, tokens de alta y endpoint de enroll para agentes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Hub de agentes (WebSocket `/agent/ws`, Hello → SyncSpecs, estado observado)

**Files:**
- Create: `panel/apps/api/src/agents/{hub.ts,service.ts,routes.ts,agents.test.ts}`, `panel/apps/api/src/servers/repo.ts` (solo el repositorio; el servicio y rutas van en la Task 14), `panel/apps/api/test/fake-agent.ts`
- Modify: `panel/apps/api/src/app.ts`

**Interfaces:**
- Produces:
```ts
// hub.ts
type Body = NonNullable<MessageInit<Envelope>["body"]>;   // oneof como inicializador: { case, value } con objetos planos
class AgentConn {
  readonly nodeId: string;
  send(body: Body, opts?: { id?: bigint; streamId?: bigint }): bigint;
  request(body: Body, timeoutMs = 30_000): Promise<Envelope>;   // rechaza con AgentError si llega Error o timeout
  openStream(body: Body, onFrame: (env: Envelope) => void, onClose: (reason: string) => void): Promise<{ streamId: bigint; close(): void }>;
}
class AgentError extends Error { code: string }
class AgentHub extends EventEmitter {
  attach(nodeId: string, socket: WebSocket): AgentConn;   // emite "attached"(nodeId)
  detach(nodeId: string): void;                           // emite "detached"(nodeId)
  get(nodeId: string): AgentConn | undefined;
  isOnline(nodeId: string): boolean;
  // emite "message"(nodeId: string, env: Envelope) para mensajes sin petición pendiente
}
// service.ts
class AgentService { constructor(app); start(): void }   // maneja hello/serverObserved; emite "observed"(serverId, observedDto) y "node"(nodeDto) en app.events
// servers/repo.ts
interface ServerRow { id, node_id, name, slug, spec, spec_version, desired_state, observed, observed_spec_version, observed_at, created_at, updated_at }
class ServersRepo { list(nodeId?), get(id), getBySlug(nodeId, slug), create(...), updateSpec(id, spec, name?), setDesiredState(id, state), updateObserved(id, observedJson, appliedVersion), delete(id), usedGamePorts(nodeId) }
toServerSpecMessage(row): ServerSpec   // proto
toServerDto(row, { includeSecrets }): ServerDto
```
- `app.events`: un `EventEmitter` decorado en `buildApp` para eventos internos (`observed`, `node`).

- [ ] **Step 1: Repositorio de servidores**

`panel/apps/api/src/servers/repo.ts`:
```ts
import { create } from "@bufbuild/protobuf";
import { DesiredState, ServerSpecSchema, type ServerSpec } from "@mcsm/proto";
import type { Spec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface ServerRow {
  id: string; node_id: string; name: string; slug: string; spec: string; spec_version: number;
  desired_state: "running" | "stopped"; observed: string | null; observed_spec_version: number;
  observed_at: string | null; created_at: string; updated_at: string;
}

export interface ObservedDto {
  containerId: string; state: string; health: string; startedAtUnix: number; exitCode: number;
  appliedVersion: number; error: string;
  mc: { online: boolean; playersOnline: number; playersMax: number; version: string; latencyMs: number };
}

export interface ServerDto {
  id: string; nodeId: string; name: string; slug: string; spec: Spec | Omit<Spec, "rconPassword">; specVersion: number;
  desiredState: "running" | "stopped"; observed: ObservedDto | null; observedSpecVersion: number; observedAt: string | null;
  createdAt: string; updatedAt: string;
}

export function toServerDto(r: ServerRow, opts: { includeSecrets: boolean } = { includeSecrets: false }): ServerDto {
  const spec = JSON.parse(r.spec) as Spec;
  const { rconPassword, ...publicSpec } = spec;
  return {
    id: r.id, nodeId: r.node_id, name: r.name, slug: r.slug,
    spec: opts.includeSecrets ? spec : publicSpec,
    specVersion: r.spec_version, desiredState: r.desired_state,
    observed: r.observed ? (JSON.parse(r.observed) as ObservedDto) : null,
    observedSpecVersion: r.observed_spec_version, observedAt: r.observed_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toServerSpecMessage(r: ServerRow): ServerSpec {
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(r.spec),
  });
}

export class ServersRepo {
  constructor(private db: Db) {}

  list(nodeId?: string): ServerRow[] {
    return nodeId
      ? (this.db.prepare("SELECT * FROM servers WHERE node_id = ? ORDER BY name").all(nodeId) as ServerRow[])
      : (this.db.prepare("SELECT * FROM servers ORDER BY name").all() as ServerRow[]);
  }
  get(id: string): ServerRow | null {
    return (this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined) ?? null;
  }
  getBySlug(nodeId: string, slug: string): ServerRow | null {
    return (this.db.prepare("SELECT * FROM servers WHERE node_id = ? AND slug = ?").get(nodeId, slug) as ServerRow | undefined) ?? null;
  }
  create(input: { nodeId: string; name: string; slug: string; spec: Spec; desiredState: "running" | "stopped" }): ServerRow {
    const id = newId();
    const now = nowIso();
    this.db.prepare(`INSERT INTO servers (id, node_id, name, slug, spec, spec_version, desired_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, input.nodeId, input.name, input.slug, JSON.stringify(input.spec), input.desiredState, now, now);
    return this.get(id)!;
  }
  /** Guarda la spec nueva, incrementa la versión. */
  updateSpec(id: string, spec: Spec, name?: string): ServerRow {
    this.db.prepare(`UPDATE servers SET spec = ?, spec_version = spec_version + 1, name = COALESCE(?, name), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(spec), name ?? null, nowIso(), id);
    return this.get(id)!;
  }
  setDesiredState(id: string, state: "running" | "stopped"): void {
    this.db.prepare("UPDATE servers SET desired_state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), id);
  }
  updateObserved(id: string, observed: ObservedDto): void {
    this.db.prepare("UPDATE servers SET observed = ?, observed_spec_version = ?, observed_at = ? WHERE id = ?")
      .run(JSON.stringify(observed), observed.appliedVersion, nowIso(), id);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  }
  usedGamePorts(nodeId: string): Set<number> {
    const rows = this.db.prepare("SELECT spec FROM servers WHERE node_id = ?").all(nodeId) as { spec: string }[];
    const used = new Set<number>();
    for (const r of rows) {
      const s = JSON.parse(r.spec) as Spec;
      used.add(s.ports.game);
      for (const e of s.ports.extra) used.add(e.host);
    }
    return used;
  }
}
```

- [ ] **Step 2: Agente falso para tests**

`panel/apps/api/test/fake-agent.ts`:
```ts
import WebSocket from "ws";
import { create, fromBinary, toBinary, type MessageInit } from "@bufbuild/protobuf";
import { EnvelopeSchema, HelloSchema, type Envelope, type Hello } from "@mcsm/proto";

/** Agente mínimo en TS: se conecta, saluda y deja que el test lea/escriba envelopes. */
export class FakeAgent {
  private ws!: WebSocket;
  private queue: Envelope[] = [];
  private waiters: ((e: Envelope) => void)[] = [];
  closed = false;

  constructor(private url: string, private token: string) {}

  async connect(hello: MessageInit<Hello> = {}): Promise<void> {
    this.ws = new WebSocket(this.url.replace(/^http/, "ws") + "/agent/ws", { headers: { authorization: `Bearer ${this.token}` } });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.ws.on("message", (data: Buffer) => {
      const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
      const w = this.waiters.shift();
      if (w) w(env); else this.queue.push(env);
    });
    this.ws.on("close", () => { this.closed = true; });
    this.send({ id: 1n, body: { case: "hello", value: create(HelloSchema, { agentVersion: "fake", dockerVersion: "29", specVersions: {}, ...hello }) } });
  }

  send(env: MessageInit<Envelope>): void {
    this.ws.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, env)));
  }

  next(timeoutMs = 3000): Promise<Envelope> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("fake agent: sin mensaje")), timeoutMs);
      this.waiters.push((e) => { clearTimeout(t); resolve(e); });
    });
  }

  /** Espera hasta recibir un envelope cuyo body.case coincida. */
  async waitFor(c: NonNullable<Envelope["body"]["case"]>, timeoutMs = 3000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = await this.next(deadline - Date.now());
      if (e.body.case === c) return e;
    }
    throw new Error(`fake agent: no llegó ${c}`);
  }

  ack(id: bigint, streamId?: bigint): void {
    this.send({ id, streamId: streamId ?? 0n, body: { case: "ack", value: {} } });
  }

  close(): void { this.ws.close(); }
}
```

- [ ] **Step 3: Test (falla)**

`panel/apps/api/src/agents/agents.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { create } from "@bufbuild/protobuf";
import { ObservedSchema, ServerObservedSchema } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { specSchema } from "@mcsm/shared";

let app: FastifyInstance;
let url: string;
let cookie: string;

async function enrollNode(name = "nas"): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

const baseSpec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

describe("agent hub", () => {
  it("rechaza tokens inválidos", async () => {
    const agent = new FakeAgent(url, "nope");
    await expect(agent.connect()).rejects.toThrow(/401/);
  });

  it("Hello → HelloAck + SyncSpecs con lo que falta, y marca el nodo online/offline", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const s2 = app.servers.create({ nodeId, name: "Dos", slug: "dos", spec: { ...baseSpec, ports: { game: 25566, extra: [] } }, desiredState: "stopped" });
    app.servers.updateSpec(s2.id, { ...baseSpec, ports: { game: 25567, extra: [] } }); // s2 pasa a versión 2

    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s2.id]: 2n, "zombie-id": 1n } });
    const ack = await agent.waitFor("helloAck");
    expect(ack.body.case === "helloAck" && ack.body.value.nodeId).toBe(nodeId);

    const sync = await agent.waitFor("syncSpecs");
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.servers.map((s) => s.serverId)).toEqual([s1.id]); // s2 ya está al día
    expect(sync.body.value.removedIds).toEqual(["zombie-id"]);
    expect(sync.body.value.servers[0]!.slug).toBe("uno");
    expect(sync.body.value.servers[0]!.version).toBe(1n);
    agent.ack(sync.id);

    await new Promise((r) => setTimeout(r, 50));
    let node = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json()[0];
    expect(node.status).toBe("online");
    expect(node.agentVersion).toBe("fake");
    expect(app.agents.isOnline(nodeId)).toBe(true);

    agent.close();
    await new Promise((r) => setTimeout(r, 100));
    node = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json()[0];
    expect(node.status).toBe("offline");
  });

  it("ServerObserved actualiza la BD y emite evento", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s1.id]: 1n } });
    await agent.waitFor("helloAck");
    const seen = new Promise<any>((resolve) => app.events.once("observed", (id, obs) => resolve({ id, obs })));
    agent.send({ body: { case: "serverObserved", value: create(ServerObservedSchema, {
      serverId: s1.id, tsUnixMs: BigInt(Date.now()),
      observed: create(ObservedSchema, { containerId: "abc", state: "running", health: "healthy", appliedVersion: 1n, mc: { online: true, playersOnline: 2, playersMax: 10, version: "1.21.4", latencyMs: 3 } }),
    }) } });
    const ev = await seen;
    expect(ev.id).toBe(s1.id);
    expect(ev.obs.state).toBe("running");
    const row = app.servers.get(s1.id)!;
    expect(row.observed_spec_version).toBe(1);
    expect(JSON.parse(row.observed!).mc.playersOnline).toBe(2);
  });

  it("request() resuelve con la respuesta del mismo id y falla con Error", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    await agent.waitFor("syncSpecs");
    const conn = app.agents.get(nodeId)!;
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 2000);
    const req = await agent.waitFor("powerAction");
    agent.ack(req.id);
    expect((await p).body.case).toBe("ack");
    const p2 = conn.request({ case: "sendCommand", value: { serverId: "x", command: "list" } }, 2000);
    const req2 = await agent.waitFor("sendCommand");
    agent.send({ id: req2.id, body: { case: "error", value: { code: "rcon_failed", message: "sin conexión" } } });
    await expect(p2).rejects.toMatchObject({ code: "rcon_failed", message: "sin conexión" });
  });
});
```

- [ ] **Step 4: Implementación del hub**

`panel/apps/api/src/agents/hub.ts`:
```ts
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { create, fromBinary, toBinary, type MessageInit } from "@bufbuild/protobuf";
import { EnvelopeSchema, type Envelope } from "@mcsm/proto";

/** Cuerpo del envelope en forma de inicializador: admite objetos planos sin $typeName. */
export type Body = NonNullable<MessageInit<Envelope>["body"]>;

export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AgentError"; }
}

interface Pending { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Stream { onFrame: (e: Envelope) => void; onClose: (reason: string) => void }

export class AgentConn {
  private nextId = 2n; // 1 lo usa el Hello del agente
  private pending = new Map<bigint, Pending>();
  private streams = new Map<bigint, Stream>();

  constructor(readonly nodeId: string, private socket: WebSocket, private hub: AgentHub) {
    socket.on("message", (data: Buffer) => this.handle(data));
    socket.on("close", () => this.dispose("conexión cerrada"));
    socket.on("error", () => this.dispose("error de socket"));
  }

  send(body: Body, opts: { id?: bigint; streamId?: bigint } = {}): bigint {
    const id = opts.id ?? this.nextId++;
    const env = create(EnvelopeSchema, { id, streamId: opts.streamId ?? 0n, body });
    this.socket.send(toBinary(EnvelopeSchema, env));
    return id;
  }

  request(body: Body, timeoutMs = 30_000): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      const id = this.send(body);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("timeout", "El agente no respondió a tiempo"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async openStream(body: Body, onFrame: (e: Envelope) => void, onClose: (reason: string) => void): Promise<{ streamId: bigint; close(): void }> {
    const ack = await this.request(body);
    const streamId = ack.streamId;
    if (streamId === 0n) throw new AgentError("protocol", "El agente no devolvió stream_id");
    this.streams.set(streamId, { onFrame, onClose });
    return {
      streamId,
      close: () => {
        if (!this.streams.delete(streamId)) return;
        if (this.socket.readyState === this.socket.OPEN) {
          this.send({ case: "streamClose", value: { reason: "cerrado por el panel" } }, { streamId });
        }
      },
    };
  }

  private handle(data: Buffer) {
    let env: Envelope;
    try {
      env = fromBinary(EnvelopeSchema, new Uint8Array(data));
    } catch {
      return;
    }
    if (env.streamId !== 0n && env.body.case !== "ack") {
      const s = this.streams.get(env.streamId);
      if (!s) return;
      if (env.body.case === "streamClose") {
        this.streams.delete(env.streamId);
        s.onClose(env.body.value.reason);
      } else {
        s.onFrame(env);
      }
      return;
    }
    const p = this.pending.get(env.id);
    if (p) {
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      if (env.body.case === "error") p.reject(new AgentError(env.body.value.code, env.body.value.message));
      else p.resolve(env);
      return;
    }
    this.hub.emit("message", this.nodeId, env);
  }

  private dispose(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentError("disconnected", "El nodo se desconectó"));
      this.pending.delete(id);
    }
    for (const [id, s] of this.streams) {
      this.streams.delete(id);
      s.onClose(reason);
    }
    this.hub.detach(this.nodeId, this);
  }

  terminate() { this.socket.terminate(); }
}

export class AgentHub extends EventEmitter {
  private conns = new Map<string, AgentConn>();

  attach(nodeId: string, socket: WebSocket): AgentConn {
    this.conns.get(nodeId)?.terminate(); // una sola sesión por nodo
    const conn = new AgentConn(nodeId, socket, this);
    this.conns.set(nodeId, conn);
    this.emit("attached", nodeId);
    return conn;
  }

  detach(nodeId: string, conn?: AgentConn) {
    const current = this.conns.get(nodeId);
    if (conn && current !== conn) return; // ya fue reemplazada por una sesión nueva
    this.conns.delete(nodeId);
    this.emit("detached", nodeId);
  }

  get(nodeId: string): AgentConn | undefined { return this.conns.get(nodeId); }
  isOnline(nodeId: string): boolean { return this.conns.has(nodeId); }
}
```

- [ ] **Step 5: Servicio y rutas**

`panel/apps/api/src/agents/service.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { Envelope, Observed } from "@mcsm/proto";
import { toNodeDto } from "../nodes/repo.js";
import { toServerSpecMessage, type ObservedDto } from "../servers/repo.js";

export function observedToDto(o: Observed | undefined): ObservedDto {
  return {
    containerId: o?.containerId ?? "", state: o?.state ?? "missing", health: o?.health ?? "",
    startedAtUnix: Number(o?.startedAtUnix ?? 0n), exitCode: o?.exitCode ?? 0,
    appliedVersion: Number(o?.appliedVersion ?? 0n), error: o?.error ?? "",
    mc: {
      online: o?.mc?.online ?? false, playersOnline: o?.mc?.playersOnline ?? 0, playersMax: o?.mc?.playersMax ?? 0,
      version: o?.mc?.version ?? "", latencyMs: o?.mc?.latencyMs ?? 0,
    },
  };
}

export class AgentService {
  private lastTouch = new Map<string, number>();

  constructor(private app: FastifyInstance) {}

  start() {
    const { agents, nodes, events } = this.app;
    agents.on("attached", (nodeId: string) => {
      nodes.setStatus(nodeId, "online");
      events.emit("node", toNodeDto(nodes.get(nodeId)!));
    });
    agents.on("detached", (nodeId: string) => {
      const row = nodes.get(nodeId);
      if (!row) return;
      nodes.setStatus(nodeId, "offline");
      events.emit("node", toNodeDto(nodes.get(nodeId)!));
    });
    agents.on("message", (nodeId: string, env: Envelope) => this.onMessage(nodeId, env));
  }

  private onMessage(nodeId: string, env: Envelope) {
    const now = Date.now();
    if ((this.lastTouch.get(nodeId) ?? 0) < now - 10_000) {
      this.app.nodes.touch(nodeId);
      this.lastTouch.set(nodeId, now);
    }
    switch (env.body.case) {
      case "hello":
        return this.onHello(nodeId, env);
      case "serverObserved": {
        const { serverId, observed } = env.body.value;
        const row = this.app.servers.get(serverId);
        if (!row || row.node_id !== nodeId) return;
        const dto = observedToDto(observed);
        this.app.servers.updateObserved(serverId, dto);
        this.app.events.emit("observed", serverId, dto);
        return;
      }
      default:
        this.app.log.warn({ nodeId, type: env.body.case }, "mensaje de agente no esperado");
    }
  }

  private async onHello(nodeId: string, env: Envelope) {
    if (env.body.case !== "hello") return;
    const hello = env.body.value;
    const conn = this.app.agents.get(nodeId);
    if (!conn) return;
    this.app.nodes.setStatus(nodeId, "online", {
      agentVersion: hello.agentVersion, dockerVersion: hello.dockerVersion,
      hostInfo: hello.host ? { hostname: hello.host.hostname, cpus: hello.host.cpus, memTotalBytes: Number(hello.host.memTotalBytes), os: hello.host.os, arch: hello.host.arch } : undefined,
    });
    this.app.events.emit("node", toNodeDto(this.app.nodes.get(nodeId)!));
    conn.send({ case: "helloAck", value: { nodeId } }, { id: env.id });

    const rows = this.app.servers.list(nodeId);
    const known = new Set(Object.keys(hello.specVersions));
    const servers = rows.filter((r) => hello.specVersions[r.id] !== BigInt(r.spec_version)).map(toServerSpecMessage);
    const removedIds = [...known].filter((id) => !rows.some((r) => r.id === id));
    try {
      await conn.request({ case: "syncSpecs", value: { servers, removedIds } }, 120_000);
      this.app.log.info({ nodeId, sent: servers.length, removed: removedIds.length }, "specs sincronizadas");
    } catch (e) {
      this.app.log.warn({ nodeId, err: e }, "SyncSpecs sin confirmación");
    }
  }
}
```

`panel/apps/api/src/agents/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { hashToken } from "../lib/tokens.js";

export async function agentRoutes(app: FastifyInstance) {
  if (!app.hasPlugin("@fastify/websocket")) await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.get("/agent/ws", { websocket: true }, (socket, req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const node = token ? app.nodes.findByTokenHash(hashToken(token)) : null;
    if (!node) {
      socket.close(4401, "token inválido");
      return;
    }
    req.log.info({ nodeId: node.id, name: node.name }, "agente conectado");
    app.agents.attach(node.id, socket);
  });
}
```

Nota: `@fastify/websocket` completa el handshake antes de ejecutar el handler, así que un token inválido se traduce en cierre con código 4401, no en HTTP 401. Para que el agente Go y el fake reciban un 401 HTTP real, añade este hook en la misma función, antes de `app.get`:
```ts
  app.addHook("onRequest", async (req, reply) => {
    if (req.url !== "/agent/ws") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !app.nodes.findByTokenHash(hashToken(token))) return reply.code(401).send({ error: "token inválido" });
  });
```
(El hook `onRequest` sí corre antes del upgrade.)

En `app.ts`, sustituye el comentario de la Task 13 por:
```ts
  app.decorate("events", new EventEmitter());
  app.decorate("agents", new AgentHub());
  app.decorate("servers", new ServersRepo(opts.db));
  await app.register(agentRoutes);
  new AgentService(app).start();
  app.addHook("onReady", async () => app.nodes.markAllOffline());
```
con imports de `node:events`, `./agents/hub.js`, `./agents/routes.js`, `./agents/service.js`, `./servers/repo.js`, y amplía la declaración de módulo:
```ts
declare module "fastify" {
  interface FastifyInstance { db: Db; config: Config; events: EventEmitter; agents: AgentHub; servers: ServersRepo }
}
```
El hook de auth (Task 11) ya deja pasar `/agent/*` porque solo protege `/api/*` y `/ws`.

- [ ] **Step 6: Ejecutar**

```bash
pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck
```
Expected: 4 tests nuevos PASS. Si el fake no recibe HTTP 401 sino un cierre 4401, revisa que el hook `onRequest` esté registrado en el mismo contexto de plugin que la ruta.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(api): hub de agentes por WebSocket con Hello/SyncSpecs, peticiones y estado observado

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Servidores (CRUD, puertos, power, consola)

**Files:**
- Create: `panel/packages/shared/src/slug.ts`, `panel/packages/shared/src/slug.test.ts`, `panel/apps/api/src/servers/{service.ts,routes.ts,servers.test.ts}`
- Modify: `panel/packages/shared/src/index.ts`, `panel/apps/api/src/app.ts`

**Interfaces:**
- Produces (`@mcsm/shared`): `slugify(name: string): string`, `serverCreateSchema`, `serverPatchSchema`, `powerActionSchema`, `type ServerCreateInput`.
- Produces (api): `ServersService` con `create(input)`, `patch(id, input)`, `power(id, action)`, `command(id, command)`, `remove(id, deleteData)`, `allocatePort(nodeId)`; errores `HttpError(status, message)`; rutas `GET /api/servers`, `POST /api/servers`, `GET /api/servers/:id`, `PATCH /api/servers/:id`, `DELETE /api/servers/:id?deleteData=true`, `POST /api/servers/:id/power`, `POST /api/servers/:id/command`.

- [ ] **Step 1: slugify (test y código)**

`panel/packages/shared/src/slug.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("normaliza acentos, espacios y mayúsculas", () => {
    expect(slugify("Supervivencia 2024 ñ")).toBe("supervivencia-2024-n");
    expect(slugify("  Creativo__Él & Ella  ")).toBe("creativo-el-ella");
  });
  it("recorta a 40 y nunca empieza por guion", () => {
    expect(slugify("-" + "a".repeat(60))).toHaveLength(40);
    expect(slugify("---x")).toBe("x");
  });
  it("devuelve 'server' si no queda nada", () => {
    expect(slugify("!!!")).toBe("server");
  });
});
```
`panel/packages/shared/src/slug.ts`:
```ts
export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "server";
}
```
Añade a `panel/packages/shared/src/spec.ts` (al final):
```ts
export const serverCreateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
  spec: specInputSchema.prefault({}),
});
export type ServerCreateInput = z.infer<typeof serverCreateSchema>;

export const serverPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  spec: specInputSchema.optional(),
});
export const powerActionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) });
export type PowerActionName = z.infer<typeof powerActionSchema>["action"];
```
y `export * from "./slug.js";` en `index.ts`. Ejecuta `pnpm --filter @mcsm/shared test` → PASS.

- [ ] **Step 2: Test de servidores (falla)**

`panel/apps/api/src/servers/servers.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

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

const post = (u: string, payload: unknown) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });

describe("servidores", () => {
  it("crea con slug, puerto y rconPassword generados; oculta el secreto en listados", async () => {
    let res = await post("/api/servers", { nodeId, name: "Supervivencia 2024 ñ", spec: { type: "PAPER", version: "1.21.4", memory: "4G" } });
    expect(res.statusCode).toBe(201);
    const s1 = res.json();
    expect(s1.slug).toBe("supervivencia-2024-n");
    expect(s1.spec.ports.game).toBe(25565);
    expect(s1.spec.rconPassword).toHaveLength(43);
    expect(s1.desiredState).toBe("stopped");
    res = await post("/api/servers", { nodeId, name: "Creativo" });
    expect(res.json().spec.ports.game).toBe(25566);
    res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie } });
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].spec.rconPassword).toBeUndefined();
    res = await app.inject({ method: "GET", url: `/api/servers/${s1.id}`, headers: { cookie } });
    expect(res.json().spec.rconPassword).toHaveLength(43);
  });

  it("rechaza slug duplicado y puerto ocupado en el mismo nodo", async () => {
    await post("/api/servers", { nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } });
    let res = await post("/api/servers", { nodeId, name: "Otro", slug: "uno" });
    expect(res.statusCode).toBe(409);
    res = await post("/api/servers", { nodeId, name: "Dos", spec: { ports: { game: 25570 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/puerto/i);
  });

  it("valida la spec (env reservada, memLimit)", async () => {
    let res = await post("/api/servers", { nodeId, name: "X", spec: { env: { TYPE: "FORGE" } } });
    expect(res.statusCode).toBe(400);
    res = await post("/api/servers", { nodeId, name: "X", spec: { memory: "4G", resources: { cpus: 0, memLimit: "2G" } } });
    expect(res.statusCode).toBe(400);
  });

  it("con el nodo offline: crear funciona, power y command devuelven 409", async () => {
    const s = (await post("/api/servers", { nodeId, name: "Uno" })).json();
    let res = await post(`/api/servers/${s.id}/power`, { action: "start" });
    expect(res.statusCode).toBe(409);
    res = await post(`/api/servers/${s.id}/command`, { command: "list" });
    expect(res.statusCode).toBe(409);
  });

  it("con el nodo online: crear, editar, power y command llegan al agente", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const created = post("/api/servers", { nodeId, name: "Uno", desiredState: "running" });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(apply.body.value.server!.slug).toBe("uno");
    expect(apply.body.value.server!.version).toBe(1n);
    expect(apply.body.value.server!.desiredState).toBe(1); // RUNNING
    agent.ack(apply.id);
    const s = (await created).json();

    const patched = app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { name: "Uno renombrado", spec: { memory: "3G" } } });
    const apply2 = await agent.waitFor("applySpec");
    if (apply2.body.case !== "applySpec") throw new Error();
    expect(apply2.body.value.server!.version).toBe(2n);
    expect(JSON.parse(new TextDecoder().decode(apply2.body.value.server!.specJson)).memory).toBe("3G");
    agent.ack(apply2.id);
    expect((await patched).json()).toMatchObject({ name: "Uno renombrado", specVersion: 2 });

    const power = post(`/api/servers/${s.id}/power`, { action: "stop" });
    const pa = await agent.waitFor("powerAction");
    if (pa.body.case !== "powerAction") throw new Error();
    expect(pa.body.value.action).toBe(2); // STOP
    agent.ack(pa.id);
    expect((await power).statusCode).toBe(200);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");

    const cmd = post(`/api/servers/${s.id}/command`, { command: "list" });
    const sc = await agent.waitFor("sendCommand");
    agent.send({ id: sc.id, body: { case: "commandResult", value: { output: "There are 0 of a max of 10 players online" } } });
    expect((await cmd).json()).toEqual({ output: "There are 0 of a max of 10 players online" });

    const del = app.inject({ method: "DELETE", url: `/api/servers/${s.id}?deleteData=true`, headers: { cookie } });
    const rm = await agent.waitFor("removeServer");
    if (rm.body.case !== "removeServer") throw new Error();
    expect(rm.body.value.deleteData).toBe(true);
    agent.ack(rm.id);
    expect((await del).statusCode).toBe(204);
    expect(app.servers.get(s.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Servicio**

`panel/apps/api/src/servers/service.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { PowerActionType } from "@mcsm/proto";
import { specSchema, slugify, type ServerCreateInput, type Spec, type SpecInput, type PowerActionName } from "@mcsm/shared";
import type { z } from "zod";
import { randomToken } from "../lib/tokens.js";
import { AgentError } from "../agents/hub.js";
import { toServerDto, toServerSpecMessage, type ServerRow } from "./repo.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const POWER: Record<PowerActionName, PowerActionType> = {
  start: PowerActionType.START, stop: PowerActionType.STOP, restart: PowerActionType.RESTART, kill: PowerActionType.KILL,
};

export class ServersService {
  constructor(private app: FastifyInstance) {}

  private requireNode(nodeId: string) {
    const node = this.app.nodes.get(nodeId);
    if (!node) throw new HttpError(404, "Nodo no encontrado");
    return node;
  }

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    return row;
  }

  private onlineConn(nodeId: string) {
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return conn;
  }

  allocatePort(nodeId: string, exclude = new Set<number>()): number {
    const used = this.app.servers.usedGamePorts(nodeId);
    const { from, to } = this.app.config.gamePortRange;
    for (let p = from; p <= to; p++) if (!used.has(p) && !exclude.has(p)) return p;
    throw new HttpError(409, `No quedan puertos libres entre ${from} y ${to} en este nodo`);
  }

  private checkPorts(nodeId: string, spec: Spec, selfId?: string) {
    const used = new Set<number>();
    for (const r of this.app.servers.list(nodeId)) {
      if (r.id === selfId) continue;
      const s = JSON.parse(r.spec) as Spec;
      used.add(s.ports.game);
      for (const e of s.ports.extra) used.add(e.host);
    }
    const mine = [spec.ports.game, ...spec.ports.extra.map((e) => e.host)];
    for (const p of mine) if (used.has(p)) throw new HttpError(409, `El puerto ${p} ya lo usa otro servidor de este nodo`);
    if (new Set(mine).size !== mine.length) throw new HttpError(400, "La spec repite un puerto");
  }

  private completeSpec(nodeId: string, input: SpecInput, previous?: Spec): Spec {
    const game = input.ports.game ?? previous?.ports.game ?? this.allocatePort(nodeId);
    const candidate = { ...input, ports: { game, extra: input.ports.extra }, rconPassword: previous?.rconPassword ?? randomToken() };
    const parsed = specSchema.safeParse(candidate);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Spec inválida");
    return parsed.data;
  }

  private async push(row: ServerRow): Promise<void> {
    const conn = this.app.agents.get(row.node_id);
    if (!conn) return; // se entregará en el próximo SyncSpecs
    try {
      await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(row) } }, 120_000);
    } catch (e) {
      this.app.log.warn({ serverId: row.id, err: e }, "ApplySpec sin éxito; el agente lo reintentará");
    }
  }

  async create(input: ServerCreateInput) {
    this.requireNode(input.nodeId);
    const slug = input.slug ?? slugify(input.name);
    if (this.app.servers.getBySlug(input.nodeId, slug)) throw new HttpError(409, `Ya existe un servidor con slug "${slug}" en este nodo`);
    const spec = this.completeSpec(input.nodeId, input.spec);
    this.checkPorts(input.nodeId, spec);
    const row = this.app.servers.create({ nodeId: input.nodeId, name: input.name, slug, spec, desiredState: input.desiredState });
    void this.push(row);
    return toServerDto(row, { includeSecrets: true });
  }

  async patch(id: string, input: { name?: string; spec?: SpecInput }) {
    const row = this.requireServer(id);
    let updated = row;
    if (input.spec) {
      const spec = this.completeSpec(row.node_id, input.spec, JSON.parse(row.spec) as Spec);
      this.checkPorts(row.node_id, spec, row.id);
      updated = this.app.servers.updateSpec(id, spec, input.name);
      void this.push(updated);
    } else if (input.name) {
      updated = this.app.servers.updateSpec(id, JSON.parse(row.spec) as Spec, input.name);
    }
    return toServerDto(updated, { includeSecrets: true });
  }

  async power(id: string, action: PowerActionName) {
    const row = this.requireServer(id);
    const conn = this.onlineConn(row.node_id);
    this.app.servers.setDesiredState(id, action === "start" || action === "restart" ? "running" : "stopped");
    try {
      await conn.request({ case: "powerAction", value: { serverId: id, action: POWER[action] } }, 90_000);
    } catch (e) {
      throw new HttpError(502, e instanceof AgentError ? e.message : "Fallo al ejecutar la acción");
    }
    return toServerDto(this.app.servers.get(id)!);
  }

  async command(id: string, command: string): Promise<{ output: string }> {
    const row = this.requireServer(id);
    const conn = this.onlineConn(row.node_id);
    try {
      const res = await conn.request({ case: "sendCommand", value: { serverId: id, command } }, 20_000);
      return { output: res.body.case === "commandResult" ? res.body.value.output : "" };
    } catch (e) {
      throw new HttpError(502, e instanceof AgentError ? e.message : "Fallo al enviar el comando");
    }
  }

  async remove(id: string, deleteData: boolean) {
    const row = this.requireServer(id);
    const conn = this.app.agents.get(row.node_id);
    if (conn) {
      try {
        await conn.request({ case: "removeServer", value: { serverId: id, deleteData } }, 120_000);
      } catch (e) {
        throw new HttpError(502, e instanceof AgentError ? e.message : "El agente no pudo eliminar el servidor");
      }
    } else if (deleteData) {
      throw new HttpError(409, "El nodo está desconectado: no se pueden borrar los datos ahora. Borra sin datos o espera a que vuelva.");
    }
    this.app.servers.delete(id);
  }
}
```

- [ ] **Step 4: Rutas**

`panel/apps/api/src/servers/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { powerActionSchema, serverCreateSchema, serverPatchSchema } from "@mcsm/shared";
import { HttpError, ServersService } from "./service.js";
import { toServerDto } from "./repo.js";

export async function serverRoutes(app: FastifyInstance) {
  const svc = new ServersService(app);
  app.decorate("serversService", svc);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Datos inválidos" });
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Error interno" });
  });

  app.get("/api/servers", async () => app.servers.list().map((r) => toServerDto(r)));

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (req) => {
    const row = app.servers.get(req.params.id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    return toServerDto(row, { includeSecrets: true });
  });

  app.post("/api/servers", async (req, reply) => {
    const dto = await svc.create(serverCreateSchema.parse(req.body));
    return reply.code(201).send(dto);
  });

  app.patch<{ Params: { id: string } }>("/api/servers/:id", async (req) => svc.patch(req.params.id, serverPatchSchema.parse(req.body)));

  app.delete<{ Params: { id: string }; Querystring: { deleteData?: string } }>("/api/servers/:id", async (req, reply) => {
    await svc.remove(req.params.id, req.query.deleteData === "true");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/servers/:id/power", async (req) => svc.power(req.params.id, powerActionSchema.parse(req.body).action));

  app.post<{ Params: { id: string } }>("/api/servers/:id/command", async (req) => {
    const { command } = z.object({ command: z.string().trim().min(1).max(500) }).parse(req.body);
    return svc.command(req.params.id, command);
  });
}

declare module "fastify" {
  interface FastifyInstance { serversService: ServersService }
}
```
En `app.ts`: `await app.register(serverRoutes);`. El `setErrorHandler` debe quedar a nivel de app (regístralo en `buildApp` tras los plugins, no dentro del plugin encapsulado; si Fastify lo encapsula, mueve la función a `app.ts`).

- [ ] **Step 5: Ejecutar**

```bash
pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/api test && pnpm -r typecheck
```
Expected: todo PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): CRUD de servidores con asignación de puertos, power y consola vía agente

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Tiempo real hacia el navegador (`/ws`): estado, nodos y logs

**Files:**
- Create: `panel/apps/api/src/realtime/{hub.ts,routes.ts,realtime.test.ts}`
- Modify: `panel/apps/api/src/app.ts`

**Interfaces:**
- Protocolo navegador ↔ panel (JSON):
  - cliente → `{type:"subscribe", topic}` / `{type:"unsubscribe", topic}`; topics: `"servers"`, `"nodes"`, `"server:<id>:logs"`.
  - panel → `{type:"observed", serverId, observed, observedAt}`, `{type:"node", node}`, `{type:"log", serverId, ts, line}`, `{type:"stream_closed", serverId, reason}`, `{type:"error", message}`.
- Produces: `BrowserHub` con `add(socket)`, `publish(topic, msg)`, y `LogRelay` interno con refcount por servidor que abre/cierra el stream del agente.

- [ ] **Step 1: Test (falla)**

`panel/apps/api/src/realtime/realtime.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { create } from "@bufbuild/protobuf";
import { LogLineSchema, ObservedSchema, ServerObservedSchema } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

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

function browser(withCookie = true): Promise<{ ws: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers: withCookie ? { cookie } : {} });
    const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m); });
    ws.on("open", () => resolve({ ws, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r, rj) => { const t = setTimeout(() => rj(new Error("sin mensaje")), 3000); waiters.push((m) => { clearTimeout(t); r(m); }); }) }));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

describe("realtime", () => {
  it("exige sesión", async () => {
    await expect(browser(false)).rejects.toThrow(/401/);
  });

  it("reenvía estado observado y cambios de nodo", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const b = await browser();
    b.ws.send(JSON.stringify({ type: "subscribe", topic: "servers" }));
    b.ws.send(JSON.stringify({ type: "subscribe", topic: "nodes" }));
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    const nodeMsg = await b.next();
    expect(nodeMsg).toMatchObject({ type: "node", node: { id: nodeId, status: "online" } });
    agent.send({ body: { case: "serverObserved", value: create(ServerObservedSchema, { serverId: s.id, observed: create(ObservedSchema, { state: "running", appliedVersion: 1n }) }) } });
    let obs: any;
    do { obs = await b.next(); } while (obs.type !== "observed"); // puede llegar un segundo evento "node" tras el Hello
    expect(obs).toMatchObject({ type: "observed", serverId: s.id, observed: { state: "running", appliedVersion: 1 } });
    b.ws.close();
  });

  it("abre un stream de logs por servidor mientras haya suscriptores y avisa al cerrarse", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const b1 = await browser();
    const b2 = await browser();
    b1.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    const sub = await agent.waitFor("subscribeLogs");
    if (sub.body.case !== "subscribeLogs") throw new Error();
    expect(sub.body.value.serverId).toBe(s.id);
    expect(sub.body.value.tail).toBe(200);
    agent.ack(sub.id, sub.id); // Ack con stream_id = id
    b2.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    await new Promise((r) => setTimeout(r, 50));
    agent.send({ streamId: sub.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: s.id, tsUnixMs: 1760000000000n, line: "Done!" }) } });
    expect(await b1.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000000, line: "Done!" });
    expect(await b2.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000000, line: "Done!" });

    b1.ws.send(JSON.stringify({ type: "unsubscribe", topic: `server:${s.id}:logs` }));
    await new Promise((r) => setTimeout(r, 50));
    await expect(agent.next(300)).rejects.toThrow(); // con b2 aún suscrito, no se cierra el stream

    agent.close(); // el nodo cae
    const closed = await b2.next();
    expect(closed).toMatchObject({ type: "stream_closed", serverId: s.id });
    b2.ws.close();
  });

  it("cierra el stream del agente cuando se va el último suscriptor", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);
    const b = await browser();
    b.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    const sub = await agent.waitFor("subscribeLogs");
    agent.ack(sub.id, sub.id);
    b.ws.close();
    const close = await agent.waitFor("streamClose");
    expect(close.streamId).toBe(sub.id);
  });
});
```

- [ ] **Step 2: Implementación**

`panel/apps/api/src/realtime/hub.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Envelope } from "@mcsm/proto";

type Msg = Record<string, unknown> & { type: string };

const LOG_TAIL = 200;

export class BrowserHub {
  private clients = new Map<WebSocket, Set<string>>();
  private topics = new Map<string, Set<WebSocket>>();
  private logs = new LogRelay(this.app, this);

  constructor(private app: FastifyInstance) {
    app.events.on("observed", (serverId: string, observed: unknown) =>
      this.publish("servers", { type: "observed", serverId, observed, observedAt: new Date().toISOString() }));
    app.events.on("node", (node: unknown) => this.publish("nodes", { type: "node", node }));
  }

  add(socket: WebSocket) {
    this.clients.set(socket, new Set());
    socket.on("message", (raw) => {
      let msg: { type?: string; topic?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return this.send(socket, { type: "error", message: "JSON inválido" }); }
      if (typeof msg.topic !== "string") return this.send(socket, { type: "error", message: "topic requerido" });
      if (msg.type === "subscribe") this.subscribe(socket, msg.topic);
      else if (msg.type === "unsubscribe") this.unsubscribe(socket, msg.topic);
    });
    socket.on("close", () => {
      for (const t of this.clients.get(socket) ?? []) this.unsubscribe(socket, t);
      this.clients.delete(socket);
    });
  }

  private subscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine || mine.has(topic)) return;
    const m = topic.match(/^server:([^:]+):logs$/);
    if (m && !this.app.servers.get(m[1]!)) return this.send(socket, { type: "error", message: "Servidor desconocido" });
    mine.add(topic);
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic)!.add(socket);
    if (m) this.logs.retain(m[1]!);
  }

  private unsubscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine?.delete(topic)) return;
    const set = this.topics.get(topic);
    set?.delete(socket);
    if (set && set.size === 0) this.topics.delete(topic);
    const m = topic.match(/^server:([^:]+):logs$/);
    if (m) this.logs.release(m[1]!);
  }

  publish(topic: string, msg: Msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.topics.get(topic) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private send(ws: WebSocket, msg: Msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

/** Mantiene un único stream de logs por servidor hacia el agente mientras haya navegadores suscritos. */
class LogRelay {
  private active = new Map<string, { count: number; close?: () => void; opening: boolean }>();

  constructor(private app: FastifyInstance, private hub: BrowserHub) {}

  retain(serverId: string) {
    const entry = this.active.get(serverId) ?? { count: 0, opening: false };
    entry.count++;
    this.active.set(serverId, entry);
    if (entry.count === 1) void this.open(serverId, entry);
  }

  release(serverId: string) {
    const entry = this.active.get(serverId);
    if (!entry) return;
    entry.count--;
    if (entry.count <= 0) {
      this.active.delete(serverId);
      entry.close?.();
    }
  }

  private async open(serverId: string, entry: { count: number; close?: () => void; opening: boolean }) {
    const row = this.app.servers.get(serverId);
    const conn = row && this.app.agents.get(row.node_id);
    const topic = `server:${serverId}:logs`;
    if (!conn) {
      this.hub.publish(topic, { type: "stream_closed", serverId, reason: "nodo desconectado" });
      return;
    }
    entry.opening = true;
    try {
      const stream = await conn.openStream(
        { case: "subscribeLogs", value: { serverId, tail: LOG_TAIL } },
        (env: Envelope) => {
          if (env.body.case === "logLine") {
            this.hub.publish(topic, { type: "log", serverId, ts: Number(env.body.value.tsUnixMs), line: env.body.value.line });
          }
        },
        (reason) => {
          this.hub.publish(topic, { type: "stream_closed", serverId, reason });
          if (this.active.get(serverId) === entry) entry.close = undefined;
        },
      );
      entry.close = stream.close;
      if (entry.count <= 0) stream.close(); // todos se fueron mientras abríamos
    } catch (e) {
      this.hub.publish(topic, { type: "stream_closed", serverId, reason: e instanceof Error ? e.message : "error" });
    } finally {
      entry.opening = false;
    }
  }
}
```

`panel/apps/api/src/realtime/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { BrowserHub } from "./hub.js";

export async function realtimeRoutes(app: FastifyInstance) {
  if (!app.hasPlugin("@fastify/websocket")) await app.register(websocket);
  const hub = new BrowserHub(app);
  app.decorate("browserHub", hub);
  // El hook de auth (Task 11) ya responde 401 en /ws sin sesión, antes del upgrade.
  app.get("/ws", { websocket: true }, (socket) => hub.add(socket));
}

declare module "fastify" {
  interface FastifyInstance { browserHub: BrowserHub }
}
```
En `app.ts`: registra `@fastify/websocket` una sola vez justo después de `authPlugin` (`await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } })`) y elimina los `if (!app.hasPlugin(...))` de agents/routes.ts y realtime/routes.ts; luego `await app.register(realtimeRoutes);`.

- [ ] **Step 3: Ejecutar**

```bash
pnpm --filter @mcsm/api test && pnpm -r typecheck
```
Expected: 4 tests nuevos PASS; el resto sigue en verde.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(api): WebSocket para el navegador con estado en vivo y relé de logs por servidor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Web — scaffold, cliente API, WebSocket y autenticación

**Files:**
- Create: `panel/apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,components.json}`, `panel/apps/web/src/{main.tsx,router.tsx,index.css}`, `panel/apps/web/src/lib/{api.ts,ws.ts,format.ts}`, `panel/apps/web/src/components/layout.tsx`, `panel/apps/web/src/routes/{login.tsx,root.tsx}`, componentes shadcn en `src/components/ui/`

**Interfaces:**
- Produces: `api.get/post/patch/del<T>(path, body?)` (lanza `ApiError{status, message}`), `useAuthStatus()`, `realtime.subscribe(topic, handler): () => void` (singleton con reconexión), `formatBytes`, `formatUptime`, rutas `/login`, `/` (layout con sidebar), `/nodes`, `/servers/new`, `/servers/$serverId` (estas tres se rellenan en Tasks 17–18).

- [ ] **Step 1: Crear el proyecto Vite y dependencias**

```bash
cd panel/apps && pnpm create vite@latest web --template react-ts && cd web && rm -rf src/assets src/App.css src/App.tsx
pnpm add react@^19.3.0 react-dom@^19.3.0 @tanstack/react-router@^1.170.0 @tanstack/react-query@^5.104.0 @mcsm/shared@workspace:* zod@^4.6.0 lucide-react@^1.0.0 clsx tailwind-merge class-variance-authority
pnpm add -D tailwindcss@^4.3.0 @tailwindcss/vite@^4.3.0 @types/react @types/react-dom @vitejs/plugin-react@^6.1.0 typescript@^5.9.0 vite@^8.3.0
```
Ajusta `package.json` para que `name` sea `@mcsm/web`, y scripts: `"dev": "vite --port 5173"`, `"build": "tsc -p tsconfig.json && vite build"`, `"typecheck": "tsc -p tsconfig.json"`, `"test": "echo no tests"`. Si `lucide-react` no tiene 1.x, usa la última estable (`pnpm add lucide-react@latest`).

`panel/apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["vite/client"], "baseUrl": ".", "paths": { "@/*": ["./src/*"] } },
  "include": ["src"]
}
```

`panel/apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
```

`panel/apps/web/src/index.css`:
```css
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));
:root { color-scheme: dark; }
html, body, #root { height: 100%; }
```
(shadcn añadirá sus variables aquí al hacer `init`; si `tw-animate-css` no se instala, elimina esa línea.)

shadcn: `components.json` lo genera el CLI:
```bash
cd panel/apps/web && pnpm dlx shadcn@latest init -d --base-color zinc && pnpm dlx shadcn@latest add -y button card input label badge table tabs dialog select textarea separator
```
Expected: `src/components/ui/*.tsx` y `src/lib/utils.ts` creados. Añade `class="dark"` al `<html>` de `index.html` y cambia el `<title>` a `MC Server Manager`.

- [ ] **Step 2: Cliente API y WebSocket**

`panel/apps/web/src/lib/api.ts`:
```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: "online" | "offline"; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: { hostname?: string; cpus?: number; memTotalBytes?: number; os?: string; arch?: string } | null; lastSeenAt: string | null; createdAt: string;
}
export interface ObservedDto {
  containerId: string; state: string; health: string; startedAtUnix: number; exitCode: number; appliedVersion: number; error: string;
  mc: { online: boolean; playersOnline: number; playersMax: number; version: string; latencyMs: number };
}
export interface ServerDto {
  id: string; nodeId: string; name: string; slug: string; specVersion: number; desiredState: "running" | "stopped";
  observed: ObservedDto | null; observedSpecVersion: number; observedAt: string | null; createdAt: string; updatedAt: string;
  spec: import("@mcsm/shared").SpecInput & { ports: { game: number }; rconPassword?: string };
}
```

`panel/apps/web/src/lib/ws.ts`:
```ts
type Handler = (msg: any) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 1000;
  private connecting = false;

  private ensure() {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      this.ws = ws; this.connecting = false; this.retry = 1000;
      for (const topic of this.handlers.keys()) ws.send(JSON.stringify({ type: "subscribe", topic }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const topic = msg.type === "node" ? "nodes" : msg.type === "observed" ? "servers" : msg.serverId ? `server:${msg.serverId}:logs` : null;
      if (!topic) return;
      for (const h of this.handlers.get(topic) ?? []) h(msg);
    };
    ws.onclose = () => {
      this.ws = null; this.connecting = false;
      if (this.handlers.size > 0) setTimeout(() => this.ensure(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }

  subscribe(topic: string, handler: Handler): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
      this.ws?.send(JSON.stringify({ type: "subscribe", topic }));
    }
    this.handlers.get(topic)!.add(handler);
    this.ensure();
    return () => {
      const set = this.handlers.get(topic);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(topic);
        this.ws?.send(JSON.stringify({ type: "unsubscribe", topic }));
      }
    };
  }
}

export const realtime = new Realtime();
```

`panel/apps/web/src/lib/format.ts`:
```ts
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log2(n) / 10), u.length - 1);
  return `${(n / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
export function formatUptime(startedAtUnix: number): string {
  if (!startedAtUnix) return "—";
  let s = Math.max(0, Math.floor(Date.now() / 1000) - startedAtUnix);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function stateLabel(o: { state: string; health: string; error: string } | null, desired: string): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (!o) return { text: "Sin datos", tone: "muted" };
  if (o.error) return { text: "Error", tone: "bad" };
  if (o.state === "running") return o.health === "healthy" ? { text: "En marcha", tone: "ok" } : { text: "Arrancando", tone: "warn" };
  if (o.state === "missing") return { text: desired === "running" ? "Creando…" : "Sin crear", tone: "muted" };
  if (o.state === "restarting") return { text: "Reiniciando", tone: "warn" };
  return { text: "Parado", tone: "muted" };
}
```

- [ ] **Step 3: Router, layout y login**

`panel/apps/web/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

`panel/apps/web/src/router.tsx`:
```tsx
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from "@tanstack/react-router";
import { api } from "./lib/api";
import { Layout } from "./components/layout";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { NodesPage } from "./routes/nodes";
import { NewServerPage } from "./routes/new-server";
import { ServerPage } from "./routes/server";

type AuthStatus = { configured: boolean; authenticated: boolean };
const getStatus = () => api.get<AuthStatus>("/api/auth/status");

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login", component: LoginPage,
  beforeLoad: async () => { const s = await getStatus(); if (s.authenticated) throw redirect({ to: "/" }); return { configured: s.configured }; },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: "app", component: Layout,
  beforeLoad: async () => { const s = await getStatus(); if (!s.authenticated) throw redirect({ to: "/login" }); },
});

export const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });
export const nodesRoute = createRoute({ getParentRoute: () => appRoute, path: "/nodes", component: NodesPage });
export const newServerRoute = createRoute({ getParentRoute: () => appRoute, path: "/servers/new", component: NewServerPage });
export const serverRoute = createRoute({ getParentRoute: () => appRoute, path: "/servers/$serverId", component: ServerPage });

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([dashboardRoute, nodesRoute, newServerRoute, serverRoute])]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
```
Hasta que existan las páginas de las Tasks 17–18, crea `routes/dashboard.tsx`, `routes/nodes.tsx`, `routes/new-server.tsx` y `routes/server.tsx` con `export function XPage() { return <div className="p-6">Pendiente</div>; }`.

`panel/apps/web/src/components/layout.tsx`:
```tsx
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Server, LogOut, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const nav = [
  { to: "/", label: "Servidores", icon: LayoutDashboard },
  { to: "/nodes", label: "Nodos", icon: Server },
] as const;

export function Layout() {
  const navigate = useNavigate();
  const logout = async () => { await api.post("/api/auth/logout"); navigate({ to: "/login" }); };
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-100">
      <aside className="flex w-56 flex-col border-r border-zinc-800 p-4">
        <div className="mb-6 text-lg font-semibold tracking-tight">MC Server Manager</div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 [&.active]:bg-zinc-800 [&.active]:text-white" activeOptions={{ exact: n.to === "/" }}>
              <n.icon className="size-4" /> {n.label}
            </Link>
          ))}
          <Link to="/servers/new" className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200">
            <Plus className="size-4" /> Nuevo servidor
          </Link>
        </nav>
        <Button variant="ghost" className="justify-start text-zinc-400" onClick={logout}><LogOut className="size-4" /> Salir</Button>
      </aside>
      <main className="flex-1 overflow-auto"><Outlet /></main>
    </div>
  );
}
```

`panel/apps/web/src/routes/login.tsx`:
```tsx
import { useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";

export function LoginPage() {
  const { configured } = useRouteContext({ from: "/login" }) as { configured: boolean };
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(configured ? "/api/auth/login" : "/api/auth/setup", { password });
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error inesperado");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-100">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>{configured ? "Entrar" : "Crea tu contraseña de administrador"}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input type="password" autoFocus placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button type="submit" disabled={busy}>{configured ? "Entrar" : "Guardar y entrar"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Verificar**

```bash
pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
En dos terminales: `pnpm dev:api` y `pnpm dev:web`; abre `http://localhost:5173`. Expected: redirige a `/login`, permite crear la contraseña, entra al layout con "Pendiente".

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): scaffold Vite+React, cliente API, WebSocket con reconexión, layout y login

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Web — dashboard de servidores, nodos y alta, asistente de nuevo servidor

**Files:**
- Create/Replace: `panel/apps/web/src/routes/{dashboard.tsx,nodes.tsx,new-server.tsx}`, `panel/apps/web/src/hooks/{use-servers.ts,use-nodes.ts}`, `panel/apps/web/src/components/{state-badge.tsx,power-buttons.tsx}`

**Interfaces:**
- Produces: `useServers()` y `useNodes()` (React Query + suscripción realtime que actualiza la caché), `<StateBadge observed desired />`, `<PowerButtons server />`.

- [ ] **Step 1: Hooks con tiempo real**

`panel/apps/web/src/hooks/use-servers.ts`:
```ts
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ServerDto, type ObservedDto } from "@/lib/api";
import { realtime } from "@/lib/ws";

export function useServers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["servers"], queryFn: () => api.get<ServerDto[]>("/api/servers"), refetchInterval: 30_000 });
  useEffect(() => realtime.subscribe("servers", (msg: { type: string; serverId: string; observed: ObservedDto; observedAt: string }) => {
    if (msg.type !== "observed") return;
    qc.setQueryData<ServerDto[]>(["servers"], (old) => old?.map((s) => s.id === msg.serverId ? { ...s, observed: msg.observed, observedSpecVersion: msg.observed.appliedVersion, observedAt: msg.observedAt } : s));
    qc.setQueryData<ServerDto>(["server", msg.serverId], (old) => old ? { ...old, observed: msg.observed, observedSpecVersion: msg.observed.appliedVersion, observedAt: msg.observedAt } : old);
  }), [qc]);
  return q;
}

export function useServer(id: string) {
  useServers(); // mantiene viva la suscripción compartida
  return useQuery({ queryKey: ["server", id], queryFn: () => api.get<ServerDto>(`/api/servers/${id}`) });
}
```

`panel/apps/web/src/hooks/use-nodes.ts`:
```ts
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NodeDto } from "@/lib/api";
import { realtime } from "@/lib/ws";

export function useNodes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<NodeDto[]>("/api/nodes"), refetchInterval: 30_000 });
  useEffect(() => realtime.subscribe("nodes", (msg: { type: string; node: NodeDto }) => {
    if (msg.type !== "node") return;
    qc.setQueryData<NodeDto[]>(["nodes"], (old) => old ? old.map((n) => n.id === msg.node.id ? msg.node : n) : old);
  }), [qc]);
  return q;
}
```

- [ ] **Step 2: Componentes compartidos**

`panel/apps/web/src/components/state-badge.tsx`:
```tsx
import { Badge } from "@/components/ui/badge";
import { stateLabel } from "@/lib/format";
import type { ObservedDto } from "@/lib/api";

const tones = { ok: "bg-emerald-600/20 text-emerald-300 border-emerald-700", warn: "bg-amber-600/20 text-amber-300 border-amber-700", bad: "bg-red-600/20 text-red-300 border-red-700", muted: "bg-zinc-800 text-zinc-400 border-zinc-700" };

export function StateBadge({ observed, desired }: { observed: ObservedDto | null; desired: string }) {
  const { text, tone } = stateLabel(observed, desired);
  return <Badge variant="outline" className={tones[tone]} title={observed?.error || undefined}>{text}</Badge>;
}
```

`panel/apps/web/src/components/power-buttons.tsx`:
```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError, type ServerDto } from "@/lib/api";

export function PowerButtons({ server, size = "sm" }: { server: ServerDto; size?: "sm" | "default" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (action: "start" | "stop" | "restart" | "kill") => api.post(`/api/servers/${server.id}/power`, { action }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ["servers"] }); qc.invalidateQueries({ queryKey: ["server", server.id] }); },
  });
  const running = server.observed?.state === "running";
  const err = m.error instanceof ApiError ? m.error.message : null;
  return (
    <div className="flex items-center gap-1">
      {!running && <Button size={size} variant="secondary" disabled={m.isPending} onClick={() => m.mutate("start")} title="Arrancar"><Play className="size-4" /></Button>}
      {running && <Button size={size} variant="secondary" disabled={m.isPending} onClick={() => m.mutate("stop")} title="Parar"><Square className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={m.isPending} onClick={() => m.mutate("restart")} title="Reiniciar"><RotateCcw className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={m.isPending} onClick={() => { if (confirm("¿Matar el proceso sin guardar? Puede corromper el mundo.")) m.mutate("kill"); }} title="Matar"><Skull className="size-4" /></Button>}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Dashboard**

`panel/apps/web/src/routes/dashboard.tsx`:
```tsx
import { Link } from "@tanstack/react-router";
import { Users, Cpu } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StateBadge } from "@/components/state-badge";
import { PowerButtons } from "@/components/power-buttons";
import { useServers } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { formatBytes } from "@/lib/format";

export function DashboardPage() {
  const servers = useServers();
  const nodes = useNodes();
  const nodeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name ?? "—";

  return (
    <div className="flex flex-col gap-6 p-6">
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {nodes.data?.map((n) => (
          <Card key={n.id} className={n.status === "online" ? "border-emerald-900" : "border-zinc-800 opacity-70"}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium">{n.name}</div>
                <div className="text-xs text-zinc-400">{n.status === "online" ? `Agente ${n.agentVersion ?? ""} · Docker ${n.dockerVersion ?? ""}` : "Desconectado"}</div>
              </div>
              <div className="flex items-center gap-1 text-xs text-zinc-400"><Cpu className="size-3" /> {n.hostInfo?.cpus ?? "?"} CPU · {formatBytes(n.hostInfo?.memTotalBytes ?? 0)}</div>
            </CardContent>
          </Card>
        ))}
        {nodes.data?.length === 0 && <Card><CardContent className="p-4 text-sm text-zinc-400">Aún no hay nodos. <Link to="/nodes" className="underline">Añade el primero</Link>.</CardContent></Card>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-400">Servidores</h2>
        <Table>
          <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Estado</TableHead><TableHead>Jugadores</TableHead><TableHead>Versión</TableHead><TableHead>Nodo</TableHead><TableHead>Puerto</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {servers.data?.map((s) => (
              <TableRow key={s.id}>
                <TableCell><Link to="/servers/$serverId" params={{ serverId: s.id }} className="font-medium hover:underline">{s.name}</Link><div className="text-xs text-zinc-500">{s.slug}</div></TableCell>
                <TableCell><StateBadge observed={s.observed} desired={s.desiredState} />{s.observedSpecVersion !== s.specVersion && <span className="ml-2 text-xs text-amber-400">aplicando v{s.specVersion}…</span>}</TableCell>
                <TableCell>{s.observed?.mc.online ? <span className="flex items-center gap-1"><Users className="size-3" /> {s.observed.mc.playersOnline}/{s.observed.mc.playersMax}</span> : <span className="text-zinc-500">—</span>}</TableCell>
                <TableCell>{s.observed?.mc.version || `${s.spec.type} ${s.spec.version}`}</TableCell>
                <TableCell>{nodeName(s.nodeId)}</TableCell>
                <TableCell className="font-mono text-sm">{s.spec.ports.game}</TableCell>
                <TableCell><PowerButtons server={s} /></TableCell>
              </TableRow>
            ))}
            {servers.data?.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-zinc-400">No hay servidores. <Link to="/servers/new" className="underline">Crea el primero</Link>.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Nodos y alta**

`panel/apps/web/src/routes/nodes.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { useNodes } from "@/hooks/use-nodes";

type EnrollResp = { token: string; expiresAt: string; dockerRun: string };

export function NodesPage() {
  const nodes = useNodes();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [nameHint, setNameHint] = useState("");
  const [dataRoot, setDataRoot] = useState("/srv/minecraft");
  const [result, setResult] = useState<EnrollResp | null>(null);

  const gen = useMutation({
    mutationFn: () => api.post<EnrollResp>("/api/nodes/enrollment-tokens", { nameHint: nameHint || "nodo", dataRoot }),
    onSuccess: setResult,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/nodes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nodes"] }),
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Nodos</h1>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setResult(null); gen.reset(); } }}>
          <DialogTrigger asChild><Button>Añadir nodo</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Añadir nodo</DialogTitle></DialogHeader>
            {!result ? (
              <div className="flex flex-col gap-3">
                <div><Label>Nombre</Label><Input value={nameHint} onChange={(e) => setNameHint(e.target.value)} placeholder="nas, salon, torre…" /></div>
                <div><Label>Directorio de datos en esa máquina</Label><Input value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} /></div>
                <Button onClick={() => gen.mutate()} disabled={gen.isPending}>Generar comando</Button>
                {gen.error && <p className="text-sm text-red-400">{(gen.error as ApiError).message}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-zinc-400">Ejecuta esto en la máquina nueva. El token caduca a las {new Date(result.expiresAt).toLocaleTimeString()} y solo sirve una vez. El nodo aparecerá aquí en cuanto conecte.</p>
                <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs">{result.dockerRun}</pre>
                <Button variant="secondary" onClick={() => navigator.clipboard.writeText(result.dockerRun)}><Copy className="size-4" /> Copiar</Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Estado</TableHead><TableHead>Agente</TableHead><TableHead>Docker</TableHead><TableHead>Host</TableHead><TableHead>Datos</TableHead><TableHead>Última vez</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {nodes.data?.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium">{n.name}</TableCell>
              <TableCell><Badge variant="outline" className={n.status === "online" ? "border-emerald-700 text-emerald-300" : "border-zinc-700 text-zinc-400"}>{n.status === "online" ? "Conectado" : "Desconectado"}</Badge></TableCell>
              <TableCell>{n.agentVersion ?? "—"}</TableCell>
              <TableCell>{n.dockerVersion ?? "—"}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.hostInfo ? `${n.hostInfo.hostname} · ${n.hostInfo.os}/${n.hostInfo.arch}` : "—"}</TableCell>
              <TableCell className="font-mono text-xs">{n.dataRoot}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "nunca"}</TableCell>
              <TableCell><Button size="sm" variant="ghost" onClick={() => { if (confirm(`¿Eliminar el nodo "${n.name}"? Solo es posible si no tiene servidores.`)) del.mutate(n.id); }}><Trash2 className="size-4" /></Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {del.error && <p className="text-sm text-red-400">{(del.error as ApiError).message}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Nuevo servidor**

`panel/apps/web/src/routes/new-server.tsx`:
```tsx
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { useNodes } from "@/hooks/use-nodes";

export const SERVER_TYPES = ["VANILLA", "PAPER", "PURPUR", "SPIGOT", "FABRIC", "FORGE", "NEOFORGE", "QUILT"] as const;
export const JAVA_TAGS = ["java21", "java17", "java8", "java25", "latest"] as const;

export function NewServerPage() {
  const nodes = useNodes();
  const navigate = useNavigate();
  const [form, setForm] = useState({ nodeId: "", name: "", type: "PAPER", version: "LATEST", imageTag: "java21", memory: "4G", port: "", start: true });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => api.post<ServerDto>("/api/servers", {
      nodeId: form.nodeId, name: form.name, desiredState: form.start ? "running" : "stopped",
      spec: { type: form.type, version: form.version, imageTag: form.imageTag, memory: form.memory, ports: form.port ? { game: Number(form.port) } : undefined },
    }),
    onSuccess: (s) => navigate({ to: "/servers/$serverId", params: { serverId: s.id } }),
  });

  const online = nodes.data?.filter((n) => n.status === "online") ?? [];
  return (
    <div className="p-6">
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Nuevo servidor</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div><Label>Nodo</Label>
              <Select value={form.nodeId} onValueChange={(v) => set("nodeId", v)}>
                <SelectTrigger><SelectValue placeholder="Elige un nodo" /></SelectTrigger>
                <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (desconectado)" : ""}</SelectItem>)}</SelectContent>
              </Select>
              {online.length === 0 && <p className="mt-1 text-xs text-amber-400">Ningún nodo conectado: el servidor se creará cuando el nodo vuelva.</p>}
            </div>
            <div><Label>Nombre</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Supervivencia 2026" required /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Tipo</Label>
                <Select value={form.type} onValueChange={(v) => set("type", v)}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{SERVER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div><Label>Versión de Minecraft</Label><Input value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="LATEST o 1.21.4" /></div>
              <div><Label>Java</Label>
                <Select value={form.imageTag} onValueChange={(v) => set("imageTag", v)}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{JAVA_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div><Label>Memoria JVM</Label><Input value={form.memory} onChange={(e) => set("memory", e.target.value)} placeholder="4G" pattern="^\d+[MG]$" /></div>
              <div><Label>Puerto (vacío = automático)</Label><Input value={form.port} onChange={(e) => set("port", e.target.value)} placeholder="25565" inputMode="numeric" /></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.start} onChange={(e) => set("start", e.target.checked)} /> Arrancar al crear</label>
            {create.error && <p className="text-sm text-red-400">{(create.error as ApiError).message}</p>}
            <Button type="submit" disabled={!form.nodeId || !form.name || create.isPending}>Crear servidor</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6: Verificar y commit**

```bash
pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Con `pnpm dev:api` + `pnpm dev:web` y el agente de desarrollo (Task 19 trae el compose; hasta entonces puedes ejecutar el agente con `cd agent && PANEL_URL=http://localhost:8080 ENROLL_TOKEN=<token> DATA_ROOT=$PWD/../deploy/data AGENT_DATA=/tmp/mcsm-agent go run ./cmd/agent`, teniendo en cuenta que así el agente no está en la red `mcsm` y la consola RCON no funcionará hasta la Task 19). Expected: el nodo aparece "Conectado"; crear un servidor VANILLA lo muestra "Creando…" → "Arrancando" → "En marcha" con jugadores 0/20.

```bash
git add -A && git commit -m "feat(web): dashboard de servidores con estado en vivo, gestión de nodos y asistente de creación

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Web — detalle de servidor: resumen, consola y configuración

**Files:**
- Create/Replace: `panel/apps/web/src/routes/server.tsx`, `panel/apps/web/src/components/{console.tsx,server-config-form.tsx}`

**Interfaces:**
- Produces: `<Console serverId />` (logs en vivo por `realtime` + envío de comandos), `<ServerConfigForm server onSaved />` (edita nombre, tipo, versión, Java, memoria, puerto, política de reinicio, límites, propiedades y env libre; PATCH).

- [ ] **Step 1: Consola**

`panel/apps/web/src/components/console.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { realtime } from "@/lib/ws";

type Line = { ts: number; text: string; kind: "log" | "cmd" | "out" | "sys" };
const MAX = 2000;

export function Console({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const push = (l: Line) => setLines((old) => (old.length >= MAX ? [...old.slice(old.length - MAX + 1), l] : [...old, l]));

  useEffect(() => {
    setLines([]);
    return realtime.subscribe(`server:${serverId}:logs`, (msg) => {
      if (msg.type === "log") push({ ts: msg.ts, text: msg.line, kind: "log" });
      else if (msg.type === "stream_closed") push({ ts: Date.now(), text: `— stream cerrado: ${msg.reason} —`, kind: "sys" });
    });
  }, [serverId]);

  useEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: "end" }); }, [lines]);

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50)); setHIdx(-1); setCmd("");
    push({ ts: Date.now(), text: `> ${c}`, kind: "cmd" });
    try {
      const { output } = await api.post<{ output: string }>(`/api/servers/${serverId}/command`, { command: c });
      for (const l of (output || "(sin salida)").split("\n")) push({ ts: Date.now(), text: l, kind: "out" });
    } catch (e) {
      push({ ts: Date.now(), text: `✗ ${e instanceof ApiError ? e.message : "error"}`, kind: "sys" });
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") return void send();
    if (e.key === "ArrowUp" && history.length) { const i = Math.min(hIdx + 1, history.length - 1); setHIdx(i); setCmd(history[i] ?? ""); e.preventDefault(); }
    if (e.key === "ArrowDown") { const i = Math.max(hIdx - 1, -1); setHIdx(i); setCmd(i === -1 ? "" : history[i] ?? ""); e.preventDefault(); }
  };

  const color = { log: "text-zinc-300", cmd: "text-sky-300", out: "text-emerald-300", sys: "text-amber-400" };
  return (
    <div className="flex h-[70vh] flex-col rounded-md border border-zinc-800 bg-black font-mono text-xs">
      <div className="flex-1 overflow-auto p-3" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {lines.map((l, i) => <div key={i} className={`whitespace-pre-wrap break-all ${color[l.kind]}`}><span className="mr-2 text-zinc-600">{new Date(l.ts).toLocaleTimeString()}</span>{l.text}</div>)}
        <div ref={bottom} />
      </div>
      <div className="border-t border-zinc-800 p-2">
        <Input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey} placeholder="Comando (sin /): list, say hola, whitelist add Lobo…" className="font-mono" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Formulario de configuración**

`panel/apps/web/src/components/server-config-form.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { SERVER_TYPES, JAVA_TAGS } from "@/routes/new-server";

const kvToText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
function textToKv(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Línea inválida: "${line}" (usa clave=valor)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const s = server.spec;
  const [f, setF] = useState({
    name: server.name, type: s.type, version: s.version, imageTag: s.imageTag, memory: s.memory, port: String(s.ports.game),
    restartPolicy: s.restartPolicy, cpus: String(s.resources.cpus || ""), memLimit: s.resources.memLimit,
    properties: kvToText(s.properties), env: kvToText(s.env), showRcon: false,
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((o) => ({ ...o, [k]: v }));
  const [localErr, setLocalErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const spec = {
        type: f.type, version: f.version, imageTag: f.imageTag, memory: f.memory, restartPolicy: f.restartPolicy,
        ports: { game: Number(f.port), extra: s.ports.extra },
        resources: { cpus: Number(f.cpus || 0), memLimit: f.memLimit },
        properties: textToKv(f.properties), env: textToKv(f.env),
      };
      return api.patch<ServerDto>(`/api/servers/${server.id}`, { name: f.name, spec });
    },
    onSuccess: (dto) => { qc.setQueryData(["server", server.id], dto); qc.invalidateQueries({ queryKey: ["servers"] }); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null);
    try { textToKv(f.properties); textToKv(f.env); } catch (err) { return setLocalErr((err as Error).message); }
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-5">
      <section className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Label>Nombre</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div><Label>Tipo</Label><Select value={f.type} onValueChange={(v) => set("type", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SERVER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
        <div><Label>Versión</Label><Input value={f.version} onChange={(e) => set("version", e.target.value)} /></div>
        <div><Label>Java</Label><Select value={f.imageTag} onValueChange={(v) => set("imageTag", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{JAVA_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
        <div><Label>Memoria JVM</Label><Input value={f.memory} onChange={(e) => set("memory", e.target.value)} /></div>
        <div><Label>Puerto de juego</Label><Input value={f.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" /></div>
        <div><Label>Reinicio</Label><Select value={f.restartPolicy} onValueChange={(v) => set("restartPolicy", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["unless-stopped", "always", "on-failure", "no"].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
        <div><Label>Límite CPUs (0 = sin límite)</Label><Input value={f.cpus} onChange={(e) => set("cpus", e.target.value)} placeholder="2" /></div>
        <div><Label>Límite RAM contenedor</Label><Input value={f.memLimit} onChange={(e) => set("memLimit", e.target.value)} placeholder="5G (≥ memoria JVM + 1G)" /></div>
      </section>
      <section>
        <Label>server.properties (clave=valor por línea)</Label>
        <Textarea rows={8} className="font-mono text-xs" value={f.properties} onChange={(e) => set("properties", e.target.value)} placeholder={"motd=Mi servidor\nmax-players=10\ndifficulty=normal\nview-distance=10"} />
      </section>
      <section>
        <Label>Variables de entorno extra de la imagen itzg (CLAVE=valor por línea)</Label>
        <Textarea rows={6} className="font-mono text-xs" value={f.env} onChange={(e) => set("env", e.target.value)} placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false\nMODRINTH_PROJECTS=lithium,ferritecore"} />
        <p className="mt-1 text-xs text-zinc-500">No se pueden sobreescribir TYPE, VERSION, MEMORY, EULA, RCON_* ni SERVER_PORT: se generan desde los campos de arriba.</p>
      </section>
      <section className="text-xs text-zinc-400">
        RCON: <button type="button" className="underline" onClick={() => set("showRcon", !f.showRcon)}>{f.showRcon ? "ocultar" : "mostrar contraseña"}</button>
        {f.showRcon && <code className="ml-2 rounded bg-zinc-900 px-1">{server.spec.rconPassword}</code>}
      </section>
      {(localErr || save.error) && <p className="text-sm text-red-400">{localErr ?? (save.error as ApiError).message}</p>}
      {save.isSuccess && <p className="text-sm text-emerald-400">Guardado. El agente recreará el contenedor si hace falta (versión {server.specVersion}).</p>}
      <div><Button type="submit" disabled={save.isPending}>Guardar y aplicar</Button></div>
    </form>
  );
}
```

- [ ] **Step 3: Página de servidor**

`panel/apps/web/src/routes/server.tsx`:
```tsx
import { useParams, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/state-badge";
import { PowerButtons } from "@/components/power-buttons";
import { Console } from "@/components/console";
import { ServerConfigForm } from "@/components/server-config-form";
import { useServer } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { api, ApiError } from "@/lib/api";
import { formatUptime } from "@/lib/format";

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div><div className="mt-1 text-lg">{value}</div></CardContent></Card>;
}

export function ServerPage() {
  const { serverId } = useParams({ from: "/servers/$serverId" });
  const q = useServer(serverId);
  const nodes = useNodes();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (deleteData: boolean) => api.del(`/api/servers/${serverId}?deleteData=${deleteData}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["servers"] }); navigate({ to: "/" }); },
  });
  if (q.isLoading) return <div className="p-6 text-zinc-400">Cargando…</div>;
  if (!q.data) return <div className="p-6 text-red-400">Servidor no encontrado</div>;
  const s = q.data;
  const o = s.observed;
  const node = nodes.data?.find((n) => n.id === s.nodeId);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{s.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-zinc-400">
            <StateBadge observed={o} desired={s.desiredState} />
            <span>{node?.name ?? "—"} · puerto {s.spec.ports.game} · {s.spec.type} {s.spec.version} · {s.spec.memory}</span>
            {s.observedSpecVersion !== s.specVersion && <span className="text-amber-400">aplicando v{s.specVersion} (actual v{s.observedSpecVersion})</span>}
          </div>
          {o?.error && <p className="mt-2 max-w-3xl rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">{o.error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <PowerButtons server={s} size="default" />
          <Button variant="ghost" onClick={() => {
            const withData = confirm(`¿Borrar también el mundo y los archivos de "${s.name}"?\n\nAceptar: borrar todo.\nCancelar: solo quitar el servidor y conservar los datos en el nodo.`);
            if (confirm(`¿Seguro que quieres eliminar "${s.name}"?`)) del.mutate(withData);
          }}><Trash2 className="size-4" /></Button>
        </div>
      </header>
      {del.error && <p className="text-sm text-red-400">{(del.error as ApiError).message}</p>}

      <Tabs defaultValue="overview">
        <TabsList><TabsTrigger value="overview">Resumen</TabsTrigger><TabsTrigger value="console">Consola</TabsTrigger><TabsTrigger value="config">Configuración</TabsTrigger></TabsList>
        <TabsContent value="overview" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Jugadores" value={o?.mc.online ? `${o.mc.playersOnline} / ${o.mc.playersMax}` : "—"} />
          <Stat label="Versión detectada" value={o?.mc.version || "—"} />
          <Stat label="Tiempo encendido" value={o?.state === "running" ? formatUptime(o.startedAtUnix) : "—"} />
          <Stat label="Latencia" value={o?.mc.online ? `${o.mc.latencyMs} ms` : "—"} />
          <Stat label="Contenedor" value={<code className="text-sm">{o?.containerId ? o.containerId.slice(0, 12) : "—"}</code>} />
          <Stat label="Healthcheck" value={o?.health || "—"} />
          <Stat label="Último exit code" value={o?.exitCode ?? "—"} />
          <Stat label="Spec" value={`v${s.specVersion} (aplicada v${s.observedSpecVersion})`} />
        </TabsContent>
        <TabsContent value="console"><Console serverId={s.id} /></TabsContent>
        <TabsContent value="config"><ServerConfigForm key={s.specVersion} server={s} /></TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 4: Verificar y commit**

```bash
pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Prueba manual con el agente en Docker (Task 19) o con `go run`: abre un servidor, pestaña Consola, deben aparecer las últimas 200 líneas y seguir en vivo; escribe `list` → respuesta en verde. Cambia la memoria en Configuración → el estado pasa a "aplicando v2…" y vuelve a "En marcha".

```bash
git add -A && git commit -m "feat(web): detalle de servidor con resumen, consola en vivo y formulario de configuración

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: Despliegue (Dockerfiles, compose), README y verificación extremo a extremo

**Files:**
- Create: `deploy/panel.Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, `deploy/docker-compose.node.yml`, `deploy/docker-compose.dev.yml`, `deploy/.env.example`, `README.md`
- Modify: `panel/apps/api/src/app.ts` (servir la web compilada)

- [ ] **Step 1: Servir la web desde la API**

En `app.ts`, sustituye el comentario de la Task 19 por:
```ts
  if (cfg.webDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/agent/") || req.url === "/ws") return reply.code(404).send({ error: "No encontrado" });
      return reply.sendFile("index.html");
    });
  }
```
con `import fastifyStatic from "@fastify/static";` y `cfg.webDist` como ruta absoluta.

- [ ] **Step 2: Imagen del panel**

`.dockerignore` (raíz):
```
**/node_modules
**/dist
agent/
deploy/data
docs/
.git
```

`deploy/panel.Dockerfile`:
```dockerfile
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.10.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY panel ./panel
COPY proto/fixtures ./proto/fixtures
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mcsm/web build
RUN pnpm --filter @mcsm/api... --prod deploy --legacy /out/api || pnpm prune --prod

FROM node:26-alpine
RUN npm install -g pnpm@12.10.1
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/panel ./panel
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/panel/apps/web/dist
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "./panel/apps/api/node_modules/.bin/tsx", "panel/apps/api/src/main.ts"]
```
Si la línea `pnpm deploy` da problemas con el workspace, elimínala: el `pnpm prune --prod` deja `tsx` fuera, así que en ese caso mueve `tsx` a `dependencies` de `@mcsm/api` (ya lo está) y usa `pnpm install --frozen-lockfile --prod` en la segunda etapa en vez de copiar `node_modules`.

- [ ] **Step 3: Compose**

`deploy/.env.example`:
```
# IP o nombre por el que los nodos y tu navegador alcanzan el panel
PANEL_PUBLIC_URL=http://192.168.1.10:8080
# Directorio del host donde viven los mundos de ESTA máquina
DATA_ROOT=/srv/minecraft
# Token de alta para el agente local (genera uno en Nodos → Añadir nodo la primera vez)
ENROLL_TOKEN=
```

`deploy/docker-compose.yml` (máquina principal: panel + agente local):
```yaml
name: mcsm
services:
  panel:
    build: { context: .., dockerfile: deploy/panel.Dockerfile }
    image: mcsm-panel:latest
    restart: unless-stopped
    ports: ["8080:8080"]
    environment:
      PANEL_PUBLIC_URL: ${PANEL_PUBLIC_URL:-http://localhost:8080}
    volumes:
      - panel-data:/data
  agent:
    build: { context: ../agent }
    image: mcsm-agent:latest
    restart: unless-stopped
    depends_on: [panel]
    environment:
      PANEL_URL: http://panel:8080
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      NODE_NAME: ${NODE_NAME:-principal}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [default, mcsm]
networks:
  mcsm:
    name: mcsm
volumes:
  panel-data: {}
  agent-data: {}
```

`deploy/docker-compose.node.yml` (nodos adicionales, solo agente):
```yaml
name: mcsm-node
services:
  agent:
    image: mcsm-agent:latest
    build: { context: ../agent }
    restart: unless-stopped
    environment:
      PANEL_URL: ${PANEL_URL:?Define PANEL_URL, p. ej. http://192.168.1.10:8080}
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      NODE_NAME: ${NODE_NAME:-}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [mcsm]
networks:
  mcsm:
    name: mcsm
volumes:
  agent-data: {}
```

`deploy/docker-compose.dev.yml` (desarrollo: panel con `pnpm dev:api` en el host, agente en Docker):
```yaml
name: mcsm-dev
services:
  agent:
    build: { context: ../agent }
    image: mcsm-agent:dev
    environment:
      PANEL_URL: http://host.docker.internal:8080
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      NODE_NAME: dev
      DATA_ROOT: ${DATA_ROOT:?Ruta absoluta en el host, p. ej. /home/lobo/dev/mc-server-manager/deploy/data}
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT}:${DATA_ROOT}
      - agent-dev-data:/var/lib/mcsm-agent
    networks: [mcsm]
networks:
  mcsm:
    name: mcsm
volumes:
  agent-dev-data: {}
```

- [ ] **Step 4: README**

`README.md`:
```markdown
# MC Server Manager

Panel self-hosted para gestionar servidores de Minecraft (imagen `itzg/minecraft-server`) repartidos en varias máquinas con Docker. Un panel, un agente por máquina.

## Puesta en marcha (máquina principal)

1. `cp deploy/.env.example deploy/.env` y edita `PANEL_PUBLIC_URL` (IP de esta máquina) y `DATA_ROOT`.
2. `docker compose -f deploy/docker-compose.yml up -d --build panel`
3. Abre `http://<ip>:8080`, crea la contraseña, ve a **Nodos → Añadir nodo** y copia el token en `ENROLL_TOKEN` del `.env`.
4. `docker compose -f deploy/docker-compose.yml up -d agent`. El nodo aparece como conectado.

## Añadir otra máquina

En **Nodos → Añadir nodo** copia el `docker run` que se muestra y ejecútalo allí (necesita la imagen `mcsm-agent`: constrúyela con `docker build -t mcsm-agent:latest agent/` o usa `deploy/docker-compose.node.yml` con `PANEL_URL` y `ENROLL_TOKEN`).

## Desarrollo

```bash
mise install && pnpm install
pnpm dev:api        # panel en :8080
pnpm dev:web        # web en :5173 (proxy a :8080)
ENROLL_TOKEN=... DATA_ROOT=$PWD/deploy/data docker compose -f deploy/docker-compose.dev.yml up --build
```
Tests: `cd agent && go test ./...` · `pnpm test` · integración con Docker real: `go test -tags integration ./...`.
Protocolo: edita `proto/`, luego `pnpm gen` y commitea lo generado.

## Seguridad

Pensado para una LAN doméstica y un único administrador. El agente monta el socket de Docker: quien controle el panel controla Docker en todos los nodos. No lo expongas a Internet.
```

- [ ] **Step 5: Verificación extremo a extremo (manual, con Docker real)**

```bash
mkdir -p deploy/data && cp deploy/.env.example deploy/.env
# edita PANEL_PUBLIC_URL=http://<tu-ip>:8080 y DATA_ROOT=$PWD/deploy/data (ruta absoluta)
docker compose -f deploy/docker-compose.yml up -d --build panel
```
1. Abre `http://<tu-ip>:8080`: crea contraseña → dashboard vacío.
2. Nodos → Añadir nodo → "principal" → copia el token en `deploy/.env` → `docker compose -f deploy/docker-compose.yml up -d agent`. El nodo pasa a **Conectado** en menos de 5 s sin recargar.
3. Nuevo servidor: nodo principal, "Prueba E2E", VANILLA, LATEST, 2G, arrancar al crear. Expected: fila "Creando…" → "Arrancando" → "En marcha" (la primera vez tarda por la descarga de la imagen y del servidor; sigue el progreso en Consola).
4. Consola: aparecen los logs de arranque; `list` responde "There are 0 of a max of 20 players online".
5. Conéctate con el cliente de Minecraft a `<tu-ip>:25565`: el dashboard muestra 1/20 en menos de 15 s.
6. Configuración: cambia memoria a 3G y guarda. Expected: "aplicando v2…" → el contenedor se recrea (ver `docker ps`) → "En marcha" con v2 aplicada. La consola sigue funcionando tras la recreación.
7. `docker compose -f deploy/docker-compose.yml restart panel`: el nodo pasa a Desconectado y vuelve a Conectado solo; la consola muestra "stream cerrado" y vuelve a emitir al resuscribirse (cambia de pestaña y vuelve).
8. Para el agente (`docker compose stop agent`), cambia la versión del servidor a `1.21.4`, arranca el agente: al conectar recibe `SyncSpecs` y aplica el cambio (v3).
9. Borra el servidor conservando datos: desaparece de la lista; `deploy/data/prueba-e2e/data` sigue existiendo.
10. `go test ./... && pnpm test` en verde.

Anota cualquier desviación en `docs/superpowers/plans/2026-10-12-01-fundamentos.md` como nota al pie de esta task antes de cerrar el plan.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(deploy): Dockerfile del panel, compose de producción/nodo/desarrollo y README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Cierre del plan

Al terminar la Task 19 el sistema cumple los pasos 1–3 del orden de construcción de la spec (sección 13). Lo que sigue está en `docs/superpowers/plans/README.md`. Antes de empezar el Plan 2, usa `superpowers:finishing-a-development-branch` para integrar y revisar la rama.
