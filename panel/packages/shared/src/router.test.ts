import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOSTNAME_RE, defaultRouterDeploymentSpec, hostnameError, routerDeploymentSpecSchema, serverRouterSchema, validHostname,
} from "./router.js";
import { specInputSchema, specSchema } from "./spec.js";
import { specToTemplate } from "./templates.js";

const cases = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/router-hostname-cases.json", import.meta.url), "utf8")) as { valid: string[]; invalid: string[] };
const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("validHostname (same criterion as the agent)", () => {
  it.each(cases.valid)("accepts %j", (h) => expect(validHostname(h)).toBe(true));
  it.each(cases.invalid)("rejects %j", (h) => expect(validHostname(h)).toBe(false));
  it("lengths: label ≤ 63 and total ≤ 253", () => {
    const l63 = "a".repeat(63);
    expect(validHostname(`${l63}.lan`)).toBe(true);
    expect(validHostname(`${"a".repeat(64)}.lan`)).toBe(false);
    const long = [l63, l63, l63, l63].join(".");
    expect(validHostname(long.slice(0, 253))).toBe(true);
    expect(validHostname(long.slice(0, 254))).toBe(false);
    expect(HOSTNAME_RE.test(long.slice(0, 254))).toBe(true); // the regex alone does not limit the total
  });
  it("explains the error in English", () => {
    expect(hostnameError("")).toBeNull();
    expect(hostnameError("survival.lan")).toBeNull();
    expect(hostnameError("Survival.lan")).toBe("The hostname must be lowercase");
    expect(hostnameError("a_b.lan")).toMatch(/Invalid hostname/);
  });
});

describe("serverRouterSchema", () => {
  it("disabled and without a hostname by default", () => {
    expect(serverRouterSchema.parse({})).toEqual({ enabled: false, hostname: "" });
  });
  it("enabled requires a hostname", () => {
    const r = serverRouterSchema.safeParse({ enabled: true });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["hostname"]);
    expect(serverRouterSchema.safeParse({ enabled: true, hostname: "survival.lan" }).success).toBe(true);
  });
  it("an invalid hostname is not valid even when disabled", () => {
    expect(serverRouterSchema.safeParse({ enabled: false, hostname: "Survival.lan" }).success).toBe(false);
  });
});

describe("router in the server spec", () => {
  it("is optional: without a section it does not appear", () => {
    expect("router" in specSchema.parse(fixture)).toBe(false);
  });
  it("is validated inside the spec", () => {
    expect(specSchema.safeParse({ ...fixture, router: { enabled: true, hostname: "survival.lan" } }).success).toBe(true);
    expect(specSchema.safeParse({ ...fixture, router: { enabled: true, hostname: "" } }).success).toBe(false);
    expect(specInputSchema.safeParse({ router: { enabled: true, hostname: "creativo.lan" } }).success).toBe(true);
  });
  it("does not travel in templates (the hostname belongs to a specific server)", () => {
    const tpl = specToTemplate({ ...fixture, router: { enabled: true, hostname: "survival.lan" } });
    expect("router" in tpl).toBe(false);
  });
});

describe("routerDeploymentSpecSchema", () => {
  it("default values: disabled, 25565, no autoscale, 10 min", () => {
    expect(defaultRouterDeploymentSpec()).toEqual({ enabled: false, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] });
  });
  it("ranges", () => {
    for (const bad of [{ port: 0 }, { port: 65536 }, { port: 25565.5 }, { autoscaleDownAfterMinutes: 0 }, { autoscaleDownAfterMinutes: 1441 }]) {
      expect(routerDeploymentSpecSchema.safeParse(bad).success).toBe(false);
    }
    expect(routerDeploymentSpecSchema.safeParse({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 1440 }).success).toBe(true);
  });
  it("list of players that wake servers: names or UUIDs, like the whitelist, max. 1000", () => {
    expect(routerDeploymentSpecSchema.safeParse({ autoscaleAllowPlayers: ["amigo", "0123456789abcdef0123456789abcdef"] }).success).toBe(true);
    for (const bad of [["a b"], ["demasiado_largo_17"], [""], Array.from({ length: 1001 }, (_, i) => `p${i}`)]) {
      expect(routerDeploymentSpecSchema.safeParse({ autoscaleAllowPlayers: bad }).success).toBe(false);
    }
  });
});
