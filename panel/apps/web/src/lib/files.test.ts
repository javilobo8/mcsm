import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { breadcrumbs, canEdit, filesApi, isClean, progressPct, uploadFile, validateNewName } from "./files";

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

describe("filesApi.downloadUrl caracteres especiales", () => {
  it("codifica # ? % & en la ruta y / en el id", () => {
    expect(filesApi.downloadUrl("s1", "/a#b?c%d&e.txt")).toBe("/api/servers/s1/files/download?path=%2Fa%23b%3Fc%25d%26e.txt");
    expect(filesApi.downloadUrl("a/b", "/x")).toBe("/api/servers/a%2Fb/files/download?path=%2Fx");
  });
});

describe("isClean", () => {
  it("compara el documento con lo guardado", () => {
    expect(isClean("abc", "abc")).toBe(true);
    expect(isClean("abd", "abc")).toBe(false);
    expect(isClean("ab", "abc")).toBe(false);
  });
  it("no construye la cadena si la longitud difiere", () => {
    const toString = vi.fn(() => "abc");
    expect(isClean({ length: 2, toString }, "abc")).toBe(false);
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("uploadFile", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rechaza al momento, sin abrir el XHR, si la señal ya está abortada", async () => {
    const ctor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", ctor);
    const ac = new AbortController();
    ac.abort();
    await expect(uploadFile("s1", "/a.bin", new Blob(["x"]), undefined, ac.signal)).rejects.toMatchObject({ name: "ApiError", status: 0, message: "Subida cancelada" });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe("progressPct", () => {
  it("redondea hacia abajo y acota", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(512, 1024)).toBe(50);
    expect(progressPct(2000, 1024)).toBe(100);
  });
});
