import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MigrateTab, MigrationSteps } from "./migrate-tab";
import type { JobDto, NodeDto, ServerDto } from "@/lib/api";
import { jobsKey } from "@/lib/jobs";
import { migrationKey } from "@/lib/migration";

const server = {
  id: "s1", nodeId: "a", name: "Survival", slug: "survival", specVersion: 1, desiredState: "running",
  observed: null, observedSpecVersion: 1, observedAt: null, createdAt: "", updatedAt: "",
  spec: { imageTag: "java21", type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565, extra: [] } },
} as unknown as ServerDto;
const nodes: NodeDto[] = [
  { id: "a", name: "Casa", dataRoot: "/srv", status: "online", agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "" },
  { id: "b", name: "Garaje", dataRoot: "/srv", status: "online", agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "" },
];
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j1", type: "migrate", serverId: "s1", nodeId: "a", status: "running", progress: 40, message: "Paso 3/7 · Subir la copia al panel: subiendo",
  payload: {}, createdAt: "2026-10-12T04:00:00Z", updatedAt: "", startedAt: null, finishedAt: null, ...over,
});

function render(jobs: JobDto[]) {
  const qc = new QueryClient();
  qc.setQueryData(["nodes"], nodes);
  qc.setQueryData(jobsKey({ serverId: "s1" }), jobs);
  qc.setQueryData(migrationKey("s1"), null);
  return renderToString(<QueryClientProvider client={qc}><MigrateTab server={server} nodeOnline /></QueryClientProvider>);
}

describe("MigrateTab", () => {
  it("MigrationSteps marca el paso en curso por el progreso", () => {
    const html = renderToString(<MigrationSteps job={{ progress: 40, status: "running" }} />);
    expect(html).toContain("3. Subir la copia al panel");
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?3\. Subir la copia al panel/);
  });

  it("con una migración en curso enseña el progreso y no el formulario", () => {
    const html = render([job({})]);
    expect(html).toContain("Paso 3/7 · Subir la copia al panel: subiendo");
    expect(html).toContain("40%");
    expect(html).not.toContain("Migrar…");
  });

  it("sin migración en curso enseña el formulario y la última que falló", () => {
    const html = render([job({ status: "failed", progress: 85, message: "Paso 6/7 (Arrancar y comprobar en el destino): puerto ocupado" })]);
    expect(html).toContain("La última migración falló");
    expect(html).toContain("puerto ocupado");
    expect(html).toContain("Migrar…");
    expect(html).toContain("Borrar el origen al terminar");
  });
});
