import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { EventDto } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";
import { applyServerEvent, bindEvents, eventSubject, eventsKey, eventsUrl, levelTone } from "./events";

const ev = (over: Partial<EventDto> = {}): EventDto => ({
  id: "e1", nodeId: "n1", serverId: "s1", serverName: "Uno", level: "warn", kind: "crash", message: "m", createdAt: "2026-10-13T04:00:00.000Z", agentAt: null, ...over,
});

describe("eventos en la web", () => {
  it("url y clave de la consulta", () => {
    expect(eventsUrl({})).toBe("/api/events?limit=100");
    expect(eventsUrl({ serverId: "a/b?c", minLevel: "warn" })).toBe("/api/events?limit=100&serverId=a%2Fb%3Fc&minLevel=warn");
    expect(eventsKey({ serverId: "s1" })).toEqual(["events", "s1", ""]);
  });

  it("de qué trata y su tono", () => {
    expect(eventSubject(ev())).toBe("Uno");
    expect(eventSubject(ev({ serverId: null, serverName: null }), "nas")).toBe("Nodo «nas»");
    expect(eventSubject(ev({ serverId: null, serverName: null, nodeId: null }))).toBe("Panel");
    expect(levelTone("error")).toContain("red");
    expect(levelTone("warn")).toContain("amber");
  });

  it("un evento recarga las listas; un bucle de crash recarga además el servidor", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyServerEvent(qc, { type: "event", event: ev() });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["events"]]);
    spy.mockClear();
    applyServerEvent(qc, { type: "event", event: ev({ kind: "crash_loop" }) });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["events"], ["server", "s1"], ["servers"]]);
  });

  it("bindEvents escucha el topic events y recarga al reconectar", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    let handler: ((m: ServerMessage) => void) | null = null;
    let reconnect: (() => void) | null = null;
    const live: LiveSource = {
      subscribe: (topic, h) => { expect(topic).toBe("events"); handler = h; return () => { handler = null; }; },
      onReconnect: (cb) => { reconnect = cb; return () => { reconnect = null; }; },
    };
    const off = bindEvents(qc, live);
    handler!({ type: "event", event: ev() });
    reconnect!();
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["events"], ["events"]]);
    off();
    expect(handler).toBeNull();
  });
});

import { EVENT_FILTERS } from "./events";

describe("filtros de la página de eventos", () => {
  it("todos, avisos y errores, y solo errores", () => {
    expect(EVENT_FILTERS.map((f) => [f.label, f.minLevel])).toEqual([["Todos", undefined], ["Avisos y errores", "warn"], ["Errores", "error"]]);
  });
});
