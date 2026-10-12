import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOSTNAME_RE, defaultRouterDeploymentSpec, hostnameError, routerDeploymentSpecSchema, serverRouterSchema, validHostname,
} from "./router.js";
import { specInputSchema, specSchema } from "./spec.js";
import { specToTemplate } from "./templates.js";

const cases = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/router-hostname-cases.json", import.meta.url), "utf8")) as { valid: string[]; invalid: string[] };
const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("validHostname (mismo criterio que el agente)", () => {
  it.each(cases.valid)("acepta %j", (h) => expect(validHostname(h)).toBe(true));
  it.each(cases.invalid)("rechaza %j", (h) => expect(validHostname(h)).toBe(false));
  it("longitudes: etiqueta ≤ 63 y total ≤ 253", () => {
    const l63 = "a".repeat(63);
    expect(validHostname(`${l63}.lan`)).toBe(true);
    expect(validHostname(`${"a".repeat(64)}.lan`)).toBe(false);
    const long = [l63, l63, l63, l63].join(".");
    expect(validHostname(long.slice(0, 253))).toBe(true);
    expect(validHostname(long.slice(0, 254))).toBe(false);
    expect(HOSTNAME_RE.test(long.slice(0, 254))).toBe(true); // la regex sola no limita el total
  });
  it("explica el error en castellano", () => {
    expect(hostnameError("")).toBeNull();
    expect(hostnameError("survival.lan")).toBeNull();
    expect(hostnameError("Survival.lan")).toBe("El hostname va en minúsculas");
    expect(hostnameError("a_b.lan")).toMatch(/Hostname inválido/);
  });
});

describe("serverRouterSchema", () => {
  it("por defecto desactivado y sin hostname", () => {
    expect(serverRouterSchema.parse({})).toEqual({ enabled: false, hostname: "" });
  });
  it("activado exige hostname", () => {
    const r = serverRouterSchema.safeParse({ enabled: true });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["hostname"]);
    expect(serverRouterSchema.safeParse({ enabled: true, hostname: "survival.lan" }).success).toBe(true);
  });
  it("un hostname inválido no vale ni desactivado", () => {
    expect(serverRouterSchema.safeParse({ enabled: false, hostname: "Survival.lan" }).success).toBe(false);
  });
});

describe("router en la spec del servidor", () => {
  it("es opcional: sin sección no aparece", () => {
    expect("router" in specSchema.parse(fixture)).toBe(false);
  });
  it("se valida dentro de la spec", () => {
    expect(specSchema.safeParse({ ...fixture, router: { enabled: true, hostname: "survival.lan" } }).success).toBe(true);
    expect(specSchema.safeParse({ ...fixture, router: { enabled: true, hostname: "" } }).success).toBe(false);
    expect(specInputSchema.safeParse({ router: { enabled: true, hostname: "creativo.lan" } }).success).toBe(true);
  });
  it("no viaja en plantillas (el hostname es de un servidor concreto)", () => {
    const tpl = specToTemplate({ ...fixture, router: { enabled: true, hostname: "survival.lan" } });
    expect("router" in tpl).toBe(false);
  });
});

describe("routerDeploymentSpecSchema", () => {
  it("valores por defecto: desactivado, 25565, sin autoscale, 10 min", () => {
    expect(defaultRouterDeploymentSpec()).toEqual({ enabled: false, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10 });
  });
  it("rangos", () => {
    for (const bad of [{ port: 0 }, { port: 65536 }, { port: 25565.5 }, { autoscaleDownAfterMinutes: 0 }, { autoscaleDownAfterMinutes: 1441 }]) {
      expect(routerDeploymentSpecSchema.safeParse(bad).success).toBe(false);
    }
    expect(routerDeploymentSpecSchema.safeParse({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 1440 }).success).toBe(true);
  });
});
