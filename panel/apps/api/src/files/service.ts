import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { FileEntry } from "@mcsm/proto";
import { INLINE_MAX_BYTES, type FileEntryDto } from "@mcsm/shared";
import type { Body } from "../agents/hub.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { TransferError, type OutboundTransfer } from "../transfers/service.js";
import { detachable, drain } from "./stream.js";

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
/** Tope de una subida o descarga completa a través del panel; la caducidad de 60 s cubre al agente que no arranca. */
export const TRANSFER_TIMEOUT_MS = 60 * 60_000;

/** Rechaza solo si la transferencia caduca sin que el agente la reclame; si no, nunca se resuelve. */
function failOnExpiry(done: Promise<void>): Promise<never> {
  return new Promise((_, reject) => {
    done.catch((e) => { if (e instanceof TransferError && e.code === "expired") reject(e); });
  });
}

/** Rechaza cuando el navegador se va (o el panel se cierra con la petición en curso); si no, nunca se resuelve. */
function failOnAbort(signal: AbortSignal | undefined, message: string): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new HttpError(499, message)), { once: true });
  });
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
  constructor(protected app: FastifyInstance) {}

  /** Servidor y conexión de su nodo: 404/409 antes de molestar al agente. */
  protected target(serverId: string) {
    const row = this.app.servers.get(serverId);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    const conn = this.app.agents.get(row.node_id);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return { row, conn };
  }

  private async call(serverId: string, body: Body, fallback: string) {
    const { conn } = this.target(serverId);
    try {
      return await conn.request(body, REQUEST_TIMEOUT_MS);
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
    await this.call(serverId, { case: "filesDelete", value: { serverId, path } }, "No se pudo borrar");
  }

  /**
   * Descarga: el agente sube el fichero por PUT /agent/transfer/:id y el stream se reenvía tal
   * cual al navegador. Los errores del agente antes de empezar a subir llegan como HttpError;
   * después, el stream se corta (el navegador lo ve truncado gracias al Content-Length).
   *
   * `signal` se aborta si el navegador se va: la transferencia se cancela y el agente ve su PUT
   * cortado (o un 404 si aún no lo había empezado). Una caída del WebSocket del agente con la
   * subida ya en marcha no la corta: el PUT es independiente y el fichero llega entero o nada.
   */
  async download(serverId: string, path: string, signal?: AbortSignal): Promise<Download> {
    if (signal?.aborted) throw new HttpError(499, "Descarga cancelada");
    const { row, conn } = this.target(serverId);
    const t = this.app.transfers.inbound(row.node_id);
    signal?.addEventListener("abort", () => t.cancel("el navegador canceló la descarga"), { once: true });
    const req = conn.request({ case: "filesDownload", value: { serverId, path, transferId: t.id } }, TRANSFER_TIMEOUT_MS);
    const done = req.then(() => undefined);
    done.catch(() => {});
    try {
      const incoming = await Promise.race([
        t.incoming,
        req.then((): never => { throw new HttpError(502, "El agente terminó sin enviar el fichero"); }),
      ]);
      return { stream: incoming.stream, size: incoming.size, done };
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
   * Si el agente falla, se drena lo que quede del cuerpo para responder al navegador con el error
   * del agente en vez de con un corte de red. Si el navegador se va (`signal`), la transferencia
   * se cancela (el agente ve su GET cortado y descarta el temporal) y no se espera al agente.
   */
  async upload(serverId: string, path: string, body: Readable, size: number | null, signal?: AbortSignal): Promise<void> {
    let t: OutboundTransfer | undefined;
    try {
      if (signal?.aborted) throw new HttpError(499, "Subida cancelada"); // ni se pregunta al agente
      const { row, conn } = this.target(serverId);
      t = this.app.transfers.outbound(row.node_id, async () => ({ stream: detachable(body), size }));
      const req = conn.request({ case: "filesUpload", value: { serverId, path, transferId: t.id, size: BigInt(size ?? -1) } }, TRANSFER_TIMEOUT_MS);
      await Promise.race([req, failOnExpiry(t.done), failOnAbort(signal, "Subida cancelada")]);
    } catch (e) {
      if (signal?.aborted) {
        t?.cancel("el navegador canceló la subida");
        body.destroy();
      } else {
        t?.cancel("subida fallida");
        await drain(body);
      }
      throw toHttpError(e, "No se pudo subir el fichero");
    }
  }
}
