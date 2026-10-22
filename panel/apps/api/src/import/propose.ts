import type { ImportCandidate } from "@mcsm/proto";
import {
  BUILD_RE, CURSEFORGE_API_KEY_RE, DIGITS_RE, ENTRY_RE, ENV_KEY_RE, IMAGE_TAG_RE, MAX_STRING_BYTES, MEMORY_RE, PLAYER_RE, PROPERTY_KEY_RE,
  RESERVED_ENV, RESERVED_PROPS, URL_RE, dataPathError, buildEnvFor, formatZodError, isFloatingVersion, memoryToBytes, pathWithin, slugify, specInputSchema, utf8Bytes,
  type ImportCandidateDto, type SpecInput,
} from "@mcsm/shared";

/**
 * Agent candidate → proposed spec (spec §6.7). Pure: used by the listing and the adoption (which
 * scans again and recomputes, so as not to trust the browser). Rules table: “Container →
 * candidate spec mapping” of Plan 6. The secrets (RCON_PASSWORD, CF_API_KEY) only come out in rconPassword and
 * curseforgeApiKey, which never go to the browser (toCandidateDto), and no warning repeats values.
 */
export interface ProposeContext {
  /** The agent's DATA_ROOT (ImportScanResult.dataRoot). */
  dataRoot: string;
  /** Slugs already used on the node. */
  takenSlugs: ReadonlySet<string>;
  /** There is a CurseForge API key in Settings. */
  curseforgeConfigured: boolean;
}

export interface ImportProposal {
  name: string;
  slug: string;
  slugLocked: boolean;
  desiredState: "running" | "stopped";
  spec: SpecInput;
  specError: string | null;
  dataPath: string | null;
  rconPassword: string | null;
  curseforgeApiKey: string | null;
  blockers: string[];
  warnings: string[];
  hiddenEnv: string[];
}

const GAME_PORT = 25565;
const RCON_PORT = 25575;
const PLUGIN_TYPES = new Set(["PAPER", "PURPUR", "SPIGOT", "FOLIA", "BUKKIT", "PUFFERFISH", "LEAF"]);
const PLATFORMS = new Set(["MODRINTH", "AUTO_CURSEFORGE", "FTBA"]);
const RESTART = new Set(["no", "always", "unless-stopped", "on-failure"]);
const SECRET_ENV = ["RCON_PASSWORD", "CF_API_KEY"] as const;
/** itzg variables that read a secret from a mounted file (Docker secrets): the mount is not kept. */
const SECRET_FILE_ENV = ["RCON_PASSWORD_FILE", "CF_API_KEY_FILE"] as const;
/** Folders the system empties (tmpfs on reboot, systemd-tmpfiles). */
const TEMP_DIRS = ["/tmp", "/var/tmp"] as const;
export const COMPOSE_PROJECT = "com.docker.compose.project";
export const COMPOSE_SERVICE = "com.docker.compose.service";
const SLUG_DATA_RE = /^\/([a-z0-9][a-z0-9-]{0,39})\/data$/;

/** "" (default), 0.0.0.0 and :: publish on all interfaces. */
const anyIp = (ip: string) => ip === "" || ip === "0.0.0.0" || ip === "::";
const truthy = (v: string | undefined) => v !== undefined && /^(true|1|yes|on)$/i.test(v.trim());
const falsy = (v: string | undefined) => v !== undefined && /^(false|0|no|off)$/i.test(v.trim());
/** itzg list: separated by commas or line breaks. */
const splitList = (v: string) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function imageTag(ref: string, warn: (m: string) => void): string {
  const rest = ref.replace(/^docker\.io\//, "").slice("itzg/minecraft-server".length);
  if (rest.startsWith("@")) {
    warn("The image is pinned by digest: on recreation the latest tag will be used (check the Java version in “Version and mods”)");
    return "latest";
  }
  if (rest.startsWith(":")) {
    const tag = rest.slice(1).split("@")[0] ?? "";
    if (IMAGE_TAG_RE.test(tag)) return tag;
    warn(`The image tag “${tag}” is not valid for the panel: on recreation latest will be used`);
  }
  return "latest";
}

function memLimitText(bytes: bigint): string {
  const MiB = 1024n * 1024n;
  const GiB = 1024n * MiB;
  return bytes % GiB === 0n ? `${bytes / GiB}G` : `${(bytes + MiB - 1n) / MiB}M`;
}

export function proposeImport(c: ImportCandidate, ctx: ProposeContext): ImportProposal {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const env: Record<string, string> = { ...c.env };
  const take = (k: string): string | undefined => { const v = env[k]; delete env[k]; return v; };
  const hiddenEnv = SECRET_ENV.filter((k) => k in env);
  const root = ctx.dataRoot.replace(/\/+$/, "") || "/";

  // Red.
  const mode = c.networkMode;
  if (mode === "host" || mode === "none" || mode.startsWith("container:")) {
    blockers.push(`It uses the “${mode}” network: only containers with their own network (bridge or a user network) are imported`);
  }

  // /data.
  let slugLocked = false;
  let lockedSlug = "";
  let dataPath: string | null = null;
  const data = c.mounts.find((m) => m.destination === "/data");
  if (!data) blockers.push("It does not mount /data: the world lives inside the container and would be lost on recreation. Mount a host folder at /data and search again");
  else if (data.type !== "bind") blockers.push(`Its /data is a Docker volume (“${data.name || data.source}”): only host folders mounted at /data are imported`);
  else if (!data.readWrite) blockers.push("Its /data is read-only");
  else {
    const src = data.source;
    const m = pathWithin(src, root) ? SLUG_DATA_RE.exec(src.slice(root === "/" ? 0 : root.length)) : null;
    if (m) {
      slugLocked = true;
      lockedSlug = m[1]!;
    } else if (pathWithin(src, root) || pathWithin(root, src)) {
      blockers.push(`The data is in ${src}, which ${pathWithin(src, root) ? "is inside" : "contains"} DATA_ROOT (${root}) without being ${root}/<slug>/data: move it to ${root}/<slug>/data or outside DATA_ROOT and search again`);
    } else {
      const err = dataPathError(src);
      if (err) blockers.push(`${src} cannot be used as the data folder: ${err}`);
      else {
        dataPath = src;
        warn(`The data is outside DATA_ROOT (${src}): this server will have no backups or file browser. To get them, stop the container and move the folder to ${root}/<slug>/data before importing`);
        if (TEMP_DIRS.some((d) => pathWithin(src, d))) {
          warn(`${src} is a temporary folder: the system may empty it (tmpfs on reboot, systemd-tmpfiles) and the world would be lost. Move it to a stable folder before importing`);
        }
      }
    }
  }
  for (const m of c.mounts) {
    const dest = m.destination.replace(/\/+$/, "");
    if (dest === "/data") continue;
    // On recreation only /data is mounted: whatever is mounted below would be the (empty) folder of the mount point,
    // and the world in /data/world would be a different one. Same as verifyAdoptable in the agent.
    if (dest.startsWith("/data/")) {
      blockers.push(`Mount ${m.source || m.name} at ${dest}, inside /data: on recreation only /data is kept and that folder would be left empty. Move its contents to the folder mounted at /data (${data?.source ?? "/data"}${dest.slice("/data".length)}), remove that mount and search again`);
      continue;
    }
    warn(`The mount ${m.source || m.name} → ${m.destination} is not kept when the container is recreated`);
  }

  // Ports.
  let game: number | undefined;
  const extra: { host: number; container: number; proto: "tcp" | "udp"; label: string }[] = [];
  const seen = new Set<string>();
  const rconHosts = new Set<number>(); // host ports that publish 25575/tcp on all interfaces (IPv4 and IPv6 entries count once)
  const rconLoopback = new Map<number, string>(); // fixed host ports that publish 25575/tcp only on a specific address
  for (const p of c.ports) {
    if (p.containerPort === GAME_PORT && p.proto === "tcp") {
      if (p.hostPort === 0) continue;
      game ??= p.hostPort;
      if (!anyIp(p.hostIp)) warn(`Port ${p.hostPort} only listens on ${p.hostIp}: on recreation it will be published on all interfaces`);
      continue;
    }
    if (p.containerPort === RCON_PORT) {
      // Only 25575/tcp on a fixed host port can be kept (ports.rcon); anything else is dropped.
      if (p.proto === "tcp" && p.hostPort !== 0) {
        if (anyIp(p.hostIp)) rconHosts.add(p.hostPort);
        else rconLoopback.set(p.hostPort, p.hostIp);
      } else warn(p.proto === "tcp"
        ? "It publishes RCON (25575/tcp) on a random host port: it is not kept on recreation (publish it on a fixed host port to keep it)"
        : `It publishes 25575/${p.proto} on the host: it is not kept on recreation (only RCON over TCP is published by the panel)`);
      continue;
    }
    if (p.hostPort === 0 || (p.proto !== "tcp" && p.proto !== "udp")) continue;
    const key = `${p.hostPort}/${p.containerPort}/${p.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({ host: p.hostPort, container: p.containerPort, proto: p.proto as "tcp" | "udp", label: "" });
  }
  // The panel does not allow two publications with the same host port even if the protocol differs
  // (ServersService.checkPorts compares numbers): the first is kept and the others are warned about.
  const hostPorts = new Set<number>(game !== undefined ? [game] : []);
  const extraPorts = extra.filter((e) => {
    if (!hostPorts.has(e.host)) {
      hostPorts.add(e.host);
      return true;
    }
    warn(`The publication ${e.host}:${e.container}/${e.proto} repeats host port ${e.host}: the panel only allows one publication per port and this one will not be kept on recreation`);
    return false;
  });
  for (const [h, ip] of rconLoopback) {
    if (!rconHosts.has(h)) warn(`It publishes RCON only on ${ip}: it will not be published; turn on Publish RCON in the review if you want it`);
  }
  // RCON: the first (lowest) host port is kept as ports.rcon; the rest and a clash with another publication are warned about.
  let rconHost: number | undefined;
  for (const h of [...rconHosts].sort((a, b) => a - b)) {
    if (rconHost !== undefined) warn(`The RCON publication ${h}:25575 is not kept on recreation: the panel publishes one RCON port per server (${rconHost})`);
    else if (hostPorts.has(h)) warn(`The RCON publication ${h}:25575 repeats host port ${h}: the panel only allows one publication per port and this one is not kept on recreation`);
    else rconHost = h;
  }
  if (game === undefined) blockers.push("It does not publish port 25565/tcp on a fixed host port (ports: \"<port>:25565\"): that is how the panel manages the game port");
  const serverPort = take("SERVER_PORT");
  if (serverPort !== undefined && serverPort.trim() !== String(GAME_PORT)) {
    blockers.push(`The server listens on SERVER_PORT=${serverPort} inside the container; the panel only manages 25565`);
  }

  // RCON and secrets.
  take("EULA");
  for (const k of SECRET_FILE_ENV) {
    if (take(k) === undefined) continue;
    warn(k === "RCON_PASSWORD_FILE"
      ? "RCON_PASSWORD_FILE reads the RCON password from a mounted file that is not kept on recreation: it is discarded (the RCON password is managed by the panel)"
      : "CF_API_KEY_FILE reads the CurseForge API key from a mounted file that is not kept on recreation: it is discarded; configure it in Settings");
  }
  const rconEnv = take("RCON_PASSWORD");
  const rconOk = rconEnv !== undefined && rconEnv.length >= 8 && utf8Bytes(rconEnv) <= MAX_STRING_BYTES;
  const rconOff = falsy(take("ENABLE_RCON"));
  const rconPort = take("RCON_PORT");
  const rconPortOk = rconPort === undefined || rconPort.trim() === String(RCON_PORT);
  if (!rconOk || rconOff || !rconPortOk) {
    const why = rconOff ? "the container has RCON disabled" : !rconPortOk ? `it uses RCON_PORT=${rconPort}` : "it does not set RCON_PASSWORD (or it has fewer than 8 characters)";
    warn(`The command console (RCON) will not work until the first “Review and apply”: ${why}. On recreation the panel enables RCON with ${rconOk ? "the same password" : "a new password"}`);
  }
  if (rconHost !== undefined) {
    if (rconOff) {
      warn("It publishes RCON but the container has RCON disabled: it will not be published; turn on Publish RCON in the review if you want it");
      rconHost = undefined;
    } else if (!rconPortOk) {
      warn(`It publishes RCON but uses RCON_PORT=${rconPort}: it will not be published; turn on Publish RCON in the review if you want it`);
      rconHost = undefined;
    } else if (!rconOk) {
      warn("It publishes RCON but does not set a usable RCON_PASSWORD: it will not be published; turn on Publish RCON in the review if you want it (the panel generates a password)");
      rconHost = undefined;
    } else {
      warn("RCON is published with the container's own password: it is kept as is and may be weak; change it before exposing the port on the LAN");
    }
  }
  const cfKey = take("CF_API_KEY");
  let curseforgeApiKey: string | null = null;
  if (cfKey !== undefined) {
    if (ctx.curseforgeConfigured) warn("The container brings its own CF_API_KEY: on recreation the CurseForge API key from Settings will be used");
    else if (CURSEFORGE_API_KEY_RE.test(cfKey)) {
      curseforgeApiKey = cfKey;
      warn("The container's CF_API_KEY will be saved in Settings on import if the server uses CurseForge (none is configured)");
    } else warn("The container's CF_API_KEY is not valid and is discarded");
  }

  // Type, version and memory.
  let type = (take("TYPE") ?? "").trim().toUpperCase();
  const platform = env.MODPACK_PLATFORM?.trim().toUpperCase();
  if (platform && PLATFORMS.has(platform) && (type === "" || type === "VANILLA")) {
    type = platform;
    delete env.MODPACK_PLATFORM;
  }
  if (!type) type = "VANILLA";
  const version = (take("VERSION") ?? "").trim() || "LATEST";
  const memRaw = take("MEMORY")?.trim();
  let memory = "1G";
  if (memRaw) {
    if (MEMORY_RE.test(memRaw)) memory = memRaw;
    else warn(`MEMORY=${memRaw} does not have the panel's format (4G, 512M): 1G is proposed; check it in “Resources”`);
  }

  // plan-10: the type's build variable moves to the build field only if valid as is (same environment,
  // same hash); with LATEST/SNAPSHOT or a value that does not satisfy BUILD_RE it stays in env.
  let build = "";
  const buildKey = buildEnvFor(type);
  const buildRaw = buildKey === undefined ? undefined : env[buildKey];
  if (buildKey !== undefined && buildRaw !== undefined && BUILD_RE.test(buildRaw) && !isFloatingVersion(version)) {
    build = buildRaw;
    delete env[buildKey];
  }

  // Modpack.
  let modpack: SpecInput["modpack"];
  if (type === "MODRINTH" && env.MODRINTH_MODPACK !== undefined) {
    modpack = {
      platform: "MODRINTH", slugOrUrl: take("MODRINTH_MODPACK")!.trim(), versionId: take("MODRINTH_VERSION")?.trim() ?? "",
      loader: (take("MODRINTH_LOADER")?.trim().toLowerCase() ?? "") as NonNullable<SpecInput["modpack"]>["loader"],
    };
  } else if (type === "AUTO_CURSEFORGE" && (env.CF_SLUG !== undefined || env.CF_PAGE_URL !== undefined)) {
    const slug = take("CF_SLUG");
    const page = slug === undefined ? take("CF_PAGE_URL") : undefined;
    modpack = { platform: "AUTO_CURSEFORGE", slugOrUrl: (slug ?? page ?? "").trim(), versionId: take("CF_FILE_ID")?.trim() ?? "", loader: "" };
  } else if (type === "FTBA" && env.FTB_MODPACK_ID !== undefined) {
    modpack = { platform: "FTBA", slugOrUrl: take("FTB_MODPACK_ID")!.trim(), versionId: take("FTB_MODPACK_VERSION_ID")?.trim() ?? "", loader: "" };
  }

  // Mods and plugins: only if all entries are valid (otherwise the variable stays in env as is).
  const moveList = (key: string, re: RegExp): string[] | undefined => {
    const v = env[key];
    if (v === undefined) return undefined;
    const items = splitList(v);
    if (!items.every((i) => re.test(i))) return undefined;
    delete env[key];
    return items;
  };
  const pluginsKind = PLUGIN_TYPES.has(type);
  const modrinth = moveList("MODRINTH_PROJECTS", ENTRY_RE);
  const cfFiles = moveList("CURSEFORGE_FILES", ENTRY_RE);
  const modUrls = moveList("MODS", URL_RE);
  const pluginUrls = moveList("PLUGINS", URL_RE);
  const spiget = moveList("SPIGET_RESOURCES", DIGITS_RE);
  let mods: SpecInput["mods"];
  let plugins: SpecInput["plugins"];
  if ((modrinth && !pluginsKind) || cfFiles || modUrls) {
    mods = { modrinthProjects: !pluginsKind ? (modrinth ?? []) : [], curseforgeFiles: cfFiles ?? [], urls: modUrls ?? [] };
  }
  if ((modrinth && pluginsKind) || pluginUrls || spiget) {
    plugins = { modrinthProjects: pluginsKind ? (modrinth ?? []) : [], spigetResources: spiget ?? [], urls: pluginUrls ?? [] };
  }

  // Properties.
  const properties: Record<string, string> = {};
  const custom = take("CUSTOM_SERVER_PROPERTIES");
  if (custom !== undefined) {
    const dropped: string[] = [];
    for (const raw of custom.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      const k = i > 0 ? line.slice(0, i).trim() : "";
      if (!k || !PROPERTY_KEY_RE.test(k) || RESERVED_PROPS.has(k)) {
        dropped.push(k && PROPERTY_KEY_RE.test(k) ? k : "(line without a valid key=value)"); // never the value: it may be rcon.password
        continue;
      }
      properties[k] = line.slice(i + 1).trim();
    }
    if (dropped.length) warn(`From CUSTOM_SERVER_PROPERTIES these are discarded: ${dropped.join(", ")}`);
  }

  // Players: sections only if the container already syncs the file (otherwise they would delete what was added from the game).
  let whitelist: SpecInput["whitelist"];
  let ops: string[] | undefined;
  if (env.EXISTING_WHITELIST_FILE?.trim().toUpperCase() === "SYNCHRONIZE" && env.WHITELIST_FILE === undefined
    && (env.WHITELIST !== undefined || env.ENABLE_WHITELIST !== undefined)
    && !("white-list" in properties) && !("enforce-whitelist" in properties)) {
    const players = env.WHITELIST !== undefined ? splitList(env.WHITELIST) : [];
    const en = env.ENABLE_WHITELIST;
    const enabled = truthy(en) || (en === undefined && players.length > 0);
    const coherent = en === undefined || truthy(en) || (falsy(en) && players.length === 0);
    if (coherent && players.every((p) => PLAYER_RE.test(p))) {
      whitelist = { enabled, players };
      delete env.WHITELIST;
      delete env.ENABLE_WHITELIST;
      delete env.EXISTING_WHITELIST_FILE;
    }
  }
  if (env.EXISTING_OPS_FILE?.trim().toUpperCase() === "SYNCHRONIZE" && env.OPS_FILE === undefined && env.OPS !== undefined) {
    const list = splitList(env.OPS);
    if (list.every((p) => PLAYER_RE.test(p))) {
      ops = list;
      delete env.OPS;
      delete env.EXISTING_OPS_FILE;
    }
  }
  if (env.WHITELIST !== undefined || env.OPS !== undefined) {
    warn("The whitelist and operators stay in environment variables (Advanced) because the container does not sync those files: this way what was added from the game is not lost");
  }

  // User (--user): on recreation, itzg starts as root and changes the owner of /data to UID:GID
  // (1000:1000 by default). With the container's, the host files keep their owner (m7).
  const user = c.user.trim();
  if (user && user !== "root") {
    const ids = /^(\d+)(?::(\d+))?$/.exec(user);
    if (!ids) {
      warn(`The container runs with the user “${user}” (by name): on recreation it will run with itzg's (1000:1000) and will change the owner of the /data files. Set UID and GID in “Advanced” with that user's numbers`);
    } else if (ids[1] !== "0") {
      const [, uid, gid] = ids as unknown as [string, string, string | undefined];
      env.UID = uid;
      if (gid !== undefined) env.GID = gid;
      warn(`The container runs with --user ${user}: UID=${uid}${gid !== undefined ? ` and GID=${gid}` : ""} is proposed so that, on recreation, itzg does not change the owner of the /data files${gid === undefined ? ". With no group in --user, check GID in “Advanced”" : ""}`);
    }
  }

  // Rest of the env.
  const passEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k) || RESERVED_ENV.has(k)) {
      warn(`The variable ${k} cannot be kept and is discarded`);
      continue;
    }
    passEnv[k] = v;
  }

  // Restart and resources.
  let restartPolicy = c.restartPolicy || "no";
  if (!RESTART.has(restartPolicy)) {
    warn(`Unknown restart policy “${restartPolicy}”: unless-stopped is proposed`);
    restartPolicy = "unless-stopped";
  }
  const cpus = Math.round(Number(c.nanoCpus) / 1e7) / 100;
  let memLimit = "";
  if (c.memoryLimitBytes > 0n) {
    memLimit = memLimitText(c.memoryLimitBytes);
    if (memoryToBytes(memLimit) < memoryToBytes(memory)) {
      warn(`Docker's memory limit (${memLimit}) is lower than MEMORY (${memory}): it is removed (the agent sets memory + 1G)`);
      memLimit = "";
    }
  } else {
    warn("Docker does not limit its memory: on recreation it will be limited to MEMORY + 1G");
  }

  // Name, slug and state.
  const project = c.labels[COMPOSE_PROJECT] ?? "";
  const service = c.labels[COMPOSE_SERVICE] ?? "";
  if (project) {
    warn(`It was created by Docker Compose (project “${project}”, service “${service}”): before the first “Review and apply”, remove that service from the compose file (or do not run “docker compose up” again), or Compose will recreate the original container next to the panel's`);
  }
  const name = (c.name || service || "Imported server").slice(0, 60);
  let slug: string;
  if (slugLocked) {
    slug = lockedSlug;
    if (ctx.takenSlugs.has(slug)) blockers.push(`There is already a server “${slug}” on this node and this container's data is in ${root}/${slug}/data`);
  } else {
    slug = uniqueSlug(slugify(c.name || service), ctx.takenSlugs);
  }
  // Paused counts as running: “Adopt without stopping” does not stop it, and the agent neither starts nor resumes
  // a paused container (that is done by whoever paused it, with docker unpause).
  const desiredState = c.state === "running" || c.state === "restarting" || c.state === "paused" ? "running" : "stopped";
  if (c.state === "paused") warn("The container is paused: it is imported as “running” and stays paused until you resume it (docker unpause); the panel does not resume it");

  const raw = {
    imageTag: imageTag(c.image, warn), type, version, build, memory, properties, env: passEnv,
    resources: { cpus, memLimit }, restartPolicy, ports: { ...(game !== undefined ? { game } : {}), extra: extraPorts, ...(rconHost !== undefined ? { rcon: rconHost } : {}) },
    ...(modpack ? { modpack } : {}), ...(mods ? { mods } : {}), ...(plugins ? { plugins } : {}),
    ...(whitelist ? { whitelist } : {}), ...(ops ? { ops } : {}),
  };
  const parsed = specInputSchema.safeParse(raw);
  return {
    name, slug, slugLocked, desiredState,
    spec: parsed.success ? parsed.data : (raw as unknown as SpecInput),
    specError: parsed.success ? null : formatZodError(parsed.error),
    dataPath, rconPassword: rconOk ? rconEnv! : null, curseforgeApiKey, blockers, warnings, hiddenEnv,
  };
}

/** DTO for the browser: without rconPassword or curseforgeApiKey. */
export function toCandidateDto(c: ImportCandidate, p: ImportProposal): ImportCandidateDto {
  return {
    containerId: c.containerId, containerName: c.name, image: c.image, state: c.state,
    composeProject: c.labels[COMPOSE_PROJECT] ?? "", composeService: c.labels[COMPOSE_SERVICE] ?? "",
    blockers: p.blockers, warnings: p.warnings, hiddenEnv: p.hiddenEnv,
    proposal: { name: p.name, slug: p.slug, slugLocked: p.slugLocked, desiredState: p.desiredState, spec: p.spec, specError: p.specError, dataPath: p.dataPath },
  };
}
