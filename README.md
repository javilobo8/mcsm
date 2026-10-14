# MC Server Manager

Self-hosted panel to manage Minecraft servers (`itzg/minecraft-server` image) spread across several machines running Docker. One panel, one agent per machine.

**Website and documentation:** <https://javilobo8.github.io/mcsm/>

## Deployment

A **panel** (web and API, port 8080) and an **agent** on every machine that will host servers; the panel's machine usually runs its own too. Images are published to GitHub Container Registry with each [release](https://github.com/javilobo8/mcsm/releases):

| Image | What it is |
|---|---|
| `ghcr.io/javilobo8/mcsm-panel` | Panel: web and API (port 8080) |
| `ghcr.io/javilobo8/mcsm-agent` | Node agent: manages the servers using its machine's Docker |

Both for `linux/amd64` and `linux/arm64` (e.g. a Raspberry Pi 4/5 with a 64-bit OS), with the tags `X.Y.Z`, `X.Y` and `latest`. Use **the same version** for the panel and every agent.

**Each machine needs** Linux with Docker Engine and the Compose v2 plugin (`docker compose`), Internet access (images and Minecraft downloads) and a directory for the worlds (`DATA_ROOT`, absolute path; `/srv/minecraft` by default). Open the ports listed in [Ports and firewall](#ports-and-firewall).

The `docker compose` commands in this README are run in the directory containing `docker-compose.yml` and its `.env`. If you use the cloned repository, the same files are in `deploy/`: add `-f deploy/docker-compose.yml --env-file deploy/.env` (on a node, `-f deploy/docker-compose.node.yml --env-file deploy/.env`).

### Main machine (panel + agent)

In a directory (e.g. `/opt/mcsm`) create a `docker-compose.yml` and a `.env`. You can download them from the repository:

```bash
mkdir -p /opt/mcsm && cd /opt/mcsm
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/.env.example
```

`docker-compose.yml` (same as `deploy/docker-compose.yml`):

```yaml
# Requires the shared network: docker network create mcsm
# Images published on GHCR; MCSM_VERSION (in .env) pins the version, empty = latest. To build from
# source, add -f deploy/docker-compose.build.yml.
name: mcsm
services:
  panel:
    image: ghcr.io/javilobo8/mcsm-panel:${MCSM_VERSION:-latest}
    init: true
    restart: unless-stopped
    ports: ["8080:8080"]
    environment:
      # Empty: the panel uses the address you open it with in the browser (Host with port).
      PANEL_PUBLIC_URL: ${PANEL_PUBLIC_URL:-}
      # Optional: initial setup token (empty = the panel generates one and writes it to its log).
      PANEL_SETUP_TOKEN: ${PANEL_SETUP_TOKEN:-}
    volumes:
      - panel-data:/data
  agent:
    image: ghcr.io/javilobo8/mcsm-agent:${MCSM_VERSION:-latest}
    # docker stop kills after 10 s; on stop, the agent waits in parallel, up to 25 s, for its
    # file operations and in-progress backups (save-on) before exiting.
    stop_grace_period: 30s
    restart: unless-stopped
    depends_on: [panel]
    environment:
      PANEL_URL: http://panel:8080
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      NODE_NAME: ${NODE_NAME:-main}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      # Optional: maximum size of a file upload, in bytes (empty = 4 GiB).
      UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [default, mcsm]
networks:
  mcsm:
    name: mcsm
    external: true
volumes:
  panel-data: {}
  agent-data: {}
```

`.env` (edit it; the other variables in `deploy/.env.example` are optional):

```bash
# Image version: pin it so that updating is always a deliberate step (empty = latest)
MCSM_VERSION=0.11.0
# Panel address with the port, as the other nodes and your browser see it
# (empty = the address you use to open the panel in the browser)
PANEL_PUBLIC_URL=http://192.168.1.10:8080
# Host directory (ABSOLUTE path) for this machine's worlds
DATA_ROOT=/srv/minecraft
# Enrollment token for the local agent: filled in at step 4
ENROLL_TOKEN=
```

Then:

1. Create the network shared by the agent and the servers, and the data directory: `docker network create mcsm 2>/dev/null || true` and `sudo mkdir -p /srv/minecraft` (your `DATA_ROOT`).
2. Start **only the panel**: `docker compose up -d panel`.
3. Find the initial setup token in its log (`docker compose logs panel | grep "Initial setup token"`), open `http://<ip>:8080` and create the password (minimum 8 characters) with that token. You can also set it beforehand with `PANEL_SETUP_TOKEN` in the `.env`. This closes the “first visitor” window: a website on the Internet cannot set the password via DNS rebinding.
4. In **Nodes → Add node**, enter the same `DATA_ROOT` from the `.env` as the “Data directory” and copy the token into `ENROLL_TOKEN`. The token expires after 15 minutes and works only once.
5. Start the agent: `docker compose up -d agent`. The node appears as online. This agent reaches the panel over the compose internal network (`http://panel:8080`). The enrollment is stored in the `mcsm_agent-data` volume: from then on `ENROLL_TOKEN` is ignored.

Don't start the agent without a token (a `docker compose up -d` without naming a service would): with no stored enrollment and no token, it exits with an error and Docker restarts it in a loop.

### Other machines (agent only)

On each one, create the network (`docker network create mcsm 2>/dev/null || true`) and the `DATA_ROOT`. Then, in **Nodes → Add node**, generate a token with that machine's “Data directory” and, within 15 minutes, start the agent in one of these two ways.

**With `docker run`:** run the command the panel shows. It already carries your token, your address and the agent image of the same version as the panel; it looks like this:

```bash
docker network create mcsm 2>/dev/null || true
docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \
  --network mcsm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/minecraft:/srv/minecraft \
  -v mcsm-agent-data:/var/lib/mcsm-agent \
  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \
  -e PANEL_URL=http://192.168.1.10:8080 \
  -e ENROLL_TOKEN=<enrollment-token> \
  -e DATA_ROOT=/srv/minecraft \
  ghcr.io/javilobo8/mcsm-agent:0.11.0
```

**With Docker Compose:** in a directory (e.g. `/opt/mcsm-node`), a `docker-compose.yml` identical to `deploy/docker-compose.node.yml` (`curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.node.yml`):

```yaml
# Requires the shared network: docker network create mcsm
# Image published on GHCR; MCSM_VERSION (in .env) pins the version, empty = latest. With an agent built from
# source (docker build -t mcsm-agent:latest agent/), set MCSM_AGENT_IMAGE=mcsm-agent:latest.
name: mcsm-node
services:
  agent:
    image: ${MCSM_AGENT_IMAGE:-ghcr.io/javilobo8/mcsm-agent:${MCSM_VERSION:-latest}}
    # docker stop kills after 10 s; on stop, the agent waits in parallel, up to 25 s, for its
    # file operations and in-progress backups (save-on) before exiting.
    stop_grace_period: 30s
    restart: unless-stopped
    environment:
      PANEL_URL: ${PANEL_URL:?Set PANEL_URL, e.g. http://192.168.1.10:8080}
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      # Optional: empty = the panel uses the enrollment token's name (same as the UI's docker run, which doesn't pass it).
      NODE_NAME: ${NODE_NAME:-}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      # Optional: maximum size of a file upload, in bytes (empty = 4 GiB).
      UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [mcsm]
networks:
  mcsm:
    name: mcsm
    external: true
volumes:
  agent-data: {}
```

and its `.env`:

```bash
MCSM_VERSION=0.11.0
PANEL_URL=http://192.168.1.10:8080
ENROLL_TOKEN=<enrollment-token>
DATA_ROOT=/srv/minecraft
```

Then, `docker compose up -d`. Without `NODE_NAME`, the node takes the token's name.

`DATA_ROOT` is mounted into the agent **with the same path inside and outside** (`-v /srv/minecraft:/srv/minecraft`): the agent checks this at startup and refuses to start if it isn't mounted from the host.

### Building from source

Instead of pulling the images, with the repository cloned: add `-f deploy/docker-compose.build.yml` to every `docker compose` and `--build` to the `up` commands (e.g. `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml --env-file deploy/.env up -d --build panel`). The images are then called `mcsm-panel:latest` and `mcsm-agent:latest`, and the `docker run` from **Add node** uses `mcsm-agent:latest`, which you will have to build on each node (`docker build -t mcsm-agent:latest agent/`; with the node compose, `MCSM_AGENT_IMAGE=mcsm-agent:latest` in its `.env`).

### Rotating a node's token

**Nodes →** node detail **→ Rotate token.** The agent must be online. The old token stays valid until the agent reconnects with the new one; if it doesn't confirm, the panel waits 2 min before retrying. Agents older than Plan 9 don't support rotation: update them first.

If you suspect a node's token has leaked, rotating it is not enough: delete the node and enroll it again.

## Settings

- **Password.** Changing it closes all sessions, including those in other browsers.
- **Panel URL.** The saved one takes precedence over `PANEL_PUBLIC_URL`; it is the one in the node enrollment command and the `Origin` the WebSocket accepts. Writes (`POST`/`PUT`/`PATCH`/`DELETE` under `/api/`) with an `Origin` other than the panel's get a 403, and login is also a write. Behind a reverse proxy that rewrites `Host`, logging in through the proxy gives a 403: sign in directly at `http://<ip>:8080` and save here the address you use through the proxy, set `PANEL_PUBLIC_URL` in the compose `.env` (it only counts if none is saved here) or make the proxy preserve `Host` (in nginx, `proxy_set_header Host $http_host;`).
- **Game port range.** Only used for new servers without a port.
- **Connection address.** What players type in Minecraft, shown in the server list: your domain or public IP and, if you forward a different external port on your router (e.g. `55567`), that port. With an empty port each server shows its own. Servers that join through mc-router show their hostname with this port (or the router's).
- **CurseForge API key.** If the saved one is not valid, the page warns you.
- **Versions and builds.** When creating or editing a server, the panel queries the official sources over HTTPS (`piston-meta.mojang.com`, `fill.papermc.io`, `api.purpurmc.org`, `hub.spigotmc.org`, `meta.fabricmc.net`, `meta.quiltmc.org`, `files.minecraftforge.net`, `maven.neoforged.net`) to list Minecraft versions and builds; the lists are kept in memory (1 h for versions, 15 min for builds). Without Internet access from the panel you can type the version by hand. The **Build / loader** field (Paper, Folia, Purpur, Fabric, Quilt, Forge, NeoForge) pins the build or loader version; empty = the latest at startup.

## Ports and firewall

| Machine | Open (inbound) | What for |
|---|---|---|
| Panel | `8080/tcp` from the LAN | The web UI and the agents on the other machines (HTTP and WebSocket). Don't open it to the Internet. |
| Each node | Each server's game port (`tcp`; the panel hands them out from 25565 up to 25600), its extra ports (e.g. Geyser's `19132/udp`) and the router's port if you enable it | Players |

- The agent listens on no port: it only connects **out** to `PANEL_URL` (the panel's 8080). RCON (25575) goes over the `mcsm` Docker network and is not published.
- Nodes need Internet access: Docker Hub images and itzg downloads (Paper, mods, modpacks).
- To play from outside your home, forward the server's port (or mc-router's) on your home router to the node's IP. Never 8080.
- **Port 25565.** The first server on each node gets 25565 (the first free port), which is also mc-router's default port. If you are going to use the router, enable it before creating servers on that node. If a server is already on 25565, enabling it fails with “Port 25565 is used by server “…” on this node”: give the router another port or change the server's (Configuration → Network). If another program on the machine already holds the port (e.g. a Minecraft server the panel doesn't manage), the server won't start and its header shows Docker's error: change its port.

## Updating

**Agents first, then the panel.** An old agent rejects what it doesn't know, but a new panel may ask it for things it can't do yet. Use the same version on all machines: in each `.env`, `MCSM_VERSION=<new>` (with `latest`, just pull again). Release notes are on the [Releases](https://github.com/javilobo8/mcsm/releases) page.

1. Agents.
   - On the main machine: `docker compose pull agent && docker compose up -d --no-deps agent` (`--no-deps`: without it, Compose would also restart the panel).
   - On nodes using compose: `docker compose pull && docker compose up -d`.
   - On nodes using `docker run`: `docker pull ghcr.io/javilobo8/mcsm-agent:<new>`, then `docker stop mcsm-agent && docker rm mcsm-agent` (with `stop` it gets its 30 s to finish; `rm -f` kills it immediately) and run the same `docker run` again with the image version changed. The `mcsm-agent-data` volume keeps the enrollment, so the expired `ENROLL_TOKEN` doesn't matter.
2. Panel: `docker compose pull panel && docker compose up -d --no-deps panel`.

[Building from source](#building-from-source): `git pull` on each machine and the same steps with `-f deploy/docker-compose.build.yml` and `up -d --build` instead of `pull` (on nodes using `docker run`, `docker build -t mcsm-agent:latest agent/`).

The agent shows its version (`agent/VERSION`) in **Nodes**. Base images (Node, `docker:dind`, Playwright…) are pinned by digest; to bump them, look up the new one with `docker buildx imagetools inspect <image>:<tag>` and change tag and digest together.

**Router.** After updating the agent, the mc-router container is recreated once (it now mounts the directory of the agent's filtered socket instead of the Docker socket). Restarting or updating the agent afterwards does not restart it: mc-router reconnects to the new socket on its own (in under 30 s), and in the meantime keeps routing to the servers it already knew.

Minecraft servers keep running while the agent and the panel are updated. Some agent updates change how it builds containers and recreate them (each server restarts) when it starts again.

## Panel database backup

Everything in the panel (servers, nodes, templates, history, password) is in `panel.db`, in the `mcsm_panel-data` volume. Worlds and their backups are not: they live in each node's `DATA_ROOT`. Copy it with the panel stopped: the servers keep running, but wait until no backups, restores or migrations are in progress. Copy the whole volume: the panel uses WAL, and the `panel.db-wal` and `panel.db-shm` files are part of the database.

```bash
docker compose stop panel
docker run --rm -v mcsm_panel-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/mcsm-panel-$(date +%F).tgz -C /data .
docker compose start panel
```

Store it somewhere private: it contains the servers' RCON passwords and the session secret. To restore it, with the panel stopped:

```bash
docker run --rm -v mcsm_panel-data:/data -v "$PWD":/backup alpine sh -c 'rm -f /data/panel.db* && tar xzf /backup/mcsm-panel-<date>.tgz -C /data'
```

First, read the warning in [Migration between nodes](#migration-between-nodes) about restoring a backup from before a migration.

## Files

Each server's **Files** tab browses its `data` folder, edits text files (up to 2 MiB) and uploads and downloads files. Uploads and downloads are streamed browser ↔ panel ↔ agent, without going through the panel's disk.

Agent configuration (per node, environment variable):

| Variable | Default | What it does |
|---|---|---|
| `UPLOAD_MAX_BYTES` | `4294967296` (4 GiB) | Maximum upload size, in bytes. Above it, the node rejects the upload with “the upload exceeds the node's maximum of … (UPLOAD_MAX_BYTES)”. Example for 10 GiB: `UPLOAD_MAX_BYTES=10737418240`. |

Set it in the compose `.env`, the main one or the node one (empty = the default value) or, on a node started with the `docker run` from **Add node**, by adding `-e UPLOAD_MAX_BYTES=…`.

Fixed limits, so you know what to expect:

- At most **4 uploads or downloads at a time per node**; the fifth gets “the node already has 4 file transfers in progress: wait for one to finish”.
- A transfer is cut if **60 s pass without a byte moving** (the agent) or 120 s (the panel); as long as it progresses, it has no overall deadline.
- Writes are atomic: a hidden temporary `.mcsm-tmp-<16 hex digits>` in the same folder and a `rename` at the end. If the agent dies midway (power cut, `kill -9`), the temporary file is deleted when it starts again (if untouched for more than 1 h). A file of yours that merely starts the same way (`.mcsm-tmp-notes`) is just a file.
- When it is stopped (`docker stop`, update), the agent waits up to 20 s for in-progress file operations to finish or clean up, in parallel with the backups (see [Stopping the agent](#stopping-the-agent)).
- While the server has a backup or restore in progress (or queued), or is locked without data, Files only lets you browse and download: writing, creating folders, renaming, deleting and uploading respond “server busy or reserved (…)”. See [Backups](#backups).

## Backups

Each server's **Backups** tab takes backups on demand, schedules automatic backups (cron in the node's time, retention by count and by days, and “Only if someone has played since the last backup”) and restores. **History** shows the jobs with their log.

- **Where:** `DATA_ROOT/<slug>/backups/<slug>-<date>-<spec version>.tar.zst` (tar + zstd), with a `.json` next to it (sha256, size). With the server running the backup is hot (`save-off`, `save-all flush`, copy, `save-on`, which is sent even if the copy fails); stopped, it is a direct copy. Temporary files from Files uploads are never included.
- **Retention:** only prunes scheduled backups, and never the most recent one. Manual backups and pre-restore data are deleted by hand.
- **Downloading a backup:** from the Backups tab; the file is streamed through the panel. Pre-restore data can't be downloaded.
- **Failed `save-on`:** if autosave could not be re-enabled after a hot backup, the agent retries on its own, with a wait that starts at 30 s and doubles on each failure up to 5 min, and records it as an “Autosave disabled” event.
- **Templates carry the schedule.** “Save as template” includes it and each server created from the template inherits it; the template editor and the wizard show it, but it is changed in each server's Backups tab.

### Restoring and pre-restore data

Restoring **deletes nothing**: it stops the server, extracts the backup into `data.restoring-<date>`, sets the current data aside as `DATA_ROOT/<slug>/data.pre-restore-<date>` and puts the backup in `data`. Then it starts the server again if its desired state is “running”; otherwise it stays stopped. If the agent goes down right at the end of a restore, the job may be left “interrupted” with the data already restored: check the world before repeating it.

The pre-restore data appears in the backup list. It can't be restored from the web: delete it when you no longer need it (it's a whole world, so it may take a while). To go back to that data by hand, stop the server from the panel and, on the node's host:

```bash
cd "$DATA_ROOT/<slug>"
mv data data.discarded                    # or delete it, if you don't want it
mv data.pre-restore-<date> data
rm -f data.pre-restore-<date>.json
```

Then start it from the panel and delete `data.discarded` once you have checked it.

### Server locked without `data`

If a restore fails right at the swap, or the agent dies midway and on return it isn't clear which data is the good one, the server is left **stopped and reserved**, with the error in the header: “…The server will not be started until …/data exists”. Starting it without `data` would create an empty folder and the server would generate a new world. While this lasts, start and stop give 409 and Files only allows reading.

To recover it, on the node's host, put a `data` in place:

- **Go back to the data that was there:** `mv data.pre-restore-<date> data` inside `DATA_ROOT/<slug>`. The ones without a `.json` next to them are swaps that didn't finish, i.e. the original data; if there are several, it is normally the most recent.
- **Start a new world:** `mkdir data && chown 1000:1000 data`.

The agent checks every 15 s: as soon as `data` exists, it releases the server and returns it to its desired state (starts it if it should be running).

### Space, files and simultaneous jobs

- **Space margin:** a backup estimates what it will take (the last backup plus 20% or, the first time, what the data takes) and a restore what it takes extracted. If the disk doesn't have that plus a margin of 256 MiB or 5% (the larger), they don't start. While writing they watch the margin and, if it runs out, abort: whatever was half-written is deleted and the server's data is not touched.
- **Files reports “busy” during backups and restores** (and with the server locked without data): you can only browse and download. A restore waits up to 10 s for file operations already started to finish; if they continue, it fails with “server busy or reserved: there are file operations in progress…” without touching anything.
- **At most 2 backups or restores at a time per node.** The rest wait as “Queued…”, with their server reserved (start, stop and file changes report busy until they finish).

### Stopping the agent

When the agent is stopped (`docker stop`, updating it), it waits **in parallel** up to 20 s for file operations and up to 25 s for in-progress backups and restores: a hot backup is cancelled and sends its `save-on`. Docker would kill it after 10 s, so the compose files give it `stop_grace_period: 30s` and the `docker run` from **Add node** carries `--stop-timeout 30`. If you start the agent some other way, give it at least 30 s. If it still dies midway, on the next start it deletes the leftovers (`.partial` backups, `data.restoring-*`) and, if a restore was left half-done, puts the original data back in `data` or locks the server (see above).

## Events and crash loops

The **Events** page and each server's **History** record: exit with error, out of memory, crash loop, container recreated, autosave disabled/re-enabled and token rotated. They are kept for 30 days or 10,000 events. If the panel was offline, the event may be lost, but the error is still visible in the server's header.

**Crash loop:** more than 3 exits with error in an hour and the agent stops the server and doesn't start it again (neither Docker, nor the panel on reconnect, nor mc-router) until you press **Start** or save a new configuration. The panel leaves it “Stopped”.

## Importing existing servers

**Nodes → Import** (or a node's detail) detects the `itzg/minecraft-server` containers on that machine that the panel doesn't manage yet. You review them before adopting.

- **Adopt** stops nothing: the original container keeps running until the first **Review and apply**, which recreates it with the `mcsm.*` labels and the same data folder. **Adopt and apply** does it all at once.
- **Data outside `DATA_ROOT`** (`dataPath`): no backups or files, and they are not migrated.
- **Docker Compose containers:** remove the service from the compose after the first “Review and apply”, or Compose will create it again.
- **Moving off an external folder:** there is no button (the agent can't see folders outside `DATA_ROOT`). Delete the server without deleting its data, move the folder to `DATA_ROOT/<slug>/data` and import it again.

## Migration between nodes

Each server's **Migrate** tab moves it (world, configuration, backups and history) to another node with a job of 7 visible steps:

1. stop on the source;
2. pre-migration backup (`pre_migration`);
3. upload it to the panel, checking size and sha256;
4. send it to the target, which checks it again and restores it;
5. create the server there (spec version +1 and, if its port clashes, another port);
6. start it and wait for it to become healthy (5 min at most). If it was stopped, it is stopped again;
7. confirm the node change and retire the source.

**Data and backups.**
- When retiring it, the source keeps its data and backups in `DATA_ROOT/<slug>.migrated-<date>` (or deletes them, with “Delete the source when finished”). Delete them by hand when you no longer need them.
- The pre-migration backup stays on the target, in the server's backup list.

**If something fails before confirming.** The server stays on its node with the world intact, and is started again if it was running. If the target's copy got as far as starting, the source doesn't start until it has been deleted: there are never two live servers with the same world. In the meantime the header warns and actions on the server wait.

**What is pending.** If a node doesn't respond, the target cleanup, the source start, the confirmation on the target or the retirement of the source are retried every 30 s and every time the node reconnects. The tab says what is missing and why. If the agent rejects something that retrying won't fix (for example, the target's directory is no longer the one from this migration), it stops being retried and is noted for you to resolve by hand. If a node isn't coming back, **Close the migration by hand…** stops retrying and says what is left undone.

**Warnings:**

- **Target node isolated, not dead.** If you delete the target node, or manually close a migration whose copy got as far as starting there, and that node is only cut off from the network, its container may keep running. Check before starting the server on the source.
- **Don't restore the panel database** to a backup from before a migration without reviewing the nodes.
  - The panel would believe the server is on its previous node and would give it its spec again, so it would start with whatever remains there (or with an empty world).
  - The target is already protected: after confirming, the agent doesn't delete the server even if a restored panel asks it to.
- **`restartPolicy: always`.** If the source's Docker daemon restarts between step 1 and the retirement, it starts the stopped container until the agent's next reconciliation (≤ 30 s), which stops it again. Avoid restarting Docker on the source during a migration, or use `unless-stopped` (the default).
- **Late spec.** If a migration fails right as the server is being created on the target, the target may be left with an empty `DATA_ROOT/<slug>` that wasn't deleted. It would be caused by a command the agent ran late and is almost impossible. A later migration with that slug will answer “already exists”: delete it by hand.
- **Imported servers still in their original container** (not yet “Review and apply”): when it finishes, retiring the source removes that container, as when deleting the server. If Docker Compose created it, remove that service from the compose, or Compose will create it again on the source.
- **Servers with `dataPath`** (data outside `DATA_ROOT`): they are not migrated, and `dataPath` can't be removed from the configuration. To migrate it, delete the server without deleting data, move the folder to the node's `DATA_ROOT/<slug>/data` and import it again.

## Router (mc-router)

**Nodes → Router** enables an [mc-router](https://github.com/itzg/mc-router) per node: players join each server by its hostname (`survival.lan`, `creative.lan`) through a single node port (25565 by default). Each server's hostname is set in **Configuration → Network**; each server also keeps its own port. Making `*.lan` resolve to the node's IP is up to you (home router, Pi-hole, `/etc/hosts`).

- **Update the agents before the panel.** An agent without the router refuses to enable it (the panel says so and saves nothing), but silently ignores a server spec's hostname.
- **Autoscale:** mc-router starts a sleeping server when someone tries to join and stops it after the configured minutes without players. With it, the panel stops starting and stopping servers with a hostname on its own; **Stop** doesn't prevent a player from starting it again by joining. Without a player list, anyone who reaches the port wakes servers (and several at once can leave the node out of memory): fill in **Players who can wake servers** if the port faces the Internet. Changing that list restarts the router (disconnecting whoever joined through it). While a cold backup, a restore or a lock without `data` has an on-demand server reserved, the agent deletes its container so mc-router doesn't start it on half-written data, and recreates it when done. A newly created or recreated container (also due to a configuration change) is started even if the server was stopped or asleep: mc-router doesn't wake containers that have never started; it puts it back to sleep after the minutes without players.
- **mc-router only sees, through the agent's proxy, the containers with a router hostname** (see [Security](#security)); with autoscale, it also starts and stops them.
- **Migrating a server with a hostname:** if the source node's router has autoscale, the migration is rejected (mc-router would start it on the source midway): remove the autoscale or the hostname, migrate and put it back. The hostname must be free on the target node, and after migrating its DNS must point to the target, with that node's router enabled; otherwise players keep reaching the source's router, which no longer has the server.
- **Import:** the review doesn't offer the hostname; enable it afterwards, in Configuration → Network.
- **Deleting a node:** with the router enabled you can't; disable it first. If the node is offline when you disable it, the `mcsm-router` container stays on that machine until an agent on that machine removes it (one enrolled anew does so on connecting; one without the previous configuration, right at startup) or you delete it with `docker rm -f mcsm-router`; the panel lets you delete the node anyway so a lost machine doesn't block it.

## Development

```bash
mise install            # installs Go and buf (Node 26 and pnpm 12 are installed separately)
pnpm install
pnpm dev:api        # panel on :8080
pnpm dev:web        # web on :5173 (proxy to :8080)
docker network create mcsm 2>/dev/null || true
ENROLL_TOKEN=... DATA_ROOT=$PWD/deploy/data docker compose -f deploy/docker-compose.dev.yml up --build
```
Tests:
- Agent: `cd agent && go test ./...`
- Panel: `pnpm test` (from the root)
- Integration with real Docker: `cd agent && go test -tags integration ./...`

### UI tests (E2E)

`pnpm e2e` (= `bash deploy/e2e/run.sh`) builds the deployment compose as project `mcsm-test-e2e` (panel on port 18080, servers on 26600–26620), adds a second node in `docker:dind` and runs Playwright in a container. Screenshots end up in `panel/apps/e2e/screenshots/` and logs in `deploy/data/e2e/logs/`. `bash deploy/e2e/run.sh up|test|down` runs each phase separately and `E2E_KEEP=1` leaves everything up when it finishes. It only touches `mcsm-test-e2e*` resources.

Protocol: edit `proto/`, then `pnpm gen` and commit the generated code.

### CI and versions

GitHub Actions runs on every push to `main` and every PR `buf lint`, `buf breaking` (against the PR's target branch), a check that the generated code is up to date, the agent's `go vet` and `go test -race`, and the panel's typecheck, tests and build (`.github/workflows/ci.yml`). Integration with real Docker and the E2E only run locally.

To publish a version:

1. Bump `agent/VERSION` (e.g. `0.10.0`), commit and push.
2. Create the Release with the tag `v` + that version: `gh release create v0.10.0 --generate-notes` (or from the web). If it is a prerelease (`--prerelease` or a suffix like `-rc.1`), it doesn't move `latest` or `X.Y`.
3. `.github/workflows/release.yml` checks that the tag matches `agent/VERSION`, repeats the CI checks, builds both images for `linux/amd64` and `linux/arm64` on native runners and publishes them to `ghcr.io/javilobo8/` with provenance attestation and SBOM. The panel image has the agent image of its own version pinned (the `docker run` from **Add node**).

The `mcsm-panel` and `mcsm-agent` packages are linked to the repository and, since it is public, they are too (they download without `docker login`). In a private fork they would be private: change it in GitHub → **Packages** → each package → **Package settings** → **Change visibility**.

## Security

Designed for a home LAN and a single administrator. The agent mounts the Docker socket: whoever controls the panel gets effective root on every node's host (Docker is equivalent to root). Don't expose it to the Internet.

- **Initial setup token.** Creating the password requires the token the panel writes to its log (or `PANEL_SETUP_TOKEN`), so nobody who reaches the panel before you, nor a website on the Internet via DNS rebinding, can set it.
- **No TLS.** Traffic between browser, panel and agents is in the clear, and the agent doesn't authenticate the panel: a LAN machine that impersonates the panel (e.g. with ARP spoofing) can capture the password, the cookie and the node tokens, and give orders to the agents (delete worlds, launch servers with its own code). Use a trusted network.
- **Migrating runs the source's world on the target.** Plugins, mods and jars included, inside the hardened container. A compromised source node can thus make the target run its code. The sha256 protects the copy in transit, not against a malicious source: migrate only from trusted nodes. The copy travels unencrypted over the LAN, `server.properties` (with the RCON password) included.
- **The router (mc-router) no longer receives the Docker socket,** but the agent's filtered socket (`<DATA_ROOT>/.mcsm-router/docker.sock`, only for its user; the router mounts, read-only, the directory `<DATA_ROOT>/.mcsm-router/`). The proxy only allows listing, inspecting without environment variables, following events and starting/stopping servers with a router hostname that are not reserved or held; it rejects requests with a body and Docker APIs < 1.24. The full socket path must fit in 100 bytes and `DATA_ROOT`'s filesystem must support unix sockets (not CIFS/SMB). The router is also hardened (no capabilities, `no-new-privileges`, read-only root, memory and process limits, image pinned by digest, log rotation). When the agent is updated the router is recreated once; agent restarts don't restart it. If the agent can't create the socket, it retries on its own (from 1 s to 30 s) and the error shows in the router's status. Its port is the one usually opened to the Internet to play with friends: limit who wakes servers with the autoscale player list.
- Servers run without extra privileges: no capabilities except those the image needs to start (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), with `no-new-privileges`, a process limit and a memory limit (by default, JVM memory + 1G). itzg features that need more capabilities (autopause/autostop with knockd) are not supported.
- **Headers and attempt limit.** The web is served with a restrictive CSP and `frame-ancestors 'none'`. Failed logins have a global limit (30 per minute): if someone on the LAN brute-forces passwords, it also locks the administrator out for a minute; restarting the panel clears it.
- **Secrets in the console.** The console hides the RCON password and the CurseForge API key.

## License

[MIT](LICENSE).
