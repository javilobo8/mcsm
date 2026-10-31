# itzg content spike (plan 11, Task 1)

Date: 2026-10-30. Image: `itzg/minecraft-server@sha256:f6d0b91029e73afd765ae8b0689cdac754067f3e36cb2d60608366f82d650008`
(tag `java21`, pulled fresh that day; mc-image-helper 1.75.0). All runs real Docker, `SETUP_ONLY=true`,
containers `mcsm-test-spike-*` with label `mcsm.test=true`, data under `deploy/data/spike/` (removed afterwards;
`docker ps -a` / `network ls` / `volume ls` identical before and after).

Helper used for every case:

```bash
run() { local d="$PWD/deploy/data/spike/$1"; shift; mkdir -p "$d"
  docker run --rm --name "mcsm-test-spike-$(basename "$d")" --label mcsm.test=true \
    -e EULA=TRUE -e SETUP_ONLY=true "$@" -v "$d:/data" itzg/minecraft-server:java21; }
```

## Results

| # | Answer | Consequence for the plan |
|---|---|---|
| F1 | **Expected: yes.** `CURSEFORGE_FILES` on `TYPE=PAPER` installs a Bukkit plugin into `/data/plugins`, as slug and as `projectId:fileId`, and records it in `/data/.curseforge-files-manifest.json`. Caveat: a slug whose latest file does not match the server version fails (`worldedit` on 1.21.1: "Unable to find match in latest files"), as does an unknown slug (`luckperms`: UnknownModException); the build fails with exit 2. | Add `plugins.curseforgeFiles` and the CurseForge Plugins tab as planned. Use the pinned `projectId:fileId` form wherever possible. |
| F2 | **Expected: yes (files stay).** `TYPE=MODRINTH` pack then `TYPE=FABRIC`: 11 mods, config and `.modrinth-modpack-manifest.json` all remain; only the old launcher jar was removed. | Agent cleans on uninstall (Task 4). |
| F3 | **Expected: yes (files stay).** `AUTO_CURSEFORGE` pack then `TYPE=FABRIC` with no CF variables: all 242 files of the pack and the manifest remain (tested with a Fabric pack; mechanism is loader independent). Cross-platform (Modrinth pack then `AUTO_CURSEFORGE` pack): the Modrinth pack's 15 manifest files (and its manifest) all remain, next to the 242 CF files. | Agent cleans on uninstall and on platform switch. |
| F4 | **Expected: yes (itzg cleans).** Modrinth pack A then pack B on the same `TYPE=MODRINTH`: itzg logs `Removing old file ...` for every file of A's manifest; none of A's mods or configs is left. | `sameSlugSwitchCleans["MODRINTH"] = false`. |
| F5 | **Expected: yes (itzg cleans).** CurseForge pack A then pack B on `AUTO_CURSEFORGE`: 66 `Removing old file` lines (A's 65 manifest files plus the old launcher); none of A's files left. | `sameSlugSwitchCleans["AUTO_CURSEFORGE"] = false`. |
| F6 | **Expected: yes.** All manifests are JSON with `files: string[]` relative to `/data`; CF pack manifest has `levelName` (null here). Names confirmed below. | Constants in Task 4 as written. |
| F7 | **Expected: yes.** `MODRINTH_PROJECTS=datapack:terralith:urbokcOc` on `TYPE=PAPER` with `LEVEL=myworld` wrote `/data/myworld/datapacks/Terralith_1.21_v2.5.8.zip`; `server.properties` got `level-name=myworld`. | Agent emits `LEVEL=<level-name>` as planned; version pinning for datapacks works. |
| F8 | **Expected: yes.** On a Paper server with a `CURSEFORGE_FILES` plugin, a run with the variable unset (and also with `CURSEFORGE_FILES=`) logs `Removing old file plugins/worldguard-bukkit-7.0.12-dist.jar`; `plugins/` is left empty and `.curseforge-files-manifest.json` is deleted. | Nothing to do (today's behaviour is correct). |

## Evidence per case

### Case 1: CurseForge plugins (F1, F8)

```
run cfplugin -e TYPE=PAPER -e VERSION=1.21.1 -e CURSEFORGE_FILES=worldedit
ERROR : Invalid parameter provided for 'curseforge-files' command: Unable to find match in latest files for worldedit   (exit 2)
run cfp-worldguard -e TYPE=PAPER -e VERSION=1.21.1 -e CURSEFORGE_FILES=worldguard
WARN  : The mod file 'WorldGuard 7.0.12 (MC 1.21 - 1.21.1)' depends on mod project 'WorldEdit for Bukkit' ... but it is not listed
INFO  : Downloaded mod file plugins/worldguard-bukkit-7.0.12-dist.jar
plugins/: worldguard-bukkit-7.0.12-dist.jar (1163769 bytes)
.curseforge-files-manifest.json:
{"@type":"me.itzg.helpers.curseforge.CurseForgeFilesManifest","timestamp":"...","files":["plugins/worldguard-bukkit-7.0.12-dist.jar"],
 "entries":[{"ids":{"modId":31054,"fileId":5719698},"filePath":"plugins/worldguard-bukkit-7.0.12-dist.jar"}]}
```

Same with `CURSEFORGE_FILES=31054:5719698` in a fresh folder: identical jar and manifest. Other slugs tried:
`essentialsx`, `vault`, `chunky` ("Unable to find match"), `luckperms` (unknown mod). WorldGuard project 31054,
file 5719698 (7.0.12, MC 1.21-1.21.1) is a realistic fixture; the plan's `31043` is WorldEdit's project id (its slug has no file for 1.21.1).

F8, same folders, second run:

```
run cfp-worldguard -e TYPE=PAPER -e VERSION=1.21.1                       (variable unset)
INFO  : Removing old file plugins/worldguard-bukkit-7.0.12-dist.jar     -> plugins/ empty, manifest gone
run cfplugin-id   -e TYPE=PAPER -e VERSION=1.21.1 -e CURSEFORGE_FILES=   (variable empty)
INFO  : Removing old file plugins/worldguard-bukkit-7.0.12-dist.jar     -> plugins/ empty, manifest gone
```

### Case 2: Modrinth pack then loader only (F2, F6)

```
run mrpack -e TYPE=MODRINTH -e VERSION=1.21.1 -e MODRINTH_MODPACK=adrenaserver
ls -a: config eula.txt .fabric-manifest.json fabric-server-mc.1.21.1-loader.0.16.2-launcher.1.1.2.jar .install-modrinth.env
       .modrinth-modpack-manifest.json mods .rcon-cli.env .rcon-cli.yaml server.properties
mods/ (11): c2me-fabric, fabric-api-0.102.1, ferritecore, krypton, lithium, modernfix, noisium, servercore, threadtweak, vmp, yosbr
.modrinth-modpack-manifest.json:
{"@type":"me.itzg.helpers.modrinth.ModrinthModpackManifest","timestamp":"...",
 "files":["mods/krypton-0.2.8.jar", ..., "config/yosbr/config/vmp.properties", ...],   (15 entries)
 "projectSlug":"adrenaserver","versionId":"7U9BhPKK","dependencies":{"fabric-loader":"0.16.2","minecraft":"1.21.1"}}
run mrpack -e TYPE=FABRIC -e VERSION=1.21.1
INFO  : Removing old file fabric-server-mc.1.21.1-loader.0.16.2-launcher.1.1.2.jar   (only this)
after: mods/ still 11 jars, config/ intact, .modrinth-modpack-manifest.json still there
```

### Case 3: Modrinth pack A to pack B (F4)

```
run mrswitch -e TYPE=MODRINTH -e VERSION=1.21.1 -e MODRINTH_MODPACK=adrenaserver
run mrswitch -e TYPE=MODRINTH -e MODRINTH_MODPACK=fabulously-optimized      (MC 26.2, 91 manifest files, versionId uQxD0ENB)
INFO  : Removing old file mods/c2me-fabric-... (one line per A file: 11 mods, 4 configs, old launcher)
after: none of A's mods present; mods/ holds only B's jars
```

### Case 4: CurseForge pack A to pack B to loader only (F3, F5, F6)

Pack A `fabulously-optimized` (project 396246, file 9270300, MC 26.3, Fabric, 14 mods + configs/resourcepacks = 65 files);
pack B `vanilla-optimized-fabric` (project 832109, file 4470263, MC 1.19.4, Fabric 0.14.18, 242 files).

```
.curseforge-manifest.json (A) keys: @type timestamp files modpackName modpackVersion slug modId fileId fileName minecraftVersion modLoaderId levelName
 {"@type":"me.itzg.helpers.curseforge.CurseForgeManifest", "files":["mods/cloth-config-fabric-26.3.159.jar", ...],
  "modpackName":"Fabulously Optimized","modpackVersion":"15.0.0-beta.2","slug":"fabulously-optimized","modId":396246,
  "fileId":9270300,"fileName":"15.0.0-beta.2 for 26.3","minecraftVersion":"26.3","modLoaderId":"fabric-0.19.5","levelName":null}
run cfpack -e TYPE=AUTO_CURSEFORGE -e CF_SLUG=vanilla-optimized-fabric
INFO  : Removing old file ... (66 lines: A's 65 files + old launcher); A files present afterwards: 0 / 65
run cfpack -e TYPE=FABRIC -e VERSION=1.19.4
INFO  : Removing old file fabric-server-mc.1.19.4-loader.0.14.18-launcher.1.1.2.jar   (only this)
B files present afterwards: 242 / 242; .curseforge-manifest.json still there
```

Not tested: a Forge pack to `TYPE=FORGE` (no small Forge pack found quickly; the manifest logic is loader independent).

### Case 5: Modrinth pack then CurseForge pack (F3 cross-platform)

```
run cross -e TYPE=MODRINTH -e VERSION=1.21.1 -e MODRINTH_MODPACK=adrenaserver
run cross -e TYPE=AUTO_CURSEFORGE -e CF_SLUG=vanilla-optimized-fabric
only removal logged: the old fabric launcher jar
.modrinth-modpack-manifest.json present; Modrinth pack files present: 15 / 15; CF files present: 242 / 242
```

### Case 6: Datapacks (F7)

```
run dp -e TYPE=PAPER -e VERSION=1.21.1 -e LEVEL=myworld -e MODRINTH_PROJECTS=datapack:terralith:urbokcOc
INFO  : Downloaded /data/myworld/datapacks/Terralith_1.21_v2.5.8.zip      (3112105 bytes)
.modrinth-manifest.json:
{"@type":"me.itzg.helpers.modrinth.ModrinthManifest","timestamp":"...","files":["myworld/datapacks/Terralith_1.21_v2.5.8.zip"],
 "projects":["datapack:terralith:urbokcOc"]}
server.properties: level-name=myworld
```

## Manifest names (F6) and fixture values

| Manifest | Written by | JSON fields seen |
|---|---|---|
| `.modrinth-modpack-manifest.json` | `MODRINTH_MODPACK` | `@type`, `timestamp`, `files[]`, `projectSlug`, `versionId`, `dependencies{}` |
| `.curseforge-manifest.json` | `AUTO_CURSEFORGE` | `@type`, `timestamp`, `files[]`, `modpackName`, `modpackVersion`, `slug`, `modId`, `fileId`, `fileName`, `minecraftVersion`, `modLoaderId`, `levelName` |
| `.modrinth-manifest.json` | `MODRINTH_PROJECTS` (mods, plugins, datapacks) | `@type`, `timestamp`, `files[]`, `projects[]` |
| `.curseforge-files-manifest.json` | `CURSEFORGE_FILES` | `@type`, `timestamp`, `files[]`, `entries[{ids{modId,fileId},filePath}]` |

Fixture ids: WorldGuard CF project 31054 / file 5719698; Modrinth pack `adrenaserver` (version `7U9BhPKK`) and
`fabulously-optimized` (`uQxD0ENB`); CF packs `fabulously-optimized` (396246:9270300) and `vanilla-optimized-fabric` (832109:4470263);
Terralith `8oi3bsk5` / `urbokcOc`.
