import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Realtime, settleSessionChange, topicOf, type SocketLike } from "./ws";

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

describe("cambio de contraseña y 4401 del WS", () => {
  it("decisión pura al terminar la mutación", () => {
    expect(settleSessionChange(false, true)).toBe("reconnect");
    expect(settleSessionChange(true, true)).toBe("reconnect");
    expect(settleSessionChange(true, false)).toBe("lose");
    expect(settleSessionChange(false, false)).toBe("none");
  });

  it("un 4401 durante el cambio no pierde la sesión; con éxito se reconecta con la cookie nueva", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    const onRe = vi.fn(); rt.onReconnect(onRe);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const settle = rt.expectSessionChange();
    sockets[0]!.drop(4401);
    vi.advanceTimersByTime(60000);
    expect(lost).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    settle(true);
    expect(lost).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([{ type: "subscribe", topic: "servers" }]);
    expect(onRe).toHaveBeenCalledTimes(1);
  });

  it("con éxito y sin 4401 aún, se renueva el socket y un 4401 tardío del viejo se ignora", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const settle = rt.expectSessionChange();
    settle(true);
    expect(sockets).toHaveLength(2);
    sockets[0]!.drop(4401);
    sockets[1]!.open();
    expect(lost).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
  });

  it("si la mutación falla tras un 4401, se pierde la sesión; sin 4401 no pasa nada", () => {
    const a = setup();
    const lostA = vi.fn(); a.rt.onAuthLost(lostA);
    a.rt.subscribe("servers", () => {});
    a.sockets[0]!.open();
    const settleA = a.rt.expectSessionChange();
    a.sockets[0]!.drop(4401);
    settleA(false);
    expect(lostA).toHaveBeenCalledTimes(1);

    const b = setup();
    const lostB = vi.fn(); b.rt.onAuthLost(lostB);
    b.rt.subscribe("servers", () => {});
    b.sockets[0]!.open();
    b.rt.expectSessionChange()(false);
    expect(lostB).not.toHaveBeenCalled();
    expect(b.sockets).toHaveLength(1);
  });

  it("fuera de un cambio de sesión, 4401 sigue perdiendo la sesión", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const settle = rt.expectSessionChange();
    settle(false);
    sockets[0]!.drop(4401);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("un checkAuthenticated en vuelo (upgrade fallido durante la mutación) que resuelve tras settle(true) no pierde la sesión", async () => {
    const sockets: FakeSocket[] = [];
    let answer!: (ok: boolean) => void;
    const rt = new Realtime({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      checkAuthenticated: () => new Promise<boolean>((r) => { answer = r; }),
      random: () => 1,
    });
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    const settle = rt.expectSessionChange();
    sockets[0]!.drop(); // el upgrade falla (cookie vieja) y se comprueba la sesión
    settle(true); // la cookie nueva ya está puesta
    expect(sockets).toHaveLength(2);
    answer(false); // la comprobación salió con la cookie vieja
    await vi.advanceTimersByTimeAsync(60000);
    expect(lost).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
  });

  it("dos expectSessionChange solapados no se pisan: el 4401 visto vale hasta que acaban los dos", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const a = rt.expectSessionChange();
    sockets[0]!.drop(4401);
    const b = rt.expectSessionChange(); // no borra el 4401 ya visto ni deja de esperar
    a(true);
    sockets[1]!.drop(4401); // el socket nuevo aún con la cookie vieja: sigue esperándose
    expect(lost).not.toHaveBeenCalled();
    b(false);
    expect(lost).not.toHaveBeenCalled(); // hubo un éxito en el lote: la cookie es nueva
  });

  it("si fallan los dos solapados tras un 4401, se pierde la sesión una vez", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const a = rt.expectSessionChange(); const b = rt.expectSessionChange();
    sockets[0]!.drop(4401);
    a(false);
    expect(lost).not.toHaveBeenCalled(); // aún queda uno en curso
    b(false);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
