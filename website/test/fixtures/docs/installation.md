---
title: Installation
description: Install the panel and the first agent on your main machine.
section: Getting started
order: 20
---

## Main machine

In a directory (e.g. `/opt/mcsm`) create a `docker-compose.yml` and a `.env`:

```bash
mkdir -p /opt/mcsm && cd /opt/mcsm
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/.env.example
```

The compose file:

```yaml include="deploy/docker-compose.yml"
```

### First start

1. Create the network: `docker network create mcsm 2>/dev/null || true`.
2. Start **only the panel**: `docker compose up -d panel`.
3. Find the setup token in its log and create the password.

> [!TIP]
> You can set the token beforehand with `PANEL_SETUP_TOKEN` in the `.env`.

> [!IMPORTANT]
> Don't start the agent without a token: it exits with an error and Docker restarts it in a loop.

### Enrolling the local agent

In **Nodes → Add node**, copy the token into `ENROLL_TOKEN` and run `docker compose up -d agent`.

```ini
MCSM_VERSION=0.10.0
PANEL_PUBLIC_URL=http://192.168.1.10:8080
DATA_ROOT=/srv/minecraft
ENROLL_TOKEN=
```

## Ports and firewall

Open `8080/tcp` from the LAN on the panel and each server's game port on the nodes. Never open 8080 to the Internet. Back to the [introduction](/docs/introduction).
