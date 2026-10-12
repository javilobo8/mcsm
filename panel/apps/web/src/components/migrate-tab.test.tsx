import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MigrateTab, MigrationSteps } from "./migrate-tab";
import type { MigrationDto } from "@mcsm/shared";
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

function render(jobs: JobDto[], migration: MigrationDto | null = null, s: ServerDto = server) {
  const qc = new QueryClient();
  qc.setQueryData(["nodes"], nodes);
  qc.setQueryData(jobsKey({ serverId: "s1" }), jobs);
  qc.setQueryData(migrationKey("s1"), migration);
  return renderToString(<QueryClientProvider client={qc}><MigrateTab server={s} nodeOnline /></QueryClientProvider>);
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

  it("un importado aún en su contenedor original avisa de que la retirada del origen lo eliminará (Planes 6 y 7)", () => {
    const original = "c".repeat(64);
    const imported = {
      ...server, observed: { containerId: original },
      importedFrom: { containerId: original, containerName: "mc-viejo", specVersion: 1, importedAt: "", composeProject: "", composeService: "" },
    } as unknown as ServerDto;
    expect(render([], null, imported)).toContain("contenedor original «mc-viejo»");
    expect(render([])).not.toContain("contenedor original");
  });

  it("una migración atascada enseña lo pendiente con su motivo y la acción de cerrarla a mano (M4)", () => {
    const stuck: MigrationDto = {
      id: "j0", serverId: "s1", sourceNodeId: "a", targetNodeId: "b", sourceSlug: "survival", targetSlug: "survival", targetPort: 25565,
      targetVersion: 2, wasRunning: true, deleteSource: false, phase: "committed", sourcePending: true, targetPending: false, targetStarted: true,
      targetConfirmPending: false, error: null, pendingError: "Retirar el origen: el contenedor aún no se ha podido borrar", createdAt: "", updatedAt: "",
    };
    const html = render([job({ id: "j0", status: "ok", progress: 100, message: "Migración completada" })], stuck);
    expect(html).toContain("se reintenta cada 30 s: el contenedor aún no se ha podido borrar");
    expect(html).toContain("Cerrar la migración a mano…");
    expect(render([job({ status: "failed" })])).not.toContain("Cerrar la migración a mano…");
  });
});
