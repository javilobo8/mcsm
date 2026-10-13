import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema, defaultSpecInput } from "./spec.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("specSchema", () => {
  it("accepts the shared fixture unchanged", () => {
    const parsed = specSchema.parse(fixture);
    expect(parsed).toEqual({ ...fixture, build: "" });
  });
  it("rejects reserved env", () => {
    expect(() => specSchema.parse({ ...fixture, env: { RCON_PASSWORD: "x" } })).toThrow(/reserved/);
  });
  it("rejects memLimit lower than memory", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "2G" } })).toThrow(/memLimit/);
  });
  it("rejects memory with an odd format", () => {
    expect(() => specSchema.parse({ ...fixture, memory: "4 gigas" })).toThrow();
  });
  it("rejects a short rconPassword", () => {
    expect(() => specSchema.parse({ ...fixture, rconPassword: "abc" })).toThrow();
  });
});

describe("specInputSchema", () => {
  it("fills in defaults and does not require rconPassword or port", () => {
    const parsed = specInputSchema.parse({ type: "VANILLA", version: "LATEST" });
    expect(parsed.memory).toBe("2G");
    expect(parsed.imageTag).toBe("latest");
    expect(parsed.ports.extra).toEqual([]);
    expect(parsed.ports.game).toBeUndefined();
    expect(parsed.restartPolicy).toBe("unless-stopped");
    expect(parsed.resources).toEqual({ cpus: 0, memLimit: "" });
  });
  it("defaultSpecInput validates", () => {
    expect(() => specInputSchema.parse(defaultSpecInput())).not.toThrow();
  });
});

describe("imageTag (same regex as the agent)", () => {
  it.each(["latest", "java21", "2024.10.0-java21-graalvm", "a".repeat(128)])("accepts %j", (tag) => {
    expect(() => specSchema.parse({ ...fixture, imageTag: tag })).not.toThrow();
  });
  it.each(["", "x/../../containers/abc", "a:b", "a b", "-x", ".x", "_x", "a".repeat(129)])("rejects %j", (tag) => {
    expect(() => specSchema.parse({ ...fixture, imageTag: tag })).toThrow(/image/i);
  });
});

describe("validation hardening", () => {
  const withEnv = (env: Record<string, string>) => ({ ...fixture, env });
  const withProps = (properties: Record<string, string>) => ({ ...fixture, properties });
  const withPorts = (extra: unknown[]) => ({ ...fixture, ports: { game: 25565, extra } });

  it.each([
    ["TYPE=X", "y"],
    ["A B", "y"],
    ["", "y"],
    ["1A", "y"],
  ])("rejects the env name %j", (k, v) => {
    expect(() => specSchema.parse(withEnv({ [k]: v }))).toThrow(/name/i);
  });
  it("accepts USE_AIKAR_FLAGS as an env name", () => {
    expect(() => specSchema.parse(withEnv({ USE_AIKAR_FLAGS: "true" }))).not.toThrow();
  });

  it.each([
    ["tcp", 25575],
    ["udp", 25575],
  ])("rejects publishing RCON on an extra port (%s)", (proto, container) => {
    const extra = [{ host: 19999, container, proto, label: "" }];
    expect(() => specSchema.parse(withPorts(extra))).toThrow(/RCON/);
  });

  it.each(["4096", "4GB", "0G"])("rejects memory %s", (m) => {
    expect(() => specSchema.parse({ ...fixture, memory: m })).toThrow();
  });
  it.each(["512M", "4G", "4g"])("accepts memory %s", (m) => {
    expect(() => specSchema.parse({ ...fixture, memory: m })).not.toThrow();
  });
  it("rejects memLimit 4096", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "4096" } })).toThrow();
  });

  it("rejects a property key with =", () => {
    expect(() => specSchema.parse(withProps({ "a=b": "x" }))).toThrow(/property/i);
  });
  it("rejects a property value with a line break", () => {
    expect(() => specSchema.parse(withProps({ motd: "x\nrcon.password=y" }))).toThrow(/line breaks/);
  });
  it.each(["rcon.password", "server-port", "enable-rcon", "rcon.port"])("rejects reserved property %s", (k) => {
    expect(() => specSchema.parse(withProps({ [k]: "y" }))).toThrow(/reserved/);
  });
  it("accepts valid properties", () => {
    expect(() => specSchema.parse(withProps({ "max-players": "10", motd: "Hola", "level-name": "world" }))).not.toThrow();
  });
});
