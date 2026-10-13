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
  nodeId: "n1", spec: { enabled: true, port: 25565, autoscale: true, autoscaleDownAfterMinutes: 15, autoscaleAllowPlayers: ["amigo"] },
  observed: {
    configured: true, state: "created", containerId: "c", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: true,
    error: "Bind for 0.0.0.0:25565 failed: port is already allocated", autoscaleDownAfterMinutes: 15, autoscaleAllowPlayers: ["amigo"],
  },
  observedAt: null, updatedAt: null,
};
const render = (r: RouterDto) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><NodeRouterForm node={node} router={r} onSaved={() => {}} /></QueryClientProvider>);

describe("NodeRouterForm (render en servidor, sin DOM)", () => {
  it("muestra el estado, el error del agente y los campos con sus valores", () => {
    const html = render(router);
    for (const t of ["Error", "port is already allocated", "Puerto del host", "25565", "Minutos sin jugadores", "15", "itzg/mc-router:1.47.1", "socket de Docker"]) expect(html).toContain(t);
  });
  it("avisa de que el router equivale a root en el nodo (m1) y de qué hace Parar con autoscale (m2)", () => {
    const html = render(router);
    expect(html).toContain("equivale a root");
    expect(html).toContain("Parar desde el panel no impide");
  });
  it("con autoscale pide la lista de jugadores que pueden despertar servidores (S3)", () => {
    const html = render(router);
    expect(html).toContain("Jugadores que pueden despertar servidores");
    expect(html).toContain("amigo");
  });
  it("sin autoscale no pide minutos ni jugadores", () => {
    const html = render({ ...router, spec: { ...router.spec, autoscale: false } });
    expect(html).not.toContain("Minutos sin jugadores");
    expect(html).not.toContain("Jugadores que pueden despertar servidores");
  });
});
