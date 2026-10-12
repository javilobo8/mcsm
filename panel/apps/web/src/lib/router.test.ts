import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { RouterDto } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { bindRouterLive, routerFormBody, routerFormErrors, routerFormFrom, routerKey, routerStatus } from "./router";

const base: RouterDto = {
  nodeId: "n1", spec: { enabled: true, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10 },
  observed: { configured: true, state: "running", containerId: "c", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: false, error: "" },
  observedAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T09:59:00.000Z",
};

describe("routerStatus", () => {
  it("activo y en marcha", () => {
    expect(routerStatus(base, true)).toEqual({ label: "Activo en :25565", tone: "ok", detail: null });
  });
  it("desactivado (y retirándose mientras el agente aún lo tiene)", () => {
    const off = { ...base, spec: { ...base.spec, enabled: false } };
    expect(routerStatus({ ...off, observed: null }, true).label).toBe("Desactivado");
    expect(routerStatus(off, true).label).toBe("Retirando…");
    expect(routerStatus(off, false).label).toBe("Desactivado");
    expect(routerStatus({ ...off, observed: { ...base.observed!, configured: false, state: "missing" } }, true).label).toBe("Desactivado");
  });
  it("nodo desconectado, error y aplicando", () => {
    expect(routerStatus(base, false).label).toBe("Nodo desconectado");
    const err = { ...base, observed: { ...base.observed!, state: "created", error: "port is already allocated" } };
    expect(routerStatus(err, true)).toEqual({ label: "Error", tone: "bad", detail: "port is already allocated" });
    expect(routerStatus({ ...base, observed: null }, true).label).toBe("Aplicando…");
    expect(routerStatus({ ...base, spec: { ...base.spec, port: 25590 } }, true).label).toBe("Aplicando…");
    expect(routerStatus({ ...base, spec: { ...base.spec, autoscale: true } }, true).label).toBe("Aplicando…");
    expect(routerStatus({ ...base, observed: { ...base.observed!, state: "exited" } }, true)).toMatchObject({ label: "Estado: exited", tone: "warn" });
  });
});

describe("formulario del router", () => {
  it("ida y vuelta", () => {
    const f = routerFormFrom(base.spec);
    expect(f).toEqual({ enabled: true, port: "25565", autoscale: false, minutes: "10" });
    expect(routerFormErrors(f)).toEqual({});
    expect(routerFormBody({ ...f, port: " 25590 ", autoscale: true, minutes: "30" })).toEqual({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30 });
  });
  it("valida puerto y minutos (los minutos solo con autoscale)", () => {
    const f = routerFormFrom(base.spec);
    for (const port of ["", "0", "65536", "25565.5", "abc", "-1"]) expect(routerFormErrors({ ...f, port }).port).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: true, minutes: "0" }).minutes).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: true, minutes: "1441" }).minutes).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: false, minutes: "" })).toEqual({});
    expect(routerFormBody({ ...f, autoscale: false, minutes: "" }).autoscaleDownAfterMinutes).toBe(10);
  });
});

describe("bindRouterLive", () => {
  const fakeLive = () => {
    const handlers: ((m: ServerMessage) => void)[] = [];
    const reconnects: (() => void)[] = [];
    return {
      live: {
        subscribe: (_t: string, h: (m: ServerMessage) => void) => { handlers.push(h); return () => {}; },
        onReconnect: (cb: () => void) => { reconnects.push(cb); return () => {}; },
      },
      emit: (m: ServerMessage) => handlers.forEach((h) => h(m)),
      reconnect: () => reconnects.forEach((cb) => cb()),
    };
  };

  it("sustituye la caché del router de su nodo y no la de otros", () => {
    const qc = new QueryClient();
    qc.setQueryData(routerKey("n1"), base);
    qc.setQueryData(routerKey("n2"), { ...base, nodeId: "n2" });
    const f = fakeLive();
    bindRouterLive(qc, f.live, "n1");
    const next = { ...base, observed: { ...base.observed!, state: "exited" } };
    f.emit({ type: "router", nodeId: "n1", router: next });
    f.emit({ type: "router", nodeId: "n2", router: { ...next, nodeId: "n2" } });
    expect(qc.getQueryData<RouterDto>(routerKey("n1"))?.observed?.state).toBe("exited");
    expect(qc.getQueryData<RouterDto>(routerKey("n2"))?.observed?.state).toBe("running");
  });

  it("al reconectar invalida su query", () => {
    const qc = new QueryClient();
    qc.setQueryData(routerKey("n1"), base);
    const f = fakeLive();
    bindRouterLive(qc, f.live, "n1");
    f.reconnect();
    expect(qc.getQueryState(routerKey("n1"))?.isInvalidated).toBe(true);
  });
});
