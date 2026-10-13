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
  { id: "a", name: "Home", dataRoot: "/srv", status: "online", agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "", tokenRotationPending: false },
  { id: "b", name: "Garage", dataRoot: "/srv", status: "online", agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "", tokenRotationPending: false },
];
const job = (over: Partial<JobDto>): JobDto => ({
  id: "j1", type: "migrate", serverId: "s1", nodeId: "a", status: "running", progress: 40, message: "Step 3/7 · Upload the backup to the panel: uploading",
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
  it("MigrationSteps marks the current step by progress", () => {
    const html = renderToString(<MigrationSteps job={{ progress: 40, status: "running" }} />);
    expect(html).toContain("3. Upload the backup to the panel");
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?3\. Upload the backup to the panel/);
  });

  it("with a migration in progress it shows the progress and not the form", () => {
    const html = render([job({})]);
    expect(html).toContain("Step 3/7 · Upload the backup to the panel: uploading");
    expect(html).toContain("40%");
    expect(html).not.toContain("Migrate…");
  });

  it("without a migration in progress it shows the form and the last one that failed", () => {
    const html = render([job({ status: "failed", progress: 85, message: "Step 6/7 (Start and check on the target): port in use" })]);
    expect(html).toContain("The last migration failed");
    expect(html).toContain("port in use");
    expect(html).toContain("Migrate…");
    expect(html).toContain("Delete the source when finished");
  });

  it("an imported server still in its original container warns that removing the source will delete it (Plans 6 and 7)", () => {
    const original = "c".repeat(64);
    const imported = {
      ...server, observed: { containerId: original },
      importedFrom: { containerId: original, containerName: "mc-old", specVersion: 1, importedAt: "", composeProject: "", composeService: "" },
    } as unknown as ServerDto;
    expect(render([], null, imported)).toContain("original container “mc-old”");
    expect(render([])).not.toContain("original container");
  });

  it("a server with a hostname warns about DNS pointing to the target node (Plans 7 and 8)", () => {
    const routed = { ...server, spec: { ...server.spec, router: { enabled: true, hostname: "survival.lan" } } } as unknown as ServerDto;
    expect(render([], null, routed)).toContain("the hostname “survival.lan” has to resolve to the IP of the target node");
    expect(render([])).not.toContain("hostname");
  });

  it("a stuck migration shows what is pending with its reason and the action to close it by hand (M4)", () => {
    const stuck: MigrationDto = {
      id: "j0", serverId: "s1", sourceNodeId: "a", targetNodeId: "b", sourceSlug: "survival", targetSlug: "survival", targetPort: 25565,
      targetVersion: 2, wasRunning: true, deleteSource: false, phase: "committed", sourcePending: true, targetPending: false, targetStarted: true,
      targetConfirmPending: false, error: null, pendingError: "Remove the source: the container could not be deleted yet", createdAt: "", updatedAt: "",
    };
    const html = render([job({ id: "j0", status: "ok", progress: 100, message: "Migration completed" })], stuck);
    expect(html).toContain("retried every 30 s: the container could not be deleted yet");
    expect(html).toContain("Close the migration by hand…");
    expect(render([job({ status: "failed" })])).not.toContain("Close the migration by hand…");
  });
});
