#!/usr/bin/env bash
# UI E2E (Plan 9, spec §11): the deployment compose (project mcsm-test-e2e), a second node in
# docker:dind and headless Playwright in a container. It only creates and deletes mcsm-test-e2e* resources.
#   deploy/e2e/run.sh up     builds and starts everything (panel configured, nodes e2e-a and e2e-b connected)
#   deploy/e2e/run.sh test   runs Playwright against what is up (screenshots in panel/apps/e2e/screenshots/)
#   deploy/e2e/run.sh down   deletes everything (including the servers the agents created)
#   deploy/e2e/run.sh [all]  up + test + down (down also on failure; E2E_KEEP=1 leaves it up)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P=mcsm-test-e2e
NET="$P-net"                 # network of node A's servers (MCSM_NETWORK); this script creates it
DEFNET="${P}_default"        # compose network: panel, agent A, node B and Playwright
COMPOSE=(docker compose -p "$P" -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.build.yml" -f "$ROOT/deploy/e2e/compose.e2e.yml")
DATA="$ROOT/deploy/data/e2e" # never under /tmp: dind mounts its tmpfs there and would hide the bind
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
export E2E_PASSWORD="${E2E_PASSWORD:-e2e-secure-password}"
export E2E_SETUP_TOKEN="${E2E_SETUP_TOKEN:-e2e-setup-$(date +%s)}"

log() { printf '\n== %s\n' "$*"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
mine() { docker ps -a --format '{{.Names}}' | grep '^mcsm-test-e2e' || true; }

up() {
  if [ -n "$(mine)" ]; then echo "There are already mcsm-test-e2e* containers: run '$0 down' first" >&2; exit 1; fi
  if ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then echo "Port $PORT is in use" >&2; exit 1; fi
  mkdir -p "$DATA/a" "$DATA/b" "$LOGS" "$SHOTS"
  rm -f "$SHOTS"/*.png
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

  log "images (deployment compose)"
  DATA_ROOT="$DATA/a" "${COMPOSE[@]}" build panel agent

  log "panel"
  DATA_ROOT="$DATA/a" "${COMPOSE[@]}" up -d panel
  for _ in $(seq 90); do curl -fsS "$API/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "$API/api/health" >/dev/null
  curl -fsS -c "$COOKIES" -H 'content-type: application/json' \
    -d "{\"password\":\"$E2E_PASSWORD\",\"setupToken\":\"$E2E_SETUP_TOKEN\"}" "$API/api/auth/setup" >/dev/null
  # Settings: the E2E port range, away from production's 25565–25600.
  curl -fsS -b "$COOKIES" -X PUT -H 'content-type: application/json' -d '{"gamePortRange":{"from":26600,"to":26620}}' "$API/api/settings" >/dev/null

  token() {
    curl -fsS -b "$COOKIES" -H 'content-type: application/json' -d "{\"nameHint\":\"$1\",\"dataRoot\":\"$2\"}" \
      "$API/api/nodes/enrollment-tokens" | json 'v.token'
  }

  log "node A: the compose agent, on the host Docker"
  ENROLL_TOKEN="$(token e2e-a "$DATA/a")" DATA_ROOT="$DATA/a" "${COMPOSE[@]}" up -d agent

  log "node B: docker:dind with the agent inside"
  docker run -d --privileged --name "$NODEB" --hostname e2e-nodeb --network "$DEFNET" \
    -e DOCKER_TLS_CERTDIR= -v "$DATA/b:$DATA/b" "$DIND_IMAGE" >/dev/null
  for _ in $(seq 60); do docker exec "$NODEB" docker info >/dev/null 2>&1 && break; sleep 1; done
  docker image inspect "$MC_IMAGE" >/dev/null 2>&1 || docker pull "$MC_IMAGE"
  docker save "$P-agent:latest" | docker exec -i "$NODEB" docker load >/dev/null
  docker save "$MC_IMAGE" | docker exec -i "$NODEB" docker load >/dev/null
  local panel_ip
  panel_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$DEFNET\").IPAddress}}" "$P-panel-1")"
  # Inside dind the compose network's DNS doesn't reach: agent B talks to the panel by IP.
  # Agent B joins the servers' network (like the compose agent on node A): it probes each server by name.
  docker exec "$NODEB" docker network inspect "$NET" >/dev/null 2>&1 || docker exec "$NODEB" docker network create "$NET" >/dev/null
  docker exec "$NODEB" docker run -d --name "$P-agent-b" --network "$NET" --restart unless-stopped --stop-timeout 30 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA/b:$DATA/b" -v agent-b-data:/var/lib/mcsm-agent \
    -e PANEL_URL="http://$panel_ip:8080" -e ENROLL_TOKEN="$(token e2e-b "$DATA/b")" -e DATA_ROOT="$DATA/b" \
    -e MCSM_NETWORK="$NET" -e MCSM_ROUTER_NAME="$P-router-b" "$P-agent:latest" >/dev/null

  log "waiting for both nodes"
  local n=0
  for _ in $(seq 90); do
    n="$(curl -fsS -b "$COOKIES" "$API/api/nodes" | json 'v.filter(x=>x.status==="online").length')"
    [ "$n" = 2 ] && break
    sleep 2
  done
  [ "$n" = 2 ] || { echo "the nodes did not connect (see $LOGS after '$0 down')" >&2; exit 1; }
}

run_tests() {
  log "Playwright (headless, official image with the browsers)"
  docker run --rm --name "$P-playwright" --network "$DEFNET" --ipc=host --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI=1 -e E2E_BASE_URL=http://panel:8080 -e E2E_PASSWORD -e E2E_NODE_A=e2e-a -e E2E_NODE_B=e2e-b \
    -e E2E_SHOTS="$SHOTS" -v "$ROOT:$ROOT" -w "$ROOT/panel/apps/e2e" "$PW_IMAGE" ./node_modules/.bin/playwright test
}

down() {
  log "cleanup (mcsm-test-e2e* only)"
  mkdir -p "$LOGS"
  docker logs "$P-panel-1" >"$LOGS/panel.log" 2>&1 || true
  docker logs "$P-agent-1" >"$LOGS/agent-a.log" 2>&1 || true
  docker exec "$NODEB" docker logs "$P-agent-b" >"$LOGS/agent-b.log" 2>&1 || true
  docker rm -f "$P-playwright" >/dev/null 2>&1 || true
  docker rm -f -v "$NODEB" >/dev/null 2>&1 || true # along with its /var/lib/docker (anonymous volume)
  DATA_ROOT="$DATA/a" ENROLL_TOKEN= "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  local left
  left="$(mine)" # servers and router that agent A created on the host Docker
  if [ -n "$left" ]; then docker rm -f $left >/dev/null; fi
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$P-panel:latest" "$P-agent:latest" >/dev/null 2>&1 || true
  # Worlds and backups are owned by root (itzg, agent): delete them from a container.
  docker run --rm -v "$DATA:/d" "$ALPINE" sh -c 'rm -rf /d/a /d/b /d/cookies.txt' >/dev/null 2>&1 || true
}

case "${1:-all}" in
  up) up ;;
  test) run_tests ;;
  down) down ;;
  all)
    start=$(date +%s)
    trap 'rc=$?; [ "${E2E_KEEP:-0}" = 1 ] || down; echo "E2E: $(( $(date +%s) - start )) s (exit $rc). Screenshots: $SHOTS"; exit $rc' EXIT
    up
    run_tests
    ;;
  *) echo "usage: $0 [all|up|test|down]" >&2; exit 2 ;;
esac
