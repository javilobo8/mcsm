import { describe, expect, it } from "vitest";
import { contentParams, contentUrls } from "./use-content";

describe("content URLs", () => {
  it("joins list parameters with commas and drops absent values", () => {
    expect(contentParams({ kind: "mod", loaders: ["quilt", "fabric"], gameVersion: undefined, offset: 0 })).toBe("kind=mod&loaders=quilt%2Cfabric&offset=0");
  });
  it("builds the search URL from the query", () => {
    expect(contentUrls.search("modrinth", { kind: "mod", q: "sodium extra", gameVersion: "1.21.1", loaders: ["fabric"], sort: "downloads", offset: 20 }))
      .toBe("/api/content/modrinth/search?kind=mod&q=sodium+extra&gameVersion=1.21.1&loaders=fabric&sort=downloads&offset=20");
  });
  it("encodes every path value", () => {
    expect(contentUrls.project("modrinth", "../x?y")).toBe("/api/content/modrinth/projects/..%2Fx%3Fy");
    expect(contentUrls.pack("curseforge", "925200", "6000001")).toBe("/api/content/curseforge/packs/925200/6000001");
    expect(contentUrls.versions("modrinth", "AANobbMI", { kind: "mod", gameVersion: "1.21.1", loaders: ["fabric", "quilt"] }))
      .toBe("/api/content/modrinth/projects/AANobbMI/versions?kind=mod&gameVersion=1.21.1&loaders=fabric%2Cquilt");
    expect(contentUrls.categories("curseforge", "plugin")).toBe("/api/content/curseforge/categories?kind=plugin");
  });
});
