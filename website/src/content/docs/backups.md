---
title: Backups
description: Take, schedule, download and restore backups, understand pre-restore data and the locked-server state, and what happens when the agent stops.
section: Guides
order: 60
---

Each server's **Backups** tab takes backups on demand, schedules automatic ones and restores them. The **History** tab shows the jobs with their log.

![The Backups tab](/screenshots/06-backups.webp)

## Take a backup

Open the server's **Backups** tab and click **Create backup now**. You can do it while the server runs or while it is stopped.

- **Where:** `DATA_ROOT/<slug>/backups/<slug>-<date>-<spec version>.tar.zst` (tar + zstd), with a `.json` next to it holding the sha256 and size.
- **Running server:** the backup is hot. The agent sends `save-off`, `save-all flush`, copies the data and sends `save-on`, which it sends even if the copy fails.
- **Stopped server:** a direct copy.
- Temporary files from Files uploads are never included.

> [!TIP]
> For servers that start and stop on demand with mc-router autoscale, prefer cold backups: a stop that begins in the middle of a hot copy, with Minecraft still saving, is a small residual risk.

## Schedule automatic backups

In the same tab, configure:

- **Frequency** or a **Cron expression (node time)**. The cron is evaluated in the node's time.
- Retention: **Keep days** and **Keep backups** (0 means no limit).
- **Exclude** patterns, one per line.
- **Only if someone has played since the last backup.**

**Retention** only prunes scheduled backups, and never the most recent one. Manual backups and pre-restore data are deleted by hand.

**Templates carry the schedule.** "Save as template" includes it and each server created from the template inherits it. The template editor and the wizard show it, but you change it in each server's Backups tab.

## Download a backup

Use the download button on the backup's row in the Backups tab. The file is streamed through the panel. Pre-restore data cannot be downloaded.

## Restoring and pre-restore data

Restoring **deletes nothing**. The agent:

1. Stops the server.
2. Extracts the backup into `data.restoring-<date>`.
3. Sets the current data aside as `DATA_ROOT/<slug>/data.pre-restore-<date>`.
4. Puts the backup in `data`.
5. Starts the server again if its desired state is "running"; otherwise it stays stopped.

> [!WARNING]
> If the agent goes down right at the end of a restore, the job may be left "interrupted" with the data already restored. Check the world before repeating the restore.

Each backup row has **Restore**, download and delete actions. The pre-restore data appears in the same list. It can't be restored from the web: delete it when you no longer need it. It is a whole world, so deleting it may take a while.

To go back to that data by hand, stop the server from the panel and, on the node's host:

```bash
cd "$DATA_ROOT/<slug>"
mv data data.discarded                    # or delete it, if you don't want it
mv data.pre-restore-<date> data
rm -f data.pre-restore-<date>.json
```

Then start the server from the panel and delete `data.discarded` once you have checked it.

## Server locked without `data`

If a restore fails right at the swap, or the agent dies midway and on return it isn't clear which data is the good one, the server is left **stopped and reserved**, with the error in its header: "...The server will not be started until .../data exists".

The agent does this because starting without `data` would create an empty folder and the server would generate a new world. While it lasts, start and stop give 409 and Files only allows reading.

To recover it, on the node's host, put a `data` directory in place inside `DATA_ROOT/<slug>`:

- **Go back to the data that was there:** `mv data.pre-restore-<date> data`. Entries without a `.json` next to them are swaps that didn't finish, that is, the original data. If there are several, it is normally the most recent.
- **Start a new world:** `mkdir data && chown 1000:1000 data`.

The agent checks every 15 s. As soon as `data` exists, it releases the server and returns it to its desired state (it starts it if it should be running).

## Space, files and simultaneous jobs

- **Space margin.** A backup estimates what it will take (the last backup plus 20 % or, the first time, what the data takes) and a restore estimates what it takes extracted. If the disk doesn't have that plus a margin of 256 MiB or 5 % (the larger), the job doesn't start. While writing, the agent watches the margin and aborts if it runs out: whatever was half-written is deleted and the server's data is not touched.
- **Files reports "busy" during backups and restores**, and with the server locked without data: you can only browse and download. A restore waits up to 10 s for file operations already started to finish; if they continue, it fails with "server busy or reserved: there are file operations in progress..." without touching anything.
- **At most 2 backups or restores at a time per node.** The rest wait as "Queued...", with their server reserved: start, stop and file changes report busy until they finish.

## Failed autosave re-enable

If autosave could not be re-enabled after a hot backup (`save-on` failed), the agent retries on its own. The wait starts at 30 s and doubles on each failure up to 5 min. It records the problem as an "Autosave disabled" event and a matching one when it recovers. See [Events and jobs](/docs/events).

## Stopping the agent

When the agent is stopped (`docker stop`, or an update), it waits **in parallel** up to 20 s for file operations and up to 25 s for in-progress backups and restores. A hot backup is cancelled and sends its `save-on`.

Docker would kill the agent after 10 s, so the compose files give it `stop_grace_period: 30s` and the `docker run` from **Add node** carries `--stop-timeout 30`.

> [!IMPORTANT]
> If you start the agent some other way, give it at least 30 s to stop.

If it still dies midway, on its next start it deletes the leftovers (`.partial` backups and `data.restoring-*`). If a restore was left half-done, it puts the original data back in `data` or locks the server (see [above](#server-locked-without-data)).
