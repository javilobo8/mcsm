import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
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

  // Fix round 1: sustituye a "cancel tras reclamar no hace nada" del brief (decisión del
  // controlador): una transferencia en curso también se puede cortar.
  it("cancel tras reclamar aborta la signal, rechaza y destruye lo que se entregue tarde", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    t.cancel("el navegador se fue");
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toMatchObject({ code: "cancelled" });
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    const late = new PassThrough();
    c.deliver({ stream: late, size: null });
    expect(late.destroyed).toBe(true); // el PUT del agente no se queda esperando a un lector
    expect(svc.activeCount).toBe(0);
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

  // ── Fix round 1: registro de transferencias en curso ──

  it("closeAll con una de salida reclamada a mitad: rechaza done, aborta la signal, destruye la fuente y vacía el registro", async () => {
    const svc = new TransferService();
    const src = new PassThrough();
    const t = svc.outbound("n1", async () => ({ stream: src, size: 1 << 20 }));
    const c = svc.claim(t.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    expect(svc.activeCount).toBe(1);
    const { stream } = await c.source();
    src.write(Buffer.alloc(1024));
    // La ruta reacciona a la signal llamando a fail(aborted): no debe pisar el "cancelled".
    c.signal.addEventListener("abort", () => c.fail(new TransferError("aborted", "corte")));
    svc.closeAll();
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
    expect(c.signal.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(svc.activeCount).toBe(0);
    expect(svc.pendingCount).toBe(0);
    c.complete(); // tarde: no cambia nada
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("closeAll con una de entrada entregada a mitad: quien la lee ve el corte y el registro queda vacío", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    const body = new PassThrough();
    c.deliver({ stream: body, size: 1 << 20 });
    const { stream } = await t.incoming;
    const reading = (async () => { for await (const _ of stream) { /* consumidor */ } })();
    body.write(Buffer.alloc(1024));
    svc.closeAll();
    expect(c.signal.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
    await expect(reading).rejects.toThrow();
    expect(svc.activeCount).toBe(0);
  });

  it("closeAll con una de entrada reclamada sin entregar: rechaza incoming", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    svc.closeAll();
    await expect(t.incoming).rejects.toMatchObject({ code: "cancelled" });
    expect(c.signal.aborted).toBe(true);
    expect(svc.activeCount).toBe(0);
  });

  it("al completar o fallar salen del registro; la de entrada sale al terminar su cuerpo", async () => {
    const svc = new TransferService();
    const ok = svc.outbound("n1", async () => payload());
    const bad = svc.outbound("n1", async () => payload());
    const co = svc.claim(ok.id, "n1", "GET");
    const cb = svc.claim(bad.id, "n1", "GET");
    if (co?.kind !== "outbound" || cb?.kind !== "outbound") throw new Error();
    expect(svc.activeCount).toBe(2);
    co.complete();
    cb.fail(new TransferError("aborted", "corte"));
    expect(svc.activeCount).toBe(0);
    await expect(bad.done).rejects.toMatchObject({ code: "aborted" });

    const inc = svc.inbound("n1");
    const ci = svc.claim(inc.id, "n1", "PUT");
    if (ci?.kind !== "inbound") throw new Error();
    const body = new PassThrough();
    ci.deliver({ stream: body, size: 4 });
    expect(svc.activeCount).toBe(1);
    const { stream } = await inc.incoming;
    body.end("hola");
    stream.resume();
    await finished(stream); // el oyente del registro se puso antes (en deliver): ya ha saltado
    expect(svc.activeCount).toBe(0);
    inc.cancel(); // ya terminada: no hace nada
    await expect(inc.incoming).resolves.toMatchObject({ size: 4 });
  });

  it("inbound fail: rechaza incoming y sale del registro (p. ej. cuerpo con tipo equivocado)", async () => {
    const svc = new TransferService();
    const t = svc.inbound("n1");
    const c = svc.claim(t.id, "n1", "PUT");
    if (c?.kind !== "inbound") throw new Error();
    c.fail(new TransferError("aborted", "sin cuerpo"));
    await expect(t.incoming).rejects.toMatchObject({ code: "aborted" });
    expect(svc.activeCount).toBe(0);
  });

  it("outbound cancelada antes de invocar la fuente: source rechaza sin abrirla", async () => {
    const svc = new TransferService();
    let calls = 0;
    const t = svc.outbound("n1", async () => { calls++; return payload(); });
    const c = svc.claim(t.id, "n1", "GET");
    if (c?.kind !== "outbound") throw new Error();
    t.cancel();
    await expect(c.source()).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  it("outbound cancelada mientras la fuente se abre: destruye el stream recién abierto", async () => {
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
      const enCurso = svc.outbound("n1", async () => payload());
      svc.claim(enCurso.id, "n1", "GET");
      const entrada = svc.inbound("n1");
      svc.claim(entrada.id, "n1", "PUT");
      svc.closeAll(); // aborta las dos reclamadas sin que nadie espere sus promesas
      svc.inbound("n1"); // nace cancelada
      // Node emite unhandledRejection al vaciar la cola de microtareas; setImmediate corre después.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
