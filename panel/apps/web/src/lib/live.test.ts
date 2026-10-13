import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { applyNodeEvent, applyObservedEvent, bindLive, type LiveSource } from "./live";
import type { NodeDto, ObservedDto, ServerDto, ServerMessage } from "./api";

const obs = (over: Partial<ObservedDto> = {}): ObservedDto => ({
  containerId: "c", state: "running", health: "healthy", startedAtUnix: 1, exitCode: 0, appliedVersion: 3, error: "",
  mc: { online: true, playersOnline: 1, playersMax: 20, version: "1.21", latencyMs: 5 }, ...over,
});
const server = (id: string): ServerDto => ({
  id, nodeId: "n1", name: id, slug: id, specVersion: 3, desiredState: "running", observed: null, observedSpecVersion: 2,
  observedAt: null, createdAt: "", updatedAt: "", spec: { ports: { game: 25565 } } as ServerDto["spec"], importedFrom: null,
});
const node = (id: string, name = id): NodeDto => ({
  id, name, dataRoot: "/srv", status: "online", agentVersion: null, dockerVersion: null, hostInfo: null, lastSeenAt: null, createdAt: "", tokenRotationPending: false,
});
const observedMsg = (serverId: string, o = obs()): Extract<ServerMessage, { type: "observed" }> => ({ type: "observed", serverId, observed: o, observedAt: "2026-01-01T00:00:00Z" });

describe("applyObservedEvent", () => {
  it("merges the observed state into the list and the detail", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a"), server("b")]);
    qc.setQueryData(["server", "a"], server("a"));
    applyObservedEvent(qc, observedMsg("a"));
    const list = qc.getQueryData<ServerDto[]>(["servers"])!;
    expect(list[0]!.observed?.state).toBe("running");
    expect(list[0]!.observedSpecVersion).toBe(3);
    expect(list[0]!.observedAt).toBe("2026-01-01T00:00:00Z");
    expect(list[1]!.observed).toBeNull();
    expect(qc.getQueryData<ServerDto>(["server", "a"])!.observedSpecVersion).toBe(3);
  });
  it("ignores an event older than the cached observedAt", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [{ ...server("a"), observed: obs({ state: "exited" }), observedAt: "2026-01-02T00:00:00Z" }]);
    qc.setQueryData(["server", "a"], { ...server("a"), observed: obs({ state: "exited" }), observedAt: "2026-01-02T00:00:00Z" });
    applyObservedEvent(qc, observedMsg("a")); // observedAt 2026-01-01
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("exited");
    expect(qc.getQueryData<ServerDto>(["server", "a"])!.observed?.state).toBe("exited");
  });
  it("applies a newer event", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [{ ...server("a"), observed: obs({ state: "exited" }), observedAt: "2025-12-31T00:00:00Z" }]);
    applyObservedEvent(qc, observedMsg("a"));
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("running");
  });
  it("event during the initial load: does not break it and when it resolves the list is shown", async () => {
    const qc = new QueryClient();
    let resolve!: (v: ServerDto[]) => void;
    const p = qc.fetchQuery({ queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }) });
    applyObservedEvent(qc, observedMsg("a"));
    resolve([server("a")]);
    await p;
    expect(qc.getQueryData<ServerDto[]>(["servers"])).toHaveLength(1);
    expect(qc.getQueryState(["servers"])?.status).toBe("success");
  });
  it("event during a refetch with data: the new event prevails over the old response", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolve!: (v: ServerDto[]) => void;
    const p = qc.fetchQuery({ queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }), staleTime: 0 }).catch(() => undefined);
    applyObservedEvent(qc, observedMsg("a"));
    resolve([server("a")]); // old response, without observed
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("running");
  });
  it("throttles invalidation for an unknown server and keeps a final call", () => {
    vi.useFakeTimers();
    try {
      const qc = new QueryClient();
      qc.setQueryData(["servers"], [server("a")]);
      const spy = vi.spyOn(qc, "invalidateQueries");
      applyObservedEvent(qc, observedMsg("x"));
      applyObservedEvent(qc, observedMsg("y"));
      applyObservedEvent(qc, observedMsg("z"));
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1100);
      expect(spy).toHaveBeenCalledTimes(2); // trailing: the last one is not lost
      vi.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("unknown server: the refetch launched by the invalidation is not cancelled and the server appears", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolve!: (v: ServerDto[]) => void;
    const obsr = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }), staleTime: Infinity });
    const unsub = obsr.subscribe(() => {});
    applyObservedEvent(qc, observedMsg("new"));
    await new Promise((r) => setTimeout(r, 0));
    resolve([server("a"), server("new")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData<ServerDto[]>(["servers"])!.map((s) => s.id)).toEqual(["a", "new"]);
    unsub();
  });
  it("unknown in the list with detail cached: the detail receives the event and the list includes it after the refetch", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    qc.setQueryData(["server", "new"], server("new"));
    let resolveList!: (v: ServerDto[]) => void;
    const listObs = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolveList = r; }), staleTime: Infinity });
    const detailFn = vi.fn(() => new Promise<ServerDto>(() => {}));
    const detailObs = new QueryObserver(qc, { queryKey: ["server", "new"], queryFn: detailFn, staleTime: Infinity });
    const offs = [listObs.subscribe(() => {}), detailObs.subscribe(() => {})];
    applyObservedEvent(qc, observedMsg("new"));
    await new Promise((r) => setTimeout(r, 0));
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    expect(detailObs.getCurrentResult().data?.observedAt).toBe("2026-01-01T00:00:00Z");
    expect(detailFn).not.toHaveBeenCalled();
    resolveList([server("a"), server("new")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data!.map((s) => s.id)).toEqual(["a", "new"]);
    offs.forEach((off) => off());
  });
  it("unknown in the list with the detail refetching: the event prevails in the detail and the list refetch is not cancelled", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    qc.setQueryData(["server", "new"], server("new"));
    let resolveList!: (v: ServerDto[]) => void;
    let resolveDetail!: (v: ServerDto) => void;
    const listObs = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolveList = r; }), staleTime: Infinity });
    const detailObs = new QueryObserver(qc, { queryKey: ["server", "new"], queryFn: () => new Promise<ServerDto>((r) => { resolveDetail = r; }), staleTime: Infinity });
    const offs = [listObs.subscribe(() => {}), detailObs.subscribe(() => {})];
    void detailObs.refetch();
    await new Promise((r) => setTimeout(r, 0));
    applyObservedEvent(qc, observedMsg("new"));
    resolveDetail(server("new")); // old response, without observed
    await new Promise((r) => setTimeout(r, 0));
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    resolveList([server("a"), server("new")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data!.map((s) => s.id)).toEqual(["a", "new"]);
    offs.forEach((off) => off());
  });
  it("known in list and detail, both refetching: the event prevails in both", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    qc.setQueryData(["server", "a"], server("a"));
    let resolveList!: (v: ServerDto[]) => void;
    let resolveDetail!: (v: ServerDto) => void;
    const listObs = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolveList = r; }), staleTime: Infinity });
    const detailObs = new QueryObserver(qc, { queryKey: ["server", "a"], queryFn: () => new Promise<ServerDto>((r) => { resolveDetail = r; }), staleTime: Infinity });
    const offs = [listObs.subscribe(() => {}), detailObs.subscribe(() => {})];
    void listObs.refetch();
    void detailObs.refetch();
    await new Promise((r) => setTimeout(r, 0));
    applyObservedEvent(qc, observedMsg("a"));
    resolveList([server("a")]); // old responses, without observed
    resolveDetail(server("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data![0]!.observed?.state).toBe("running");
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    expect(qc.getQueryState(["servers"])?.status).toBe("success");
    expect(qc.getQueryState(["server", "a"])?.status).toBe("success");
    offs.forEach((off) => off());
  });
  it("unknown in the list and detail in initial load: the detail is neither cancelled nor written", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolveDetail!: (v: ServerDto) => void;
    const p = qc.fetchQuery({ queryKey: ["server", "new"], queryFn: () => new Promise<ServerDto>((r) => { resolveDetail = r; }) });
    applyObservedEvent(qc, observedMsg("new"));
    resolveDetail(server("new"));
    await p;
    expect(qc.getQueryState(["server", "new"])?.status).toBe("success");
    expect(qc.getQueryData<ServerDto>(["server", "new"])!.observed).toBeNull();
  });
  it("invalidates the list if the server is unknown (created from another tab)", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyObservedEvent(qc, observedMsg("zzz"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["servers"] });
    expect(qc.getQueryData<ServerDto[]>(["servers"])).toHaveLength(1);
  });
  it("does not create a cache if it has not been loaded yet", () => {
    const qc = new QueryClient();
    applyObservedEvent(qc, observedMsg("a"));
    expect(qc.getQueryData(["servers"])).toBeUndefined();
    expect(qc.getQueryData(["server", "a"])).toBeUndefined();
  });
});

describe("applyNodeEvent (P14)", () => {
  it("updates an existing node", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], [node("n1", "old")]);
    applyNodeEvent(qc, { type: "node", node: node("n1", "new") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])!.map((n) => n.name)).toEqual(["new"]);
  });
  it("adds a new node that arrives over WS", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], [node("n1")]);
    applyNodeEvent(qc, { type: "node", node: node("n2") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])!.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
  it("also adds it with an empty list", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], []);
    applyNodeEvent(qc, { type: "node", node: node("n2") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])).toHaveLength(1);
  });
});

describe("bindLive", () => {
  function fakeLive() {
    const handlers = new Map<string, (m: ServerMessage) => void>();
    let reconnect: (() => void) | null = null;
    const unsubs = { topics: vi.fn(), reconnect: vi.fn() };
    const live: LiveSource = {
      subscribe: (topic, h) => { handlers.set(topic, h); return unsubs.topics; },
      onReconnect: (cb) => { reconnect = cb; return unsubs.reconnect; },
    };
    return { live, handlers, fire: () => reconnect?.(), unsubs };
  }
  it("routes events and cleans up on unmount", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], []);
    const { live, handlers, unsubs } = fakeLive();
    const off = bindLive(qc, live);
    handlers.get("nodes")!({ type: "node", node: node("n9") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])).toHaveLength(1);
    off();
    expect(unsubs.topics).toHaveBeenCalledTimes(2);
    expect(unsubs.reconnect).toHaveBeenCalledTimes(1);
  });
  it("invalidates servers and nodes on reconnect", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { live, fire } = fakeLive();
    bindLive(qc, live);
    fire();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["servers"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["nodes"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["server"] });
  });
});
