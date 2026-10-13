import { pipeline, type Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { FileEntry } from "@mcsm/proto";
import { INLINE_MAX_BYTES, type FileEntryDto } from "@mcsm/shared";
import type { Body } from "../agents/hub.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { TransferError, type OutboundTransfer } from "../transfers/service.js";
import { IDLE_TIMEOUT_MS, detachable, idleGuard, realTimers, type Timers } from "./stream.js";

/**
 * Traduce un fallo del agente o de una transferencia a HttpError conservando su texto (spec §10).
 * Los códigos de archivos ya los conoce `agentErrorToHttp`; una transferencia que el agente no
 * reclamó a tiempo es 504 y cualquier otro corte, 502.
 */
export function toHttpError(e: unknown, fallback: string): HttpError {
  if (e instanceof TransferError) return new HttpError(e.code === "expired" ? 504 : 502, e.message);
  return agentErrorToHttp(e, fallback);
}

export const toEntryDto = (e: FileEntry): FileEntryDto => ({
  name: e.name, dir: e.dir, symlink: e.symlink, size: Number(e.size), modifiedAt: Number(e.modTimeUnixMs), mode: e.mode,
});

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Borrar una carpeta grande (un mundo en una SD o un disco lento) puede tardar minutos: con 30 s
 * el navegador vería 504 mientras el agente sigue borrando. Renombrar no lo necesita: es un
 * rename(2) y no depende del tamaño.
 */
const REMOVE_TIMEOUT_MS = 5 * 60_000;
/**
 * Plazo de las peticiones FilesDownload/FilesUpload al agente: ninguno en la práctica (el máximo
 * de setTimeout, ~24,8 días). Una transferencia que avanza puede durar lo que haga falta; las
 * muertas las cortan la caducidad del reclamo (60 s), el vigilante de inactividad
 * (IDLE_TIMEOUT_MS), la caída del WebSocket y, en la subida, el plazo del Ack.
 */
const NO_DEADLINE_MS = 2 ** 31 - 1;
/**
 * Tras recibir el agente el cuerpo entero de una subida, lo que tiene para confirmarla (fsync y
 * rename de un fichero de varios GiB en un disco lento pueden llevar su tiempo).
 */
export const ACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Centinela interno: el navegador ya no está (canceló, se cayó la red o el panel cortó su
 * conexión al cerrarse). Nunca llega al cable porque el socket ya está cerrado; 499 es el
 * "Client Closed Request" de nginx, por si aparece en un log.
 */
export class ClientGone extends HttpError {
  constructor(message: string) { super(499, message); this.name = "ClientGone"; }
}

/** Rechaza solo si la transferencia caduca sin que el agente la reclame; si no, nunca se resuelve. */
function failOnExpiry(done: Promise<void>): Promise<never> {
  return new Promise((_, reject) => {
    done.catch((e) => { if (e instanceof TransferError && e.code === "expired") reject(e); });
  });
}

/** Rechaza cuando el navegador se va (o el panel se cierra con la petición en curso); si no, nunca se resuelve. */
function failOnAbort(signal: AbortSignal | undefined, message: string): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new ClientGone(message)), { once: true });
  });
}

/**
 * Plazo del Ack de una subida: rechaza con 504 si, entregado ya el cuerpo (`delivered`
 * resuelta), el agente no confirma en `ms`. Si no, nunca se resuelve; `stop` lo desarma.
 */
function ackDeadline(delivered: Promise<void>, ms: number, timers: Timers): { promise: Promise<never>; stop(): void } {
  let stopped = false;
  let disarm = () => {};
  const promise = new Promise<never>((_, reject) => {
    delivered.then(() => {
      if (stopped) return;
      disarm = timers.set(() => reject(new HttpError(504, "El agente recibió el fichero pero no confirmó que lo guardó")), ms);
    }, () => {});
  });
  return { promise, stop: () => { stopped = true; disarm(); } };
}

export interface Download {
  /** Cuerpo del PUT del agente: se reenvía tal cual al navegador. */
  stream: Readable;
  /** Content-Length del agente, o null si no lo envió. */
  size: number | null;
  /** Respuesta final del agente (Ack o Error): solo para registrarla. */
  done: Promise<void>;
}

export class FilesService {
  /** Temporizadores de los plazos de inactividad y del Ack (los tests ponen un reloj virtual). */
  timers: Timers = realTimers;

  constructor(protected app: FastifyInstance) {}

  /**
   * Comprobación previa de una subida desde el navegador (N2/m-n del Plan 5): lo que el panel sabe sin preguntar al
   * agente. Una subida grande que el agente rechaza antes de leerla (servidor reservado) acaba en el navegador como
   * «error de red» en vez de con el motivo; así la web lo sabe antes de empezar.
   */
  uploadCheck(serverId: string): void {
    this.target(serverId); // 404 / 409 desconectado
    const busy = this.app.jobs.activeForServer(serverId).find((j) => j.type === "backup" || j.type === "restore" || j.type === "migrate");
    if (busy?.type === "backup") throw new HttpError(409, "Hay una copia de seguridad en curso: espera a que termine para subir ficheros");
    if (busy?.type === "restore") throw new HttpError(409, "Hay una restauración en curso: espera a que termine para subir ficheros");
    if (busy || this.app.migrations.blockingServer(serverId)) throw new HttpError(409, "El servidor se está migrando: espera a que termine (pestaña Migrar)");
  }

  /** Servidor y conexión de su nodo: 404/409 antes de molestar al agente. */
  protected target(serverId: string) {
    const row = this.app.servers.get(serverId);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    const conn = this.app.agents.get(row.node_id);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return { row, conn };
  }

  private async call(serverId: string, body: Body, fallback: string, timeoutMs = REQUEST_TIMEOUT_MS) {
    const { conn } = this.target(serverId);
    try {
      return await conn.request(body, timeoutMs);
    } catch (e) {
      throw toHttpError(e, fallback);
    }
  }

  async list(serverId: string, path: string): Promise<{ path: string; entries: FileEntryDto[]; truncated: boolean }> {
    const res = await this.call(serverId, { case: "filesList", value: { serverId, path } }, "No se pudo listar la carpeta");
    if (res.body.case !== "filesListResult") throw new HttpError(502, "Respuesta inesperada del agente");
    return { path, entries: res.body.value.entries.map(toEntryDto), truncated: res.body.value.truncated };
  }

  async stat(serverId: string, path: string): Promise<FileEntryDto> {
    const res = await this.call(serverId, { case: "filesStat", value: { serverId, path } }, "No se pudo consultar el fichero");
    if (res.body.case !== "filesStatResult" || !res.body.value.entry) throw new HttpError(502, "Respuesta inesperada del agente");
    return toEntryDto(res.body.value.entry);
  }

  async read(serverId: string, path: string): Promise<{ path: string; content: string; size: number }> {
    const res = await this.call(serverId, { case: "filesRead", value: { serverId, path, maxBytes: INLINE_MAX_BYTES } }, "No se pudo leer el fichero");
    if (res.body.case !== "filesReadResult") throw new HttpError(502, "Respuesta inesperada del agente");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(res.body.value.content);
    } catch {
      throw new HttpError(415, "El fichero no es texto UTF-8: descárgalo para abrirlo");
    }
    if (content.includes("\u0000")) throw new HttpError(415, "El fichero parece binario: descárgalo para abrirlo");
    return { path, content, size: Number(res.body.value.size) };
  }

  async write(serverId: string, path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > INLINE_MAX_BYTES) throw new HttpError(413, "El contenido supera 2 MiB: súbelo como fichero");
    await this.call(serverId, { case: "filesWrite", value: { serverId, path, content: bytes } }, "No se pudo guardar el fichero");
  }

  async mkdir(serverId: string, path: string): Promise<void> {
    await this.call(serverId, { case: "filesMkdir", value: { serverId, path } }, "No se pudo crear la carpeta");
  }

  async rename(serverId: string, from: string, to: string): Promise<void> {
    if (from === "/" || to === "/") throw new HttpError(400, "No se puede renombrar la carpeta raíz");
    await this.call(serverId, { case: "filesRename", value: { serverId, from, to } }, "No se pudo renombrar");
  }

  async remove(serverId: string, path: string): Promise<void> {
    if (path === "/") throw new HttpError(400, "No se puede borrar la carpeta raíz");
    await this.call(serverId, { case: "filesDelete", value: { serverId, path } }, "No se pudo borrar", REMOVE_TIMEOUT_MS);
  }

  /**
   * Descarga: el agente sube el fichero por PUT /agent/transfer/:id y el stream se reenvía tal
   * cual al navegador. Los errores del agente antes de empezar a subir llegan como HttpError;
   * después, el stream se corta (el navegador lo ve truncado gracias al Content-Length).
   *
   * `signal` se aborta si el navegador se va: la transferencia se cancela y el agente ve su PUT
   * cortado (o un 404 si aún no lo había empezado). Una caída del WebSocket del agente con la
   * subida ya en marcha no la corta: el PUT es independiente y el fichero llega entero o nada.
   * Lo que la corta es la inactividad: IDLE_TIMEOUT_MS sin un byte (nodo apagado, cable fuera).
   */
  async download(serverId: string, path: string, signal?: AbortSignal): Promise<Download> {
    if (signal?.aborted) throw new ClientGone("Descarga cancelada");
    const { row, conn } = this.target(serverId);
    const t = this.app.transfers.inbound(row.node_id);
    signal?.addEventListener("abort", () => t.cancel("el navegador canceló la descarga"), { once: true });
    const req = conn.request({ case: "filesDownload", value: { serverId, path, transferId: t.id } }, NO_DEADLINE_MS);
    const done = req.then(() => undefined);
    done.catch(() => {});
    try {
      const incoming = await Promise.race([
        t.incoming,
        req.then((): never => { throw new HttpError(502, "El agente terminó sin enviar el fichero"); }),
      ]);
      // Sin bytes durante IDLE_TIMEOUT_MS: se cancela (el PUT del agente se corta) y el navegador
      // recibe 504 si aún no tenía nada, o la descarga cortada si ya había empezado.
      const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
        t.cancel("el nodo dejó de enviar el fichero");
        return new HttpError(504, "El nodo dejó de enviar el fichero");
      }, this.timers);
      pipeline(incoming.stream, guard, () => { /* el resultado lo ve la respuesta */ });
      return { stream: guard, size: incoming.size, done };
    } catch (e) {
      t.cancel("descarga fallida");
      throw toHttpError(e, "No se pudo descargar el fichero");
    }
  }

  /**
   * Subida: el agente descarga el cuerpo del navegador por GET /agent/transfer/:id, sin pasar
   * por disco. `size` es el Content-Length del navegador (null si viene chunked: el agente
   * recibe -1 y aplica su tope). Termina con la respuesta del agente: Ack o su Error.
   *
   * Sin plazo total: mientras pasen bytes, dura lo que haga falta. Sin bytes del navegador
   * durante IDLE_TIMEOUT_MS se cancela (el agente ve su GET cortado y descarta el temporal); una
   * vez entregado el cuerpo, el agente tiene ACK_TIMEOUT_MS para confirmar. Si el navegador se va
   * (`signal`), se cancela, se destruye el cuerpo y no se espera al agente.
   *
   * Al fallar, el cuerpo queda sin leer: quien responde al navegador decide si drenarlo (ver
   * `settleBody` en las rutas).
   */
  async upload(serverId: string, path: string, body: Readable, size: number | null, signal?: AbortSignal): Promise<void> {
    let t: OutboundTransfer | undefined;
    let ack: { promise: Promise<never>; stop(): void } | undefined;
    try {
      if (signal?.aborted) throw new ClientGone("Subida cancelada"); // ni se pregunta al agente
      const { row, conn } = this.target(serverId);
      let claimed = false;
      const transfer = this.app.transfers.outbound(row.node_id, async () => {
        claimed = true;
        const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
          transfer.cancel("el navegador dejó de enviar el fichero");
          return new Error("El navegador dejó de enviar el fichero");
        }, this.timers);
        pipeline(detachable(body), guard, () => { /* el resultado lo ve la GET del agente */ });
        return { stream: guard, size };
      });
      t = transfer;
      const req = conn.request({ case: "filesUpload", value: { serverId, path, transferId: t.id, size: BigInt(size ?? -1) } }, NO_DEADLINE_MS);
      ack = ackDeadline(t.done, ACK_TIMEOUT_MS, this.timers);
      await Promise.race([req, failOnExpiry(t.done), failOnAbort(signal, "Subida cancelada"), ack.promise]);
      // El Ack solo vale si el agente recibió de verdad el cuerpo entero (un agente defectuoso
      // podría confirmar sin hacer el GET). Si lo hizo, `done` se resuelve en cuanto termina la
      // respuesta de su GET; si se cortó, se rechaza (el vigilante de inactividad lo acota).
      if (!claimed) throw new HttpError(502, "El agente confirmó la subida sin haber recibido el fichero");
      await Promise.race([t.done, failOnAbort(signal, "Subida cancelada")]).catch((e: unknown) => {
        throw e instanceof ClientGone ? e : new HttpError(502, "El agente confirmó la subida sin haber recibido el fichero entero");
      });
    } catch (e) {
      t?.cancel(signal?.aborted ? "el navegador canceló la subida" : "subida fallida");
      if (signal?.aborted) body.destroy();
      throw toHttpError(e, "No se pudo subir el fichero");
    } finally {
      ack?.stop();
    }
  }
}
