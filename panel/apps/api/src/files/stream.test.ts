import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { detachable, drain } from "./stream.js";

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
    await expect(drain(src)).resolves.toBeUndefined();
  });

  it("lee y descarta lo que quede hasta el final", async () => {
    const src = new PassThrough();
    src.write("sin leer");
    const drained = drain(src);
    src.end("y más");
    await drained;
    expect(src.readableEnded).toBe(true);
  });

  it("un cuerpo destruido o que falla a mitad no la hace fallar", async () => {
    const gone = new PassThrough();
    gone.destroy();
    await expect(drain(gone)).resolves.toBeUndefined();
    const cut = new PassThrough();
    const drained = drain(cut);
    cut.destroy(new Error("aborted"));
    await expect(drained).resolves.toBeUndefined();
  });
});
