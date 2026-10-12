import { describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ImportCandidateSchema, type ImportCandidate } from "@mcsm/proto";
import { proposeImport, toCandidateDto, type ProposeContext } from "./propose.js";

const ROOT = "/srv/minecraft";
const ctx = (over: Partial<ProposeContext> = {}): ProposeContext => ({ dataRoot: ROOT, takenSlugs: new Set(), curseforgeConfigured: false, ...over });
/** Inicializador (no el mensaje): así `Partial` y el spread conservan `$typeName?: undefined`. */
type Init = Exclude<MessageInitShape<typeof ImportCandidateSchema>, ImportCandidate>;
const cand = (over: Partial<Init> = {}) => create(ImportCandidateSchema, {
  containerId: "c".repeat(64), name: "survival", image: "itzg/minecraft-server:java21", state: "running",
  env: { EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass" },
  ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25565 }],
  mounts: [{ type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true }],
  restartPolicy: "unless-stopped", networkMode: "bridge", networks: ["bridge"], labels: {},
  ...over,
});
const env = (extra: Record<string, string>) => ({ EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass", ...extra });

describe("proposeImport", () => {
  it("contenedor típico de compose con los datos fuera de DATA_ROOT", () => {
    const p = proposeImport(cand({
      env: env({ MOTD: "Hola", USE_AIKAR_FLAGS: "true", CF_API_KEY: "$2a$10$clave" }),
      ports: [
        { containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25570 },
        { containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25570 },
        { containerPort: 19132, proto: "udp", hostIp: "", hostPort: 19132 },
        { containerPort: 25575, proto: "tcp", hostIp: "", hostPort: 25575 },
      ],
      memoryLimitBytes: 5n * 1024n ** 3n, nanoCpus: 2_000_000_000n,
      labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "survival" },
    }), ctx());
    expect(p.blockers).toEqual([]);
    expect(p.dataPath).toBe("/home/lobo/mc/survival");
    expect(p.slugLocked).toBe(false);
    expect(p.slug).toBe("survival");
    expect(p.desiredState).toBe("running");
    expect(p.rconPassword).toBe("s3cr3t-rcon-pass");
    expect(p.curseforgeApiKey).toBe("$2a$10$clave");
    expect(p.hiddenEnv).toEqual(["RCON_PASSWORD", "CF_API_KEY"]);
    expect(p.specError).toBeNull();
    expect(p.spec).toMatchObject({
      imageTag: "java21", type: "PAPER", version: "1.21.4", memory: "4G", restartPolicy: "unless-stopped",
      env: { MOTD: "Hola", USE_AIKAR_FLAGS: "true" }, resources: { cpus: 2, memLimit: "5G" },
      ports: { game: 25570, extra: [{ host: 19132, container: 19132, proto: "udp", label: "" }] },
    });
    expect(p.spec.env).not.toHaveProperty("RCON_PASSWORD");
    expect(p.spec.env).not.toHaveProperty("EULA");
    expect(p.warnings.join(" ")).toMatch(/Compose/);
    expect(p.warnings.join(" ")).toMatch(/DATA_ROOT/);
    expect(p.warnings.join(" ")).toMatch(/25575/);
  });

  it("datos en <DATA_ROOT>/<slug>/data: sin dataPath y slug fijo; ocupado = bloqueo", () => {
    const c = cand({ mounts: [{ type: "bind", source: `${ROOT}/survival/data`, destination: "/data", readWrite: true }] });
    const p = proposeImport(c, ctx());
    expect(p).toMatchObject({ dataPath: null, slugLocked: true, slug: "survival", blockers: [] });
    expect(proposeImport(c, ctx({ takenSlugs: new Set(["survival"]) })).blockers.join(" ")).toMatch(/survival/);
  });

  it("datos dentro de DATA_ROOT con otra forma, o conteniéndolo: bloqueo", () => {
    for (const source of [`${ROOT}/survival`, `${ROOT}/Mundo/data`, "/srv"]) {
      expect(proposeImport(cand({ mounts: [{ type: "bind", source, destination: "/data", readWrite: true }] }), ctx()).blockers).toHaveLength(1);
    }
  });

  it("bloqueos: volumen, sin /data, solo lectura, red host, zona del sistema, sin 25565, SERVER_PORT", () => {
    const blocked = (over: Partial<Init>) => proposeImport(cand(over), ctx()).blockers.length;
    expect(blocked({ mounts: [{ type: "volume", source: "/var/lib/docker/volumes/mc/_data", name: "mc", destination: "/data", readWrite: true }] })).toBe(1);
    expect(blocked({ mounts: [] })).toBe(1);
    expect(blocked({ mounts: [{ type: "bind", source: "/home/lobo/mc", destination: "/data", readWrite: false }] })).toBe(1);
    expect(blocked({ networkMode: "host" })).toBe(1);
    expect(blocked({ mounts: [{ type: "bind", source: "/etc/mc", destination: "/data", readWrite: true }] })).toBe(1);
    expect(blocked({ ports: [{ containerPort: 25566, proto: "tcp", hostIp: "", hostPort: 25566 }] })).toBe(1);
    expect(blocked({ ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 0 }] })).toBe(1);
    expect(blocked({ env: env({ SERVER_PORT: "25570" }) })).toBe(1);
  });

  it("valores por defecto de itzg y avisos de RCON", () => {
    const p = proposeImport(cand({ env: {} }), ctx());
    expect(p.spec).toMatchObject({ type: "VANILLA", version: "LATEST", memory: "1G" });
    expect(p.rconPassword).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ ENABLE_RCON: "false" }) }), ctx()).warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ RCON_PASSWORD: "corta" }) }), ctx()).rconPassword).toBeNull();
  });

  it("whitelist y ops solo pasan a secciones con SYNCHRONIZE; si no, se quedan en env y la spec vale", () => {
    const sync = proposeImport(cand({ env: env({ OPS: "Lobo,Steve", EXISTING_OPS_FILE: "SYNCHRONIZE", WHITELIST: "Lobo\nSteve", EXISTING_WHITELIST_FILE: "synchronize" }) }), ctx());
    expect(sync.spec).toMatchObject({ ops: ["Lobo", "Steve"], whitelist: { enabled: true, players: ["Lobo", "Steve"] } });
    expect(sync.spec.env).toEqual({});
    expect(sync.specError).toBeNull();
    const keep = proposeImport(cand({ env: env({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" }) }), ctx());
    expect(keep.spec).not.toHaveProperty("ops");
    expect(keep.spec).not.toHaveProperty("whitelist");
    expect(keep.spec.env).toEqual({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" });
    expect(keep.specError).toBeNull();
    const bad = proposeImport(cand({ env: env({ OPS: "nombre con espacios", EXISTING_OPS_FILE: "SYNCHRONIZE" }) }), ctx());
    expect(bad.spec).not.toHaveProperty("ops");
    expect(bad.specError).toBeNull();
  });

  it("MODRINTH_PROJECTS va a plugins o a mods según el tipo; una entrada inválida lo deja en env", () => {
    expect(proposeImport(cand({ env: env({ MODRINTH_PROJECTS: "chunky,luckperms" }) }), ctx()).spec.plugins?.modrinthProjects).toEqual(["chunky", "luckperms"]);
    const fabric = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODRINTH_PROJECTS: "lithium\nfabric-api", MODS: "https://x.example/a.jar" }) }), ctx());
    expect(fabric.spec.mods).toEqual({ modrinthProjects: ["lithium", "fabric-api"], curseforgeFiles: [], urls: ["https://x.example/a.jar"] });
    expect(fabric.spec).not.toHaveProperty("plugins");
    const odd = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODS: "/extras/mod.jar" }) }), ctx());
    expect(odd.spec.env).toMatchObject({ MODS: "/extras/mod.jar" });
    expect(odd.spec).not.toHaveProperty("mods");
  });

  it("modpacks: Modrinth, CurseForge por slug y MODPACK_PLATFORM sin TYPE", () => {
    const mr = proposeImport(cand({ env: env({ TYPE: "MODRINTH", MODRINTH_MODPACK: "cobblemon-fabric", MODRINTH_LOADER: "fabric" }) }), ctx());
    expect(mr.spec).toMatchObject({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(mr.specError).toBeNull();
    const cf = proposeImport(cand({ env: env({ TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_FILE_ID: "123" }) }), ctx());
    expect(cf.spec.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10", versionId: "123", loader: "" });
    const viaPlatform = proposeImport(cand({ env: { MODPACK_PLATFORM: "MODRINTH", MODRINTH_MODPACK: "x", RCON_PASSWORD: "s3cr3t-rcon-pass" } }), ctx());
    expect(viaPlatform.spec.type).toBe("MODRINTH");
    expect(viaPlatform.spec.env).not.toHaveProperty("MODPACK_PLATFORM");
    const missing = proposeImport(cand({ env: env({ TYPE: "MODRINTH" }) }), ctx());
    expect(missing.specError).not.toBeNull();
  });

  it("CUSTOM_SERVER_PROPERTIES pasa a properties; las líneas no admitidas se descartan sin mostrar su valor", () => {
    const p = proposeImport(cand({ env: env({ CUSTOM_SERVER_PROPERTIES: "difficulty=hard\nview-distance=12\nrcon.password=supersecreta\nlinea rara\n# comentario" }) }), ctx());
    expect(p.spec.properties).toEqual({ difficulty: "hard", "view-distance": "12" });
    expect(JSON.stringify(p.warnings)).not.toContain("supersecreta");
    expect(p.warnings.join(" ")).toMatch(/rcon\.password/);
  });

  it("memoria, límites, imagen y política de reinicio", () => {
    const p = proposeImport(cand({ env: env({ MEMORY: "1.5G" }), memoryLimitBytes: 512n * 1024n * 1024n, image: "itzg/minecraft-server@sha256:" + "a".repeat(64), restartPolicy: "" }), ctx());
    expect(p.spec).toMatchObject({ memory: "1G", imageTag: "latest", restartPolicy: "no", resources: { memLimit: "" } });
    expect(p.warnings.join(" ")).toMatch(/MEMORY/);
    expect(p.warnings.join(" ")).toMatch(/digest/);
    expect(proposeImport(cand({ memoryLimitBytes: 1536n * 1024n * 1024n, env: env({ MEMORY: "1G" }) }), ctx()).spec.resources.memLimit).toBe("1536M");
    expect(proposeImport(cand({ image: "docker.io/itzg/minecraft-server:java17" }), ctx()).spec.imageTag).toBe("java17");
  });

  it("slug libre sin repetir y estado parado", () => {
    const p = proposeImport(cand({ name: "Survival Mundo", state: "exited" }), ctx({ takenSlugs: new Set(["survival-mundo"]) }));
    expect(p).toMatchObject({ name: "Survival Mundo", slug: "survival-mundo-2", desiredState: "stopped" });
  });

  it("dos publicaciones con el mismo puerto del host: se queda la primera y avisa (el panel no las admite)", () => {
    const p = proposeImport(cand({
      ports: [
        { containerPort: 25565, proto: "tcp", hostIp: "0.0.0.0", hostPort: 25565 },
        { containerPort: 25565, proto: "udp", hostIp: "", hostPort: 25565 },
        { containerPort: 24454, proto: "udp", hostIp: "", hostPort: 24454 },
        { containerPort: 24454, proto: "tcp", hostIp: "", hostPort: 24454 },
      ],
    }), ctx());
    expect(p.spec.ports).toEqual({ game: 25565, extra: [{ host: 24454, container: 24454, proto: "udp", label: "" }] });
    expect(p.warnings.filter((w) => /repite el puerto/.test(w))).toHaveLength(2);
    expect(p.warnings.join(" ")).not.toMatch(/solo escucha/);
    expect(p.specError).toBeNull();
  });

  it("variables con nombre inválido se descartan con aviso", () => {
    const p = proposeImport(cand({ env: env({ "1MAL": "x", "OK_VAR": "y" }) }), ctx());
    expect(p.spec.env).toEqual({ OK_VAR: "y" });
    expect(p.warnings.join(" ")).toMatch(/1MAL/);
  });
});

describe("toCandidateDto", () => {
  it("nunca lleva los secretos", () => {
    const c = cand({ env: env({ CF_API_KEY: "$2a$10$clave", CUSTOM_SERVER_PROPERTIES: "rcon.password=supersecreta" }), labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "mc" } });
    const dto = toCandidateDto(c, proposeImport(c, ctx()));
    const json = JSON.stringify(dto);
    for (const secret of ["s3cr3t-rcon-pass", "$2a$10$clave", "supersecreta"]) expect(json).not.toContain(secret);
    expect(dto).toMatchObject({ containerId: "c".repeat(64), containerName: "survival", composeProject: "casa", composeService: "mc", hiddenEnv: ["RCON_PASSWORD", "CF_API_KEY"] });
    expect(dto.proposal).not.toHaveProperty("rconPassword");
    expect(dto.proposal).not.toHaveProperty("curseforgeApiKey");
  });
});

describe("proposeImport: arreglos de la revisión", () => {
  it("I2: un montaje dentro de /data (/data/world…) bloquea: al recrearlo solo se monta /data y el mundo sería otro", () => {
    const p = proposeImport(cand({
      mounts: [
        { type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true },
        { type: "bind", source: "/srv/mundos/survival", destination: "/data/world", readWrite: true },
      ],
    }), ctx());
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatch(/\/data\/world/);
    // Fuera de /data sigue siendo solo un aviso.
    const q = proposeImport(cand({
      mounts: [
        { type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true },
        { type: "bind", source: "/home/lobo/mc/extra", destination: "/extra", readWrite: true },
        { type: "bind", source: "/home/lobo/mc/datos", destination: "/datos", readWrite: true },
      ],
    }), ctx());
    expect(q.blockers).toEqual([]);
    expect(q.warnings.join(" ")).toMatch(/\/extra/);
  });
});
