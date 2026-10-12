import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RouterDto } from "@mcsm/shared";
import type { NodeDto } from "@/lib/api";
import { NodeRouterForm } from "./node-router";

const node: NodeDto = {
  id: "n1", name: "nas", dataRoot: "/srv/minecraft", status: "online", agentVersion: "1", dockerVersion: "29",
  hostInfo: null, lastSeenAt: null, createdAt: "2026-10-12T00:00:00.000Z",
};
const router: RouterDto = {
  nodeId: "n1", spec: { enabled: true, port: 25565, autoscale: true, autoscaleDownAfterMinutes: 15 },
  observed: { configured: true, state: "created", containerId: "c", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: true, error: "Bind for 0.0.0.0:25565 failed: port is already allocated" },
  observedAt: null, updatedAt: null,
};
const render = (r: RouterDto) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><NodeRouterForm node={node} router={r} onSaved={() => {}} /></QueryClientProvider>);

describe("NodeRouterForm (render en servidor, sin DOM)", () => {
  it("muestra el estado, el error del agente y los campos con sus valores", () => {
    const html = render(router);
    for (const t of ["Error", "port is already allocated", "Puerto del host", "25565", "Minutos sin jugadores", "15", "itzg/mc-router:1.47.1", "socket de Docker"]) expect(html).toContain(t);
  });
  it("sin autoscale no pide minutos", () => {
    const html = render({ ...router, spec: { ...router.spec, autoscale: false } });
    expect(html).not.toContain("Minutos sin jugadores");
  });
});
