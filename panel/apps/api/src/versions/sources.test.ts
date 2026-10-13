import { describe, expect, it } from "vitest";
import { SOURCES, UpstreamError, allowedSource, forgeBuildId, neoforgeMcVersion, type Get, type GetOptions } from "./sources.js";

/** Fake `get`: returns each URL's document and records what was requested. */
function fakeGet(docs: Record<string, unknown>) {
  const asked: ({ url: string } & GetOptions)[] = [];
  const get: Get = async (url, schema, opts = {}) => {
    asked.push({ url, ...opts });
    if (!Object.hasOwn(docs, url)) throw new Error(`unexpected URL: ${url}`);
    // Like the catalog: validates with the adapter's schema and a foreign shape is UpstreamError.
    const r = schema.safeParse(docs[url]);
    if (!r.success) throw new UpstreamError(null, `unexpected response from ${url}`);
    return r.data;
  };
  return { get, asked };
}

const MOJANG = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FILL = "https://fill.papermc.io/v3/projects";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const FORGE_META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const FORGE_PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

describe("Vanilla (Mojang)", () => {
  it("releases and snapshots in the source's order; without old_alpha/old_beta", async () => {
    const { get } = fakeGet({ [MOJANG]: {
      latest: { release: "26.3", snapshot: "26.4-snapshot-3" },
      versions: [
        { id: "26.4-snapshot-3", type: "snapshot", url: "https://piston-meta.mojang.com/v1/packages/x/26.4-snapshot-3.json", releaseTime: "2026-10-06T12:54:26+00:00" },
        { id: "26.3", type: "release" }, { id: "1.21.11", type: "release" }, { id: "25w14a", type: "snapshot" }, { id: "b1.7.3", type: "old_beta" },
      ],
    } });
    expect(await SOURCES.VANILLA.versions(get)).toEqual([
      { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "1.21.11", stable: true }, { id: "25w14a", stable: false },
    ]);
    expect(SOURCES.VANILLA.builds).toBeUndefined();
  });
});

describe("Paper y Folia (Fill v3)", () => {
  it("flattens the families and sorts from newest to oldest", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: {
      project: { id: "paper", name: "Paper" },
      versions: { "26.3": ["26.3", "26.3-rc-3"], "1.21": ["1.21.11", "1.21.11-rc3", "1.21.10", "1.21"], "1.20": ["1.20.6", "1.20.1"] },
    } });
    expect(await SOURCES.PAPER.versions(get)).toEqual([
      { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false }, { id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false },
      { id: "1.21.10", stable: true }, { id: "1.21", stable: true }, { id: "1.20.6", stable: true }, { id: "1.20.1", stable: true },
    ]);
  });
  it("builds: only STABLE, with the builds cache", async () => {
    const url = `${FILL}/paper/versions/1.20.1/builds`;
    const { get, asked } = fakeGet({ [url]: [
      { id: 177, time: "2026-10-01T00:00:00Z", channel: "BETA", commits: [], downloads: {} },
      { id: 178, time: "2026-10-12T20:42:19Z", channel: "STABLE", commits: [], downloads: {} },
      { id: 176, time: "2026-09-30T00:00:00Z", channel: "STABLE", commits: [], downloads: {} },
    ] });
    expect(await SOURCES.PAPER.builds!(get, "1.20.1")).toEqual([
      { id: "178", stable: true, recommended: false }, { id: "176", stable: true, recommended: false },
    ]);
    expect(asked).toEqual([{ url, ttl: "builds" }]);
  });
  it("Folia uses its project", async () => {
    const { get } = fakeGet({ [`${FILL}/folia`]: { project: { id: "folia" }, versions: { "1.21": ["1.21.11"] } } });
    expect(await SOURCES.FOLIA.versions(get)).toEqual([{ id: "1.21.11", stable: true }]);
  });
  it("the version is encoded when building the URL", async () => {
    const { get, asked } = fakeGet({ [`${FILL}/paper/versions/1.21%2B1/builds`]: [] });
    await SOURCES.PAPER.builds!(get, "1.21+1");
    expect(asked[0]!.url).toBe(`${FILL}/paper/versions/1.21%2B1/builds`);
  });
  it("a response with another shape is UpstreamError (not a 500)", async () => {
    const { get } = fakeGet({ [`${FILL}/paper`]: "<html>maintenance</html>" });
    await expect(SOURCES.PAPER.versions(get)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("Purpur", () => {
  it("versions and builds from newest to oldest", async () => {
    const { get } = fakeGet({
      [PURPUR]: { project: "purpur", metadata: { current: "26.2" }, versions: ["1.14.1", "1.21.11", "26.1.2", "26.2"] },
      [`${PURPUR}/26.2`]: { project: "purpur", version: "26.2", builds: { latest: "2633", all: ["2593", "2600", "2633"] } },
    });
    expect((await SOURCES.PURPUR.versions(get)).map((v) => v.id)).toEqual(["26.2", "26.1.2", "1.21.11", "1.14.1"]);
    expect(await SOURCES.PURPUR.builds!(get, "26.2")).toEqual([
      { id: "2633", stable: true, recommended: false }, { id: "2600", stable: true, recommended: false }, { id: "2593", stable: true, recommended: false },
    ]);
  });
});

describe("Spigot (BuildTools index)", () => {
  it("only version names, without repeats or loose builds", async () => {
    const html = `<html><head><title>Index of /versions/</title></head><body><pre>
<a href="latest.json">latest.json</a>    15-Sep-2026 15:15   534
<a href="1.8.json">1.8.json</a>   16-Apr-2015 22:00   479
<a href="1.21.11.json">1.21.11.json</a>
<a href="26.1.json">26.1.json</a>
<a href="3000.json">3000.json</a>
<a href="1.21.11.json">1.21.11.json</a>
</pre></body></html>`;
    const { get, asked } = fakeGet({ "https://hub.spigotmc.org/versions/": html });
    expect(await SOURCES.SPIGOT.versions(get)).toEqual([{ id: "26.1", stable: true }, { id: "1.21.11", stable: true }, { id: "1.8", stable: true }]);
    expect(asked[0]).toMatchObject({ kind: "text" });
    expect(SOURCES.SPIGOT.builds).toBeUndefined();
  });
});

describe("Fabric y Quilt", () => {
  it("Fabric: versions and loaders with their stable flag", async () => {
    const { get } = fakeGet({
      "https://meta.fabricmc.net/v2/versions/game": [{ version: "26.4-snapshot-3", stable: false }, { version: "26.3", stable: true }],
      "https://meta.fabricmc.net/v2/versions/loader/26.3": [
        { loader: { separator: ".", build: 5, maven: "net.fabricmc:fabric-loader:0.19.5", version: "0.19.5", stable: true }, intermediary: {}, launcherMeta: {} },
        { loader: { version: "0.19.4", stable: false }, intermediary: {}, launcherMeta: {} },
      ],
    });
    expect(await SOURCES.FABRIC.versions(get)).toEqual([{ id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }]);
    expect(await SOURCES.FABRIC.builds!(get, "26.3")).toEqual([
      { id: "0.19.5", stable: true, recommended: false }, { id: "0.19.4", stable: false, recommended: false },
    ]);
  });
  it("Quilt: loaders arrive unordered; beta = with a suffix", async () => {
    const { get } = fakeGet({
      "https://meta.quiltmc.org/v3/versions/loader/26.3": [
        { loader: { version: "0.20.0-beta.9" } }, { loader: { version: "0.24.0" } }, { loader: { version: "0.20.0-beta.10" } },
      ],
    });
    expect(await SOURCES.QUILT.builds!(get, "26.3")).toEqual([
      { id: "0.24.0", stable: true, recommended: false }, { id: "0.20.0-beta.10", stable: false, recommended: false }, { id: "0.20.0-beta.9", stable: false, recommended: false },
    ]);
  });
});

describe("Forge", () => {
  const docs = {
    [FORGE_META]: {
      "1.7.10_pre4": ["1.7.10_pre4-10.12.2.1149-prerelease"],
      "1.7.10": ["1.7.10-10.13.4.1566-1.7.10", "1.7.10-10.13.4.1614-1.7.10"],
      "1.20.1": ["1.20.1-47.4.26", "1.20.1-47.4.27", "1.20.1-47.4.0"],
      "26.3": ["26.3-66.0.0", "26.3-66.0.11"],
    },
    [FORGE_PROMOS]: { homepage: "https://files.minecraftforge.net/net/minecraftforge/forge/", promos: { "1.20.1-latest": "47.4.27", "1.20.1-recommended": "47.4.0" } },
  };
  it("MC versions = metadata keys", async () => {
    expect(await SOURCES.FORGE.versions(fakeGet(docs).get)).toEqual([
      { id: "26.3", stable: true }, { id: "1.20.1", stable: true }, { id: "1.7.10", stable: true }, { id: "1.7.10_pre4", stable: false },
    ]);
  });
  it("builds without the version prefix, with the recommended one marked", async () => {
    expect(await SOURCES.FORGE.builds!(fakeGet(docs).get, "1.20.1")).toEqual([
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26", stable: true, recommended: false }, { id: "47.4.0", stable: true, recommended: true },
    ]);
    expect(await SOURCES.FORGE.builds!(fakeGet(docs).get, "1.12.2")).toEqual([]);
    expect(forgeBuildId("1.7.10-10.13.4.1614-1.7.10", "1.7.10")).toBe("10.13.4.1614");
  });
});

describe("NeoForge", () => {
  const docs = { [NEOFORGE]: { isSnapshot: false, versions: [
    "0.25w14craftmine.3-beta", "20.2.3-beta", "20.4.237", "21.0.167", "21.1.77", "21.1.228", "26.1.0.0-alpha", "26.1.2.5", "26.3.0.75-beta", "26.3.0.76",
  ] } };
  it("deduced MC version", () => {
    expect(["26.3.0.76", "26.1.2.5", "21.0.167", "21.1.77", "20.2.3-beta", "0.25w14craftmine.3-beta", "19.1.2", "26.1"].map(neoforgeMcVersion))
      .toEqual(["26.3", "26.1.2", "1.21", "1.21.1", "1.20.2", null, null, null]);
  });
  it("unique versions and builds filtered by version", async () => {
    expect((await SOURCES.NEOFORGE.versions(fakeGet(docs).get)).map((v) => v.id)).toEqual(["26.3", "26.1.2", "26.1", "1.21.1", "1.21", "1.20.4", "1.20.2"]);
    expect(await SOURCES.NEOFORGE.builds!(fakeGet(docs).get, "1.21.1")).toEqual([
      { id: "21.1.228", stable: true, recommended: false }, { id: "21.1.77", stable: true, recommended: false },
    ]);
    expect(await SOURCES.NEOFORGE.builds!(fakeGet(docs).get, "26.3")).toEqual([
      { id: "26.3.0.76", stable: true, recommended: false }, { id: "26.3.0.75-beta", stable: false, recommended: false },
    ]);
  });
});

describe("allowedSource", () => {
  it("only HTTPS and only the sources' hosts", () => {
    expect(allowedSource(`${PURPUR}/26.2`)).toBe(true);
    expect(allowedSource(FORGE_PROMOS)).toBe(true);
    expect(allowedSource("http://api.purpurmc.org/v2/purpur")).toBe(false);
    expect(allowedSource("https://evil.example/v2/purpur")).toBe(false);
    expect(allowedSource("not a url")).toBe(false);
  });
});
