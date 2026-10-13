#!/usr/bin/env bash
# E2E de la interfaz (Plan 9, spec §11): el compose de despliegue (proyecto mcsm-test-e2e), un segundo nodo en
# docker:dind y Playwright headless en contenedor. Solo crea y borra recursos mcsm-test-e2e*.
#   deploy/e2e/run.sh up     construye y levanta todo (panel configurado, nodos e2e-a y e2e-b conectados)
#   deploy/e2e/run.sh test   ejecuta Playwright contra lo levantado (capturas en panel/apps/e2e/screenshots/)
#   deploy/e2e/run.sh down   lo borra todo (también los servidores que crearon los agentes)
#   deploy/e2e/run.sh [all]  up + test + down (down también si algo falla; E2E_KEEP=1 lo deja levantado)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P=mcsm-test-e2e
NET="$P-net"                 # red de los servidores del nodo A (MCSM_NETWORK); la crea este script
DEFNET="${P}_default"        # red del compose: panel, agente A, nodo B y Playwright
COMPOSE=(docker compose -p "$P" -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.build.yml" -f "$ROOT/deploy/e2e/compose.e2e.yml")
DATA="$ROOT/deploy/data/e2e" # nunca bajo /tmp: dind monta su tmpfs ahí y taparía el bind
SHOTS="$ROOT/panel/apps/e2e/screenshots"
LOGS="$DATA/logs"
PORT="${E2E_PANEL_PORT:-18080}"
API="http://127.0.0.1:$PORT"
NODEB="$P-nodeb"
COOKIES="$DATA/cookies.txt"
DIND_IMAGE="docker:29-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470"
PW_IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
ALPINE="alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
MC_IMAGE="itzg/minecraft-server:java21"
export E2E_PANEL_PORT="$PORT"
export E2E_PASSWORD="${E2E_PASSWORD:-e2e-contrasena-segura}"
export E2E_SETUP_TOKEN="${E2E_SETUP_TOKEN:-e2e-setup-$(date +%s)}"

log() { printf '\n== %s\n' "$*"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
mine() { docker ps -a --format '{{.Names}}' | grep '^mcsm-test-e2e' || true; }

up() {
  if [ -n "$(mine)" ]; then echo "Ya hay contenedores mcsm-test-e2e*: ejecuta '$0 down' antes" >&2; exit 1; fi
  if ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then echo "El puerto $PORT está ocupado" >&2; exit 1; fi
  mkdir -p "$DATA/a" "$DATA/b" "$LOGS" "$SHOTS"
  rm -f "$SHOTS"/*.png
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

  log "imágenes (compose de despliegue)"
  DATA_ROOT="$DATA/a" "${COMPOSE[@]}" build panel agent

  log "panel"
  DATA_ROOT="$DATA/a" "${COMPOSE[@]}" up -d panel
  for _ in $(seq 90); do curl -fsS "$API/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "$API/api/health" >/dev/null
  curl -fsS -c "$COOKIES" -H 'content-type: application/json' \
    -d "{\"password\":\"$E2E_PASSWORD\",\"setupToken\":\"$E2E_SETUP_TOKEN\"}" "$API/api/auth/setup" >/dev/null
  # Ajustes: rango de puertos de la E2E, lejos de los 25565–25600 de producción.
  curl -fsS -b "$COOKIES" -X PUT -H 'content-type: application/json' -d '{"gamePortRange":{"from":26600,"to":26620}}' "$API/api/settings" >/dev/null

  token() {
    curl -fsS -b "$COOKIES" -H 'content-type: application/json' -d "{\"nameHint\":\"$1\",\"dataRoot\":\"$2\"}" \
      "$API/api/nodes/enrollment-tokens" | json 'v.token'
  }

  log "nodo A: el agente del compose, sobre el Docker del host"
  ENROLL_TOKEN="$(token e2e-a "$DATA/a")" DATA_ROOT="$DATA/a" "${COMPOSE[@]}" up -d agent

  log "nodo B: docker:dind con el agente dentro"
  docker run -d --privileged --name "$NODEB" --hostname e2e-nodeb --network "$DEFNET" \
    -e DOCKER_TLS_CERTDIR= -v "$DATA/b:$DATA/b" "$DIND_IMAGE" >/dev/null
  for _ in $(seq 60); do docker exec "$NODEB" docker info >/dev/null 2>&1 && break; sleep 1; done
  docker image inspect "$MC_IMAGE" >/dev/null 2>&1 || docker pull "$MC_IMAGE"
  docker save "$P-agent:latest" | docker exec -i "$NODEB" docker load >/dev/null
  docker save "$MC_IMAGE" | docker exec -i "$NODEB" docker load >/dev/null
  local panel_ip
  panel_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$DEFNET\").IPAddress}}" "$P-panel-1")"
  # Dentro de dind el DNS de la red del compose no llega: el agente B va al panel por IP.
  # El agente B se une a la red de los servidores (como el agente del compose en el nodo A): sondea a cada servidor por su nombre.
  docker exec "$NODEB" docker network inspect "$NET" >/dev/null 2>&1 || docker exec "$NODEB" docker network create "$NET" >/dev/null
  docker exec "$NODEB" docker run -d --name "$P-agent-b" --network "$NET" --restart unless-stopped --stop-timeout 30 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA/b:$DATA/b" -v agent-b-data:/var/lib/mcsm-agent \
    -e PANEL_URL="http://$panel_ip:8080" -e ENROLL_TOKEN="$(token e2e-b "$DATA/b")" -e DATA_ROOT="$DATA/b" \
    -e MCSM_NETWORK="$NET" -e MCSM_ROUTER_NAME="$P-router-b" "$P-agent:latest" >/dev/null

  log "esperando a los dos nodos"
  local n=0
  for _ in $(seq 90); do
    n="$(curl -fsS -b "$COOKIES" "$API/api/nodes" | json 'v.filter(x=>x.status==="online").length')"
    [ "$n" = 2 ] && break
    sleep 2
  done
  [ "$n" = 2 ] || { echo "los nodos no se conectaron (ver $LOGS tras '$0 down')" >&2; exit 1; }
}

run_tests() {
  log "Playwright (headless, imagen oficial con los navegadores)"
  docker run --rm --name "$P-playwright" --network "$DEFNET" --ipc=host --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI=1 -e E2E_BASE_URL=http://panel:8080 -e E2E_PASSWORD -e E2E_NODE_A=e2e-a -e E2E_NODE_B=e2e-b \
    -e E2E_SHOTS="$SHOTS" -v "$ROOT:$ROOT" -w "$ROOT/panel/apps/e2e" "$PW_IMAGE" ./node_modules/.bin/playwright test
}

down() {
  log "limpieza (solo mcsm-test-e2e*)"
  mkdir -p "$LOGS"
  docker logs "$P-panel-1" >"$LOGS/panel.log" 2>&1 || true
  docker logs "$P-agent-1" >"$LOGS/agent-a.log" 2>&1 || true
  docker exec "$NODEB" docker logs "$P-agent-b" >"$LOGS/agent-b.log" 2>&1 || true
  docker rm -f "$P-playwright" >/dev/null 2>&1 || true
  docker rm -f -v "$NODEB" >/dev/null 2>&1 || true # con su /var/lib/docker (volumen anónimo)
  DATA_ROOT="$DATA/a" ENROLL_TOKEN= "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  local left
  left="$(mine)" # servidores y router que el agente A creó en el Docker del host
  if [ -n "$left" ]; then docker rm -f $left >/dev/null; fi
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$P-panel:latest" "$P-agent:latest" >/dev/null 2>&1 || true
  # Mundos y copias son de root (itzg, agente): se borran desde un contenedor.
  docker run --rm -v "$DATA:/d" "$ALPINE" sh -c 'rm -rf /d/a /d/b /d/cookies.txt' >/dev/null 2>&1 || true
}

case "${1:-all}" in
  up) up ;;
  test) run_tests ;;
  down) down ;;
  all)
    start=$(date +%s)
    trap 'rc=$?; [ "${E2E_KEEP:-0}" = 1 ] || down; echo "E2E: $(( $(date +%s) - start )) s (salida $rc). Capturas: $SHOTS"; exit $rc' EXIT
    up
    run_tests
    ;;
  *) echo "uso: $0 [all|up|test|down]" >&2; exit 2 ;;
esac
