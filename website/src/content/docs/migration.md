---
title: Migration between nodes
description: Move a server with its world, configuration, backups and history to another node, and what to do when a step fails or a node disappears.
section: Guides
order: 80
---

A server's **Migrate** tab moves it (world, configuration, backups and history) to another node.

![The Migrate tab](/screenshots/09-migrate.webp)

## Migrate a server

1. Open the server and go to the **Migrate** tab.
2. Choose the **Target node**. The panel proposes a port for the target; if the server's port clashes there, it picks another one, or you can type one.
3. Optionally tick **Delete the source when finished** to remove the data and backups from the source node. Otherwise they are kept.
4. Start the migration and confirm.

The migration is a job with 7 visible steps:

1. Stop the server on the source.
2. Pre-migration backup (`pre_migration`).
3. Upload it to the panel, checking size and sha256.
4. Send it to the target, which checks it again and restores it.
5. Create the server there (spec version +1 and, if its port clashes, another port).
6. Start it and wait for it to become healthy (5 minutes at most). If it was stopped, it is stopped again.
7. Confirm the node change and retire the source.

![A finished migration](/screenshots/10-migrated.webp)

## Data and backups

- When retiring the source, it keeps its data and backups in `DATA_ROOT/<slug>.migrated-<date>`, or deletes them if you ticked **Delete the source when finished**. Delete them by hand when you no longer need them.
- The pre-migration backup stays on the target, in the server's backup list.

## If something fails before confirming

The server stays on its node with the world intact, and is started again if it was running.

If the target's copy got as far as starting, the source doesn't start until that copy has been deleted: there are never two live servers with the same world. In the meantime the header warns you and actions on the server wait.

## What is pending

If a node doesn't respond, these tasks are retried every 30 s and every time the node reconnects:

- the target cleanup,
- the source start,
- the confirmation on the target,
- the retirement of the source.

The tab says what is missing and why. If the agent rejects something that retrying won't fix (for example, the target's directory is no longer the one from this migration), it stops being retried and is noted for you to resolve by hand.

If a node isn't coming back, **Close the migration by hand...** stops retrying and tells you what is left undone.

## Warnings

> [!WARNING]
> **Target node isolated, not dead.** If you delete the target node, or manually close a migration whose copy got as far as starting there, and that node is only cut off from the network, its container may keep running. Check before starting the server on the source.

> [!CAUTION]
> **Don't restore the panel database** to a backup from before a migration without reviewing the nodes. The panel would believe the server is on its previous node and would give it its spec again, so it would start with whatever remains there (or with an empty world). The target is already protected: after confirming, the agent doesn't delete the server even if a restored panel asks it to. For the restore procedure, see [Panel database backup](/docs/updating#panel-database-backup).

- **`restartPolicy: always`.** If the source's Docker daemon restarts between step 1 and the retirement, it starts the stopped container until the agent's next reconciliation (30 s at most), which stops it again. Avoid restarting Docker on the source during a migration, or use `unless-stopped` (the default).
- **Late spec.** If a migration fails right as the server is being created on the target, the target may be left with an empty `DATA_ROOT/<slug>` that wasn't deleted. It would be caused by a command the agent ran late and is almost impossible. A later migration with that slug will answer "already exists": delete the directory by hand.
- **Imported servers still in their original container** (not yet "Review and apply"): when the migration finishes, retiring the source removes that container, as when deleting the server. If Docker Compose created it, remove that service from the compose file, or Compose will create it again on the source.
- **Servers with `dataPath`** (data outside `DATA_ROOT`) are not migrated, and `dataPath` can't be removed from the configuration. To migrate one, delete the server without deleting its data, move the folder to the node's `DATA_ROOT/<slug>/data` and [import it again](/docs/importing#moving-off-an-external-folder).
- **Servers with a router hostname.** See [Migrating a server with a hostname](/docs/router#migrating-a-server-with-a-hostname).
- **On-demand servers** (mc-router autoscale) are not migrated: starting them on the source to park them would defeat the purpose.

## Security note

Migration runs the source's world on the target, plugins, mods and jars included. Migrate only from trusted nodes. The details are in [Security](/docs/security).
