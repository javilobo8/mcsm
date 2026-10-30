import type { PackInfoDto } from "@mcsm/shared";
import { unzipSync } from "fflate";
import { z } from "zod";
import { UpstreamError } from "../versions/sources.js";
import { JSON_MAX_BYTES } from "./http.js";

/** Modpack archives: `.mrpack` (modrinth.index.json) and CurseForge zips (manifest.json). */

export interface MrpackIndex {
  versionId: string;
  name: string;
  dependencies: Record<string, string>;
  files: { path: string; sha1: string; server: "required" | "optional" | "unsupported" | null }[];
}

export interface CfPackManifest {
  minecraftVersion: string;
  loaderId: string | null;
  files: { projectId: number; fileId: number; required: boolean }[];
}

const side = z.enum(["required", "optional", "unsupported"]);

const mrpackSchema = z.object({
  versionId: z.string(),
  name: z.string(),
  dependencies: z.record(z.string(), z.string()),
  files: z.array(z.object({
    path: z.string(),
    hashes: z.object({ sha1: z.string().regex(/^[0-9a-fA-F]{40}$/) }),
    env: z.object({ server: side.optional() }).optional(),
  })),
});

const cfManifestSchema = z.object({
  minecraft: z.object({
    version: z.string(),
    modLoaders: z.array(z.object({ id: z.string(), primary: z.boolean().optional() })).default([]),
  }),
  files: z.array(z.object({ projectID: z.number().int().positive(), fileID: z.number().int().positive(), required: z.boolean().default(true) })),
});

export function readMrpackIndex(zip: Uint8Array): MrpackIndex {
  const doc = mrpackSchema.safeParse(readJson(zip, "modrinth.index.json"));
  if (!doc.success) throw new UpstreamError(null, "the pack's modrinth.index.json has an unexpected shape");
  return {
    versionId: doc.data.versionId,
    name: doc.data.name,
    dependencies: doc.data.dependencies,
    files: doc.data.files.map((f) => ({ path: f.path, sha1: f.hashes.sha1.toLowerCase(), server: f.env?.server ?? null })),
  };
}

export function readCurseForgeManifest(zip: Uint8Array): CfPackManifest {
  const doc = cfManifestSchema.safeParse(readJson(zip, "manifest.json"));
  if (!doc.success) throw new UpstreamError(null, "the pack's manifest.json has an unexpected shape");
  const loaders = doc.data.minecraft.modLoaders;
  return {
    minecraftVersion: doc.data.minecraft.version,
    loaderId: (loaders.find((l) => l.primary) ?? loaders[0])?.id ?? null,
    files: doc.data.files.map((f) => ({ projectId: f.projectID, fileId: f.fileID, required: f.required })),
  };
}

const LOADER_DEPS: [string, NonNullable<PackInfoDto["loader"]>][] = [
  ["fabric-loader", "fabric"], ["quilt-loader", "quilt"], ["neoforge", "neoforge"], ["forge", "forge"],
];

/** Loader of a `.mrpack` from its `dependencies`. */
export function loaderOf(deps: Record<string, string>): { loader: PackInfoDto["loader"]; version: string | null } {
  for (const [key, loader] of LOADER_DEPS) {
    const v = deps[key];
    if (v !== undefined) return { loader, version: v };
  }
  return { loader: null, version: null };
}

/** Parses one JSON file at the root of the zip; the file may not inflate beyond JSON_MAX_BYTES. */
function readJson(zip: Uint8Array, name: string): unknown {
  let files: Record<string, Uint8Array>;
  let tooLarge = false;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        if (f.name !== name) return false;
        if (f.originalSize > JSON_MAX_BYTES) { tooLarge = true; return false; }
        return true;
      },
    });
  } catch {
    throw new UpstreamError(null, "the pack is not a valid zip");
  }
  if (tooLarge) throw new UpstreamError(null, `the pack's ${name} is too large`);
  const data = files[name];
  if (!data) throw new UpstreamError(null, `the pack has no ${name}`);
  try {
    return JSON.parse(Buffer.from(data).toString("utf8")) as unknown;
  } catch {
    throw new UpstreamError(null, `the pack's ${name} is not valid JSON`);
  }
}
