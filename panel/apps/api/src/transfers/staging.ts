import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../lib/http.js";
import type { TransferSource } from "./service.js";

/** File in staging. `path` is informational: `source` and `remove` always derive it from `id`. */
export interface StagedFile { id: string; path: string; size: number }

export interface SaveOptions {
  /** Cuts the write: destroys the origin, deletes the `.part` and rejects with AbortError. */
  signal?: AbortSignal;
  /** Maximum size in bytes; if the stream exceeds it, it is cut with HttpError 413. */
  maxBytes?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The panel's staging directory (spec §5.1) for transfers that cannot go as
 * direct streaming (e.g. migration with the target not yet ready, wave B). The Plan 5
 * browser flows do not use it: they stream without touching disk. It is emptied on startup,
 * each file is deleted when consumed and `sweep` removes whatever is abandoned.
 *
 * Directory 0700 and files 0600 (L9: it is inside the panel's data directory). Data
 * is never loaded into memory: `pipeline` with backpressure to and from disk.
 */
export class Staging {
  private removing = new Set<Promise<void>>();

  constructor(readonly dir: string, private now: () => number = () => Date.now()) {}

  /** Deletes the leftovers of a previous run and restricts the directory to 0700. Does not create it. */
  async init(): Promise<number> {
    const names = await this.list();
    if (names === null) return 0;
    // Best effort, like data-dir.ts: a foreign directory (bind mount) does not prevent starting.
    await chmod(this.dir, 0o700).catch(() => {});
    await Promise.all(names.map((n) => rm(join(this.dir, n), { recursive: true, force: true })));
    return names.length;
  }

  /**
   * Saves a stream: reserves `<id>.bin` (exclusive), writes `<id>.part` (exclusive, 0600) and
   * renames it over its reservation when done. Never overwrites an existing `.bin`: a repeated id (another
   * `save` in progress or already finished) fails with EEXIST without touching what is foreign. If it fails, is cut or
   * exceeds `maxBytes`, it deletes its own and rejects. The stream becomes Staging's: if it fails, it is left
   * destroyed (whoever sends it sees the cut).
   */
  async save(id: string, stream: Readable, opts: SaveOptions = {}): Promise<StagedFile> {
    let part = "";
    let path = "";
    let size = 0;
    // Only what this save created is deleted: with EEXIST, the .part/.bin belongs to another write.
    let reserved = false;
    let created = false;
    try {
      part = this.file(id, "part");
      path = this.file(id, "bin");
      opts.signal?.throwIfAborted();
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const reservation = await open(path, "wx", 0o600);
      reserved = true;
      await reservation.close();

      const max = opts.maxBytes;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (max !== undefined && size > max) cb(new HttpError(413, `The file exceeds the maximum allowed size (${max} bytes)`));
          else cb(null, chunk);
        },
      });
      const out = createWriteStream(part, { flags: "wx", mode: 0o600 });
      out.once("open", () => { created = true; });
      await pipeline(stream, counter, out, opts.signal ? { signal: opts.signal } : {});
      await rename(part, path); // over its own reservation: atomic
    } catch (e) {
      stream.destroy(); // without an error: if it failed before the pipeline, nobody listens for 'error' on the origin
      if (created) await rm(part, { force: true }).catch(() => {});
      if (reserved) await rm(path, { force: true }).catch(() => {});
      throw e;
    }
    return { id, path, size };
  }

  /**
   * Source for TransferService.outbound. Opens the file when invoked (if it no longer exists, the
   * source rejects and the route can respond with the error) and announces its real size.
   *
   * `removeAfter` (true by default) deletes the file when the stream closes, **whether it ends well
   * or not**: for single-attempt deliveries. If the file is the only origin of something that
   * must be retryable —migration between nodes (wave B)—, use `removeAfter: false` and
   * call `remove(file)` after the transfer's `done` resolves (and on its definitive failure).
   * Whatever is never invoked (expired or cancelled transfer) stays until `sweep` or the
   * next startup.
   */
  source(file: StagedFile, opts: { removeAfter?: boolean } = {}): TransferSource {
    const removeAfter = opts.removeAfter ?? true;
    const path = this.file(file.id, "bin");
    return async () => {
      const fh = await open(path, "r");
      let size: number;
      try {
        size = (await fh.stat()).size;
      } catch (e) {
        await fh.close();
        throw e;
      }
      const stream = fh.createReadStream(); // closes the descriptor on finishing or being destroyed
      if (removeAfter) stream.once("close", () => { this.track(rm(path, { force: true })); });
      return { stream, size };
    };
  }

  async remove(file: StagedFile): Promise<void> {
    await rm(this.file(file.id, "bin"), { force: true });
  }

  /** Waits for the deletions launched when sources close to finish (panel shutdown, tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.removing]);
  }

  /** Deletes whatever has gone more than maxAgeMs without being modified. Returns how many entries. */
  async sweep(maxAgeMs: number): Promise<number> {
    const names = await this.list();
    if (names === null) return 0;
    let n = 0;
    for (const name of names) {
      const p = join(this.dir, name);
      const st = await lstat(p).catch(() => null);
      if (st && this.now() - st.mtimeMs > maxAgeMs) {
        await rm(p, { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }

  private file(id: string, ext: "part" | "bin"): string {
    if (!ID_RE.test(id)) throw new Error("Invalid staging identifier");
    return join(this.dir, `${id}.${ext}`);
  }

  /** Directory entries, or null if it does not exist yet. */
  private async list(): Promise<string[] | null> {
    try {
      return await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private track(p: Promise<void>) {
    const t: Promise<void> = p.catch(() => {}).finally(() => this.removing.delete(t));
    this.removing.add(t);
  }
}
