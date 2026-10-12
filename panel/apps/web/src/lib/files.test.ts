import { describe, expect, it } from "vitest";
import { breadcrumbs, canEdit, filesApi, progressPct, validateNewName } from "./files";

describe("breadcrumbs", () => {
  it("raíz y rutas anidadas", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "data", path: "/" }]);
    expect(breadcrumbs("/world/region")).toEqual([
      { name: "data", path: "/" }, { name: "world", path: "/world" }, { name: "region", path: "/world/region" },
    ]);
  });
});

describe("canEdit", () => {
  it("solo texto conocido de hasta 2 MiB", () => {
    expect(canEdit({ name: "server.properties", dir: false, size: 1200 })).toBe(true);
    expect(canEdit({ name: "latest.log", dir: false, size: 3 * 1024 * 1024 })).toBe(false);
    expect(canEdit({ name: "lithium.jar", dir: false, size: 10 })).toBe(false);
    expect(canEdit({ name: "config.yml", dir: true, size: 0 })).toBe(false);
  });
});

describe("validateNewName", () => {
  it("rechaza vacíos, barras, .. y duplicados; permite conservar el nombre actual", () => {
    expect(validateNewName("", [])).toMatch(/vacío/);
    expect(validateNewName("a/b", [])).toMatch(/inválido/);
    expect(validateNewName("..", [])).toMatch(/inválido/);
    expect(validateNewName("mods", ["mods"])).toMatch(/Ya existe/);
    expect(validateNewName("mods", ["mods"], "mods")).toBeNull();
    expect(validateNewName("plugins", ["mods"])).toBeNull();
  });
});

describe("filesApi", () => {
  it("codifica la ruta en la URL de descarga", () => {
    expect(filesApi.downloadUrl("s1", "/world/mundo ñ.dat")).toBe("/api/servers/s1/files/download?path=%2Fworld%2Fmundo%20%C3%B1.dat");
  });
});

describe("progressPct", () => {
  it("redondea hacia abajo y acota", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(512, 1024)).toBe(50);
    expect(progressPct(2000, 1024)).toBe(100);
  });
});
