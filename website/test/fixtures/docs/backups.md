---
title: Backups
description: Hot and scheduled backups, retention and restore.
section: Guides
order: 50
---

Each server's **Backups** tab takes backups on demand, schedules automatic backups and restores.

![The Backups tab](/screenshots/06-backups.webp)

## Where they are

`DATA_ROOT/<slug>/backups/<slug>-<date>-<spec version>.tar.zst`, with a `.json` next to it.

## Restoring and pre-restore data

Restoring **deletes nothing**: it sets the current data aside as `data.pre-restore-<date>`.

```bash
cd "$DATA_ROOT/<slug>"
mv data data.discarded
mv data.pre-restore-<date> data
```

> [!CAUTION]
> Check the world before repeating an interrupted restore.

> [!NOTE]
> Pre-restore data can't be downloaded.

### Server locked without data

If a restore fails right at the swap, the server is left stopped and reserved until `data` exists.

## Space, files and simultaneous jobs

- At most **2 backups or restores at a time per node**.
- A space margin of 256 MiB or 5% (the larger).

See also [the installation](/docs/installation#ports-and-firewall).
