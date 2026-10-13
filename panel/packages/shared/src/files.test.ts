import { describe, expect, it } from "vitest";
import { baseName, editorLanguage, fileNameSchema, filePathSchema, joinPath, normalizePath, parentPath } from "./files.js";

describe("normalizePath", () => {
  it("normalizes separators, dots and the root", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("mods//a.jar/")).toBe("/mods/a.jar");
    expect(normalizePath("./config/./a.yml")).toBe("/config/a.yml");
    expect(normalizePath("/mundo ñ/level.dat")).toBe("/mundo ñ/level.dat");
  });
  it("rejects .. and control characters instead of fixing them", () => {
    for (const p of ["../../etc/passwd", "/a/../b", "..", "a\u0000b", "a\nb", "a\rb"]) expect(normalizePath(p)).toBeNull();
  });
});

describe("path limit (4096 UTF-8 bytes)", () => {
  it("accepts exactly 4096 bytes, even if multibyte", () => {
    expect(normalizePath("ñ".repeat(2048))).toBe("/" + "ñ".repeat(2048));
    expect(normalizePath("a".repeat(4096))).not.toBeNull();
  });
  it("rejects 4097 bytes with a length message", () => {
    expect(normalizePath("ñ".repeat(2048) + "a")).toBeNull();
    expect(normalizePath("a".repeat(4097))).toBeNull();
    expect(filePathSchema.safeParse("ñ".repeat(2048) + "a").error?.issues[0]?.message).toMatch(/too long/);
  });
});

describe("filePathSchema", () => {
  it("returns the normalized path", () => {
    expect(filePathSchema.parse("mods/a.jar")).toBe("/mods/a.jar");
  });
  it("gives messages in English", () => {
    expect(filePathSchema.safeParse("../../etc/passwd").error?.issues[0]?.message).toMatch(/Invalid path/);
    expect(filePathSchema.safeParse(undefined).error?.issues[0]?.message).toBe("Missing path");
  });
});

describe("fileNameSchema", () => {
  it("measures the 255-byte limit, not characters", () => {
    expect(fileNameSchema.safeParse("ñ".repeat(127)).success).toBe(true);
    expect(fileNameSchema.safeParse("ñ".repeat(130)).success).toBe(false);
    expect(fileNameSchema.safeParse("a".repeat(255)).success).toBe(true);
    expect(fileNameSchema.safeParse("a".repeat(256)).success).toBe(false);
  });
  it("accepts normal names and trims spaces", () => {
    expect(fileNameSchema.parse("  plugins ")).toBe("plugins");
    expect(fileNameSchema.parse("mundo ñ (copia).zip")).toBe("mundo ñ (copia).zip");
  });
  it("rejects empty names, slashes, dots and control characters", () => {
    for (const n of ["", "  ", "a/b", ".", "..", "a\nb"]) expect(fileNameSchema.safeParse(n).success).toBe(false);
  });
});

describe("path helpers", () => {
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
  it("picks the language by extension, case-insensitively", () => {
    expect(editorLanguage("server.properties")).toBe("properties");
    expect(editorLanguage("bukkit.YML")).toBe("yaml");
    expect(editorLanguage("ops.json")).toBe("json");
    expect(editorLanguage("lithium.toml")).toBe("toml");
    expect(editorLanguage("eula.txt")).toBe("text");
  });
  it("null for binaries and files without an extension", () => {
    expect(editorLanguage("lithium.jar")).toBeNull();
    expect(editorLanguage("level.dat")).toBeNull();
    expect(editorLanguage("README")).toBeNull();
  });
});
