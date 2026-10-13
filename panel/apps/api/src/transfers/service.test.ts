import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { TransferError, TransferService } from "./service.js";

const payload = () => ({ stream: Readable.from([Buffer.from("hello")]), size: 4 });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("TransferService", () => {
  it("generates unpredictable 32-byte ids in base64url", () => {
    const svc = new TransferService();
    const a = svc.outbound("n1", async () => payload());
    const b = svc.inbound("n1");
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("a transferId is single use", () => {
    const svc = new TransferService();
    const t = svc.outbound("n1", async () => payload());
    expect(svc.claim(t.id, "n1", "GET")?.kind).toBe("outbound");
    expect(svc.claim(t.id, "n1", "GET")).toBeNull();
    expect(svc.pendingCount).toBe(0);
  });

  it("another node or the other direction do not consume it", () => {
    const svc = new TransferService();
    const out = svc.outbound("n1", async () => payload());
    const inc = svc.inbound("n1");
    expect(svc.claim(out.id, "n2", "GET")).toBeNull();
    expect(svc.claim(out.id, "n1", "PUT")).toBeNull();
    expect(svc.claim(inc.id, "n1", "GET")).toBeNull();
    expect(svc.claim(out.id, "n1", "GET")).not.toBeNull(); // still available for its owner
    expect(svc.claim(inc.id, "n1", "PUT")).not.toBeNull();
  });

  it("outbound: complete and fail resolve done", async () => {
    const svc = new TransferService();
    const ok = svc.outbound("n1", async () => payload());
    const c = svc.claim(ok.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    expect((await c.source()).size).toBe(4);
    c.complete();
    await expect(ok.done).resolves.toBeUndefined();

    const bad = svc.outbound("n1", async () => payload());
    const c2 = svc.claim(bad.id, "n1", "GET");
    if (c2?.kind !== "outbound") throw new Error();
    c2.fail(new TransferError("aborted", "The agent cut the transfer"));
    await expect(bad.done).rejects.toMatchObject({ code: "aborted" });
  });

  it("inbound: deliver resolves incoming with the stream", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    const p = payload();
    c.deliver(p);
    await expect(t.incoming).resolves.toBe(p);
  });

  it("expires what is unclaimed: sweep rejects and the late claim gives null", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 60_000 });
    const a = svc.inbound("n1");
    const b = svc.outbound("n1", async () => payload());
    c.advance(59_000);
    expect(svc.sweep()).toBe(0);
    c.advance(2_000);
    expect(svc.claim(b.id, "n1", "GET")).toBeNull(); // expired on claiming
    await expect(b.done).rejects.toMatchObject({ code: "expired" });
    expect(svc.sweep()).toBe(1);
    await expect(a.incoming).rejects.toBeInstanceOf(TransferError);
    expect(svc.pendingCount).toBe(0);
  });

  it("own claim deadline per transfer (migration): it does not expire with the service's", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 60_000 });
    const long = svc.outbound("n1", async () => payload(), { claimTtlMs: 30 * 60_000 });
    const longIn = svc.inbound("n1", { claimTtlMs: 30 * 60_000 });
    const short = svc.outbound("n1", async () => payload());
    c.advance(61_000);
    expect(svc.sweep()).toBe(1); // only the one with the default deadline (Files)
    await expect(short.done).rejects.toMatchObject({ code: "expired" });
    c.advance(28 * 60_000); // 29 min 1 s since creation
    expect(svc.claim(long.id, "n1", "GET")?.kind).toBe("outbound");
    expect(svc.sweep()).toBe(0);
    c.advance(60_000);
    expect(svc.sweep()).toBe(1);
    await expect(longIn.incoming).rejects.toMatchObject({ code: "expired" });
  });

  it("cancel before claiming rejects and leaves the id unusable; closeAll cancels everything", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    t.cancel("the browser left");
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    expect(svc.claim(t.id, "n1", "PUT")).toBeNull();
    const u = svc.outbound("n1", async () => payload());
    svc.closeAll();
    await expect(u.done).rejects.toMatchObject({ code: "cancelled" });
  });

  // Fix round 1: replaces the brief's "cancel after claiming does nothing" (controller
  // decision): an in-progress transfer can also be cut.
  it("cancel after claiming aborts the signal, rejects and destroys whatever is delivered late", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    t.cancel("the browser left");
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toMatchObject({ code: "cancelled" });
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    const late = new PassThrough();
    c.deliver({ stream: late, size: null });
    expect(late.destroyed).toBe(true); // the agent's PUT is not left waiting for a reader
    expect(svc.activeCount).toBe(0);
  });

  // ── Hardening (beyond the brief) ──

  it("a claim from another node does not consume even an expired one: sweep sweeps it", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 60_000 });
    const t = svc.outbound("n1", async () => payload());
    c.advance(61_000);
    expect(svc.claim(t.id, "n2", "GET")).toBeNull();
    expect(svc.pendingCount).toBe(1);
    expect(svc.sweep()).toBe(1);
    await expect(t.done).rejects.toMatchObject({ code: "expired" });
  });

  it("the deadline is exactly claimTtlMs: at the limit it can still be claimed", () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 1_000 });
    const t = svc.inbound("n1");
    c.advance(1_000);
    expect(svc.sweep()).toBe(0);
    expect(svc.claim(t.id, "n1", "PUT")?.kind).toBe("inbound");
  });

  it("after closeAll new transfers are born cancelled and none stay pending", async () => {
    const svc = new TransferService();
    svc.closeAll();
    const a = svc.inbound("n1");
    const b = svc.outbound("n1", async () => payload());
    expect(svc.pendingCount).toBe(0);
    expect(svc.claim(a.id, "n1", "PUT")).toBeNull();
    await expect(a.incoming).rejects.toMatchObject({ code: "cancelled" });
    await expect(b.done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("the source is lazy: it is not invoked if the transfer is cancelled or expires", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now });
    let calls = 0;
    const src = async () => { calls++; return payload(); };
    svc.outbound("n1", src).cancel();
    svc.outbound("n1", src);
    c.advance(120_000);
    svc.sweep();
    expect(calls).toBe(0);
  });

  it("repeated complete/fail/deliver do not change the first result", async () => {
    const svc = new TransferService();
    const out = svc.outbound("n1", async () => payload());
    const c = svc.claim(out.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    c.complete();
    c.fail(new TransferError("aborted", "late"));
    await expect(out.done).resolves.toBeUndefined();

    const inc = svc.inbound("n1");
    const ci = svc.claim(inc.id, "n1", "PUT");
    if (ci?.kind !== "inbound") throw new Error();
    const p = payload();
    ci.deliver(p);
    ci.deliver(payload());
    await expect(inc.incoming).resolves.toBe(p);
  });

  // ── Fix round 1: registry of transfers in progress ──

  it("closeAll with an outbound one claimed midway: rejects done, aborts the signal, destroys the source and empties the registry", async () => {
    const svc = new TransferService();
    const src = new PassThrough();
    const t = svc.outbound("n1", async () => ({ stream: src, size: 1 << 20 }));
    const c = svc.claim(t.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    expect(svc.activeCount).toBe(1);
    const { stream } = await c.source();
    src.write(Buffer.alloc(1024));
    // The route reacts to the signal by calling fail(aborted): it must not overwrite the "cancelled".
    c.signal.addEventListener("abort", () => c.fail(new TransferError("aborted", "cut")));
    svc.closeAll();
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
    expect(c.signal.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(svc.activeCount).toBe(0);
    expect(svc.pendingCount).toBe(0);
    c.complete(); // late: changes nothing
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("closeAll with an inbound one delivered midway: the reader sees the cut and the registry is left empty", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    const body = new PassThrough();
    c.deliver({ stream: body, size: 1 << 20 });
    const { stream } = await t.incoming;
    const reading = (async () => { for await (const _ of stream) { /* consumer */ } })();
    body.write(Buffer.alloc(1024));
    svc.closeAll();
    expect(c.signal.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
    await expect(reading).rejects.toThrow();
    expect(svc.activeCount).toBe(0);
  });

  it("closeAll with an inbound one claimed but not delivered: rejects incoming", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    svc.closeAll();
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    expect(c.signal.aborted).toBe(true);
    expect(svc.activeCount).toBe(0);
  });

  it("on completing or failing they leave the registry; the inbound one leaves when its body ends", async () => {
    const svc = new TransferService();
    const ok = svc.outbound("n1", async () => payload());
    const bad = svc.outbound("n1", async () => payload());
    const co = svc.claim(ok.id, "n1", "GET");
    const cb = svc.claim(bad.id, "n1", "GET");
    if (co?.kind !== "outbound" || cb?.kind !== "outbound") throw new Error();
    expect(svc.activeCount).toBe(2);
    co.complete();
    cb.fail(new TransferError("aborted", "cut"));
    expect(svc.activeCount).toBe(0);
    await expect(bad.done).rejects.toMatchObject({ code: "aborted" });

    const inc = svc.inbound("n1");
    const ci = svc.claim(inc.id, "n1", "PUT");
    if (ci?.kind !== "inbound") throw new Error();
    const body = new PassThrough();
    ci.deliver({ stream: body, size: 4 });
    expect(svc.activeCount).toBe(1);
    const { stream } = await inc.incoming;
    body.end("hello");
    stream.resume();
    await finished(stream); // the registry's listener was attached earlier (in deliver): it has already fired
    expect(svc.activeCount).toBe(0);
    inc.cancel(); // already finished: does nothing
    await expect(inc.incoming).resolves.toMatchObject({ size: 4 });
  });

  it("inbound fail: rejects incoming and leaves the registry (e.g. body with the wrong type)", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    c.fail(new TransferError("aborted", "no body"));
    await expect(t.incoming).rejects.toMatchObject({ code: "aborted" });
    expect(svc.activeCount).toBe(0);
  });

  it("outbound cancelled before invoking the source: source rejects without opening it", async () => {
    const svc = new TransferService();
    let calls = 0;
    const t = svc.outbound("n1", async () => { calls++; return payload(); });
    const c = svc.claim(t.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    t.cancel();
    await expect(c.source()).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  it("outbound cancelled while the source is opening: destroys the freshly opened stream", async () => {
    const svc = new TransferService();
    const src = new PassThrough();
    let open!: (p: { stream: PassThrough; size: number }) => void;
    const t = svc.outbound("n1", () => new Promise((r) => { open = r; }));
    const c = svc.claim(t.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    const sourcing = c.source();
    t.cancel();
    open({ stream: src, size: 0 });
    await expect(sourcing).rejects.toMatchObject({ code: "cancelled" });
    expect(src.destroyed).toBe(true);
  });

  it("nobody that does not await done/incoming causes an unhandledRejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => { seen.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const c = clock();
      const svc = new TransferService({ now: c.now });
      svc.inbound("n1").cancel();
      svc.outbound("n1", async () => payload()).cancel();
      svc.inbound("n1");
      svc.outbound("n1", async () => payload());
      c.advance(120_000);
      svc.sweep();
      const enCurso = svc.outbound("n1", async () => payload());
      svc.claim(enCurso.id, "n1", "GET");
      const entrada = svc.inbound("n1");
      svc.claim(entrada.id, "n1", "PUT");
      svc.closeAll(); // aborts the two claimed ones without anyone awaiting their promises
      svc.inbound("n1"); // born cancelled
      // Node emits unhandledRejection when draining the microtask queue; setImmediate runs after.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
