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
  it("fusiona el estado observado en la lista y en el detalle", () => {
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
  it("ignora un evento más antiguo que el observedAt en caché", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [{ ...server("a"), observed: obs({ state: "exited" }), observedAt: "2026-01-02T00:00:00Z" }]);
    qc.setQueryData(["server", "a"], { ...server("a"), observed: obs({ state: "exited" }), observedAt: "2026-01-02T00:00:00Z" });
    applyObservedEvent(qc, observedMsg("a")); // observedAt 2026-01-01
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("exited");
    expect(qc.getQueryData<ServerDto>(["server", "a"])!.observed?.state).toBe("exited");
  });
  it("aplica un evento más nuevo", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [{ ...server("a"), observed: obs({ state: "exited" }), observedAt: "2025-12-31T00:00:00Z" }]);
    applyObservedEvent(qc, observedMsg("a"));
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("running");
  });
  it("evento durante la carga inicial: no la rompe y al resolver se muestra la lista", async () => {
    const qc = new QueryClient();
    let resolve!: (v: ServerDto[]) => void;
    const p = qc.fetchQuery({ queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }) });
    applyObservedEvent(qc, observedMsg("a"));
    resolve([server("a")]);
    await p;
    expect(qc.getQueryData<ServerDto[]>(["servers"])).toHaveLength(1);
    expect(qc.getQueryState(["servers"])?.status).toBe("success");
  });
  it("evento durante un refetch con datos: el evento nuevo prevalece sobre la respuesta vieja", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolve!: (v: ServerDto[]) => void;
    const p = qc.fetchQuery({ queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }), staleTime: 0 }).catch(() => undefined);
    applyObservedEvent(qc, observedMsg("a"));
    resolve([server("a")]); // respuesta vieja, sin observed
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData<ServerDto[]>(["servers"])![0]!.observed?.state).toBe("running");
  });
  it("limita la invalidación por servidor desconocido y conserva una llamada final", () => {
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
      expect(spy).toHaveBeenCalledTimes(2); // trailing: no se pierde el último
      vi.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("servidor desconocido: el refetch que lanza la invalidación no se cancela y el servidor aparece", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolve!: (v: ServerDto[]) => void;
    const obsr = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolve = r; }), staleTime: Infinity });
    const unsub = obsr.subscribe(() => {});
    applyObservedEvent(qc, observedMsg("nuevo"));
    await new Promise((r) => setTimeout(r, 0));
    resolve([server("a"), server("nuevo")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData<ServerDto[]>(["servers"])!.map((s) => s.id)).toEqual(["a", "nuevo"]);
    unsub();
  });
  it("desconocido en la lista con detalle en caché: el detalle recibe el evento y la lista lo incluye tras el refetch", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    qc.setQueryData(["server", "nuevo"], server("nuevo"));
    let resolveList!: (v: ServerDto[]) => void;
    const listObs = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolveList = r; }), staleTime: Infinity });
    const detailFn = vi.fn(() => new Promise<ServerDto>(() => {}));
    const detailObs = new QueryObserver(qc, { queryKey: ["server", "nuevo"], queryFn: detailFn, staleTime: Infinity });
    const offs = [listObs.subscribe(() => {}), detailObs.subscribe(() => {})];
    applyObservedEvent(qc, observedMsg("nuevo"));
    await new Promise((r) => setTimeout(r, 0));
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    expect(detailObs.getCurrentResult().data?.observedAt).toBe("2026-01-01T00:00:00Z");
    expect(detailFn).not.toHaveBeenCalled();
    resolveList([server("a"), server("nuevo")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data!.map((s) => s.id)).toEqual(["a", "nuevo"]);
    offs.forEach((off) => off());
  });
  it("desconocido en la lista con el detalle en refetch: el evento prevalece en el detalle y el refetch de la lista no se cancela", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    qc.setQueryData(["server", "nuevo"], server("nuevo"));
    let resolveList!: (v: ServerDto[]) => void;
    let resolveDetail!: (v: ServerDto) => void;
    const listObs = new QueryObserver(qc, { queryKey: ["servers"], queryFn: () => new Promise<ServerDto[]>((r) => { resolveList = r; }), staleTime: Infinity });
    const detailObs = new QueryObserver(qc, { queryKey: ["server", "nuevo"], queryFn: () => new Promise<ServerDto>((r) => { resolveDetail = r; }), staleTime: Infinity });
    const offs = [listObs.subscribe(() => {}), detailObs.subscribe(() => {})];
    void detailObs.refetch();
    await new Promise((r) => setTimeout(r, 0));
    applyObservedEvent(qc, observedMsg("nuevo"));
    resolveDetail(server("nuevo")); // respuesta vieja, sin observed
    await new Promise((r) => setTimeout(r, 0));
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    resolveList([server("a"), server("nuevo")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data!.map((s) => s.id)).toEqual(["a", "nuevo"]);
    offs.forEach((off) => off());
  });
  it("conocido en lista y detalle, ambos en refetch: el evento prevalece en los dos", async () => {
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
    resolveList([server("a")]); // respuestas viejas, sin observed
    resolveDetail(server("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(listObs.getCurrentResult().data![0]!.observed?.state).toBe("running");
    expect(detailObs.getCurrentResult().data?.observed?.state).toBe("running");
    expect(qc.getQueryState(["servers"])?.status).toBe("success");
    expect(qc.getQueryState(["server", "a"])?.status).toBe("success");
    offs.forEach((off) => off());
  });
  it("desconocido en la lista y detalle en carga inicial: no se cancela ni se escribe el detalle", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    let resolveDetail!: (v: ServerDto) => void;
    const p = qc.fetchQuery({ queryKey: ["server", "nuevo"], queryFn: () => new Promise<ServerDto>((r) => { resolveDetail = r; }) });
    applyObservedEvent(qc, observedMsg("nuevo"));
    resolveDetail(server("nuevo"));
    await p;
    expect(qc.getQueryState(["server", "nuevo"])?.status).toBe("success");
    expect(qc.getQueryData<ServerDto>(["server", "nuevo"])!.observed).toBeNull();
  });
  it("invalida la lista si el servidor es desconocido (creado desde otra pestaña)", () => {
    const qc = new QueryClient();
    qc.setQueryData(["servers"], [server("a")]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyObservedEvent(qc, observedMsg("zzz"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["servers"] });
    expect(qc.getQueryData<ServerDto[]>(["servers"])).toHaveLength(1);
  });
  it("no crea caché si aún no se ha cargado", () => {
    const qc = new QueryClient();
    applyObservedEvent(qc, observedMsg("a"));
    expect(qc.getQueryData(["servers"])).toBeUndefined();
    expect(qc.getQueryData(["server", "a"])).toBeUndefined();
  });
});

describe("applyNodeEvent (P14)", () => {
  it("actualiza un nodo existente", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], [node("n1", "viejo")]);
    applyNodeEvent(qc, { type: "node", node: node("n1", "nuevo") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])!.map((n) => n.name)).toEqual(["nuevo"]);
  });
  it("incorpora un nodo nuevo que llega por WS", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nodes"], [node("n1")]);
    applyNodeEvent(qc, { type: "node", node: node("n2") });
    expect(qc.getQueryData<NodeDto[]>(["nodes"])!.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
  it("con la lista vacía también lo incorpora", () => {
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
  it("enruta eventos y limpia al desmontar", () => {
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
  it("invalida servidores y nodos al reconectar", () => {
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
