import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("init deletes the leftovers of a previous run and does not create the directory if it does not exist", async () => {
    const s = new Staging(dir);
    expect(await s.init()).toBe(0);
    await expect(stat(dir)).rejects.toThrow();
    await s.save("a", Readable.from([Buffer.from("x")]));
    await writeFile(join(dir, "b.part"), "medio");
    expect(await new Staging(dir).init()).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("save writes .part and renames it; source serves it and deletes it on close", async () => {
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

  it("if the stream fails it leaves no .part", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    const saving = s.save("roto", src);
    src.write("medio");
    src.destroy(new Error("cut"));
    await expect(saving).rejects.toThrow("cut");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects ids that could escape the directory", async () => {
    await expect(new Staging(dir).save("../x", Readable.from([]))).rejects.toThrow(/Invalid/);
  });

  it("sweep deletes only the old", async () => {
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

  // ── Hardening (beyond the brief) ──

  it("the directory is left at 0700 and the files at 0600", async () => {
    const s = new Staging(dir);
    const f = await s.save("perm", Readable.from([Buffer.from("x")]));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  });

  it("init sets a too-open staging directory back to 0700", async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    expect(await new Staging(dir).init()).toBe(0);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("maxBytes: going over the limit fails with 413 leaving nothing; the exact limit goes in", async () => {
    const s = new Staging(dir);
    const big = s.save("grande", Readable.from([Buffer.from("hola "), Buffer.from("mundo")]), { maxBytes: 9 });
    await expect(big).rejects.toBeInstanceOf(HttpError);
    await expect(big).rejects.toMatchObject({ status: 413 });
    expect(await readdir(dir)).toEqual([]);
    const ok = await s.save("justo", Readable.from([Buffer.from("hola "), Buffer.from("mundo")]), { maxBytes: 10 });
    expect(ok.size).toBe(10);
  });

  it("signal: aborting with data already written in the .part cuts, destroys the origin and leaves nothing", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    const ac = new AbortController();
    const saving = s.save("cancelado", src, { signal: ac.signal });
    src.write("medio");
    // Waits with a condition and a deadline (not a sleep): the first chunk is already on disk.
    await vi.waitFor(async () => {
      expect((await stat(join(dir, "cancelado.part"))).size).toBe(5);
    }, { timeout: 5000, interval: 5 });
    ac.abort();
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    expect(src.destroyed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("an invalid id also destroys the origin (whoever sends it is not left hanging)", async () => {
    const src = new PassThrough();
    await expect(new Staging(dir).save("a/b", src)).rejects.toThrow(/Invalid/);
    expect(src.destroyed).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("signal already aborted: creates nothing", async () => {
    const s = new Staging(dir);
    const src = new PassThrough();
    await expect(s.save("never", src, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(src.destroyed).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("an id taken by another write fails without deleting the foreign .part", async () => {
    const s = new Staging(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dup.part"), "from another write");
    await expect(s.save("dup", Readable.from([Buffer.from("x")]))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "dup.part"), "utf8")).toBe("from another write");
    expect(await readdir(dir)).toEqual(["dup.part"]); // no trace of what this save reserved
  });

  it("does not overwrite an existing .bin of the same id: fails with EEXIST and destroys the origin", async () => {
    const s = new Staging(dir);
    const first = await s.save("one", Readable.from([Buffer.from("first")]));
    const src = new PassThrough();
    await expect(s.save("one", src)).rejects.toMatchObject({ code: "EEXIST" });
    expect(src.destroyed).toBe(true);
    expect(await readFile(first.path, "utf8")).toBe("first");
    expect(await readdir(dir)).toEqual(["one.bin"]);
  });

  it("two simultaneous saves with the same id: one wins whole and the other fails without touching anything", async () => {
    const s = new Staging(dir);
    const results = await Promise.allSettled([
      s.save("par", Readable.from([Buffer.from("aaaa")])),
      s.save("par", Readable.from([Buffer.from("bbbb")])),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0] as PromiseRejectedResult).reason).toMatchObject({ code: "EEXIST" });
    expect(["aaaa", "bbbb"]).toContain(await readFile(join(dir, "par.bin"), "utf8"));
    expect(await readdir(dir)).toEqual(["par.bin"]);
  });

  it("source fails when invoked if the file no longer exists (the route can respond with the error)", async () => {
    const s = new Staging(dir);
    const f = await s.save("ido", Readable.from([Buffer.from("x")]));
    await s.remove(f);
    await expect(s.source(f)()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("source with removeAfter:false keeps the file; remove deletes it", async () => {
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

  it("source and remove only touch staging files even if the StagedFile comes tampered with", async () => {
    const s = new Staging(dir);
    const outside = join(dir, "..", "fuera.txt");
    await writeFile(outside, "intocable");
    await expect(s.remove({ id: "../fuera", path: outside, size: 9 })).rejects.toThrow(/Invalid/);
    await expect(s.source({ id: "x", path: outside, size: 9 })()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside, "utf8")).toBe("intocable");
  });

  it("source destroyed without being read also deletes the file", async () => {
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
