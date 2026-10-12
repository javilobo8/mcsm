import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, templateSpecSchema } from "./spec.js";
import { SPEC_MAX_BYTES, specSizeError, utf8Bytes } from "./spec-limits.js";

const base = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));
const names = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const issuePath = (spec: unknown) => {
  const r = specSchema.safeParse(spec);
  return r.success ? null : r.error.issues[0]!.path.join(".");
};

// Mismos topes y casos límite que agent/internal/spec/limits_test.go (auditoría L1).
describe("topes de tamaño de la spec", () => {
  const lists: Record<string, (n: number) => object> = {
    ops: (n) => ({ ops: names(n) }),
    "whitelist.players": (n) => ({ whitelist: { players: names(n) } }),
    "mods.modrinthProjects": (n) => ({ mods: { modrinthProjects: names(n) } }),
    "mods.curseforgeFiles": (n) => ({ mods: { curseforgeFiles: names(n) } }),
    "plugins.spigetResources": (n) => ({ plugins: { spigetResources: names(n).map((_, i) => String(i + 1)) } }),
    "plugins.urls": (n) => ({ plugins: { urls: names(n).map((_, i) => `https://example.com/${i}.jar`) } }),
    "ports.extra": (n) => ({ ports: { game: 25565, extra: Array.from({ length: n }, (_, i) => ({ host: 30000 + i, container: 30000 + i, proto: "tcp", label: "" })) } }),
  };
  it.each(Object.entries(lists))("%s: 1000 elementos sí, 1001 no", (name, make) => {
    expect(issuePath({ ...base, ...make(1000) })).toBeNull();
    expect(issuePath({ ...base, ...make(1001) })).toBe(name);
  });

  const ok = "a".repeat(4096);
  const strings: Record<string, (v: string) => object> = {
    "env.X": (v) => ({ env: { X: v } }),
    "properties.motd": (v) => ({ properties: { motd: v } }),
    version: (v) => ({ version: v }),
    type: (v) => ({ type: v }),
  };
  it.each(Object.entries(strings))("%s: 4096 bytes sí; 4097 bytes o 2049 «ñ» (4098 bytes) no", (name, make) => {
    expect(issuePath({ ...base, ...make(ok) })).toBeNull();
    expect(issuePath({ ...base, ...make("a".repeat(4097)) })).toBe(name);
    expect(issuePath({ ...base, ...make("ñ".repeat(2049)) })).toBe(name);
  });
  it("también el nombre de una variable", () => {
    expect(issuePath({ ...base, env: { ["K".repeat(4097)]: "v" } })).toBe(`env.${"K".repeat(4097)}`);
  });
  it("las plantillas tienen los mismos topes", () => {
    expect(templateSpecSchema.safeParse({ ops: names(1001) }).success).toBe(false);
  });
});

describe("spec serializada ≤ 64 KiB (panel)", () => {
  it("mide bytes UTF-8 del JSON", () => {
    expect(utf8Bytes("ñ")).toBe(2);
    expect(specSizeError(base)).toBeNull();
    const env = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`V${i}`, "x".repeat(4000)]));
    const msg = specSizeError({ ...base, env });
    expect(msg).toMatch(/64 KiB/);
    expect(utf8Bytes(JSON.stringify({ ...base, env }))).toBeGreaterThan(SPEC_MAX_BYTES);
  });
});
