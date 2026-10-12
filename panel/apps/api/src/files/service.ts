import type { FastifyInstance } from "fastify";
import type { FileEntry } from "@mcsm/proto";
import { INLINE_MAX_BYTES, type FileEntryDto } from "@mcsm/shared";
import type { Body } from "../agents/hub.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";

/**
 * Traduce un fallo del agente a HttpError conservando su texto (spec §10). Los códigos de
 * archivos ya los conoce `agentErrorToHttp`; aquí solo se fija el texto de reserva.
 */
export const toHttpError = (e: unknown, fallback: string): HttpError => agentErrorToHttp(e, fallback);

export const toEntryDto = (e: FileEntry): FileEntryDto => ({
  name: e.name, dir: e.dir, symlink: e.symlink, size: Number(e.size), modifiedAt: Number(e.modTimeUnixMs), mode: e.mode,
});

const REQUEST_TIMEOUT_MS = 30_000;

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
}
