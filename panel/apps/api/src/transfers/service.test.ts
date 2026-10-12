import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TransferError, TransferService } from "./service.js";

const payload = () => ({ stream: Readable.from([Buffer.from("hola")]), size: 4 });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("TransferService", () => {
  it("genera ids impredecibles de 32 bytes en base64url", () => {
    const svc = new TransferService();
    const a = svc.outbound("n1", async () => payload());
    const b = svc.inbound("n1");
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("un transferId es de un solo uso", () => {
    const svc = new TransferService();
    const t = svc.outbound("n1", async () => payload());
    expect(svc.claim(t.id, "n1", "GET")?.kind).toBe("outbound");
    expect(svc.claim(t.id, "n1", "GET")).toBeNull();
    expect(svc.pendingCount).toBe(0);
  });

  it("otro nodo o el otro sentido no lo consumen", () => {
    const svc = new TransferService();
    const out = svc.outbound("n1", async () => payload());
    const inc = svc.inbound("n1");
    expect(svc.claim(out.id, "n2", "GET")).toBeNull();
    expect(svc.claim(out.id, "n1", "PUT")).toBeNull();
    expect(svc.claim(inc.id, "n1", "GET")).toBeNull();
    expect(svc.claim(out.id, "n1", "GET")).not.toBeNull(); // sigue disponible para su dueño
    expect(svc.claim(inc.id, "n1", "PUT")).not.toBeNull();
  });

  it("outbound: complete y fail resuelven done", async () => {
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
    c2.fail(new TransferError("aborted", "El agente cortó la transferencia"));
    await expect(bad.done).rejects.toMatchObject({ code: "aborted" });
  });

  it("inbound: deliver resuelve incoming con el stream", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    const p = payload();
    c.deliver(p);
    await expect(t.incoming).resolves.toBe(p);
  });

  it("caduca lo no reclamado: sweep rechaza y el reclamo tardío da null", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 60_000 });
    const a = svc.inbound("n1");
    const b = svc.outbound("n1", async () => payload());
    c.advance(59_000);
    expect(svc.sweep()).toBe(0);
    c.advance(2_000);
    expect(svc.claim(b.id, "n1", "GET")).toBeNull(); // caducada al reclamar
    await expect(b.done).rejects.toMatchObject({ code: "expired" });
    expect(svc.sweep()).toBe(1);
    await expect(a.incoming).rejects.toBeInstanceOf(TransferError);
    expect(svc.pendingCount).toBe(0);
  });

  it("cancel antes de reclamar rechaza y deja el id inservible; closeAll cancela todo", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    t.cancel("el navegador se fue");
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    expect(svc.claim(t.id, "n1", "PUT")).toBeNull();
    const u = svc.outbound("n1", async () => payload());
    svc.closeAll();
    await expect(u.done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancel tras reclamar no hace nada (la ruta gestiona el corte)", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    t.cancel();
    if (c?.kind !== "inbound") throw new Error();
    const p = payload();
    c.deliver(p);
    await expect(t.incoming).resolves.toBe(p);
  });

  // ── Endurecimiento (además del brief) ──

  it("un reclamo de otro nodo no consume ni siquiera una caducada: la barre sweep", async () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 60_000 });
    const t = svc.outbound("n1", async () => payload());
    c.advance(61_000);
    expect(svc.claim(t.id, "n2", "GET")).toBeNull();
    expect(svc.pendingCount).toBe(1);
    expect(svc.sweep()).toBe(1);
    await expect(t.done).rejects.toMatchObject({ code: "expired" });
  });

  it("el plazo es justo claimTtlMs: en el límite aún se puede reclamar", () => {
    const c = clock();
    const svc = new TransferService({ now: c.now, claimTtlMs: 1_000 });
    const t = svc.inbound("n1");
    c.advance(1_000);
    expect(svc.sweep()).toBe(0);
    expect(svc.claim(t.id, "n1", "PUT")?.kind).toBe("inbound");
  });

  it("tras closeAll las transferencias nuevas nacen canceladas y no quedan pendientes", async () => {
    const svc = new TransferService();
    svc.closeAll();
    const a = svc.inbound("n1");
    const b = svc.outbound("n1", async () => payload());
    expect(svc.pendingCount).toBe(0);
    expect(svc.claim(a.id, "n1", "PUT")).toBeNull();
    await expect(a.incoming).rejects.toMatchObject({ code: "cancelled" });
    await expect(b.done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("la fuente es perezosa: no se invoca si la transferencia se cancela o caduca", async () => {
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

  it("complete/fail/deliver repetidos no cambian el primer resultado", async () => {
    const svc = new TransferService();
    const out = svc.outbound("n1", async () => payload());
    const c = svc.claim(out.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    c.complete();
    c.fail(new TransferError("aborted", "tarde"));
    await expect(out.done).resolves.toBeUndefined();

    const inc = svc.inbound("n1");
    const ci = svc.claim(inc.id, "n1", "PUT");
    if (ci?.kind !== "inbound") throw new Error();
    const p = payload();
    ci.deliver(p);
    ci.deliver(payload());
    await expect(inc.incoming).resolves.toBe(p);
  });

  it("nadie que no espere done/incoming provoca un unhandledRejection", async () => {
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
      svc.closeAll();
      svc.inbound("n1"); // nace cancelada
      // Node emite unhandledRejection al vaciar la cola de microtareas; setImmediate corre después.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
