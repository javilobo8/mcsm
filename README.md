# MC Server Manager

Panel self-hosted para gestionar servidores de Minecraft (imagen `itzg/minecraft-server`) repartidos en varias máquinas con Docker. Un panel, un agente por máquina.

## Puesta en marcha (máquina principal)

1. `docker network create mcsm 2>/dev/null || true` (red compartida por el agente y los servidores; los compose la declaran como externa).
2. `cp deploy/.env.example deploy/.env` y edita `PANEL_PUBLIC_URL` (IP de esta máquina) y `DATA_ROOT` (ruta absoluta).
3. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build panel`
4. Abre `http://<ip>:8080`, crea la contraseña, ve a **Nodos → Añadir nodo** y copia el token en `ENROLL_TOKEN` del `.env`.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build agent`. El nodo aparece como conectado.

## Añadir otra máquina

Crea la red (`docker network create mcsm 2>/dev/null || true`). En **Nodos → Añadir nodo** copia el `docker run` que se muestra y ejecútalo allí (necesita la imagen `mcsm-agent`: constrúyela con `docker build -t mcsm-agent:latest agent/` o usa `deploy/docker-compose.node.yml` con `PANEL_URL` y `ENROLL_TOKEN`).

## Desarrollo

```bash
mise install && pnpm install
pnpm dev:api        # panel en :8080
pnpm dev:web        # web en :5173 (proxy a :8080)
docker network create mcsm 2>/dev/null || true
ENROLL_TOKEN=... DATA_ROOT=$PWD/deploy/data docker compose -f deploy/docker-compose.dev.yml up --build
```
Tests: `cd agent && go test ./...` · `pnpm test` · integración con Docker real: `go test -tags integration ./...`.
Protocolo: edita `proto/`, luego `pnpm gen` y commitea lo generado.

## Seguridad

Pensado para una LAN doméstica y un único administrador. El agente monta el socket de Docker: quien controle el panel controla Docker en todos los nodos. No lo expongas a Internet.
