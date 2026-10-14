---
title: Events and jobs
description: What the Events page records, how crash-loop protection works, and where to follow long-running jobs.
section: Guides
order: 110
---

## Events

The **Events** page and each server's **History** tab record these events:

| Event | Meaning |
|---|---|
| Exit with error | The server's process exited with an error code |
| Out of memory | The server ran out of memory |
| Crash loop | Repeated exits with error: the agent stopped the server |
| Container recreated | The agent recreated the container to match its configuration |
| Autosave disabled / re-enabled | A hot backup could not re-enable autosave; the agent keeps retrying |
| Node token rotated | A node's token was rotated |

![The Events page](/screenshots/16-events.webp)

Events are kept for 30 days or 10,000 events. Use the filter at the top to show all events, warnings and errors, or only errors.

If the panel was offline when something happened, the event may be lost, but the error is still visible in the server's header.

## Crash loops

If a server exits with an error more than 3 times in an hour, the agent stops it and does not start it again. This holds against Docker, against the panel on reconnect and against mc-router, until you press **Start** or save a new configuration. The panel leaves the server "Stopped".

Exits you asked for (stop, kill, restart, delete, or a stop done by mc-router) are not counted.

## Jobs

The **Jobs** page lists long-running operations (backups, restores, migrations) across all servers, with their progress and log. Filter by All, Running, Successful or Failed. Each server's **History** tab shows its own events and jobs.

![The Jobs page](/screenshots/17-jobs.webp)

See [Backups](/docs/backups) and [Migration between nodes](/docs/migration) for what those jobs do.
