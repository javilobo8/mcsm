import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { RouterDto } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { bindRouterLive, routerFormBody, routerFormErrors, routerFormFrom, routerKey, routerStatus } from "./router";

const base: RouterDto = {
  nodeId: "n1", spec: { enabled: true, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] },
  observed: {
    configured: true, state: "running", containerId: "c", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: false, error: "",
    autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [],
  },
  observedAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T09:59:00.000Z",
};

describe("routerStatus", () => {
  it("active and running", () => {
    expect(routerStatus(base, true)).toEqual({ label: "Active on :25565", tone: "ok", detail: null });
  });
  it("disabled (and being removed while the agent still has it)", () => {
    const off = { ...base, spec: { ...base.spec, enabled: false } };
    expect(routerStatus({ ...off, observed: null }, true).label).toBe("Disabled");
    expect(routerStatus(off, true).label).toBe("Removing…");
    expect(routerStatus(off, false).label).toBe("Disabled");
    expect(routerStatus({ ...off, observed: { ...base.observed!, configured: false, state: "missing" } }, true).label).toBe("Disabled");
  });
  it("node offline, error and applying", () => {
    expect(routerStatus(base, false).label).toBe("Node offline");
    const err = { ...base, observed: { ...base.observed!, state: "created", error: "port is already allocated" } };
    expect(routerStatus(err, true)).toEqual({ label: "Error", tone: "bad", detail: "port is already allocated" });
    expect(routerStatus({ ...base, observed: null }, true).label).toBe("Applying…");
    expect(routerStatus({ ...base, spec: { ...base.spec, port: 25590 } }, true).label).toBe("Applying…");
    expect(routerStatus({ ...base, spec: { ...base.spec, autoscale: true } }, true).label).toBe("Applying…");
    expect(routerStatus({ ...base, observed: { ...base.observed!, state: "exited" } }, true)).toMatchObject({ label: "State: exited", tone: "warn" });
  });
  it("with autoscale it also compares the minutes and the player list (m6)", () => {
    const auto = { ...base, spec: { ...base.spec, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["friend"] },
      observed: { ...base.observed!, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["friend"] } };
    expect(routerStatus(auto, true).label).toBe("Active on :25565");
    expect(routerStatus({ ...auto, spec: { ...auto.spec, autoscaleDownAfterMinutes: 15 } }, true).label).toBe("Applying…");
    expect(routerStatus({ ...auto, spec: { ...auto.spec, autoscaleAllowPlayers: ["friend", "other"] } }, true).label).toBe("Applying…");
    // Without autoscale, minutes and the list do not count.
    expect(routerStatus({ ...base, spec: { ...base.spec, autoscaleDownAfterMinutes: 15 } }, true).label).toBe("Active on :25565");
  });
});

describe("router form", () => {
  it("round trip", () => {
    const f = routerFormFrom({ ...base.spec, autoscaleAllowPlayers: ["friend", "other"] });
    expect(f).toEqual({ enabled: true, port: "25565", autoscale: false, minutes: "10", players: "friend\nother" });
    expect(routerFormErrors(f)).toEqual({});
    expect(routerFormBody({ ...f, port: " 25590 ", autoscale: true, minutes: "30", players: "friend\n other ,friend\n" }, base.spec))
      .toEqual({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["friend", "other"] });
  });
  it("validates port and minutes (minutes only with autoscale)", () => {
    const f = routerFormFrom(base.spec);
    for (const port of ["", "0", "65536", "25565.5", "abc", "-1"]) expect(routerFormErrors({ ...f, port }).port).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: true, minutes: "0" }).minutes).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: true, minutes: "1441" }).minutes).toBeDefined();
    expect(routerFormErrors({ ...f, autoscale: false, minutes: "" })).toEqual({});
    expect(routerFormBody({ ...f, autoscale: false, minutes: "" }, base.spec).autoscaleDownAfterMinutes).toBe(10);
    expect(routerFormErrors({ ...f, autoscale: true, players: "friend\nbad player" }).players).toMatch(/bad player/);
    expect(routerFormErrors({ ...f, autoscale: false, players: "bad player" })).toEqual({});
  });
  it("disabling can be saved even if the rest is not valid (m7): what was saved is sent", () => {
    const saved = { ...base.spec, port: 25590, autoscaleAllowPlayers: ["friend"] };
    const f = { ...routerFormFrom(saved), enabled: false, port: "abc", autoscale: true, minutes: "0", players: "bad player" };
    expect(routerFormErrors(f)).toEqual({});
    expect(routerFormBody(f, saved)).toEqual({ enabled: false, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: ["friend"] });
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

  it("replaces the router cache of its node and not that of others", () => {
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

  it("on reconnect it invalidates its query", () => {
    const qc = new QueryClient();
    qc.setQueryData(routerKey("n1"), base);
    const f = fakeLive();
    bindRouterLive(qc, f.live, "n1");
    f.reconnect();
    expect(qc.getQueryState(routerKey("n1"))?.isInvalidated).toBe(true);
  });
});
