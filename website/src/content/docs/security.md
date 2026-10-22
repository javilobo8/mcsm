---
title: Security
description: The security model of MC Server Manager, why the Docker socket means effective root, and the caveats of running it on a LAN without TLS.
section: Operations
order: 130
---

MC Server Manager is designed for a home LAN and a single administrator.

> [!CAUTION]
> The agent mounts the Docker socket. Whoever controls the panel gets **effective root on every node's host**, because Docker is equivalent to root. Don't expose the panel to the Internet.

## Initial setup token

Creating the password requires the token the panel writes to its log (or the one you set in `PANEL_SETUP_TOKEN`). Nobody who reaches the panel before you, nor a website on the Internet via DNS rebinding, can set it.

## No TLS

Traffic between the browser, the panel and the agents is in the clear, and the agent doesn't authenticate the panel.

> [!WARNING]
> A LAN machine that impersonates the panel (for example with ARP spoofing) can capture the password, the cookie and the node tokens, and give orders to the agents: delete worlds, or launch servers with its own code. Use a trusted network.

## Migration runs the source's world on the target

Plugins, mods and jars included, inside the hardened container. A compromised source node can thus make the target run its code. The sha256 protects the copy in transit, not against a malicious source: migrate only from trusted nodes.

The copy travels unencrypted over the LAN, `server.properties` (with the RCON password) included.

## Published RCON

A server with **Publish RCON** accepts RCON connections on its own host port. RCON has no encryption: the password and every command travel in clear text, and whoever holds the password has full control of the server (operators, `stop`, commands from plugins). The panel's password is long and random, so guessing it is not realistic; reading it off the network is. Publish it only where you need it, and prefer the LAN or a VPN to forwarding it to the Internet.

## The router and the Docker socket

mc-router does not receive the Docker socket. It gets the agent's filtered socket (`<DATA_ROOT>/.mcsm-router/docker.sock`, only for its user); the router mounts the directory `<DATA_ROOT>/.mcsm-router/` read-only.

- The proxy only allows listing, inspecting without environment variables, following events, and starting and stopping servers with a router hostname that are not reserved or held.
- It rejects requests with a body and Docker APIs older than 1.24.
- The full socket path must fit in 100 bytes, and `DATA_ROOT`'s filesystem must support unix sockets (not CIFS/SMB).
- The router is hardened: no capabilities, `no-new-privileges`, read-only root, memory and process limits, image pinned by digest, log rotation.
- When the agent is updated the router is recreated once; agent restarts don't restart it.
- If the agent can't create the socket, it retries on its own (from 1 s to 30 s) and the error shows in the router's status.

The router's port is the one usually opened to the Internet to play with friends: limit who wakes servers with the autoscale player list. See [Router (mc-router)](/docs/router#autoscale).

## Server containers

Servers run without extra privileges:

- No capabilities except those the image needs to start (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`).
- `no-new-privileges`, a process limit and a memory limit (by default, JVM memory + 1G).
- itzg features that need more capabilities (autopause and autostop with knockd) are not supported.

## Headers and attempt limit

The web is served with a restrictive CSP and `frame-ancestors 'none'`.

Failed logins have a global limit (30 per minute). If someone on the LAN brute-forces passwords, it also locks the administrator out for a minute. Restarting the panel clears it.

## Secrets in the console

The console hides the RCON password and the CurseForge API key.

## Protect the panel database

`panel.db` contains the servers' RCON passwords and the session secret. Store its backups privately. See [Panel database backup](/docs/updating#panel-database-backup).
