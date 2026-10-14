#!/usr/bin/env bash
# Visual check of the built site: serves website/dist under /mcsm/ (404.html as the fallback, like GitHub
# Pages) and takes screenshots with Playwright, both inside one container (nftables drops container → host
# traffic, so nothing runs on the host). Builds nothing: run `pnpm build` first.
# Writes website/screenshots/*.png (gitignored). Only creates the container mcsm-test-site-shots (--rm).
set -euo pipefail

SITE="$(cd "$(dirname "$0")/.." && pwd)"
# Same image and digest as deploy/e2e/run.sh.
PW_IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
NAME="mcsm-test-site-shots"

[ -f "$SITE/dist/index.html" ] || { echo "no website/dist: run pnpm build first" >&2; exit 1; }
[ -d "$SITE/node_modules/playwright-core" ] || { echo "no node_modules: run pnpm install first" >&2; exit 1; }
mkdir -p "$SITE/screenshots"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --name "$NAME" --network none --ipc=host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e SITE_BASE="${SITE_BASE:-/mcsm/}" -e DEEP_LINK="${DEEP_LINK:-}" \
  -v "$SITE:$SITE" -w "$SITE" "$PW_IMAGE" node scripts/screenshots.mjs
