---
title: Installation
description: Deploy the panel and the local agent on your main machine with Docker Compose, create the administrator password and enroll the first node.
section: Getting started
order: 20
---

This page deploys the **panel** and an **agent** on the same machine, using the published images from GitHub Container Registry. To add more machines afterwards, see [Adding nodes](/docs/adding-nodes).

![Login and password creation screen](/screenshots/01-login.webp)

## Images

| Image | What it is |
|---|---|
| `ghcr.io/javilobo8/mcsm-panel` | Panel: web and API (port 8080) |
| `ghcr.io/javilobo8/mcsm-agent` | Node agent: manages the servers using its machine's Docker |

Both are built for `linux/amd64` and `linux/arm64` and tagged `X.Y.Z`, `X.Y` and `latest`. Release notes are on the [Releases](https://github.com/javilobo8/mcsm/releases) page.

## Before you start

You need Linux with Docker Engine and the Compose v2 plugin, Internet access and a directory for the worlds. See the [requirements](/docs/introduction#requirements).

> [!NOTE]
> The `docker compose` commands in these docs are run in the directory that contains `docker-compose.yml` and its `.env`. If you use a cloned repository instead, the same files are in `deploy/`: add `-f deploy/docker-compose.yml --env-file deploy/.env` (on a node, `-f deploy/docker-compose.node.yml --env-file deploy/.env`).

## Get the files

In a directory such as `/opt/mcsm`, download the compose file and the example environment file:

```bash
mkdir -p /opt/mcsm && cd /opt/mcsm
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/.env.example
```

`docker-compose.yml` is the same as `deploy/docker-compose.yml`:

```yaml include="deploy/docker-compose.yml"
```

## Configure the `.env`

The example file lists every variable. Only the ones below need your attention; the rest are optional.

```bash include="deploy/.env.example"
```

| Variable | What to set |
|---|---|
| `MCSM_VERSION` | Pin a version, for example `0.10.0`, so that updating is always a deliberate step. Empty means `latest`. |
| `PANEL_PUBLIC_URL` | The panel address with the port, as the other nodes and your browser see it, for example `http://192.168.1.10:8080`. Empty means the address you use to open the panel in the browser. |
| `DATA_ROOT` | Host directory (**absolute** path) for this machine's worlds. |
| `ENROLL_TOKEN` | Leave empty for now: you fill it in at step 4 below. |
| `PANEL_SETUP_TOKEN` | Optional. Sets the initial setup token yourself (use a long, random value). Empty means the panel generates one and writes it to its log. |
| `UPLOAD_MAX_BYTES` | Optional. Maximum file upload size in bytes. See [Upload limit](/docs/files#upload-limit). |

## First start

1. Create the network shared by the agent and the servers, and the data directory (your `DATA_ROOT`):

   ```bash
   docker network create mcsm 2>/dev/null || true
   sudo mkdir -p /srv/minecraft
   ```

2. Start **only the panel**:

   ```bash
   docker compose up -d panel
   ```

3. Find the initial setup token in the panel log, open `http://<ip>:8080` and create the administrator password (minimum 8 characters) with that token:

   ```bash
   docker compose logs panel | grep "Initial setup token"
   ```

   If you set `PANEL_SETUP_TOKEN` in the `.env`, use that value instead. The token closes the "first visitor" window: nobody who reaches the panel before you, and no website on the Internet via DNS rebinding, can set the password.

4. In **Nodes → Add node**, enter the same `DATA_ROOT` from the `.env` as the "Data directory", generate the command and copy the token into `ENROLL_TOKEN` in the `.env`. The token expires after 15 minutes and works only once.

5. Start the agent:

   ```bash
   docker compose up -d agent
   ```

   The node appears as online. This agent reaches the panel over the compose internal network (`http://panel:8080`). The enrollment is stored in the `mcsm_agent-data` volume, so from then on `ENROLL_TOKEN` is ignored.

> [!WARNING]
> Don't start the agent without a token, which is what a plain `docker compose up -d` (naming no service) would do. With no stored enrollment and no token, the agent exits with an error and Docker restarts it in a loop.

> [!IMPORTANT]
> `DATA_ROOT` is mounted into the agent **with the same path inside and outside** (`/srv/minecraft:/srv/minecraft`). The agent checks this at startup and refuses to start if the directory isn't mounted from the host.

## Ports

Open `8080/tcp` from your LAN to reach the panel. Players need each server's game port on the node. The full list is in [Ports and firewall](/docs/settings#ports-and-firewall).

## Building from source

Instead of pulling the images, clone the repository and add `-f deploy/docker-compose.build.yml` to every `docker compose` command, plus `--build` to the `up` commands:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml --env-file deploy/.env up -d --build panel
```

The images are then called `mcsm-panel:latest` and `mcsm-agent:latest`. The `docker run` from **Add node** will use `mcsm-agent:latest`, which you must build on each node:

```bash
docker build -t mcsm-agent:latest agent/
```

With the node compose file, set `MCSM_AGENT_IMAGE=mcsm-agent:latest` in its `.env`.

## What's next

- [Add other machines as nodes](/docs/adding-nodes).
- [Create a server](/docs/servers).
- Back up the panel database: see [Panel database backup](/docs/updating#panel-database-backup).
