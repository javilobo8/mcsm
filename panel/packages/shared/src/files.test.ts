import { describe, expect, it } from "vitest";
import { baseName, editorLanguage, fileNameSchema, filePathSchema, joinPath, normalizePath, parentPath } from "./files.js";

describe("normalizePath", () => {
  it("normaliza separadores, puntos y la raíz", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("mods//a.jar/")).toBe("/mods/a.jar");
    expect(normalizePath("./config/./a.yml")).toBe("/config/a.yml");
    expect(normalizePath("/mundo ñ/level.dat")).toBe("/mundo ñ/level.dat");
  });
  it("rechaza .. y caracteres de control en vez de arreglarlos", () => {
    for (const p of ["../../etc/passwd", "/a/../b", "..", "a\u0000b", "a\nb", "a\rb"]) expect(normalizePath(p)).toBeNull();
  });
});

describe("límite de ruta (4096 bytes UTF-8)", () => {
  it("acepta exactamente 4096 bytes, aunque sean multibyte", () => {
    expect(normalizePath("ñ".repeat(2048))).toBe("/" + "ñ".repeat(2048));
    expect(normalizePath("a".repeat(4096))).not.toBeNull();
  });
  it("rechaza 4097 bytes con mensaje de longitud", () => {
    expect(normalizePath("ñ".repeat(2048) + "a")).toBeNull();
    expect(normalizePath("a".repeat(4097))).toBeNull();
    expect(filePathSchema.safeParse("ñ".repeat(2048) + "a").error?.issues[0]?.message).toMatch(/demasiado larga/);
  });
});

describe("filePathSchema", () => {
  it("devuelve la ruta normalizada", () => {
    expect(filePathSchema.parse("mods/a.jar")).toBe("/mods/a.jar");
  });
  it("da mensajes en castellano", () => {
    expect(filePathSchema.safeParse("../../etc/passwd").error?.issues[0]?.message).toMatch(/Ruta inválida/);
    expect(filePathSchema.safeParse(undefined).error?.issues[0]?.message).toBe("Falta la ruta");
  });
});

describe("fileNameSchema", () => {
  it("mide el límite de 255 bytes, no caracteres", () => {
    expect(fileNameSchema.safeParse("ñ".repeat(127)).success).toBe(true);
    expect(fileNameSchema.safeParse("ñ".repeat(130)).success).toBe(false);
    expect(fileNameSchema.safeParse("a".repeat(255)).success).toBe(true);
    expect(fileNameSchema.safeParse("a".repeat(256)).success).toBe(false);
  });
  it("acepta nombres normales y recorta espacios", () => {
    expect(fileNameSchema.parse("  plugins ")).toBe("plugins");
    expect(fileNameSchema.parse("mundo ñ (copia).zip")).toBe("mundo ñ (copia).zip");
  });
  it("rechaza vacíos, barras, puntos y control", () => {
    for (const n of ["", "  ", "a/b", ".", "..", "a\nb"]) expect(fileNameSchema.safeParse(n).success).toBe(false);
  });
});

describe("helpers de rutas", () => {
  it("join, parent y base", () => {
    expect(joinPath("/", "mods")).toBe("/mods");
    expect(joinPath("/mods", "a.jar")).toBe("/mods/a.jar");
    expect(parentPath("/mods/a.jar")).toBe("/mods");
    expect(parentPath("/mods")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(baseName("/mods/a.jar")).toBe("a.jar");
    expect(baseName("/")).toBe("");
  });
});

describe("editorLanguage", () => {
  it("elige lenguaje por extensión, sin distinguir mayúsculas", () => {
    expect(editorLanguage("server.properties")).toBe("properties");
    expect(editorLanguage("bukkit.YML")).toBe("yaml");
    expect(editorLanguage("ops.json")).toBe("json");
    expect(editorLanguage("lithium.toml")).toBe("toml");
    expect(editorLanguage("eula.txt")).toBe("text");
  });
  it("null para binarios y ficheros sin extensión", () => {
    expect(editorLanguage("lithium.jar")).toBeNull();
    expect(editorLanguage("level.dat")).toBeNull();
    expect(editorLanguage("README")).toBeNull();
  });
});
