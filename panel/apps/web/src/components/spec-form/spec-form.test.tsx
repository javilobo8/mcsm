import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { SpecForm, sectionOfField } from "./spec-form";
import type { EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec, mode: "server" | "template") =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SpecForm value={spec} onChange={() => {}} onError={() => {}} mode={mode} general={<p>contenido general</p>} />
    </QueryClientProvider>,
  );

describe("SpecForm (render en servidor, sin DOM)", () => {
  const modded: EditableSpec = {
    ...defaultSpecInput(), type: "AUTO_CURSEFORGE", version: "1.20.1",
    modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" },
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    properties: { motd: "Hola", difficulty: "hard", "max-players": "8", "custom-x": "1" },
    whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"], env: { USE_AIKAR_FLAGS: "true" },
    ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
  };

  it("pinta todas las secciones (forceMount) con valores", () => {
    const html = render(modded, "server");
    for (const t of ["General", "Versión y mods", "Propiedades", "Jugadores", "Red", "Recursos", "Avanzado", "contenido general"]) expect(html).toContain(t);
    for (const v of ["all-the-mods-9", "lithium", "Lobo", "custom-x=1", "USE_AIKAR_FLAGS=true", "Geyser", "API key de CurseForge"]) expect(html).toContain(v);
    expect(html).not.toContain("Backups");
  });

  it("en plantillas no hay sección Red", () => {
    const html = render({ ...defaultSpecInput(), ports: { extra: [] } }, "template");
    expect(html).not.toContain("Puerto de juego");
    expect(html).toContain("Avanzado");
  });

  it("ausente no es vacío: sin ops/whitelist se ofrece gestionarlos y no hay botón de dejar de gestionar", () => {
    const html = render(defaultSpecInput(), "server");
    expect(html).not.toContain("Dejar de gestionar");
    expect(html).toContain("No se gestiona");
    expect(render(modded, "server")).toContain("Dejar de gestionar");
  });

  it("cada campo se asigna a su pestaña", () => {
    expect(sectionOfField("sf-mods-urls")).toBe("Versión y mods");
    expect(sectionOfField("sf-prop-motd")).toBe("Propiedades");
    expect(sectionOfField("sf-props-other")).toBe("Propiedades");
    expect(sectionOfField("sf-ops")).toBe("Jugadores");
    expect(sectionOfField("sf-extra-ports")).toBe("Red");
    expect(sectionOfField("sf-memlimit")).toBe("Recursos");
    expect(sectionOfField("sf-env")).toBe("Avanzado");
    expect(sectionOfField("otro")).toBe("General");
  });
});

import { duplicateHostPorts } from "./network-section";
describe("puertos de host duplicados", () => {
  it("detecta juego vs extra y entre extras, por protocolo", () => {
    const x = (host: number, proto: "tcp" | "udp") => ({ host, container: 1, proto, label: "" });
    expect(duplicateHostPorts(25565, [x(25565, "tcp")])).toEqual(["25565/tcp"]);
    expect(duplicateHostPorts(25565, [x(25565, "udp")])).toEqual([]);
    expect(duplicateHostPorts(undefined, [x(8100, "tcp"), x(8100, "tcp"), x(0, "tcp"), x(0, "tcp")])).toEqual(["8100/tcp"]);
  });
});
