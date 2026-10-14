---
title: Development
description: Set up the repository, run the panel and agent locally, run unit, integration and E2E tests, work with the protocol, and contribute.
section: Project
order: 140
---

MC Server Manager is a monorepo: a TypeScript panel (Fastify API and React web) and a Go agent, connected over a WebSocket with protobuf. The source is at [github.com/javilobo8/mcsm](https://github.com/javilobo8/mcsm) and is released under the [MIT license](https://github.com/javilobo8/mcsm/blob/main/LICENSE).

## Repository layout

```text
agent/     Go module mcsm/agent (cmd/agent, internal/*)
panel/     pnpm workspace: apps/api, apps/web, packages/shared, packages/proto-ts
proto/     .proto files, the single source of the protocol (buf)
deploy/    deployment docker-compose files
docs/      specs, plans, notes
```

## Set up

Go and buf come from `mise`. Node 26 and pnpm 12 are installed separately.

```bash
mise install
pnpm install
```

Run the panel and the web UI, then an agent:

```bash
pnpm dev:api        # panel on :8080
pnpm dev:web        # web on :5173 (proxy to :8080)
docker network create mcsm 2>/dev/null || true
ENROLL_TOKEN=... DATA_ROOT=$PWD/deploy/data docker compose -f deploy/docker-compose.dev.yml up --build
```

## Tests

- Agent: `cd agent && go test ./...`
- Panel: `pnpm test` (from the root)
- Integration with real Docker: `cd agent && go test -tags integration ./...`

Before `go` and `buf` commands, run `eval "$(mise env)"` at the repository root.

## UI tests (E2E)

```bash
pnpm e2e
```

`pnpm e2e` is the same as `bash deploy/e2e/run.sh`. It builds the deployment compose as project `mcsm-test-e2e` (panel on port 18080, servers on 26600-26620), adds a second node in `docker:dind` and runs Playwright in a container.

- Screenshots end up in `panel/apps/e2e/screenshots/` and logs in `deploy/data/e2e/logs/`.
- `bash deploy/e2e/run.sh up|test|down` runs each phase separately.
- `E2E_KEEP=1` leaves everything up when it finishes.
- It only touches `mcsm-test-e2e*` resources.

## Protocol

Edit `proto/`, then run `pnpm gen` and commit the generated code. Don't edit the generated code by hand.

## Continuous integration

GitHub Actions runs on every push to `main` and every PR (`.github/workflows/ci.yml`):

- `buf lint` and `buf breaking` (against the PR's target branch),
- a check that the generated code is up to date,
- the agent's `go vet` and `go test -race`,
- the panel's typecheck, tests and build.

Integration tests with real Docker and the E2E only run locally.

## Releases

1. Bump `agent/VERSION` (for example `0.10.0`), commit and push.
2. Create the Release with the tag `v` + that version: `gh release create v0.10.0 --generate-notes` (or from the web). If it is a prerelease (`--prerelease` or a suffix like `-rc.1`), it doesn't move `latest` or `X.Y`.
3. `.github/workflows/release.yml` checks that the tag matches `agent/VERSION`, repeats the CI checks, builds both images for `linux/amd64` and `linux/arm64` on native runners, and publishes them to `ghcr.io/javilobo8/` with provenance attestation and SBOM. The panel image has the agent image of its own version pinned, which is what the `docker run` from **Add node** uses.

The `mcsm-panel` and `mcsm-agent` packages are linked to the repository and, since it is public, they are too: they download without `docker login`. In a private fork they would be private; change it in GitHub → **Packages** → each package → **Package settings** → **Change visibility**.

## Contributing

Pull requests are made against `main`.

- **Commits:** conventional commits in English and small: `feat(agent): ...`, `fix(panel): ...`, `test(web): ...`, `docs: ...`.
- **TDD:** write the test first for anything with logic, and keep test output clean. Tests don't use `time.Sleep` or `setTimeout` to synchronize; use injectable clocks and schedulers.
- **Generated code:** regenerated with `pnpm gen`, never edited by hand.
- **Language:** the UI, error messages and code identifiers are in English.

Before opening a pull request, run the full verification:

```bash
eval "$(mise env)" && pnpm lint:proto && (cd agent && go vet ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build
```

Also run `buf breaking --against ".git#ref=main"` and `go vet -tags integration ./...` (integration tests don't compile under plain `go vet`).

> [!NOTE]
> When you change `deploy/docker-compose.yml` or the `docker run` shown by **Add node**, update the docs that reproduce them, including the `adding-nodes` page, and their example `.env` files.
