import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RouterDto } from "@mcsm/shared";
import type { NodeDto } from "@/lib/api";
import { NodeRouterForm } from "./node-router";

const node: NodeDto = {
  id: "n1", name: "nas", dataRoot: "/srv/minecraft", status: "online", agentVersion: "1", dockerVersion: "29",
  hostInfo: null, lastSeenAt: null, createdAt: "2026-10-12T00:00:00.000Z", tokenRotationPending: false,
};
const router: RouterDto = {
  nodeId: "n1", spec: { enabled: true, port: 25565, autoscale: true, autoscaleDownAfterMinutes: 15, autoscaleAllowPlayers: ["friend"] },
  observed: {
    configured: true, state: "created", containerId: "c", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: true,
    error: "Bind for 0.0.0.0:25565 failed: port is already allocated", autoscaleDownAfterMinutes: 15, autoscaleAllowPlayers: ["friend"],
  },
  observedAt: null, updatedAt: null,
};
const render = (r: RouterDto) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><NodeRouterForm node={node} router={r} onSaved={() => {}} /></QueryClientProvider>);

describe("NodeRouterForm (server render, no DOM)", () => {
  it("shows the status, the agent's error and the fields with their values", () => {
    const html = render(router);
    for (const t of ["Error", "port is already allocated", "Host port", "25565", "Minutes without players", "15", "itzg/mc-router:1.47.1", "Docker socket"]) expect(html).toContain(t);
  });
  it("warns that the router is equivalent to root on the node (m1) and what Stop does with autoscale (m2)", () => {
    const html = render(router);
    expect(html).toContain("equivalent to root");
    expect(html).toContain("Stopping from the panel does not prevent");
  });
  it("with autoscale asks for the list of players who can wake servers (S3)", () => {
    const html = render(router);
    expect(html).toContain("Players who can wake servers");
    expect(html).toContain("friend");
  });
  it("without autoscale it asks for neither minutes nor players", () => {
    const html = render({ ...router, spec: { ...router.spec, autoscale: false } });
    expect(html).not.toContain("Minutes without players");
    expect(html).not.toContain("Players who can wake servers");
  });
});
