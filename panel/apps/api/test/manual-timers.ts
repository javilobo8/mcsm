import type { Timers } from "../src/files/stream.js";

/**
 * Test timers with a virtual clock: nothing expires until the test calls `advance`.
 * Replaces `realTimers` (e.g. `app.filesService.timers = clock`).
 */
export class ManualTimers implements Timers {
  private now = 0;
  private seq = 0;
  private armed = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.armed.set(id, { at: this.now + ms, fn });
    return () => { this.armed.delete(id); };
  }

  /** Timers armed and not yet expired. */
  get pending(): number { return this.armed.size; }

  /** Advances the clock and fires, in order of expiry, those that expire. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.armed) if (e[1].at <= this.now && (!next || e[1].at < next[1].at)) next = e;
      if (!next) return;
      this.armed.delete(next[0]);
      next[1].fn();
    }
  }
}
