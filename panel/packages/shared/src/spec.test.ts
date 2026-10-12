import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema, defaultSpecInput } from "./spec.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("specSchema", () => {
  it("acepta la fixture compartida sin cambios", () => {
    const parsed = specSchema.parse(fixture);
    expect(parsed).toEqual(fixture);
  });
  it("rechaza env reservadas", () => {
    expect(() => specSchema.parse({ ...fixture, env: { RCON_PASSWORD: "x" } })).toThrow(/reservada/);
  });
  it("rechaza memLimit menor que memory", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "2G" } })).toThrow(/memLimit/);
  });
  it("rechaza memoria con formato raro", () => {
    expect(() => specSchema.parse({ ...fixture, memory: "4 gigas" })).toThrow();
  });
  it("rechaza rconPassword corta", () => {
    expect(() => specSchema.parse({ ...fixture, rconPassword: "abc" })).toThrow();
  });
});

describe("specInputSchema", () => {
  it("rellena defaults y no exige rconPassword ni puerto", () => {
    const parsed = specInputSchema.parse({ type: "VANILLA", version: "LATEST" });
    expect(parsed.memory).toBe("2G");
    expect(parsed.imageTag).toBe("latest");
    expect(parsed.ports.extra).toEqual([]);
    expect(parsed.ports.game).toBeUndefined();
    expect(parsed.restartPolicy).toBe("unless-stopped");
    expect(parsed.resources).toEqual({ cpus: 0, memLimit: "" });
  });
  it("defaultSpecInput valida", () => {
    expect(() => specInputSchema.parse(defaultSpecInput())).not.toThrow();
  });
});

describe("endurecimiento de validación", () => {
  const withEnv = (env: Record<string, string>) => ({ ...fixture, env });
  const withProps = (properties: Record<string, string>) => ({ ...fixture, properties });
  const withPorts = (extra: unknown[]) => ({ ...fixture, ports: { game: 25565, extra } });

  it.each([
    ["TYPE=X", "y"],
    ["A B", "y"],
    ["", "y"],
    ["1A", "y"],
  ])("rechaza el nombre de env %j", (k, v) => {
    expect(() => specSchema.parse(withEnv({ [k]: v }))).toThrow(/nombre/i);
  });
  it("acepta USE_AIKAR_FLAGS como nombre de env", () => {
    expect(() => specSchema.parse(withEnv({ USE_AIKAR_FLAGS: "true" }))).not.toThrow();
  });

  it.each([
    ["tcp", 25575],
    ["udp", 25575],
  ])("rechaza publicar RCON por puerto extra (%s)", (proto, container) => {
    const extra = [{ host: 19999, container, proto, label: "" }];
    expect(() => specSchema.parse(withPorts(extra))).toThrow(/RCON/);
  });

  it.each(["4096", "4GB", "0G"])("rechaza memoria %s", (m) => {
    expect(() => specSchema.parse({ ...fixture, memory: m })).toThrow();
  });
  it.each(["512M", "4G", "4g"])("acepta memoria %s", (m) => {
    expect(() => specSchema.parse({ ...fixture, memory: m })).not.toThrow();
  });
  it("rechaza memLimit 4096", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "4096" } })).toThrow();
  });

  it("rechaza clave de propiedad con =", () => {
    expect(() => specSchema.parse(withProps({ "a=b": "x" }))).toThrow(/propiedad/i);
  });
  it("rechaza valor de propiedad con salto de línea", () => {
    expect(() => specSchema.parse(withProps({ motd: "x\nrcon.password=y" }))).toThrow(/saltos de línea/);
  });
  it.each(["rcon.password", "server-port", "enable-rcon", "rcon.port"])("rechaza propiedad reservada %s", (k) => {
    expect(() => specSchema.parse(withProps({ [k]: "y" }))).toThrow(/reservada/);
  });
  it("acepta propiedades válidas", () => {
    expect(() => specSchema.parse(withProps({ "max-players": "10", motd: "Hola", "level-name": "world" }))).not.toThrow();
  });
});
