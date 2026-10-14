---
title: Importing existing servers
description: Adopt itzg/minecraft-server containers that already run on a node so the panel manages them, and handle data outside DATA_ROOT.
section: Guides
order: 90
---

If you already run `itzg/minecraft-server` containers, the panel can adopt them instead of making you recreate them.

![The import page](/screenshots/14-import.webp)

## Import a server

1. Open **Nodes → Import** (or the node's detail page and its **Import** button).
2. The agent lists the `itzg/minecraft-server` containers on that machine that the panel doesn't manage yet.
3. Click **Review and import** on one. Check the name, slug and configuration the panel proposes.
4. Choose how to adopt it:
   - **Adopt without stopping.** Stops nothing: the original container keeps running until the first **Review and apply** in the server's Configuration tab, which recreates it with the `mcsm.*` labels and the same data folder.
   - **Adopt and apply now.** Does it all at once, recreating the container immediately.

## Things to know

- **Data outside `DATA_ROOT`** (`dataPath`): no backups or files, and these servers are not migrated.
- **Docker Compose containers:** remove the service from your compose file after the first "Review and apply", or Compose will create it again.
- **Router hostname:** the review doesn't offer it. Enable it afterwards in Configuration → Network. See [Router (mc-router)](/docs/router).

## Moving off an external folder

There is no button for this, because the agent can't see folders outside `DATA_ROOT`. Instead:

1. Delete the server **without** deleting its data.
2. Move the folder to `DATA_ROOT/<slug>/data` on the node.
3. Import it again.

Once the data is under `DATA_ROOT`, backups, files and [migration](/docs/migration) work for it.
