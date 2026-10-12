import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../lib/http.js";
import type { TransferSource } from "./service.js";

/** Fichero en staging. `path` es informativo: `source` y `remove` lo derivan siempre de `id`. */
export interface StagedFile { id: string; path: string; size: number }

export interface SaveOptions {
  /** Corta la escritura: destruye el origen, borra el `.part` y rechaza con AbortError. */
  signal?: AbortSignal;
  /** Tamaño máximo en bytes; si el stream lo supera se corta con HttpError 413. */
  maxBytes?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Directorio de staging del panel (spec §5.1) para transferencias que no pueden ir en
 * streaming directo (p. ej. migración con el destino aún no listo, oleada B). Los flujos del
 * navegador del Plan 5 no lo usan: van en streaming sin tocar disco. Se vacía al arrancar,
 * cada fichero se borra al consumirse y `sweep` elimina lo abandonado.
 *
 * Directorio 0700 y ficheros 0600 (L9: está dentro del directorio de datos del panel). Los
 * datos nunca se cargan en memoria: `pipeline` con backpressure hacia y desde disco.
 */
export class Staging {
  private removing = new Set<Promise<void>>();

  constructor(readonly dir: string, private now: () => number = () => Date.now()) {}

  /** Borra los restos de una ejecución anterior y restringe el directorio a 0700. No lo crea. */
  async init(): Promise<number> {
    const names = await this.list();
    if (names === null) return 0;
    // Mejor esfuerzo, como data-dir.ts: un directorio ajeno (bind mount) no impide arrancar.
    await chmod(this.dir, 0o700).catch(() => {});
    await Promise.all(names.map((n) => rm(join(this.dir, n), { recursive: true, force: true })));
    return names.length;
  }

  /**
   * Guarda un stream: escribe `<id>.part` (exclusivo, 0600) y lo renombra a `<id>.bin` al
   * terminar. Si falla, se corta o supera `maxBytes`, borra su `.part` y rechaza. El id debe
   * ser único (p. ej. un transferId): un `.part` ajeno con el mismo id hace fallar con EEXIST.
   * El stream pasa a ser de Staging: si falla, queda destruido (quien lo envía ve el corte).
   */
  async save(id: string, stream: Readable, opts: SaveOptions = {}): Promise<StagedFile> {
    let part: string, path: string;
    try {
      part = this.file(id, "part");
      path = this.file(id, "bin");
      opts.signal?.throwIfAborted();
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      stream.destroy(); // sin error: nadie escucha 'error' en el origen todavía
      throw e;
    }

    let size = 0;
    const max = opts.maxBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (max !== undefined && size > max) cb(new HttpError(413, `El fichero supera el tamaño máximo admitido (${max} bytes)`));
        else cb(null, chunk);
      },
    });
    const out = createWriteStream(part, { flags: "wx", mode: 0o600 });
    // Solo borramos el .part si lo creamos nosotros: con EEXIST es de otra escritura.
    let created = false;
    out.once("open", () => { created = true; });
    try {
      await pipeline(stream, counter, out, opts.signal ? { signal: opts.signal } : {});
      await rename(part, path);
    } catch (e) {
      if (created) await rm(part, { force: true });
      throw e;
    }
    return { id, path, size };
  }

  /**
   * Fuente para TransferService.outbound. Abre el fichero al invocarse (si ya no existe, la
   * fuente rechaza y la ruta puede responder el error) y anuncia su tamaño real. Por defecto
   * borra el fichero al cerrarse el stream, termine bien o no.
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
      const stream = fh.createReadStream(); // cierra el descriptor al terminar o destruirse
      if (removeAfter) stream.once("close", () => { this.track(rm(path, { force: true })); });
      return { stream, size };
    };
  }

  async remove(file: StagedFile): Promise<void> {
    await rm(this.file(file.id, "bin"), { force: true });
  }

  /** Espera a que terminen los borrados lanzados al cerrarse las fuentes (cierre del panel, tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.removing]);
  }

  /** Borra lo que lleve más de maxAgeMs sin modificarse. Devuelve cuántas entradas. */
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
    if (!ID_RE.test(id)) throw new Error("Identificador de staging inválido");
    return join(this.dir, `${id}.${ext}`);
  }

  /** Entradas del directorio, o null si aún no existe. */
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
