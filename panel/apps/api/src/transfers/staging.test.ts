import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http.js";
import { Staging } from "./staging.js";

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), "mcsm-staging-")), "staging"); });
afterEach(async () => { await rm(join(dir, ".."), { recursive: true, force: true }); });

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

describe("Staging", () => {
  it("init borra los restos de una ejecución anterior y no crea el directorio si no existe", async () => {
    const s = new Staging(dir);
    expect(await s.init()).toBe(0);
    await expect(stat(dir)).rejects.toThrow();
    await s.save("a", Readable.from([Buffer.from("x")]));
    await writeFile(join(dir, "b.part"), "medio");
    expect(await new Staging(dir).init()).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("save escribe .part y lo renombra; source lo sirve y lo borra al cerrarse", async () => {
    const s = new Staging(dir);
    const f = await s.save("abc", Readable.from([Buffer.from("hola "), Buffer.from("mundo")]));
    expect(f.size).toBe(10);
    expect(await readFile(f.path, "utf8")).toBe("hola mundo");
    expect(await readdir(dir)).toEqual(["abc.bin"]);
    const { stream, size } = await s.source(f)();
    const closed = new Promise((r) => stream.once("close", r));
    expect(size).toBe(10);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hola mundo");
    await closed;
    await s.settled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("si el stream falla no deja el .part", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    const saving = s.save("roto", src);
    src.write("medio");
    src.destroy(new Error("corte"));
    await expect(saving).rejects.toThrow("corte");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rechaza ids que podrían salir del directorio", async () => {
    await expect(new Staging(dir).save("../x", Readable.from([]))).rejects.toThrow(/inválido/);
  });

  it("sweep borra solo lo viejo", async () => {
    let now = Date.now();
    const s = new Staging(dir, () => now);
    const viejo = await s.save("viejo", Readable.from([Buffer.from("1")]));
    await s.save("nuevo", Readable.from([Buffer.from("2")]));
    const hace2h = new Date(now - 2 * 3600_000);
    await utimes(viejo.path, hace2h, hace2h);
    expect(await s.sweep(3600_000)).toBe(1);
    expect(await readdir(dir)).toEqual(["nuevo.bin"]);
    now += 2 * 3600_000;
    expect(await s.sweep(3600_000)).toBe(1);
  });

  // ── Endurecimiento (además del brief) ──

  it("el directorio queda en 0700 y los ficheros en 0600", async () => {
    const s = new Staging(dir);
    const f = await s.save("perm", Readable.from([Buffer.from("x")]));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  });

  it("init devuelve a 0700 un directorio de staging demasiado abierto", async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    expect(await new Staging(dir).init()).toBe(0);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("maxBytes: lo que se pasa del límite falla con 413 sin dejar nada; el límite exacto entra", async () => {
    const s = new Staging(dir);
    const big = s.save("grande", Readable.from([Buffer.from("hola "), Buffer.from("mundo")]), { maxBytes: 9 });
    await expect(big).rejects.toBeInstanceOf(HttpError);
    await expect(big).rejects.toMatchObject({ status: 413 });
    expect(await readdir(dir)).toEqual([]);
    const ok = await s.save("justo", Readable.from([Buffer.from("hola "), Buffer.from("mundo")]), { maxBytes: 10 });
    expect(ok.size).toBe(10);
  });

  it("signal: abortar a mitad corta el pipeline, destruye el origen y borra el .part", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    const ac = new AbortController();
    const saving = s.save("cancelado", src, { signal: ac.signal });
    src.write("medio");
    ac.abort();
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    expect(src.destroyed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("un id inválido también destruye el origen (quien lo envía no se queda colgado)", async () => {
    const src = new PassThrough();
    await expect(new Staging(dir).save("a/b", src)).rejects.toThrow(/inválido/);
    expect(src.destroyed).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("signal ya abortada: no crea nada", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    await expect(s.save("nunca", src, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(src.destroyed).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("un id ocupado por otra escritura falla sin borrar el .part ajeno", async () => {
    const s = new Staging(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dup.part"), "de otra escritura");
    await expect(s.save("dup", Readable.from([Buffer.from("x")]))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "dup.part"), "utf8")).toBe("de otra escritura");
  });

  it("source falla al invocarse si el fichero ya no existe (la ruta puede responder el error)", async () => {
    const s = new Staging(dir);
    const f = await s.save("ido", Readable.from([Buffer.from("x")]));
    await s.remove(f);
    await expect(s.source(f)()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("source con removeAfter:false conserva el fichero; remove lo borra", async () => {
    const s = new Staging(dir);
    const f = await s.save("keep", Readable.from([Buffer.from("abc")]));
    const { stream, size } = await s.source(f, { removeAfter: false })();
    expect(size).toBe(3);
    expect(await readAll(stream)).toBe("abc");
    await s.settled();
    expect(await readdir(dir)).toEqual(["keep.bin"]);
    await s.remove(f);
    expect(await readdir(dir)).toEqual([]);
  });

  it("source y remove solo tocan ficheros del staging aunque el StagedFile venga alterado", async () => {
    const s = new Staging(dir);
    const outside = join(dir, "..", "fuera.txt");
    await writeFile(outside, "intocable");
    await expect(s.remove({ id: "../fuera", path: outside, size: 9 })).rejects.toThrow(/inválido/);
    await expect(s.source({ id: "x", path: outside, size: 9 })()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside, "utf8")).toBe("intocable");
  });

  it("source destruido sin leer también borra el fichero", async () => {
    const s = new Staging(dir);
    const f = await s.save("tirado", Readable.from([Buffer.from("x")]));
    const { stream } = await s.source(f)();
    const closed = new Promise((r) => stream.once("close", r));
    stream.destroy();
    await closed;
    await s.settled();
    expect(await readdir(dir)).toEqual([]);
  });
});
