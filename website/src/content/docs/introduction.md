---
title: Introduction
description: What MC Server Manager is, how its panel and agents fit together, what it can do and what it deliberately does not do.
section: Getting started
order: 10
---

MC Server Manager is a self-hosted web panel for running Minecraft Java servers (the `itzg/minecraft-server` image) on one or several machines of your home network. You install one **panel** and one **agent** on every machine that will host servers, and manage everything from the browser.

It is built for a single administrator on a trusted LAN. Read [Security](/docs/security) before you decide where to run it.

![Dashboard with node cards and the servers table](/screenshots/11-dashboard-node-cards.webp)

## How it works

The **panel** (a web UI and API on port 8080) is the single source of truth for configuration. Each **agent** is a small container with the machine's Docker socket mounted. It receives the desired state of its servers from the panel and reconciles Docker to match it.

```text
┌────────────────────────── Main machine ──────────────────────────┐
│  panel (container)                                               │
│   ├─ web UI + HTTP API       ← your browser                      │
│   ├─ WebSocket /agent/ws     ← agents (they connect out)         │
│   └─ SQLite (panel.db)                                           │
│  agent (container) ── docker.sock ── the node's Minecraft servers│
└──────────────────────────────────────────────────────────────────┘
┌──────── Node B ────────┐   ┌──────── Node C ────────┐
│ agent ── docker.sock   │   │ agent ── docker.sock   │
│   └─ Minecraft x N     │   │   └─ Minecraft x N     │
└────────────────────────┘   └────────────────────────┘
```

- The agent **never listens** on a network port. It only connects out to the panel (`PANEL_URL`).
- The agent keeps a copy of its node's server definitions, so it can keep reconciling, restarting servers and running scheduled backups while the panel is down. On reconnect, the panel's version wins.
- Each agent manages only the containers that carry its own `mcsm.*` labels. Other containers on the machine are left alone (unless you [import them](/docs/importing)).
- Worlds, configuration and backups live on each node's disk, under its `DATA_ROOT` directory (`/srv/minecraft` by default).
- Minecraft servers keep running while the agent or the panel restarts.

## What you can do

- Create, configure, start, stop, restart and delete servers on any node, with the type, version, mods, modpacks, memory, properties, whitelist, ops and ports. See [Servers](/docs/servers).
- Watch state, connected players, CPU and memory charts, and the live console, and send console commands.
- Browse, edit, upload and download a server's files. See [Files](/docs/files).
- Take, schedule, download and restore backups. See [Backups](/docs/backups).
- Save templates and create servers from them.
- Move a server to another node. See [Migration between nodes](/docs/migration).
- Adopt `itzg/minecraft-server` containers you already run. See [Importing existing servers](/docs/importing).
- Let players join by hostname through an optional per-node mc-router. See [Router (mc-router)](/docs/router).
- Review exits, crash loops and long-running operations in [Events and jobs](/docs/events).

## Requirements

Each machine (the panel's machine and every node) needs:

- Linux with Docker Engine and the Compose v2 plugin (`docker compose`).
- Internet access, for the images and for Minecraft downloads.
- A directory for the worlds (`DATA_ROOT`, an absolute path; `/srv/minecraft` by default).
- The ports from [Ports and firewall](/docs/settings#ports-and-firewall) open.

The images are published for `linux/amd64` and `linux/arm64`, so a Raspberry Pi 4 or 5 with a 64-bit OS works. Use **the same version** for the panel and every agent.

## What it does not do

- It is not multi-user: there is one administrator password and no permissions model.
- It is not meant to be exposed to the Internet, and it has no TLS. See [Security](/docs/security).
- It manages Minecraft Java servers with `itzg/minecraft-server` only: no Bedrock servers, Kubernetes or Swarm.
- Backups are stored on the node's local disk. There are no cloud backups.
- There is no Prometheus or Grafana integration: metrics are kept in the panel for 7 days.

## Next steps

1. [Install the panel and the local agent](/docs/installation).
2. [Add other machines as nodes](/docs/adding-nodes) if you have any.
3. [Create your first server](/docs/servers).
