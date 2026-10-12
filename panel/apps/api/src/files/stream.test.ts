import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { detachable, drain, idleGuard } from "./stream.js";
import { ManualTimers } from "../../test/manual-timers.js";

const collect = async (s: AsyncIterable<unknown>) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
};

describe("detachable", () => {
  it("copia el cuerpo tal cual", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.end("hola mundo");
    expect(await collect(out)).toBe("hola mundo");
  });

  it("si el consumidor corta, el origen se drena en vez de destruirse", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.write("primero");
    out.destroy();
    await new Promise((r) => out.once("close", r));
    src.end("resto que nadie quiere");
    await drain(src);
    expect(src.destroyed && !src.readableEnded).toBe(false);
    expect(src.readableEnded).toBe(true);
  });

  it("si el origen falla o se corta, la copia se destruye con error", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    src.destroy(new Error("aborted"));
    expect((await failed).message).toBe("aborted");
  });

  it("si el origen se cierra sin terminar y sin error, la copia falla igualmente (no se da por completa)", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    src.destroy();
    expect((await failed).message).toMatch(/interrumpió/);
    expect(out.readableEnded).toBe(false);
  });

  it("con el consumidor parado por contrapresión, cortarlo reanuda el origen hasta el final", async () => {
    const src = new PassThrough({ highWaterMark: 1024 });
    const out = detachable(src);
    // Nadie lee `out`: la tubería se detiene y el origen deja de aceptar escrituras.
    let accepted = true;
    for (let i = 0; i < 4096 && accepted; i++) accepted = src.write(Buffer.alloc(1024));
    expect(accepted).toBe(false);
    out.destroy();
    await new Promise((r) => out.once("close", r));
    if (src.writableNeedDrain) await new Promise((r) => src.once("drain", r)); // el origen vuelve a aceptar datos
    src.end(Buffer.alloc(4096));
    await drain(src);
    expect(src.readableEnded).toBe(true);
  });

  it("sobre un origen ya destruido con error, la copia falla con ese error (no se queda colgada)", async () => {
    const src = new PassThrough();
    src.on("error", () => {});
    src.destroy(new Error("aborted"));
    await new Promise((r) => src.once("close", r));
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    expect((await failed).message).toBe("aborted");
  });

  it("sobre un origen ya destruido sin error, la copia falla igualmente", async () => {
    const src = new PassThrough();
    src.destroy();
    await new Promise((r) => src.once("close", r));
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    expect((await failed).message).toMatch(/interrumpió/);
  });

  it("si el origen ya terminó, la copia se cierra limpia y el origen queda sin errores", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.end("todo");
    expect(await collect(out)).toBe("todo");
    await new Promise((r) => (out.closed ? r(null) : out.once("close", r)));
    expect(out.errored).toBeNull();
    expect(src.readableEnded).toBe(true);
    expect(src.errored).toBeNull();
  });
});

describe("drain", () => {
  it("no hace nada si el cuerpo ya terminó", async () => {
    const src = new PassThrough();
    src.end();
    src.resume();
    await new Promise((r) => src.once("end", r));
    await expect(drain(src)).resolves.toBe(true);
  });

  it("lee y descarta lo que quede hasta el final", async () => {
    const src = new PassThrough();
    src.write("sin leer");
    const drained = drain(src);
    src.end("y más");
    await expect(drained).resolves.toBe(true);
    expect(src.readableEnded).toBe(true);
  });

  it("un cuerpo destruido o que falla a mitad no la hace fallar", async () => {
    const gone = new PassThrough();
    gone.destroy();
    await expect(drain(gone)).resolves.toBe(false);
    const cut = new PassThrough();
    const drained = drain(cut);
    cut.destroy(new Error("aborted"));
    await expect(drained).resolves.toBe(false);
  });

  it("con tope: si queda más de maxBytes deja de esperar, sin destruir el cuerpo", async () => {
    const clock = new ManualTimers();
    const src = new PassThrough();
    const drained = drain(src, { maxBytes: 1024, timers: clock });
    src.write(Buffer.alloc(512));
    src.write(Buffer.alloc(1024));
    await expect(drained).resolves.toBe(false);
    expect(src.destroyed).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("dentro del tope termina normal", async () => {
    const src = new PassThrough();
    const drained = drain(src, { maxBytes: 1024, timers: new ManualTimers() });
    src.end(Buffer.alloc(1024));
    await expect(drained).resolves.toBe(true);
  });

  it("si el cuerpo se calla durante idleMs, lo destruye y devuelve false; cada trozo rearma el plazo", async () => {
    const clock = new ManualTimers();
    const src = new PassThrough();
    const drained = drain(src, { idleMs: 1000, timers: clock });
    clock.advance(900);
    await new Promise((r) => src.write("a", r));
    clock.advance(900); // 1800 desde el principio, pero solo 900 desde el último trozo
    expect(src.destroyed).toBe(false);
    clock.advance(100);
    await expect(drained).resolves.toBe(false);
    expect(src.destroyed).toBe(true);
  });
});

describe("idleGuard", () => {
  it("deja pasar los datos tal cual y se desarma al terminar", async () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    expect(clock.pending).toBe(1); // mide también la espera hasta el primer trozo
    g.end("hola");
    expect(await collect(g)).toBe("hola");
    expect(clock.pending).toBe(0);
  });

  it("sin trozos durante el plazo, se destruye con el error que devuelve onIdle", async () => {
    const clock = new ManualTimers();
    let called = 0;
    const g = idleGuard(1000, () => { called++; return new Error("inactivo"); }, clock);
    const failed = new Promise<Error>((r) => g.once("error", r));
    clock.advance(999);
    expect(called).toBe(0);
    clock.advance(1);
    expect(called).toBe(1);
    expect((await failed).message).toBe("inactivo");
    expect(clock.pending).toBe(0);
  });

  it("cada trozo rearma el plazo: un flujo lento pero continuo no se corta", async () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    const got = collect(g);
    for (let i = 0; i < 5; i++) {
      clock.advance(900);
      await new Promise((r) => g.write("x", r));
    }
    g.end();
    expect(await got).toBe("xxxxx");
    expect(g.destroyed && g.errored).toBeFalsy();
  });

  it("si quien lee deja de leer tras el último trozo, también vence", async () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    const failed = new Promise<Error>((r) => g.once("error", r));
    g.write("a");
    g.end(); // nadie lee: 'end' no llega
    clock.advance(1000);
    expect((await failed).message).toBe("inactivo");
  });

  it("destruida por fuera, se desarma", () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    g.destroy();
    expect(clock.pending).toBe(0);
  });
});
