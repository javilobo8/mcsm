import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { VersionSection } from "./version-section";
import { withType, type EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><VersionSection spec={spec} onChange={() => {}} /></QueryClientProvider>);

describe("VersionSection (server render, no DOM)", () => {
  it("Fabric shows Mods and not Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("MODRINTH_PROJECTS");
    expect(html).toContain("lithium");
    expect(html).not.toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CurseForge API key");
  });
  it("Paper shows Plugins and not Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER" });
    expect(html).toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CURSEFORGE_FILES");
  });
  it("a CurseForge modpack asks for the slug and shows the API key status", () => {
    const html = render({ ...withType(defaultSpecInput(), "AUTO_CURSEFORGE"), modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" } });
    expect(html).toContain("CurseForge modpack");
    expect(html).toContain("all-the-mods-9");
    expect(html).toContain("CurseForge API key");
    expect(html).not.toContain("Loader (optional)");
  });
  it("Vanilla without mods explains that it loads neither mods nor plugins", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).toContain("Vanilla does not load mods or plugins");
  });
});

describe("VersionSection: stable visibility", () => {
  it("Paper with empty mods but the section present still shows Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", mods: { modrinthProjects: [], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("CURSEFORGE_FILES");
  });
  it("Fabric with empty but present plugins still shows Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", plugins: { modrinthProjects: [], spigetResources: [], urls: [] } });
    expect(html).toContain("SPIGET_RESOURCES");
  });
});

describe("VersionSection: aria-describedby inherited from Field", () => {
  it("sf-version and sf-mp-slug reference their hint", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toMatch(/id="sf-mp-slug"[^>]*aria-describedby="sf-mp-slug-hint"|aria-describedby="sf-mp-slug-hint"[^>]*id="sf-mp-slug"/);
    expect(html).toContain('id="sf-version-hint"');
  });
});

describe("VersionSection: version and build picker (plan 10)", () => {
  it("Paper: version combobox with its hint, Paper build and the new Java hint", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1" });
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="sf-version"|<button[^>]*id="sf-version"[^>]*role="combobox"/);
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toContain("Paper build");
    expect(html).toContain('id="sf-build"');
    expect(html).toContain("java25 for 26.x");
  });
  it("modpack: version as free text and no build", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/<input[^>]*id="sf-version"/);
    expect(html).not.toContain('id="sf-build"');
  });
  it("Vanilla without build; Spigot warns about BUILD_FROM_SOURCE", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).not.toContain('id="sf-build"');
    const spigot = render({ ...defaultSpecInput(), type: "SPIGOT", version: "1.21.4" });
    expect(spigot).toContain("BUILD_FROM_SOURCE=true");
    expect(spigot).not.toContain('id="sf-build"');
  });
  it("with LATEST the build asks for a specific version", () => {
    expect(render({ ...defaultSpecInput(), type: "FABRIC", version: "LATEST" })).toContain("Choose a specific Minecraft version to pin the build");
  });
});
