import { describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ImportCandidateSchema, type ImportCandidate } from "@mcsm/proto";
import { proposeImport, toCandidateDto, type ProposeContext } from "./propose.js";

const ROOT = "/srv/minecraft";
const ctx = (over: Partial<ProposeContext> = {}): ProposeContext => ({ dataRoot: ROOT, takenSlugs: new Set(), curseforgeConfigured: false, ...over });
/** Initializer (not the message): so `Partial` and the spread keep `$typeName?: undefined`. */
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
  it("typical compose container with the data outside DATA_ROOT", () => {
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
      ports: { game: 25570, extra: [{ host: 19132, container: 19132, proto: "udp", label: "" }], rcon: 25575 },
    });
    expect(p.spec.env).not.toHaveProperty("RCON_PASSWORD");
    expect(p.spec.env).not.toHaveProperty("EULA");
    expect(p.warnings.join(" ")).toMatch(/Compose/);
    expect(p.warnings.join(" ")).toMatch(/DATA_ROOT/);
    expect(p.warnings.join(" ")).not.toMatch(/25575/); // published RCON is kept, no warning any more
  });

  describe("published RCON (25575/tcp on the host)", () => {
    const game = { containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25570 } as const;
    const rcon = (hostPort: number, proto: "tcp" | "udp" = "tcp", hostIp = "") => ({ containerPort: 25575, proto, hostIp, hostPort });
    const warnings = (p: { warnings: string[] }) => p.warnings.join(" | ");

    it("becomes ports.rcon with that host port and no warning (an IPv4 + IPv6 pair counts once)", () => {
      const p = proposeImport(cand({ ports: [game, rcon(25580, "tcp", "0.0.0.0"), rcon(25580, "tcp", "::")] }), ctx());
      expect(p.spec.ports).toEqual({ game: 25570, extra: [], rcon: 25580 });
      expect(p.specError).toBeNull();
      expect(warnings(p)).not.toMatch(/RCON \(25575\)|25575/);
      expect(warnings(p)).not.toMatch(/will not be published/);
    });
    it("is not carried (with a warning) when it listens on loopback only", () => {
      const p = proposeImport(cand({ ports: [game, rcon(25580, "tcp", "127.0.0.1")] }), ctx());
      expect(p.spec.ports).not.toHaveProperty("rcon");
      expect(warnings(p)).toMatch(/only on 127\.0\.0\.1.*will not be published/);
    });
    it.each([
      ["ENABLE_RCON=false", { ENABLE_RCON: "false" }, /RCON disabled.*will not be published/],
      ["RCON_PORT other than 25575", { RCON_PORT: "25580" }, /RCON_PORT=25580.*will not be published/],
      ["a short password", { RCON_PASSWORD: "corta" }, /RCON_PASSWORD.*will not be published/],
    ])("is not carried (with a warning) with %s", (_n, e, re) => {
      const p = proposeImport(cand({ env: env(e), ports: [game, rcon(25580)] }), ctx());
      expect(p.spec.ports).not.toHaveProperty("rcon");
      expect(warnings(p)).toMatch(re);
    });
    it("is not carried when RCON_PASSWORD is missing", () => {
      const { RCON_PASSWORD: _omit, ...rest } = env({});
      const p = proposeImport(cand({ env: rest, ports: [game, rcon(25580)] }), ctx());
      expect(p.spec.ports).not.toHaveProperty("rcon");
      expect(warnings(p)).toMatch(/will not be published/);
    });
    it("carried on all interfaces with a good password, warning that the container's own password is kept", () => {
      const p = proposeImport(cand({ ports: [game, rcon(25580)] }), ctx());
      expect(p.spec.ports.rcon).toBe(25580);
      expect(warnings(p)).toMatch(/container's own password/);
    });
    it("without the publication there is no ports.rcon", () => {
      expect(proposeImport(cand({ ports: [game] }), ctx()).spec.ports).not.toHaveProperty("rcon");
    });
    it("25575/udp is dropped with a warning", () => {
      const p = proposeImport(cand({ ports: [game, rcon(25575, "udp")] }), ctx());
      expect(p.spec.ports).not.toHaveProperty("rcon");
      expect(warnings(p)).toMatch(/25575\/udp.*not kept/);
    });
    it("an ephemeral host port (0) is dropped with a warning", () => {
      const p = proposeImport(cand({ ports: [game, rcon(0)] }), ctx());
      expect(p.spec.ports).not.toHaveProperty("rcon");
      expect(warnings(p)).toMatch(/random host port.*not kept/);
    });
    it("several 25575/tcp publications: the first (lowest host port) wins and the rest are warned about", () => {
      const p = proposeImport(cand({ ports: [game, rcon(25590), rcon(25580)] }), ctx());
      expect(p.spec.ports.rcon).toBe(25580);
      expect(warnings(p)).toMatch(/25590.*not kept/);
    });
    it("a host port that repeats the game or an extra port is dropped with a warning (the panel allows one publication per port)", () => {
      const a = proposeImport(cand({ ports: [game, rcon(25570)] }), ctx());
      expect(a.spec.ports).not.toHaveProperty("rcon");
      expect(a.specError).toBeNull();
      expect(warnings(a)).toMatch(/25570.*not kept/);
      const b = proposeImport(cand({ ports: [game, { containerPort: 8100, proto: "tcp", hostIp: "", hostPort: 8100 }, rcon(8100)] }), ctx());
      expect(b.spec.ports).not.toHaveProperty("rcon");
      expect(b.specError).toBeNull();
    });
  });

  it("plan-10: the type's build variable becomes build (same environment); if invalid, it stays in env", () => {
    const fabric = proposeImport(cand({ env: env({ TYPE: "FABRIC", FABRIC_LOADER_VERSION: "0.16.9", PAPER_BUILD: "100" }) }), ctx());
    expect(fabric.specError).toBeNull();
    expect(fabric.spec.build).toBe("0.16.9");
    expect(fabric.spec.env).not.toHaveProperty("FABRIC_LOADER_VERSION");
    expect(fabric.spec.env).toHaveProperty("PAPER_BUILD", "100");

    const latest = proposeImport(cand({ env: env({ VERSION: "LATEST", PAPER_BUILD: "100" }) }), ctx());
    expect(latest.spec.build).toBe("");
    expect(latest.spec.env).toHaveProperty("PAPER_BUILD", "100");

    const spaced = proposeImport(cand({ env: env({ PAPER_BUILD: " 100" }) }), ctx());
    expect(spaced.spec.build).toBe("");
    expect(spaced.spec.env).toHaveProperty("PAPER_BUILD", " 100");

    expect(proposeImport(cand({ env: env({ TYPE: "FOLIA", FOLIABUILD: "12" }) }), ctx()).spec.build).toBe("12");
  });

  it("data in <DATA_ROOT>/<slug>/data: no dataPath and fixed slug; taken = blocker", () => {
    const c = cand({ mounts: [{ type: "bind", source: `${ROOT}/survival/data`, destination: "/data", readWrite: true }] });
    const p = proposeImport(c, ctx());
    expect(p).toMatchObject({ dataPath: null, slugLocked: true, slug: "survival", blockers: [] });
    expect(proposeImport(c, ctx({ takenSlugs: new Set(["survival"]) })).blockers.join(" ")).toMatch(/survival/);
  });

  it("data inside DATA_ROOT with a different shape, or containing it: blocker", () => {
    for (const source of [`${ROOT}/survival`, `${ROOT}/Mundo/data`, "/srv"]) {
      expect(proposeImport(cand({ mounts: [{ type: "bind", source, destination: "/data", readWrite: true }] }), ctx()).blockers).toHaveLength(1);
    }
  });

  it("blockers: volume, no /data, read-only, host network, system area, no 25565, SERVER_PORT", () => {
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

  it("itzg default values and RCON warnings", () => {
    const p = proposeImport(cand({ env: {} }), ctx());
    expect(p.spec).toMatchObject({ type: "VANILLA", version: "LATEST", memory: "1G" });
    expect(p.rconPassword).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ ENABLE_RCON: "false" }) }), ctx()).warnings.join(" ")).toMatch(/RCON/);
    expect(proposeImport(cand({ env: env({ RCON_PASSWORD: "corta" }) }), ctx()).rconPassword).toBeNull();
  });

  it("whitelist and ops only become sections with SYNCHRONIZE; otherwise they stay in env and the spec is valid", () => {
    const sync = proposeImport(cand({ env: env({ OPS: "Lobo,Steve", EXISTING_OPS_FILE: "SYNCHRONIZE", WHITELIST: "Lobo\nSteve", EXISTING_WHITELIST_FILE: "synchronize" }) }), ctx());
    expect(sync.spec).toMatchObject({ ops: ["Lobo", "Steve"], whitelist: { enabled: true, players: ["Lobo", "Steve"] } });
    expect(sync.spec.env).toEqual({});
    expect(sync.specError).toBeNull();
    const keep = proposeImport(cand({ env: env({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" }) }), ctx());
    expect(keep.spec).not.toHaveProperty("ops");
    expect(keep.spec).not.toHaveProperty("whitelist");
    expect(keep.spec.env).toEqual({ OPS: "Lobo", WHITELIST: "Lobo", ENABLE_WHITELIST: "true" });
    expect(keep.specError).toBeNull();
    const bad = proposeImport(cand({ env: env({ OPS: "name with spaces", EXISTING_OPS_FILE: "SYNCHRONIZE" }) }), ctx());
    expect(bad.spec).not.toHaveProperty("ops");
    expect(bad.specError).toBeNull();
  });

  it("MODRINTH_PROJECTS goes to plugins or mods depending on the type; an invalid entry leaves it in env", () => {
    expect(proposeImport(cand({ env: env({ MODRINTH_PROJECTS: "chunky,luckperms" }) }), ctx()).spec.plugins?.modrinthProjects).toEqual(["chunky", "luckperms"]);
    const fabric = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODRINTH_PROJECTS: "lithium\nfabric-api", MODS: "https://x.example/a.jar" }) }), ctx());
    expect(fabric.spec.mods).toEqual({ modrinthProjects: ["lithium", "fabric-api"], curseforgeFiles: [], urls: ["https://x.example/a.jar"] });
    expect(fabric.spec).not.toHaveProperty("plugins");
    const odd = proposeImport(cand({ env: env({ TYPE: "FABRIC", MODS: "/extras/mod.jar" }) }), ctx());
    expect(odd.spec.env).toMatchObject({ MODS: "/extras/mod.jar" });
    expect(odd.spec).not.toHaveProperty("mods");
  });

  it("modpacks: Modrinth, CurseForge by slug and MODPACK_PLATFORM without TYPE", () => {
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

  it("CUSTOM_SERVER_PROPERTIES becomes properties; unsupported lines are discarded without showing their value", () => {
    const p = proposeImport(cand({ env: env({ CUSTOM_SERVER_PROPERTIES: "difficulty=hard\nview-distance=12\nrcon.password=supersecreta\nlinea rara\n# comentario" }) }), ctx());
    expect(p.spec.properties).toEqual({ difficulty: "hard", "view-distance": "12" });
    expect(JSON.stringify(p.warnings)).not.toContain("supersecreta");
    expect(p.warnings.join(" ")).toMatch(/rcon\.password/);
  });

  it("memory, limits, image and restart policy", () => {
    const p = proposeImport(cand({ env: env({ MEMORY: "1.5G" }), memoryLimitBytes: 512n * 1024n * 1024n, image: "itzg/minecraft-server@sha256:" + "a".repeat(64), restartPolicy: "" }), ctx());
    expect(p.spec).toMatchObject({ memory: "1G", imageTag: "latest", restartPolicy: "no", resources: { memLimit: "" } });
    expect(p.warnings.join(" ")).toMatch(/MEMORY/);
    expect(p.warnings.join(" ")).toMatch(/digest/);
    expect(proposeImport(cand({ memoryLimitBytes: 1536n * 1024n * 1024n, env: env({ MEMORY: "1G" }) }), ctx()).spec.resources.memLimit).toBe("1536M");
    expect(proposeImport(cand({ image: "docker.io/itzg/minecraft-server:java17" }), ctx()).spec.imageTag).toBe("java17");
  });

  it("free slug without repeating and stopped state", () => {
    const p = proposeImport(cand({ name: "Survival Mundo", state: "exited" }), ctx({ takenSlugs: new Set(["survival-mundo"]) }));
    expect(p).toMatchObject({ name: "Survival Mundo", slug: "survival-mundo-2", desiredState: "stopped" });
  });

  it("two publications with the same host port: the first is kept and it warns (the panel does not allow them)", () => {
    const p = proposeImport(cand({
      ports: [
        { containerPort: 25565, proto: "tcp", hostIp: "0.0.0.0", hostPort: 25565 },
        { containerPort: 25565, proto: "udp", hostIp: "", hostPort: 25565 },
        { containerPort: 24454, proto: "udp", hostIp: "", hostPort: 24454 },
        { containerPort: 24454, proto: "tcp", hostIp: "", hostPort: 24454 },
      ],
    }), ctx());
    expect(p.spec.ports).toEqual({ game: 25565, extra: [{ host: 24454, container: 24454, proto: "udp", label: "" }] });
    expect(p.warnings.filter((w) => /repeats host port/.test(w))).toHaveLength(2);
    expect(p.warnings.join(" ")).not.toMatch(/only listens/);
    expect(p.specError).toBeNull();
  });

  it("variables with an invalid name are discarded with a warning", () => {
    const p = proposeImport(cand({ env: env({ "1MAL": "x", "OK_VAR": "y" }) }), ctx());
    expect(p.spec.env).toEqual({ OK_VAR: "y" });
    expect(p.warnings.join(" ")).toMatch(/1MAL/);
  });
});

describe("toCandidateDto", () => {
  it("never carries the secrets", () => {
    const c = cand({ env: env({ CF_API_KEY: "$2a$10$clave", CUSTOM_SERVER_PROPERTIES: "rcon.password=supersecreta" }), labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "mc" } });
    const dto = toCandidateDto(c, proposeImport(c, ctx()));
    const json = JSON.stringify(dto);
    for (const secret of ["s3cr3t-rcon-pass", "$2a$10$clave", "supersecreta"]) expect(json).not.toContain(secret);
    expect(dto).toMatchObject({ containerId: "c".repeat(64), containerName: "survival", composeProject: "casa", composeService: "mc", hiddenEnv: ["RCON_PASSWORD", "CF_API_KEY"] });
    expect(dto.proposal).not.toHaveProperty("rconPassword");
    expect(dto.proposal).not.toHaveProperty("curseforgeApiKey");
  });
});

describe("proposeImport: review fixes", () => {
  it("I2: a mount inside /data (/data/world…) blocks: on recreation only /data is mounted and the world would be a different one", () => {
    const p = proposeImport(cand({
      mounts: [
        { type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true },
        { type: "bind", source: "/srv/mundos/survival", destination: "/data/world", readWrite: true },
      ],
    }), ctx());
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatch(/\/data\/world/);
    // Outside /data it is still only a warning.
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

describe("proposeImport: state", () => {
  it("m6: a paused container is proposed as running (adopting it does not stop it) and a warning says it stays paused", () => {
    const p = proposeImport(cand({ state: "paused" }), ctx());
    expect(p.desiredState).toBe("running");
    expect(p.warnings.join(" ")).toMatch(/paused/);
    expect(proposeImport(cand({ state: "exited" }), ctx()).desiredState).toBe("stopped");
  });
});

describe("proposeImport: container user (m7)", () => {
  it("--user uid:gid numeric → UID and GID in env (itzg does not change the owner of /data on recreation)", () => {
    const p = proposeImport(cand({ user: "1001:1002" }), ctx());
    expect(p.spec.env).toMatchObject({ UID: "1001", GID: "1002" });
    expect(p.specError).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/UID=1001/);
  });
  it("uid only: UID and a warning to check GID", () => {
    const p = proposeImport(cand({ user: "1001" }), ctx());
    expect(p.spec.env).toMatchObject({ UID: "1001" });
    expect(p.spec.env).not.toHaveProperty("GID");
    expect(p.warnings.join(" ")).toMatch(/GID/);
  });
  it("by name: warning, no UID/GID", () => {
    const p = proposeImport(cand({ user: "minecraft" }), ctx());
    expect(p.spec.env).not.toHaveProperty("UID");
    expect(p.warnings.join(" ")).toMatch(/user “minecraft”/);
  });
  it("empty or root: nothing to do (itzg already started as root)", () => {
    for (const user of ["", "0", "0:0", "root"]) {
      const p = proposeImport(cand({ user }), ctx());
      expect(p.spec.env).not.toHaveProperty("UID");
      expect(p.warnings.join(" ")).not.toMatch(/UID|user/);
    }
  });
});

describe("proposeImport: review warnings", () => {
  it("m8: a dataPath under /tmp warns (tmpfs or systemd-tmpfiles delete it)", () => {
    const at = (source: string) => proposeImport(cand({ mounts: [{ type: "bind", source, destination: "/data", readWrite: true }] }), ctx());
    expect(at("/tmp/mc/survival").dataPath).toBe("/tmp/mc/survival");
    expect(at("/tmp/mc/survival").warnings.join(" ")).toMatch(/temporary/);
    expect(at("/var/tmp/mc").warnings.join(" ")).toMatch(/temporary/);
    expect(at("/home/lobo/tmp/mc").warnings.join(" ")).not.toMatch(/temporary/);
  });
  it("m11: RCON_PASSWORD_FILE and CF_API_KEY_FILE do not go to env (the mounted secret is not kept) and it warns", () => {
    const p = proposeImport(cand({ env: env({ RCON_PASSWORD_FILE: "/run/secrets/rcon", CF_API_KEY_FILE: "/run/secrets/cf", MOTD: "Hola" }) }), ctx());
    expect(p.spec.env).toEqual({ MOTD: "Hola" });
    expect(p.warnings.join(" ")).toMatch(/RCON_PASSWORD_FILE/);
    expect(p.warnings.join(" ")).toMatch(/CF_API_KEY_FILE/);
  });
});
