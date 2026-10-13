import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerConfigForm } from "./server-config-form";
import type { ServerDto } from "@/lib/api";

// Sin RouterProvider: useBlocker se sustituye por un espía (el resto del router, el real).
const { blockers } = vi.hoisted(() => ({ blockers: [] as { disabled?: boolean; enableBeforeUnload?: () => boolean }[] }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: (opts: (typeof blockers)[number]) => { blockers.push(opts); return { status: "idle" }; },
}));

const server: ServerDto = {
  id: "s1", nodeId: "n1", name: "Supervivencia", slug: "supervivencia", specVersion: 3, desiredState: "running",
  observed: null, observedSpecVersion: 3, observedAt: null, createdAt: "", updatedAt: "", importedFrom: null,
  spec: {
    imageTag: "java21", type: "FABRIC", version: "1.21.4", memory: "4G", properties: { motd: "Hola" }, env: {}, build: "",
    resources: { cpus: 0, memLimit: "" }, restartPolicy: "unless-stopped",
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    ports: { game: 25565, extra: [] }, rconPassword: "secretosecreto",
  },
};

describe("ServerConfigForm (render en servidor)", () => {
  it("pinta el formulario por secciones, oculta RCON y ofrece guardar como plantilla", () => {
    const html = renderToString(<QueryClientProvider client={new QueryClient()}><ServerConfigForm server={server} /></QueryClientProvider>);
    expect(html).toContain("Supervivencia");
    expect(html).toContain("mcsm-supervivencia");
    expect(html).toContain("Guardar como plantilla");
    expect(html).toContain("Revisar y aplicar");
    expect(html).not.toContain("secretosecreto");
    // Registra la guarda de salida, desactivada mientras no haya cambios sin guardar.
    expect(blockers.at(-1)).toMatchObject({ disabled: true });
    expect(blockers.at(-1)?.enableBeforeUnload?.()).toBe(false);
  });
});
