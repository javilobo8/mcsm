import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { UpstreamError } from "../versions/sources.js";
import { loaderOf, readCurseForgeManifest, readMrpackIndex } from "./pack.js";

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const INDEX = {
  formatVersion: 1, game: "minecraft", versionId: "5.0.1", name: "Fabulously Optimized",
  dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" },
  files: [
    { path: "mods/sodium.jar", hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) }, env: { client: "required", server: "required" }, downloads: ["https://cdn.modrinth.com/x"], fileSize: 1 },
    { path: "mods/zoom.jar", hashes: { sha1: "c".repeat(40) }, env: { client: "required", server: "unsupported" }, downloads: [], fileSize: 1 },
    { path: "config/x.txt", hashes: { sha1: "d".repeat(40) }, downloads: [], fileSize: 1 },
  ],
};

describe("readMrpackIndex", () => {
  it("reads modrinth.index.json with each file's server side", () => {
    const idx = readMrpackIndex(zip({ "modrinth.index.json": JSON.stringify(INDEX), "overrides/a.txt": "x" }));
    expect(idx).toEqual({
      versionId: "5.0.1", name: "Fabulously Optimized", dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" },
      files: [
        { path: "mods/sodium.jar", sha1: "a".repeat(40), server: "required" },
        { path: "mods/zoom.jar", sha1: "c".repeat(40), server: "unsupported" },
        { path: "config/x.txt", sha1: "d".repeat(40), server: null },
      ],
    });
    expect(loaderOf(idx.dependencies)).toEqual({ loader: "fabric", version: "0.16.9" });
  });

  it("a pack without the index, or with a broken one, is an UpstreamError", () => {
    expect(() => readMrpackIndex(zip({ "a.txt": "x" }))).toThrow(new UpstreamError(null, "the pack has no modrinth.index.json"));
    expect(() => readMrpackIndex(zip({ "modrinth.index.json": "{not json" }))).toThrow(UpstreamError);
    expect(() => readMrpackIndex(zip({ "modrinth.index.json": JSON.stringify({ files: "x" }) }))).toThrow(UpstreamError);
    expect(() => readMrpackIndex(new Uint8Array([1, 2, 3]))).toThrow(UpstreamError);
  });
});

describe("loaderOf", () => {
  it("maps each loader dependency", () => {
    expect(loaderOf({ minecraft: "1.21.1", "quilt-loader": "0.27.1" })).toEqual({ loader: "quilt", version: "0.27.1" });
    expect(loaderOf({ forge: "47.3.0" })).toEqual({ loader: "forge", version: "47.3.0" });
    expect(loaderOf({ neoforge: "21.1.77" })).toEqual({ loader: "neoforge", version: "21.1.77" });
    expect(loaderOf({ minecraft: "1.21.1" })).toEqual({ loader: null, version: null });
  });
});

describe("readCurseForgeManifest", () => {
  it("reads the game version, the primary loader and the files", () => {
    const manifest = {
      minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-46.0.1", primary: false }, { id: "forge-47.3.0", primary: true }] },
      manifestType: "minecraftModpack", manifestVersion: 1, name: "ATM9", version: "1.0",
      files: [{ projectID: 238222, fileID: 4712866, required: true }, { projectID: 1, fileID: 2, required: false }],
      overrides: "overrides",
    };
    expect(readCurseForgeManifest(zip({ "manifest.json": JSON.stringify(manifest) }))).toEqual({
      minecraftVersion: "1.20.1", loaderId: "forge-47.3.0",
      files: [{ projectId: 238222, fileId: 4712866, required: true }, { projectId: 1, fileId: 2, required: false }],
    });
  });

  it("without a primary loader takes the first; without loaders, null", () => {
    const m = (modLoaders: unknown[]) => zip({ "manifest.json": JSON.stringify({ minecraft: { version: "1.20.1", modLoaders }, files: [] }) });
    expect(readCurseForgeManifest(m([{ id: "neoforge-21.1.1" }])).loaderId).toBe("neoforge-21.1.1");
    expect(readCurseForgeManifest(m([])).loaderId).toBeNull();
  });

  it("a pack without manifest.json is an UpstreamError", () => {
    expect(() => readCurseForgeManifest(zip({ "a.txt": "x" }))).toThrow(new UpstreamError(null, "the pack has no manifest.json"));
  });
});
