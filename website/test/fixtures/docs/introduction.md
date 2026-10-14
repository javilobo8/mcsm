---
title: Introduction
description: What MC Server Manager is, how it is built and what it needs.
section: Getting started
order: 10
---

MC Server Manager is a self-hosted panel to manage Minecraft servers (the `itzg/minecraft-server` image) spread across several machines running Docker. One panel, one agent per machine.

## Architecture

A **panel** (web and API, port 8080) and an **agent** on every machine that will host servers. The agent listens on no port: it only connects **out** to the panel.

| Piece | What it is |
|---|---|
| `ghcr.io/javilobo8/mcsm-panel` | Panel: web and API (port 8080) |
| `ghcr.io/javilobo8/mcsm-agent` | Node agent: manages the servers using its machine's Docker |

### Requirements

Linux with Docker Engine and the Compose v2 plugin, Internet access and a directory for the worlds (`DATA_ROOT`). See [Installation](/docs/installation) to start.

> [!WARNING]
> Designed for a home LAN and a single administrator. Don't expose it to the Internet.

## What it doesn't do

- No TLS between the browser, the panel and the agents.
- itzg features that need more capabilities (autopause with knockd) are not supported.

Read about [backups](/docs/backups#restoring-and-pre-restore-data) once you are running.
