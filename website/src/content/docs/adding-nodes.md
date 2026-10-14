---
title: Adding nodes
description: Enroll other machines as nodes with the docker run command from the panel or the node compose file, and rotate a node's token.
section: Getting started
order: 30
---

A node is any machine that runs an agent. The machine hosting the panel usually has one too (see [Installation](/docs/installation)); this page covers the other machines.

## Prepare the machine

On each new machine you need Docker Engine and the Compose v2 plugin. Then create the shared network and the data directory:

```bash
docker network create mcsm 2>/dev/null || true
sudo mkdir -p /srv/minecraft
```

Adjust the directory if you want a different `DATA_ROOT`. Open the [ports](/docs/settings#ports-and-firewall) players will use, and make sure the machine can reach the panel's port 8080.

## Generate an enrollment token

1. In the panel, open **Nodes → Add node**.
2. Enter a **Name** for the node and the **Data directory on that machine** (its `DATA_ROOT`).
3. Click **Generate command**.

The token expires after 15 minutes and works only once, so start the agent right away using one of the two methods below.

![The Add node dialog showing the generated command](/screenshots/12b-add-node-command.webp)

## Option 1: docker run

Run the command the panel shows. It already carries your token, your panel address and the agent image of the same version as the panel. It looks like this:

```bash
docker network create mcsm 2>/dev/null || true
docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \
  --network mcsm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/minecraft:/srv/minecraft \
  -v mcsm-agent-data:/var/lib/mcsm-agent \
  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \
  -e PANEL_URL=http://192.168.1.10:8080 \
  -e ENROLL_TOKEN=<enrollment-token> \
  -e DATA_ROOT=/srv/minecraft \
  ghcr.io/javilobo8/mcsm-agent:0.11.0
```

To raise the upload limit on this node, add `-e UPLOAD_MAX_BYTES=…` to the command (see [Upload limit](/docs/files#upload-limit)).

## Option 2: Docker Compose

In a directory such as `/opt/mcsm-node`, download the node compose file:

```bash
mkdir -p /opt/mcsm-node && cd /opt/mcsm-node
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.node.yml
```

It is identical to `deploy/docker-compose.node.yml`:

```yaml include="deploy/docker-compose.node.yml"
```

Create its `.env`:

```bash
MCSM_VERSION=0.11.0
PANEL_URL=http://192.168.1.10:8080
ENROLL_TOKEN=<enrollment-token>
DATA_ROOT=/srv/minecraft
```

Then start it:

```bash
docker compose up -d
```

Without `NODE_NAME`, the node takes the name you gave the token in **Add node**.

## Check that it worked

The node appears in **Nodes** as online, with its agent version. The enrollment is stored in the agent's volume (`mcsm-agent-data` or `agent-data`), so the expired `ENROLL_TOKEN` no longer matters.

> [!IMPORTANT]
> `DATA_ROOT` is mounted into the agent **with the same path inside and outside** (`-v /srv/minecraft:/srv/minecraft`). The agent checks this at startup and refuses to start if the directory isn't mounted from the host.

> [!NOTE]
> If the panel is built from source, the `docker run` uses `mcsm-agent:latest`, which you must build on each node. See [Building from source](/docs/installation#building-from-source).

## Rotating a node's token

Go to **Nodes →** the node's detail **→ Rotate token**. The agent must be online.

The old token stays valid until the agent reconnects with the new one. If it doesn't confirm, the panel waits 2 minutes before retrying. Agents too old to support rotation need to be [updated](/docs/updating) first.

> [!WARNING]
> If you suspect a node's token has leaked, rotating it is not enough. Delete the node and enroll it again.

## Deleting a node

You can only delete a node that has no servers. If it has the router enabled, disable the router first (see [Deleting a node with the router](/docs/router#deleting-a-node-with-the-router)).
