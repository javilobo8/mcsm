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
  it("subscribes on open and routes messages by topic", () => {
    const { rt, sockets } = setup();
    const logs = vi.fn(); const nodes = vi.fn();
    rt.subscribe("server:a:logs", logs); rt.subscribe("nodes", nodes);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ type: "subscribe", topic: "server:a:logs" }, { type: "subscribe", topic: "nodes" }]);
    sockets[0]!.recv({ type: "log", serverId: "a", ts: 1, line: "hello" });
    sockets[0]!.recv({ type: "log_reset", serverId: "a" });
    sockets[0]!.recv({ type: "node", node: { id: "n" } });
    expect(logs).toHaveBeenCalledTimes(2);
    expect(nodes).toHaveBeenCalledTimes(1);
  });

  it("ignores non-object messages and a handler that throws does not stop the others", () => {
    const { rt, sockets } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error("boom"); }); const good = vi.fn();
    rt.subscribe("nodes", bad); rt.subscribe("nodes", good);
    sockets[0]!.open();
    for (const raw of ["null", "5", "\"x\"", "[]", "{no json"]) sockets[0]!.recv(raw);
    sockets[0]!.recv({ type: "node", node: {} });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("reconnects with backoff, resends subscribe and notifies with onReconnect (not on the first connection)", () => {
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

  it("stops retrying on an auth close code and notifies", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open(); sockets[0]!.drop(4401);
    vi.advanceTimersByTime(60000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it("if the upgrade fails and the session is not valid, it does not retry", async () => {
    const { rt, sockets } = setup(false);
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.drop(1006); // it never opened
    await vi.advanceTimersByTimeAsync(60000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    rt.resume();
    expect(sockets).toHaveLength(2);
  });

  it("if the upgrade fails with a valid session, it retries", async () => {
    const { rt, sockets } = setup(true);
    rt.subscribe("servers", () => {});
    sockets[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe("topicOf (Plan 9)", () => {
  it("events to the events topic and the router state to the nodes topic", () => {
    expect(topicOf({ type: "event", event: { id: "e", nodeId: null, serverId: null, serverName: null, level: "info", kind: "drift", message: "m", createdAt: "", agentAt: null } })).toBe("events");
    expect(topicOf({ type: "router", nodeId: "n1", router: {} as never })).toBe("nodes");
  });
});

describe("password change and WS 4401", () => {
  it("pure decision when the mutation ends", () => {
    expect(settleSessionChange(false, true)).toBe("reconnect");
    expect(settleSessionChange(true, true)).toBe("reconnect");
    expect(settleSessionChange(true, false)).toBe("lose");
    expect(settleSessionChange(false, false)).toBe("none");
  });

  it("a 4401 during the change does not lose the session; on success it reconnects with the new cookie", () => {
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

  it("on success and without a 4401 yet, the socket is renewed and a late 4401 from the old one is ignored", () => {
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

  it("if the mutation fails after a 4401, the session is lost; without a 4401 nothing happens", () => {
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

  it("outside a session change, 4401 still loses the session", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const settle = rt.expectSessionChange();
    settle(false);
    sockets[0]!.drop(4401);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("an in-flight checkAuthenticated (failed upgrade during the mutation) that resolves after settle(true) does not lose the session", async () => {
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
    sockets[0]!.drop(); // the upgrade fails (old cookie) and the session is checked
    settle(true); // the new cookie is already set
    expect(sockets).toHaveLength(2);
    answer(false); // the check went out with the old cookie
    await vi.advanceTimersByTimeAsync(60000);
    expect(lost).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
  });

  it("two overlapping expectSessionChange do not step on each other: the 4401 seen holds until both end", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const a = rt.expectSessionChange();
    sockets[0]!.drop(4401);
    const b = rt.expectSessionChange(); // it neither clears the 4401 already seen nor stops waiting
    a(true);
    sockets[1]!.drop(4401); // the new socket still with the old cookie: it keeps waiting
    expect(lost).not.toHaveBeenCalled();
    b(false);
    expect(lost).not.toHaveBeenCalled(); // there was a success in the batch: the cookie is new
  });

  it("if both overlapping ones fail after a 4401, the session is lost once", () => {
    const { rt, sockets } = setup();
    const lost = vi.fn(); rt.onAuthLost(lost);
    rt.subscribe("servers", () => {});
    sockets[0]!.open();
    const a = rt.expectSessionChange(); const b = rt.expectSessionChange();
    sockets[0]!.drop(4401);
    a(false);
    expect(lost).not.toHaveBeenCalled(); // one is still in progress
    b(false);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
