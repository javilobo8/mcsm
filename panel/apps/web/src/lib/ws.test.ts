import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Realtime, topicOf, type SocketLike } from "./ws";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: unknown[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(data: unknown) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
  drop(code?: number) { this.readyState = 3; this.onclose?.({ code }); }
}

function setup(authenticated = true) {
  const sockets: FakeSocket[] = [];
  const rt = new Realtime({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    checkAuthenticated: async () => authenticated,
    random: () => 1,
  });
  return { rt, sockets };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Realtime", () => {
  it("suscribe al abrir y enruta mensajes por topic", () => {
    const { rt, sockets } = setup();
    const logs = vi.fn(); const nodes = vi.fn();
    rt.subscribe("server:a:logs", logs); rt.subscribe("nodes", nodes);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ type: "subscribe", topic: "server:a:logs" }, { type: "subscribe", topic: "nodes" }]);
    sockets[0]!.recv({ type: "log", serverId: "a", ts: 1, line: "hola" });
    sockets[0]!.recv({ type: "log_reset", serverId: "a" });
    sockets[0]!.recv({ type: "node", node: { id: "n" } });
    expect(logs).toHaveBeenCalledTimes(2);
    expect(nodes).toHaveBeenCalledTimes(1);
  });

  it("ignora mensajes no objeto y un handler que lanza no corta a los demás", () => {
    const { rt, sockets } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error("boom"); }); const good = vi.fn();
    rt.subscribe("nodes", bad); rt.subscribe("nodes", good);
    sockets[0]!.open();
    for (const raw of ["null", "5", "\"x\"", "[]", "{no json"]) sockets[0]!.recv(raw);
    sockets[0]!.recv({ type: "node", node: {} });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("reconecta con backoff, reenvía subscribe y avisa con onReconnect (no en la primera conexión)", () => {
    const { rt, sockets } = setup();
    const onRe = vi.fn();
    rt.onReconnect(onRe);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    expect(onRe).not.toHaveBeenCalled();
    sockets[0]!.drop(1006);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([{ type: "subscribe", topic: "servers" }]);
    expect(onRe).toHaveBeenCalledTimes(1);
  });

  it("deja de reintentar con código de cierre de auth y avisa", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open(); sockets[0]!.drop(4401);
    vi.advanceTimersByTime(60000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it("si el upgrade falla y la sesión no es válida, no reintenta", async () => {
    const { rt, sockets } = setup(false);
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.drop(1006); // nunca abrió
    await vi.advanceTimersByTimeAsync(60000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    rt.resume();
    expect(sockets).toHaveLength(2);
  });

  it("si el upgrade falla con sesión válida, reintenta", async () => {
    const { rt, sockets } = setup(true);
    rt.subscribe("servers", () => {});
    sockets[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe("topicOf (Plan 9)", () => {
  it("eventos al topic events y el estado del router al topic nodes", () => {
    expect(topicOf({ type: "event", event: { id: "e", nodeId: null, serverId: null, serverName: null, level: "info", kind: "drift", message: "m", createdAt: "", agentAt: null } })).toBe("events");
    expect(topicOf({ type: "router", nodeId: "n1", router: {} as never })).toBe("nodes");
  });
});
