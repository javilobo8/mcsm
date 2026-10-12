import type { ImportCandidate } from "@mcsm/proto";
import {
  CURSEFORGE_API_KEY_RE, DIGITS_RE, ENTRY_RE, ENV_KEY_RE, IMAGE_TAG_RE, MAX_STRING_BYTES, MEMORY_RE, PLAYER_RE, PROPERTY_KEY_RE,
  RESERVED_ENV, RESERVED_PROPS, URL_RE, dataPathError, formatZodError, memoryToBytes, pathWithin, slugify, specInputSchema, utf8Bytes,
  type ImportCandidateDto, type SpecInput,
} from "@mcsm/shared";

/**
 * Candidato del agente → spec propuesta (spec §6.7). Pura: la usan el listado y la adopción (que
 * vuelve a escanear y recalcula, para no fiarse del navegador). Tabla de reglas: «Mapeo contenedor →
 * spec candidata» del Plan 6. Los secretos (RCON_PASSWORD, CF_API_KEY) solo salen en rconPassword y
 * curseforgeApiKey, que nunca van al navegador (toCandidateDto), y ningún aviso repite valores.
 */
export interface ProposeContext {
  /** DATA_ROOT del agente (ImportScanResult.dataRoot). */
  dataRoot: string;
  /** Slugs ya usados en el nodo. */
  takenSlugs: ReadonlySet<string>;
  /** Hay API key de CurseForge en Ajustes. */
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
export const COMPOSE_PROJECT = "com.docker.compose.project";
export const COMPOSE_SERVICE = "com.docker.compose.service";
const SLUG_DATA_RE = /^\/([a-z0-9][a-z0-9-]{0,39})\/data$/;

/** "" (por defecto), 0.0.0.0 y :: publican en todas las interfaces. */
const anyIp = (ip: string) => ip === "" || ip === "0.0.0.0" || ip === "::";
const truthy = (v: string | undefined) => v !== undefined && /^(true|1|yes|on)$/i.test(v.trim());
const falsy = (v: string | undefined) => v !== undefined && /^(false|0|no|off)$/i.test(v.trim());
/** Lista de itzg: separada por comas o saltos de línea. */
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
    warn("La imagen está fijada por digest: al recrearlo se usará la etiqueta latest (revisa la versión de Java en «Versión y mods»)");
    return "latest";
  }
  if (rest.startsWith(":")) {
    const tag = rest.slice(1).split("@")[0] ?? "";
    if (IMAGE_TAG_RE.test(tag)) return tag;
    warn(`La etiqueta de imagen «${tag}» no es válida para el panel: al recrearlo se usará latest`);
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
    blockers.push(`Usa la red «${mode}»: solo se importan contenedores con red propia (bridge o una red de usuario)`);
  }

  // /data.
  let slugLocked = false;
  let lockedSlug = "";
  let dataPath: string | null = null;
  const data = c.mounts.find((m) => m.destination === "/data");
  if (!data) blockers.push("No monta /data: el mundo vive dentro del contenedor y se perdería al recrearlo. Monta una carpeta del host en /data y vuelve a buscar");
  else if (data.type !== "bind") blockers.push(`Su /data es un volumen de Docker («${data.name || data.source}»): solo se importan carpetas del host montadas en /data`);
  else if (!data.readWrite) blockers.push("Su /data es de solo lectura");
  else {
    const src = data.source;
    const m = pathWithin(src, root) ? SLUG_DATA_RE.exec(src.slice(root === "/" ? 0 : root.length)) : null;
    if (m) {
      slugLocked = true;
      lockedSlug = m[1]!;
    } else if (pathWithin(src, root) || pathWithin(root, src)) {
      blockers.push(`Los datos están en ${src}, que ${pathWithin(src, root) ? "está dentro de" : "contiene"} DATA_ROOT (${root}) sin ser ${root}/<slug>/data: muévelos a ${root}/<slug>/data o fuera de DATA_ROOT y vuelve a buscar`);
    } else {
      const err = dataPathError(src);
      if (err) blockers.push(`No se puede usar ${src} como carpeta de datos: ${err}`);
      else {
        dataPath = src;
        warn(`Los datos quedan fuera de DATA_ROOT (${src}): este servidor no tendrá copias de seguridad ni navegador de archivos. Para tenerlos, para el contenedor y mueve la carpeta a ${root}/<slug>/data antes de importar`);
      }
    }
  }
  for (const m of c.mounts) {
    const dest = m.destination.replace(/\/+$/, "");
    if (dest === "/data") continue;
    // Al recrearlo solo se monta /data: lo montado debajo sería la carpeta (vacía) del punto de montaje,
    // y el mundo de /data/world sería otro. Igual que verifyAdoptable en el agente.
    if (dest.startsWith("/data/")) {
      blockers.push(`Monta ${m.source || m.name} en ${dest}, dentro de /data: al recrearlo solo se conserva /data y esa carpeta quedaría vacía. Mueve su contenido a la carpeta montada en /data (${data?.source ?? "/data"}${dest.slice("/data".length)}), quita ese montaje y vuelve a buscar`);
      continue;
    }
    warn(`El montaje ${m.source || m.name} → ${m.destination} no se conserva al recrear el contenedor`);
  }

  // Puertos.
  let game: number | undefined;
  const extra: { host: number; container: number; proto: "tcp" | "udp"; label: string }[] = [];
  const seen = new Set<string>();
  for (const p of c.ports) {
    if (p.containerPort === GAME_PORT && p.proto === "tcp") {
      if (p.hostPort === 0) continue;
      game ??= p.hostPort;
      if (!anyIp(p.hostIp)) warn(`El puerto ${p.hostPort} solo escucha en ${p.hostIp}: al recrearlo se publicará en todas las interfaces`);
      continue;
    }
    if (p.containerPort === RCON_PORT) {
      warn("Publica RCON (25575) en el host: al recrearlo dejará de publicarse (el panel usa RCON por la red interna)");
      continue;
    }
    if (p.hostPort === 0 || (p.proto !== "tcp" && p.proto !== "udp")) continue;
    const key = `${p.hostPort}/${p.containerPort}/${p.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({ host: p.hostPort, container: p.containerPort, proto: p.proto as "tcp" | "udp", label: "" });
  }
  // El panel no admite dos publicaciones con el mismo puerto del host aunque cambie el protocolo
  // (ServersService.checkPorts compara números): se conserva la primera y se avisa de las demás.
  const hostPorts = new Set<number>(game !== undefined ? [game] : []);
  const extraPorts = extra.filter((e) => {
    if (!hostPorts.has(e.host)) {
      hostPorts.add(e.host);
      return true;
    }
    warn(`La publicación ${e.host}:${e.container}/${e.proto} repite el puerto ${e.host} del host: el panel solo admite una publicación por puerto y esta no se conservará al recrear`);
    return false;
  });
  if (game === undefined) blockers.push("No publica el puerto 25565/tcp en un puerto fijo del host (ports: \"<puerto>:25565\"): el panel gestiona así el puerto de juego");
  const serverPort = take("SERVER_PORT");
  if (serverPort !== undefined && serverPort.trim() !== String(GAME_PORT)) {
    blockers.push(`El servidor escucha en SERVER_PORT=${serverPort} dentro del contenedor; el panel solo gestiona 25565`);
  }

  // RCON y secretos.
  take("EULA");
  const rconEnv = take("RCON_PASSWORD");
  const rconOk = rconEnv !== undefined && rconEnv.length >= 8 && utf8Bytes(rconEnv) <= MAX_STRING_BYTES;
  const rconOff = falsy(take("ENABLE_RCON"));
  const rconPort = take("RCON_PORT");
  const rconPortOk = rconPort === undefined || rconPort.trim() === String(RCON_PORT);
  if (!rconOk || rconOff || !rconPortOk) {
    const why = rconOff ? "el contenedor tiene RCON desactivado" : !rconPortOk ? `usa RCON_PORT=${rconPort}` : "no fija RCON_PASSWORD (o tiene menos de 8 caracteres)";
    warn(`La consola de comandos (RCON) no funcionará hasta el primer «Guardar y aplicar»: ${why}. Al recrearlo el panel activa RCON con ${rconOk ? "la misma contraseña" : "una contraseña nueva"}`);
  }
  const cfKey = take("CF_API_KEY");
  let curseforgeApiKey: string | null = null;
  if (cfKey !== undefined) {
    if (ctx.curseforgeConfigured) warn("El contenedor trae su propia CF_API_KEY: al recrearlo se usará la API key de CurseForge de Ajustes");
    else if (CURSEFORGE_API_KEY_RE.test(cfKey)) {
      curseforgeApiKey = cfKey;
      warn("La CF_API_KEY del contenedor se guardará en Ajustes al importarlo si el servidor usa CurseForge (no hay ninguna configurada)");
    } else warn("La CF_API_KEY del contenedor no es válida y se descarta");
  }

  // Tipo, versión y memoria.
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
    else warn(`MEMORY=${memRaw} no tiene el formato del panel (4G, 512M): se propone 1G; revísalo en «Recursos»`);
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

  // Mods y plugins: solo si todas las entradas valen (si no, la variable se queda en env tal cual).
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

  // Propiedades.
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
        dropped.push(k && PROPERTY_KEY_RE.test(k) ? k : "(línea sin clave=valor válida)"); // nunca el valor: puede ser rcon.password
        continue;
      }
      properties[k] = line.slice(i + 1).trim();
    }
    if (dropped.length) warn(`De CUSTOM_SERVER_PROPERTIES se descartan: ${dropped.join(", ")}`);
  }

  // Jugadores: secciones solo si el contenedor ya sincroniza el fichero (si no, borrarían lo añadido desde el juego).
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
    warn("La whitelist y los operadores se quedan en variables de entorno (Avanzado) porque el contenedor no sincroniza esos ficheros: así no se pierde lo añadido desde el juego");
  }

  // Resto del env.
  const passEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k) || RESERVED_ENV.has(k)) {
      warn(`La variable ${k} no se puede conservar y se descarta`);
      continue;
    }
    passEnv[k] = v;
  }

  // Reinicio y recursos.
  let restartPolicy = c.restartPolicy || "no";
  if (!RESTART.has(restartPolicy)) {
    warn(`Política de reinicio «${restartPolicy}» desconocida: se propone unless-stopped`);
    restartPolicy = "unless-stopped";
  }
  const cpus = Math.round(Number(c.nanoCpus) / 1e7) / 100;
  let memLimit = "";
  if (c.memoryLimitBytes > 0n) {
    memLimit = memLimitText(c.memoryLimitBytes);
    if (memoryToBytes(memLimit) < memoryToBytes(memory)) {
      warn(`El límite de memoria de Docker (${memLimit}) es menor que MEMORY (${memory}): se quita (el agente pone memoria + 1G)`);
      memLimit = "";
    }
  } else {
    warn("Docker no limita su memoria: al recrearlo se limitará a MEMORY + 1G");
  }

  // Nombre, slug y estado.
  const project = c.labels[COMPOSE_PROJECT] ?? "";
  const service = c.labels[COMPOSE_SERVICE] ?? "";
  if (project) {
    warn(`Lo creó Docker Compose (proyecto «${project}», servicio «${service}»): antes del primer «Guardar y aplicar», quita ese servicio del compose (o no vuelvas a hacer «docker compose up»), o Compose volverá a crear el contenedor original junto al del panel`);
  }
  const name = (c.name || service || "Servidor importado").slice(0, 60);
  let slug: string;
  if (slugLocked) {
    slug = lockedSlug;
    if (ctx.takenSlugs.has(slug)) blockers.push(`Ya hay un servidor «${slug}» en este nodo y los datos de este contenedor están en ${root}/${slug}/data`);
  } else {
    slug = uniqueSlug(slugify(c.name || service), ctx.takenSlugs);
  }
  // En pausa cuenta como en marcha: «Adoptar sin parar» no lo para, y el agente no arranca ni reanuda
  // un contenedor en pausa (eso lo hace quien lo pausó, con docker unpause).
  const desiredState = c.state === "running" || c.state === "restarting" || c.state === "paused" ? "running" : "stopped";
  if (c.state === "paused") warn("El contenedor está en pausa: se importa como «en marcha» y sigue en pausa hasta que lo reanudes (docker unpause); el panel no lo reanuda");

  const raw = {
    imageTag: imageTag(c.image, warn), type, version, memory, properties, env: passEnv,
    resources: { cpus, memLimit }, restartPolicy, ports: { ...(game !== undefined ? { game } : {}), extra: extraPorts },
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

/** DTO para el navegador: sin rconPassword ni curseforgeApiKey. */
export function toCandidateDto(c: ImportCandidate, p: ImportProposal): ImportCandidateDto {
  return {
    containerId: c.containerId, containerName: c.name, image: c.image, state: c.state,
    composeProject: c.labels[COMPOSE_PROJECT] ?? "", composeService: c.labels[COMPOSE_SERVICE] ?? "",
    blockers: p.blockers, warnings: p.warnings, hiddenEnv: p.hiddenEnv,
    proposal: { name: p.name, slug: p.slug, slugLocked: p.slugLocked, desiredState: p.desiredState, spec: p.spec, specError: p.specError, dataPath: p.dataPath },
  };
}
