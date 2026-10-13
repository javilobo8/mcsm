import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { EventDto } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";
import { applyServerEvent, bindEvents, EVENT_FILTERS, EVENTS_LIMIT, eventSubject, eventsKey, eventsUrl, levelTone } from "./events";

const ev = (over: Partial<EventDto> = {}): EventDto => ({
  id: "e1", nodeId: "n1", serverId: "s1", serverName: "One", level: "warn", kind: "crash", message: "m", createdAt: "2026-10-13T04:00:00.000Z", agentAt: null, ...over,
});

describe("events in the web", () => {
  it("query url and key", () => {
    expect(eventsUrl({})).toBe("/api/events?limit=100");
    expect(eventsUrl({ serverId: "a/b?c", minLevel: "warn" })).toBe("/api/events?limit=100&serverId=a%2Fb%3Fc&minLevel=warn");
    expect(eventsKey({ serverId: "s1" })).toEqual(["events", "s1", ""]);
  });

  it("what it is about and its tone", () => {
    expect(eventSubject(ev())).toBe("One");
    expect(eventSubject(ev({ serverId: null, serverName: null }), "nas")).toBe("Node “nas”");
    expect(eventSubject(ev({ serverId: null, serverName: null, nodeId: null }))).toBe("Panel");
    expect(levelTone("error")).toContain("red");
    expect(levelTone("warn")).toContain("amber");
  });

  it("an event reloads the lists; a crash loop also reloads the server", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyServerEvent(qc, { type: "event", event: ev() });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["events"]]);
    spy.mockClear();
    applyServerEvent(qc, { type: "event", event: ev({ kind: "crash_loop" }) });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["events"], ["server", "s1"], ["servers"]]);
  });

  it("bindEvents listens to the events topic and reloads on reconnect", () => {
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

describe("events page filters", () => {
  it("all, warnings and errors, and errors only", () => {
    expect(EVENT_FILTERS.map((f) => [f.label, f.minLevel])).toEqual([["All", undefined], ["Warnings and errors", "warn"], ["Errors", "error"]]);
  });
});

describe("list limit", () => {
  it("the URL asks for as many events as the list note says", () => {
    expect(EVENTS_LIMIT).toBe(100);
    expect(eventsUrl({})).toContain(`limit=${EVENTS_LIMIT}`);
  });
});
