---
title: Updating
description: Update agents and panel in the right order, pin versions, and back up and restore the panel database.
section: Getting started
order: 40
---

Use the **same version** on every machine. In each `.env`, set `MCSM_VERSION=<new>` (with `latest`, just pull again). Release notes are on the [Releases](https://github.com/javilobo8/mcsm/releases) page.

> [!IMPORTANT]
> **Agents first, then the panel.** An old agent rejects what it doesn't know, but a new panel may ask it for things it can't do yet.

## Update the agents

On the main machine:

```bash
docker compose pull agent && docker compose up -d --no-deps agent
```

`--no-deps` matters: without it, Compose would also restart the panel.

On nodes that use the node compose file:

```bash
docker compose pull && docker compose up -d
```

On nodes started with `docker run`:

1. Pull the new image: `docker pull ghcr.io/javilobo8/mcsm-agent:<new>`.
2. Stop and remove the container: `docker stop mcsm-agent && docker rm mcsm-agent`. With `stop` the agent gets its 30 s to finish; `rm -f` kills it immediately.
3. Run the same `docker run` again with the image version changed.

The `mcsm-agent-data` volume keeps the enrollment, so the expired `ENROLL_TOKEN` doesn't matter.

## Update the panel

```bash
docker compose pull panel && docker compose up -d --no-deps panel
```

## Building from source

`git pull` on each machine and repeat the same steps with `-f deploy/docker-compose.build.yml` and `up -d --build` instead of `pull`. On nodes that use `docker run`, rebuild the image with `docker build -t mcsm-agent:latest agent/`.

## What happens to running servers

Minecraft servers keep running while the agent and the panel are updated. Some agent updates change how it builds containers; in that case the agent recreates them (each server restarts) when it starts again.

The agent shows its version in **Nodes**.

> [!NOTE]
> **Router.** After updating the agent, the mc-router container is recreated once, because it now mounts the directory of the agent's filtered socket instead of the Docker socket. Restarting or updating the agent afterwards does not restart it: mc-router reconnects to the new socket on its own (in under 30 s) and keeps routing to the servers it already knew in the meantime. See [Router (mc-router)](/docs/router).

## Base image digests

Base images (Node, `docker:dind`, Playwright and so on) are pinned by digest. To bump one, look up the new digest with `docker buildx imagetools inspect <image>:<tag>` and change tag and digest together.

## Panel database backup

Everything in the panel (servers, nodes, templates, history, password) is in `panel.db`, in the `mcsm_panel-data` volume. Worlds and their backups are not: they live in each node's `DATA_ROOT`.

Copy it with the panel stopped. The servers keep running, but wait until no backups, restores or migrations are in progress. Copy the whole volume: the panel uses WAL, so the `panel.db-wal` and `panel.db-shm` files are part of the database.

```bash
docker compose stop panel
docker run --rm -v mcsm_panel-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/mcsm-panel-$(date +%F).tgz -C /data .
docker compose start panel
```

> [!WARNING]
> Store the archive somewhere private: it contains the servers' RCON passwords and the session secret.

To restore it, with the panel stopped:

```bash
docker run --rm -v mcsm_panel-data:/data -v "$PWD":/backup alpine sh -c 'rm -f /data/panel.db* && tar xzf /backup/mcsm-panel-<date>.tgz -C /data'
```

> [!CAUTION]
> Before restoring, read the warning about restoring a database from before a migration in [Warnings](/docs/migration#warnings).
