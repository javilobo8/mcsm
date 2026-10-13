import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { VersionSection } from "./version-section";
import { withType, type EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><VersionSection spec={spec} onChange={() => {}} /></QueryClientProvider>);

describe("VersionSection (render en servidor, sin DOM)", () => {
  it("Fabric muestra Mods y no Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("MODRINTH_PROJECTS");
    expect(html).toContain("lithium");
    expect(html).not.toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("API key de CurseForge");
  });
  it("Paper muestra Plugins y no Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER" });
    expect(html).toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CURSEFORGE_FILES");
  });
  it("un modpack de CurseForge pide el slug y muestra el estado de la API key", () => {
    const html = render({ ...withType(defaultSpecInput(), "AUTO_CURSEFORGE"), modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" } });
    expect(html).toContain("Modpack de CurseForge");
    expect(html).toContain("all-the-mods-9");
    expect(html).toContain("API key de CurseForge");
    expect(html).not.toContain("Loader (opcional)");
  });
  it("Vanilla sin mods explica que no carga mods ni plugins", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).toContain("Vanilla no carga mods ni plugins");
  });
});

describe("VersionSection: visibilidad estable", () => {
  it("Paper con mods vacíos pero la sección presente sigue mostrando Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", mods: { modrinthProjects: [], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("CURSEFORGE_FILES");
  });
  it("Fabric con plugins vacíos pero presentes sigue mostrando Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", plugins: { modrinthProjects: [], spigetResources: [], urls: [] } });
    expect(html).toContain("SPIGET_RESOURCES");
  });
});

describe("VersionSection: aria-describedby heredado de Field", () => {
  it("sf-version y sf-mp-slug referencian su hint", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toMatch(/id="sf-mp-slug"[^>]*aria-describedby="sf-mp-slug-hint"|aria-describedby="sf-mp-slug-hint"[^>]*id="sf-mp-slug"/);
    expect(html).toContain('id="sf-version-hint"');
  });
});

describe("VersionSection: selector de versión y build (plan 10)", () => {
  it("Paper: combobox de versión con su hint, build de Paper y la pista de Java nueva", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1" });
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="sf-version"|<button[^>]*id="sf-version"[^>]*role="combobox"/);
    expect(html).toMatch(/id="sf-version"[^>]*aria-describedby="sf-version-hint"|aria-describedby="sf-version-hint"[^>]*id="sf-version"/);
    expect(html).toContain("Build de Paper");
    expect(html).toContain('id="sf-build"');
    expect(html).toContain("java25 para 26.x");
  });
  it("modpack: versión como texto libre y sin build", () => {
    const html = render({ ...withType(defaultSpecInput(), "MODRINTH"), modpack: { platform: "MODRINTH", slugOrUrl: "x", versionId: "", loader: "" } });
    expect(html).toMatch(/<input[^>]*id="sf-version"/);
    expect(html).not.toContain('id="sf-build"');
  });
  it("Vanilla sin build; Spigot avisa de BUILD_FROM_SOURCE", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).not.toContain('id="sf-build"');
    const spigot = render({ ...defaultSpecInput(), type: "SPIGOT", version: "1.21.4" });
    expect(spigot).toContain("BUILD_FROM_SOURCE=true");
    expect(spigot).not.toContain('id="sf-build"');
  });
  it("con LATEST el build pide una versión concreta", () => {
    expect(render({ ...defaultSpecInput(), type: "FABRIC", version: "LATEST" })).toContain("Elige una versión concreta de Minecraft para fijar el build");
  });
});
