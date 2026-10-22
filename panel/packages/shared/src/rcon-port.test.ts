import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specHostPorts, specInputSchema, specSchema, templateSpecSchema } from "./spec.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("rcon-port-cases.json") as { name: string; ports: unknown; ok: boolean }[];

describe("cases shared with the Go agent (proto/fixtures/rcon-port-cases.json)", () => {
  it("the fixture has cases", () => expect(cases.length).toBeGreaterThanOrEqual(10));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(specSchema.safeParse({ ...base, ports: c.ports }).success).toBe(c.ok);
  });
});

describe("ports.rcon", () => {
  it("a collision is reported on ports.rcon", () => {
    const r = specSchema.safeParse({ ...base, ports: { game: 25570, extra: [], rcon: 25570 } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ["ports", "rcon"], message: expect.stringMatching(/RCON port/) });
  });
  it("the input accepts a number or \"auto\", the stored spec only a number", () => {
    expect(specInputSchema.parse({ ports: { rcon: "auto" } }).ports.rcon).toBe("auto");
    expect(specInputSchema.parse({ ports: { rcon: 25580 } }).ports.rcon).toBe(25580);
    expect(specInputSchema.safeParse({ ports: { rcon: "other" } }).success).toBe(false);
    expect(specSchema.safeParse({ ...base, ports: { game: 25570, extra: [], rcon: "auto" } }).success).toBe(false);
  });
  it("the input rejects a collision with the game port or an extra", () => {
    expect(specInputSchema.safeParse({ ports: { game: 25570, rcon: 25570 } }).success).toBe(false);
    expect(specInputSchema.safeParse({ ports: { extra: [{ host: 8100, container: 8100, proto: "udp" }], rcon: 8100 } }).success).toBe(false);
  });
  it("templates still carry no ports", () => {
    const t = templateSpecSchema.parse({ ...base, ports: { game: 1, extra: [], rcon: 5 } }) as Record<string, unknown>;
    expect(t.ports).toBeUndefined();
  });
});

describe("specHostPorts", () => {
  it("lists game, extras and rcon when present", () => {
    const extra = [{ host: 8100, container: 8100, proto: "tcp" as const, label: "" }];
    expect(specHostPorts({ ports: { game: 25570, extra } })).toEqual([25570, 8100]);
    expect(specHostPorts({ ports: { game: 25570, extra, rcon: 25580 } })).toEqual([25570, 8100, 25580]);
  });
});
