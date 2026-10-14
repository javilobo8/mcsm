---
title: Router (mc-router)
description: Let players join by hostname through one port per node with mc-router, use autoscale to start and stop servers on demand, and know the caveats.
section: Guides
order: 100
---

**Nodes → Router** enables an [mc-router](https://github.com/itzg/mc-router) on a node. Players then join each server by its hostname (`survival.lan`, `creative.lan`) through a single node port (25565 by default). Each server also keeps its own port.

![The Nodes page with the router](/screenshots/12-nodes-router.webp)

## Set it up

1. Make sure the agent on that node is up to date. See the first caveat below.
2. On the **Nodes** page, open the router of the node, tick **Enable the router on this node** and choose the **Host port**. Save.
3. In each server, set the **Hostname** in **Configuration → Network**.
4. Make the hostnames resolve to the node's IP. That part is up to you: your home router, Pi-hole, `/etc/hosts`.

> [!IMPORTANT]
> The first server on each node gets 25565, which is also the router's default port. Enable the router **before** creating servers on that node. If a server is already on 25565, enabling the router fails with "Port 25565 is used by server "..." on this node": give the router another port or change the server's (Configuration → Network).

## Caveats

- **Update the agents before the panel.** An agent without the router refuses to enable it (the panel says so and saves nothing), but silently ignores a server definition's hostname.
- **mc-router only sees, through the agent's proxy, the containers with a router hostname.** With autoscale, it also starts and stops them. See [Security](/docs/security).
- **Import:** the review doesn't offer the hostname; enable it afterwards in Configuration → Network.

## Autoscale

With autoscale, mc-router starts a sleeping server when someone tries to join and stops it after the configured **Minutes without players until stopping**.

- The panel stops starting and stopping servers with a hostname on its own. **Stop** doesn't prevent a player from starting the server again by joining.
- Without a player list, anyone who reaches the port wakes servers, and several at once can leave the node out of memory. Fill in **Players who can wake servers** if the port faces the Internet. Changing that list restarts the router, disconnecting whoever joined through it.
- While a cold backup, a restore or a lock without `data` has an on-demand server reserved, the agent deletes its container so mc-router doesn't start it on half-written data, and recreates it when done.
- A newly created or recreated container (also due to a configuration change) is started even if the server was stopped or asleep. mc-router doesn't wake containers that have never started; it puts it back to sleep after the minutes without players.
- On-demand servers are not migrated.

## Migrating a server with a hostname

If the source node's router has autoscale, the migration is rejected, because mc-router would start the server on the source midway. Remove the autoscale or the hostname, migrate, and put it back.

The hostname must be free on the target node. After migrating, its DNS must point to the target, with that node's router enabled. Otherwise players keep reaching the source's router, which no longer has the server.

## Deleting a node with the router

With the router enabled you can't delete the node: disable it first.

If the node is offline when you disable it, the `mcsm-router` container stays on that machine until one of these happens:

- an agent on that machine removes it (an agent enrolled anew does so on connecting; one without the previous configuration, right at startup), or
- you delete it with `docker rm -f mcsm-router`.

The panel lets you delete the node anyway, so a lost machine doesn't block it.

## Port 25565

See [Ports and firewall](/docs/settings#ports-and-firewall) for the case where another program on the machine already holds the port.
