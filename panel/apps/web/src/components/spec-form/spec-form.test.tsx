import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { SpecForm, sectionOfField } from "./spec-form";
import type { EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec, mode: "server" | "template", routerHidden?: string) =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SpecForm value={spec} onChange={() => {}} onError={() => {}} mode={mode} general={<p>general content</p>} routerHidden={routerHidden} />
    </QueryClientProvider>,
  );

describe("SpecForm (server render, no DOM)", () => {
  const modded: EditableSpec = {
    ...defaultSpecInput(), type: "AUTO_CURSEFORGE", version: "1.20.1",
    modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" },
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    properties: { motd: "Hello", difficulty: "hard", "max-players": "8", "custom-x": "1" },
    whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"], env: { USE_AIKAR_FLAGS: "true" },
    ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
  };

  it("renders all the sections (forceMount) with values", () => {
    const html = render(modded, "server");
    for (const t of ["General", "Version and mods", "Properties", "Players", "Network", "Resources", "Advanced", "general content"]) expect(html).toContain(t);
    for (const v of ["all-the-mods-9", "lithium", "Lobo", "custom-x=1", "USE_AIKAR_FLAGS=true", "Geyser", "CurseForge API key"]) expect(html).toContain(v);
    expect(html).not.toContain("Backups");
  });

  it("templates have no Network section", () => {
    const html = render({ ...defaultSpecInput(), ports: { extra: [] } }, "template");
    expect(html).not.toContain("Game port");
    expect(html).toContain("Advanced");
  });

  it("plan-8: with routerHidden (import) the router section is not rendered, that text is", () => {
    expect(render(defaultSpecInput(), "server")).toContain("Router (mc-router)");
    const html = render(defaultSpecInput(), "server", "THE ROUTER IS ENABLED LATER");
    expect(html).not.toContain("Router (mc-router)");
    expect(html).toContain("THE ROUTER IS ENABLED LATER");
    expect(html).toContain("Game port");
  });

  it("absent is not empty: without ops/whitelist it offers to manage them and there is no stop-managing button", () => {
    const html = render(defaultSpecInput(), "server");
    expect(html).not.toContain("Stop managing");
    expect(html).toContain("Not managed");
    expect(render(modded, "server")).toContain("Stop managing");
  });

  it("truthful texts: without a RAM limit the agent applies memory + 1G; when editing, the empty port is kept", () => {
    const html = render(modded, "server");
    expect(html).toContain("Empty = JVM memory + 1G");
    expect(html).toContain("Empty = the current port is kept");
    expect(html).not.toContain("the panel picks a free one");
  });

  it("Players warns (in its section) about the env variables that would override it", () => {
    const html = render({ ...modded, env: { OPS: "Lobo,Pepe" } }, "server");
    expect(html).toContain("Remove the OPS variable from the environment variables");
  });

  it("each field is assigned to its tab", () => {
    expect(sectionOfField("sf-mods-urls")).toBe("Version and mods");
    expect(sectionOfField("sf-dp-modrinth")).toBe("Version and mods");
    expect(sectionOfField("sf-content-mods")).toBe("Version and mods");
    expect(sectionOfField("sf-prop-motd")).toBe("Properties");
    expect(sectionOfField("sf-props-other")).toBe("Properties");
    expect(sectionOfField("sf-ops")).toBe("Players");
    expect(sectionOfField("sf-extra-ports")).toBe("Network");
    expect(sectionOfField("sf-rcon-port")).toBe("Network");
    expect(sectionOfField("sf-rcon-port-input")).toBe("Network");
    expect(sectionOfField("sf-memlimit")).toBe("Resources");
    expect(sectionOfField("sf-env")).toBe("Advanced");
    expect(sectionOfField("other")).toBe("General");
  });
});

import { duplicateHostPorts } from "./network-section";
describe("duplicate host ports", () => {
  it("detects game vs extra and among extras, by protocol", () => {
    const x = (host: number, proto: "tcp" | "udp") => ({ host, container: 1, proto, label: "" });
    expect(duplicateHostPorts(25565, [x(25565, "tcp")])).toEqual(["25565/tcp"]);
    expect(duplicateHostPorts(25565, [x(25565, "udp")])).toEqual([]);
    expect(duplicateHostPorts(undefined, [x(8100, "tcp"), x(8100, "tcp"), x(0, "tcp"), x(0, "tcp")])).toEqual(["8100/tcp"]);
  });
});
