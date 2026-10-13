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
  it("copies the body as is", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.end("hola mundo");
    expect(await collect(out)).toBe("hola mundo");
  });

  it("if the consumer cuts off, the source is drained instead of destroyed", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.write("primero");
    out.destroy();
    await new Promise((r) => out.once("close", r));
    src.end("rest that nobody wants");
    await drain(src);
    expect(src.destroyed && !src.readableEnded).toBe(false);
    expect(src.readableEnded).toBe(true);
  });

  it("if the source fails or is cut, the copy is destroyed with an error", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    src.destroy(new Error("aborted"));
    expect((await failed).message).toBe("aborted");
  });

  it("if the source closes without finishing and without error, the copy fails anyway (it is not taken as complete)", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    src.destroy();
    expect((await failed).message).toMatch(/interrupted/);
    expect(out.readableEnded).toBe(false);
  });

  it("with the consumer stalled by backpressure, cutting it resumes the source to the end", async () => {
    const src = new PassThrough({ highWaterMark: 1024 });
    const out = detachable(src);
    // Nobody reads `out`: the pipeline stalls and the source stops accepting writes.
    let accepted = true;
    for (let i = 0; i < 4096 && accepted; i++) accepted = src.write(Buffer.alloc(1024));
    expect(accepted).toBe(false);
    out.destroy();
    await new Promise((r) => out.once("close", r));
    if (src.writableNeedDrain) await new Promise((r) => src.once("drain", r)); // the origin accepts data again
    src.end(Buffer.alloc(4096));
    await drain(src);
    expect(src.readableEnded).toBe(true);
  });

  it("on an already destroyed source with an error, the copy fails with that error (it does not hang)", async () => {
    const src = new PassThrough();
    src.on("error", () => {});
    src.destroy(new Error("aborted"));
    await new Promise((r) => src.once("close", r));
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    expect((await failed).message).toBe("aborted");
  });

  it("on an already destroyed source without an error, the copy fails anyway", async () => {
    const src = new PassThrough();
    src.destroy();
    await new Promise((r) => src.once("close", r));
    const out = detachable(src);
    const failed = new Promise<Error>((r) => out.once("error", r));
    expect((await failed).message).toMatch(/interrupted/);
  });

  it("if the source already finished, the copy closes cleanly and the source is left without errors", async () => {
    const src = new PassThrough();
    const out = detachable(src);
    src.end("all");
    expect(await collect(out)).toBe("all");
    await new Promise((r) => (out.closed ? r(null) : out.once("close", r)));
    expect(out.errored).toBeNull();
    expect(src.readableEnded).toBe(true);
    expect(src.errored).toBeNull();
  });
});

describe("drain", () => {
  it("does nothing if the body already finished", async () => {
    const src = new PassThrough();
    src.end();
    src.resume();
    await new Promise((r) => src.once("end", r));
    await expect(drain(src)).resolves.toBe(true);
  });

  it("reads and discards whatever remains to the end", async () => {
    const src = new PassThrough();
    src.write("unread");
    const drained = drain(src);
    src.end("and more");
    await expect(drained).resolves.toBe(true);
    expect(src.readableEnded).toBe(true);
  });

  it("a body destroyed or failing midway does not make it fail", async () => {
    const gone = new PassThrough();
    gone.destroy();
    await expect(drain(gone)).resolves.toBe(false);
    const cut = new PassThrough();
    const drained = drain(cut);
    cut.destroy(new Error("aborted"));
    await expect(drained).resolves.toBe(false);
  });

  it("with a cap: if more than maxBytes remains it stops waiting, without destroying the body", async () => {
    const clock = new ManualTimers();
    const src = new PassThrough();
    const drained = drain(src, { maxBytes: 1024, timers: clock });
    src.write(Buffer.alloc(512));
    src.write(Buffer.alloc(1024));
    await expect(drained).resolves.toBe(false);
    expect(src.destroyed).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("within the cap it ends normally", async () => {
    const src = new PassThrough();
    const drained = drain(src, { maxBytes: 1024, timers: new ManualTimers() });
    src.end(Buffer.alloc(1024));
    await expect(drained).resolves.toBe(true);
  });

  it("if the body goes silent for idleMs, it destroys it and returns false; each chunk re-arms the deadline", async () => {
    const clock = new ManualTimers();
    const src = new PassThrough();
    const drained = drain(src, { idleMs: 1000, timers: clock });
    clock.advance(900);
    await new Promise((r) => src.write("a", r));
    clock.advance(900); // 1800 since the start, but only 900 since the last chunk
    expect(src.destroyed).toBe(false);
    clock.advance(100);
    await expect(drained).resolves.toBe(false);
    expect(src.destroyed).toBe(true);
  });
});

describe("idleGuard", () => {
  it("passes data through as is and disarms itself on finishing", async () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    expect(clock.pending).toBe(1); // it also measures the wait until the first chunk
    g.end("hola");
    expect(await collect(g)).toBe("hola");
    expect(clock.pending).toBe(0);
  });

  it("with no chunks during the deadline, it is destroyed with the error returned by onIdle", async () => {
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

  it("each chunk re-arms the deadline: a slow but continuous flow is not cut", async () => {
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

  it("if the reader stops reading after the last chunk, it also expires", async () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    const failed = new Promise<Error>((r) => g.once("error", r));
    g.write("a");
    g.end(); // nobody reads: 'end' does not arrive
    clock.advance(1000);
    expect((await failed).message).toBe("inactivo");
  });

  it("destroyed from outside, it disarms itself", () => {
    const clock = new ManualTimers();
    const g = idleGuard(1000, () => new Error("inactivo"), clock);
    g.destroy();
    expect(clock.pending).toBe(0);
  });
});
