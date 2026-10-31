import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ContentVersionDto, type PackInfoDto } from "@mcsm/shared";
import { ApiError } from "./api";
import { installedPackIds, packChange, packDetailsError, packRefOf, packSlugOrUrl, withPackInstalled, withPackUninstalled, type PackRef } from "./content-pack";
import { buildSpecPatch, type EditableSpec } from "./spec-edit";

const info: PackInfoDto = {
  platform: "modrinth", projectId: "P0000001", slug: "cobblemon", versionId: "V0000002", name: "Cobblemon", versionLabel: "1.6.1",
  iconUrl: null, minecraftVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.9", contents: [], contentsKnown: true, reason: null,
};
const cfInfo: PackInfoDto = { ...info, platform: "curseforge", projectId: "925200", slug: "all-the-mods-10", versionId: "6000001", loader: "neoforge", loaderVersion: "21.1.77" };
const ver = (versionId: string): ContentVersionDto => ({
  platform: "modrinth", projectId: "P0000001", versionId, label: versionId, type: "release", publishedAt: "", gameVersions: [], loaders: [], dependencies: [], installable: true, reason: null,
});
const versions = [ver("V0000003"), ver("V0000002"), ver("V0000001")]; // newest first
const mp = (slugOrUrl: string, versionId: string, platform: "MODRINTH" | "AUTO_CURSEFORGE" = "MODRINTH") => ({ platform, slugOrUrl, versionId, loader: "" as const });
const modrinthPackSpec: EditableSpec = { ...defaultSpecInput(), type: "MODRINTH", version: "LATEST", modpack: { ...mp("P0000001", "V0000002"), loader: "fabric" } };

describe("packChange", () => {
  it("none, install, uninstall and switch", () => {
    expect(packChange(undefined, undefined, versions)).toBe("none");
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000002"), undefined)).toBe("none");
    expect(packChange(undefined, mp("P0000001", "V0000002"), versions)).toBe("install");
    expect(packChange(mp("P0000001", "V0000002"), undefined, versions)).toBe("uninstall");
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000009", "V0000002"), versions)).toBe("switch");
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000002", "AUTO_CURSEFORGE"), versions)).toBe("switch");
  });
  it("packChange detects downgrade by position in the version list", () => {
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000001"), versions)).toBe("downgrade");
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000003"), versions)).toBe("upgrade");
  });
  it("unknown when a version is not in the list or the list is not loaded", () => {
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000009"), versions)).toBe("unknown");
    expect(packChange(mp("P0000001", ""), mp("P0000001", "V0000002"), versions)).toBe("unknown");
    expect(packChange(mp("P0000001", "V0000002"), mp("P0000001", "V0000001"), undefined)).toBe("unknown");
  });
});

describe("withPackInstalled", () => {
  it("turns a Paper server into a pinned Modrinth pack with its Minecraft version", () => {
    const s = withPackInstalled({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1", build: "196" }, info);
    expect(s).toMatchObject({ type: "MODRINTH", version: "1.21.1", build: "", imageTag: "java21", modpack: { platform: "MODRINTH", slugOrUrl: "P0000001", versionId: "V0000002", loader: "fabric" } });
  });
  it("CurseForge packs use the slug and no loader", () => {
    const s = withPackInstalled({ ...defaultSpecInput(), type: "FABRIC" }, cfInfo);
    expect(s).toMatchObject({ type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10", versionId: "6000001", loader: "" } });
  });
  it("keeps the version when the pack does not say it and adds no build to old specs", () => {
    const old = { ...defaultSpecInput(), type: "VANILLA", version: "1.21.4" };
    delete (old as { build?: string }).build;
    const s = withPackInstalled(old, { ...info, minecraftVersion: null });
    expect(s.version).toBe("1.21.4");
    expect(s).not.toHaveProperty("build");
  });
});

describe("withPackUninstalled", () => {
  it("uninstalling a pack turns it into its loader with the pack's versions", () => {
    const r = withPackUninstalled(modrinthPackSpec, { ...info, loader: "fabric", minecraftVersion: "1.21.1", loaderVersion: "0.16.9" });
    expect(r).toMatchObject({ ok: true, spec: { type: "FABRIC", version: "1.21.1", build: "0.16.9" } });
    expect((r as { spec: EditableSpec }).spec.modpack).toBeUndefined();
  });
  it("an invalid loader version leaves the build empty", () => {
    const r = withPackUninstalled(modrinthPackSpec, { ...cfInfo, loaderVersion: "bad version" });
    expect(r).toMatchObject({ ok: true, spec: { type: "NEOFORGE", version: "1.21.1", build: "" } });
  });
  it("uninstalling refuses without a known loader", () => {
    const err = { ok: false, error: "The modpack's loader is unknown: choose the server type by hand" };
    expect(withPackUninstalled(modrinthPackSpec, null)).toEqual(err);
    expect(withPackUninstalled(modrinthPackSpec, { ...info, loader: null })).toEqual(err);
    expect(withPackUninstalled(modrinthPackSpec, { ...info, minecraftVersion: null })).toEqual(err);
  });
  it("the modpack section is removed with null in the PATCH", () => {
    const r = withPackUninstalled(modrinthPackSpec, info);
    expect(r.ok && buildSpecPatch(modrinthPackSpec, r.spec)).toMatchObject({ modpack: null, type: "FABRIC" });
  });
});

describe("packSlugOrUrl", () => {
  it("Modrinth uses the project id and CurseForge the slug", () => {
    expect(packSlugOrUrl(info)).toBe("P0000001");
    expect(packSlugOrUrl(cfInfo)).toBe("all-the-mods-10");
  });
});

describe("packRefOf", () => {
  it("Modrinth packs are looked up by id or slug, URLs by their last segment", () => {
    expect(packRefOf(mp("P0000001", "V0000002"))).toEqual({ platform: "modrinth", projectId: "P0000001", slug: null, versionId: "V0000002" });
    expect(packRefOf(mp("https://modrinth.com/modpack/cobblemon-fabric", ""))).toEqual({ platform: "modrinth", projectId: "cobblemon-fabric", slug: null, versionId: "" });
  });
  it("CurseForge packs by numeric id, or by slug (the id is found by searching)", () => {
    expect(packRefOf(mp("925200", "6000001", "AUTO_CURSEFORGE"))).toEqual({ platform: "curseforge", projectId: "925200", slug: null, versionId: "6000001" });
    expect(packRefOf(mp("all-the-mods-10", "", "AUTO_CURSEFORGE"))).toEqual({ platform: "curseforge", projectId: null, slug: "all-the-mods-10", versionId: "" });
    expect(packRefOf(mp("https://www.curseforge.com/minecraft/modpacks/all-the-mods-10/files/6000001", "", "AUTO_CURSEFORGE")))
      .toEqual({ platform: "curseforge", projectId: null, slug: "all-the-mods-10", versionId: "" });
  });
  it("nothing to look up for FTB, an empty pack or no pack", () => {
    expect(packRefOf(undefined)).toBeNull();
    expect(packRefOf({ platform: "FTBA", slugOrUrl: "23", versionId: "", loader: "" })).toBeNull();
    expect(packRefOf(mp("", ""))).toBeNull();
    expect(packRefOf(mp("not a slug!", ""))).toBeNull();
  });
});

describe("installedPackIds", () => {
  const labelled = (versionId: string, label: string, type: ContentVersionDto["type"] = "release") => ({ ...ver(versionId), label, type });
  const list = [labelled("V0000003", "1.7.0-beta", "beta"), labelled("V0000002", "1.6.1"), labelled("V0000001", "1.6.0")];
  const ref = (projectId: string | null, versionId: string, platform: PackRef["platform"] = "modrinth"): PackRef => ({ platform, projectId, slug: null, versionId });

  it("a Modrinth pack typed as a slug is asked about by that slug (the panel resolves it)", () => {
    expect(installedPackIds(ref("cobblemon", "V0000002"), null, list)).toEqual({ projectId: "cobblemon", versionId: "V0000002" });
    expect(installedPackIds(ref("cobblemon", "1.6.1"), null, list)).toEqual({ projectId: "cobblemon", versionId: "V0000002" });
    expect(installedPackIds(ref("cobblemon", "V0000002"), null, undefined)).toEqual({ projectId: "cobblemon", versionId: "V0000002" });
  });
  it("matches the version by id or by a hand-typed label; empty means the newest release", () => {
    expect(installedPackIds(ref("P0000001", "1.6.0"), null, list).versionId).toBe("V0000001");
    expect(installedPackIds(ref("cobblemon", ""), null, list).versionId).toBe("V0000002");
    expect(installedPackIds(ref("cobblemon", ""), null, undefined).versionId).toBeNull();
  });
  it("keeps a version id the list does not hold (it may be older); an unknown label is not a version", () => {
    expect(installedPackIds(ref("cobblemon", "OldVer01"), null, list).versionId).toBe("OldVer01");
    expect(installedPackIds(ref("cobblemon", "0.9.9"), null, list).versionId).toBeNull();
    expect(installedPackIds(ref("925200", "5999999", "curseforge"), null, [{ ...ver("6000001"), platform: "curseforge", projectId: "925200" }]))
      .toEqual({ projectId: "925200", versionId: "5999999" });
  });
  it("a CurseForge slug takes the id the search found", () => {
    expect(installedPackIds({ platform: "curseforge", projectId: null, slug: "atm10", versionId: "" }, null, undefined)).toEqual({ projectId: null, versionId: null });
    expect(installedPackIds({ platform: "curseforge", projectId: null, slug: "atm10", versionId: "6000001" }, "925200", undefined).projectId).toBe("925200");
  });
});

describe("packDetailsError", () => {
  const base = { modpack: mp("cobblemon", "V0000002"), ref: packRefOf(mp("cobblemon", "V0000002")), slugNotFound: false, error: null, versionsLoaded: false, versionId: null };

  it("null while the details may still come, or once they did", () => {
    expect(packDetailsError(base)).toBeNull();
    expect(packDetailsError({ ...base, versionsLoaded: true, versionId: "V0000002" })).toBeNull();
    expect(packDetailsError({ ...base, modpack: undefined, ref: null })).toBeNull();
    expect(packDetailsError({ ...base, modpack: { platform: "FTBA", slugOrUrl: "23", versionId: "", loader: "" }, ref: null })).toBeNull();
  });
  it("says why they never will", () => {
    expect(packDetailsError({ ...base, modpack: mp("", ""), ref: null })).toBe("No modpack chosen yet");
    expect(packDetailsError({ ...base, modpack: mp("not a slug!", ""), ref: null })).toBe("The modpack is written in a way the browser cannot look up: use Edit as text");
    const cf = mp("atm10", "", "AUTO_CURSEFORGE");
    expect(packDetailsError({ ...base, modpack: cf, ref: packRefOf(cf), slugNotFound: true })).toBe("“atm10” was not found on CurseForge: check it with Edit as text");
    expect(packDetailsError({ ...base, versionsLoaded: true, modpack: mp("cobblemon", "0.9.9"), ref: packRefOf(mp("cobblemon", "0.9.9")) }))
      .toBe("Version “0.9.9” of the modpack was not found");
    expect(packDetailsError({ ...base, versionsLoaded: true, modpack: mp("cobblemon", ""), ref: packRefOf(mp("cobblemon", "")) }))
      .toBe("The modpack has no release to install");
  });
  it("shows a 404 as the panel says it, anything else as a failure to load", () => {
    expect(packDetailsError({ ...base, error: new ApiError(404, "Version not found on Modrinth") })).toBe("Version not found on Modrinth");
    expect(packDetailsError({ ...base, error: new ApiError(502, "Could not query Modrinth") })).toBe("Could not load the modpack's details: Could not query Modrinth");
  });
});
