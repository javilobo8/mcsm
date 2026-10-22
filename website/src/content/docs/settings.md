---
title: Settings
description: The panel's Settings page, the versions and builds sources, and the ports and firewall rules for the panel and each node.
section: Operations
order: 120
---

Open **Settings** in the sidebar.

![The Settings page](/screenshots/15-settings.webp)

## Administrator password

Changing the password closes all sessions, including those in other browsers.

## Panel URL

The URL the agents use to reach the panel; it goes in the node enrollment command. The saved one takes precedence over `PANEL_PUBLIC_URL`. It also determines the `Origin` the WebSocket accepts.

Writes (`POST`, `PUT`, `PATCH` and `DELETE` under `/api/`) with an `Origin` other than the panel's get a 403, and login is also a write.

### Behind a reverse proxy

If the proxy rewrites `Host`, logging in through it gives a 403. Do one of these:

- Sign in directly at `http://<ip>:8080` and save here the address you use through the proxy.
- Set `PANEL_PUBLIC_URL` in the compose `.env`. It only counts if none is saved here.
- Make the proxy preserve `Host`. In nginx: `proxy_set_header Host $http_host;`.

## Game ports

The range the panel picks ports from. It is used for new servers without a port, for RCON ports set to automatic and for ports reassigned when a server is migrated. The range is the same for all nodes.

## Connection address

What players type in Minecraft, shown in the server list: your domain or public IP and, if you forward a different external port on your router (for example `55567`), that port. With an empty port each server shows its own. Servers that join through mc-router show their hostname with this port (or the router's).

## CurseForge API key

Needed for CurseForge modpacks and files. If the saved key is not valid, the page warns you.

## Versions and builds

When you create or edit a server, the panel queries the official sources over HTTPS to list Minecraft versions and builds:

- `piston-meta.mojang.com`
- `fill.papermc.io`
- `api.purpurmc.org`
- `hub.spigotmc.org`
- `meta.fabricmc.net`
- `meta.quiltmc.org`
- `files.minecraftforge.net`
- `maven.neoforged.net`

The lists are kept in memory: 1 hour for versions, 15 minutes for builds. Without Internet access from the panel you can type the version by hand.

The **Build / loader** field (Paper, Folia, Purpur, Fabric, Quilt, Forge, NeoForge) pins the build or loader version. Empty means the latest at startup.

## Ports and firewall

| Machine | Open (inbound) | What for |
|---|---|---|
| Panel | `8080/tcp` from the LAN | The web UI and the agents on the other machines (HTTP and WebSocket). Don't open it to the Internet. |
| Each node | Each server's game port (`tcp`; the panel hands them out from 25565 up to 25600), its extra ports (for example Geyser's `19132/udp`), the router's port if you enable it, and the RCON port of the servers that publish it | Players and RCON clients |

- The agent listens on no port: it only connects **out** to `PANEL_URL` (the panel's 8080). RCON (25575) goes over the `mcsm` Docker network and is not published, unless a server turns on **Publish RCON** (Configuration → Network): then it gets its own host port. RCON is not encrypted: don't forward it to the Internet unless you accept that.
- Nodes need Internet access: Docker Hub images and itzg downloads (Paper, mods, modpacks).
- To play from outside your home, forward the server's port (or mc-router's) on your home router to the node's IP. **Never 8080.**

### Port 25565

The first server on each node gets 25565 (the first free port), which is also mc-router's default port. If you are going to use the router, enable it before creating servers on that node. If a server is already on 25565, enabling it fails with "Port 25565 is used by server "..." on this node": give the router another port or change the server's (Configuration → Network).

If another program on the machine already holds the port (for example a Minecraft server the panel doesn't manage), the server won't start and its header shows Docker's error. Change its port.

## Environment variables

These are set in the compose `.env` files, not in the UI.

| Variable | Where | What it does |
|---|---|---|
| `MCSM_VERSION` | panel and node | Image version to pull. Empty means `latest`. |
| `PANEL_PUBLIC_URL` | panel | Panel address with the port. Empty means the address you open it with. Overridden by the URL saved in Settings. |
| `PANEL_SETUP_TOKEN` | panel | Initial setup token. Empty means the panel generates one and writes it to its log. |
| `PANEL_URL` | agent | The panel address the agent connects to. |
| `ENROLL_TOKEN` | agent | One-time enrollment token. Ignored once enrolled. |
| `NODE_NAME` | agent | Node name. On the main machine it defaults to `main`; on a node, empty means the name of the enrollment token. |
| `DATA_ROOT` | agent | Absolute path of the worlds directory, mounted with the same path inside and outside. Default `/srv/minecraft`. |
| `UPLOAD_MAX_BYTES` | agent | Maximum upload size in bytes. Default 4 GiB. See [Upload limit](/docs/files#upload-limit). |
| `MCSM_AGENT_IMAGE` | node compose | Overrides the agent image, for example `mcsm-agent:latest` for a build from source. |
