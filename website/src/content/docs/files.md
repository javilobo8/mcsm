---
title: Files
description: Browse, edit, upload and download a server's files, and know the upload limit and the fixed limits on transfers.
section: Guides
order: 70
---

Each server's **Files** tab browses its `data` folder, edits text files (up to 2 MiB), and uploads and downloads files. Uploads and downloads are streamed browser to panel to agent, without going through the panel's disk.

![The Files tab](/screenshots/07-files.webp)

## Upload limit

The maximum upload size is set per node with an environment variable of the agent.

| Variable | Default | What it does |
|---|---|---|
| `UPLOAD_MAX_BYTES` | `4294967296` (4 GiB) | Maximum upload size, in bytes. Above it, the node rejects the upload with "the upload exceeds the node's maximum of ... (UPLOAD_MAX_BYTES)". |

For example, for 10 GiB: `UPLOAD_MAX_BYTES=10737418240`.

Set it in the compose `.env` (the main machine's or the node's); an empty value means the default. On a node started with the `docker run` from **Add node**, add `-e UPLOAD_MAX_BYTES=...` to the command instead.

## Limits

Fixed limits, so you know what to expect:

- At most **4 uploads or downloads at a time per node**. The fifth gets "the node already has 4 file transfers in progress: wait for one to finish".
- A transfer is cut if **60 s pass without a byte moving** (on the agent side) or 120 s (on the panel side). As long as it progresses, it has no overall deadline.
- Writes are atomic: the agent writes a hidden temporary file `.mcsm-tmp-<16 hex digits>` in the same folder and renames it at the end. If the agent dies midway (power cut, `kill -9`), the temporary file is deleted when it starts again, if untouched for more than 1 hour. A file of yours that merely starts the same way (`.mcsm-tmp-notes`) is just a file.
- When the agent is stopped (`docker stop`, an update), it waits up to 20 s for in-progress file operations to finish or clean up, in parallel with backups. See [Stopping the agent](/docs/backups#stopping-the-agent).
- Text files open in the editor up to 2 MiB.

## When Files is read-only

While the server has a backup or restore in progress (or queued), or is locked without data, Files only lets you browse and download. Writing, creating folders, renaming, deleting and uploading respond "server busy or reserved (...)". See [Backups](/docs/backups#space-files-and-simultaneous-jobs).

Servers whose data lives outside `DATA_ROOT` (`dataPath`, from [imports](/docs/importing)) have no backups and no file manager: those tabs show a note instead.
