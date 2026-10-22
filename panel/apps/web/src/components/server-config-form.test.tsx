import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerConfigForm } from "./server-config-form";
import type { ServerDto } from "@/lib/api";

// Without RouterProvider: useBlocker is replaced by a spy (the rest of the router is the real one).
const { blockers } = vi.hoisted(() => ({ blockers: [] as { disabled?: boolean; enableBeforeUnload?: () => boolean }[] }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: (opts: (typeof blockers)[number]) => { blockers.push(opts); return { status: "idle" }; },
}));

const server: ServerDto = {
  id: "s1", nodeId: "n1", name: "Survival", slug: "survival", specVersion: 3, desiredState: "running",
  observed: null, observedSpecVersion: 3, observedAt: null, createdAt: "", updatedAt: "", importedFrom: null,
  spec: {
    imageTag: "java21", type: "FABRIC", version: "1.21.4", memory: "4G", properties: { motd: "Hello" }, env: {}, build: "",
    resources: { cpus: 0, memLimit: "" }, restartPolicy: "unless-stopped",
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    ports: { game: 25565, extra: [] }, rconPassword: "secretosecreto",
  },
};

describe("ServerConfigForm (server render)", () => {
  it("renders the form by sections, hides RCON and offers to save as a template", () => {
    const html = renderToString(<QueryClientProvider client={new QueryClient()}><ServerConfigForm server={server} /></QueryClientProvider>);
    expect(html).toContain("Survival");
    expect(html).toContain("mcsm-survival");
    expect(html).toContain("Save as template");
    expect(html).toContain("Review and apply");
    expect(html).not.toContain("secretosecreto");
    // Registers the exit guard, disabled while there are no unsaved changes.
    expect(blockers.at(-1)).toMatchObject({ disabled: true });
    expect(blockers.at(-1)?.enableBeforeUnload?.()).toBe(false);
  });

  it("shows the RCON address only when the server publishes RCON", () => {
    const render = (s: ServerDto) => renderToString(<QueryClientProvider client={new QueryClient()}><ServerConfigForm server={s} /></QueryClientProvider>);
    expect(render(server)).not.toContain("RCON address");
    const published = { ...server, spec: { ...server.spec, ports: { ...server.spec.ports, rcon: 25580 } } };
    const html = render(published);
    expect(html).toContain("RCON address");
    expect(html).toContain("25580");
  });
});
