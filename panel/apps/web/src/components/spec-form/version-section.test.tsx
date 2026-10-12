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
