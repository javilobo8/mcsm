import { pipeline, type Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { FileEntry } from "@mcsm/proto";
import { INLINE_MAX_BYTES, type FileEntryDto } from "@mcsm/shared";
import type { Body } from "../agents/hub.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { TransferError, type OutboundTransfer } from "../transfers/service.js";
import { IDLE_TIMEOUT_MS, detachable, idleGuard, realTimers, type Timers } from "./stream.js";

/**
 * Translates an agent or transfer failure into an HttpError keeping its text (spec §10).
 * The file codes are already known to `agentErrorToHttp`; a transfer the agent did not
 * claim in time is 504 and any other cut, 502.
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
 * Deleting a large folder (a world on an SD card or a slow disk) can take minutes: with 30 s
 * the browser would see 504 while the agent keeps deleting. Rename does not need it: it is a
 * rename(2) and does not depend on size.
 */
const REMOVE_TIMEOUT_MS = 5 * 60_000;
/**
 * Deadline of FilesDownload/FilesUpload requests to the agent: none in practice (the maximum
 * of setTimeout, ~24.8 days). A transfer that makes progress can last as long as needed; dead
 * ones are cut by the claim expiry (60 s), the inactivity watchdog
 * (IDLE_TIMEOUT_MS), the WebSocket dropping and, on upload, the Ack deadline.
 */
const NO_DEADLINE_MS = 2 ** 31 - 1;
/**
 * Once the agent has received the whole body of an upload, what it has to confirm it (fsync and
 * rename of a multi-GiB file on a slow disk can take their time).
 */
export const ACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Internal sentinel: the browser is gone (cancelled, the network dropped or the panel cut its
 * connection on shutdown). It never reaches the wire because the socket is already closed; 499 is nginx's
 * "Client Closed Request", in case it shows up in a log.
 */
export class ClientGone extends HttpError {
  constructor(message: string) { super(499, message); this.name = "ClientGone"; }
}

/** Rejects only if the transfer expires without the agent claiming it; otherwise it never resolves. */
function failOnExpiry(done: Promise<void>): Promise<never> {
  return new Promise((_, reject) => {
    done.catch((e) => { if (e instanceof TransferError && e.code === "expired") reject(e); });
  });
}

/** Rejects when the browser leaves (or the panel shuts down with the request in progress); otherwise it never resolves. */
function failOnAbort(signal: AbortSignal | undefined, message: string): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new ClientGone(message)), { once: true });
  });
}

/**
 * Ack deadline of an upload: rejects with 504 if, once the body has been delivered (`delivered`
 * resolved), the agent does not confirm within `ms`. Otherwise it never resolves; `stop` disarms it.
 */
function ackDeadline(delivered: Promise<void>, ms: number, timers: Timers): { promise: Promise<never>; stop(): void } {
  let stopped = false;
  let disarm = () => {};
  const promise = new Promise<never>((_, reject) => {
    delivered.then(() => {
      if (stopped) return;
      disarm = timers.set(() => reject(new HttpError(504, "The agent received the file but did not confirm it saved it")), ms);
    }, () => {});
  });
  return { promise, stop: () => { stopped = true; disarm(); } };
}

export interface Download {
  /** Body of the agent's PUT: forwarded as is to the browser. */
  stream: Readable;
  /** Content-Length from the agent, or null if it did not send it. */
  size: number | null;
  /** Final response from the agent (Ack or Error): only to log it. */
  done: Promise<void>;
}

export class FilesService {
  /** Timers for the inactivity and Ack deadlines (tests provide a virtual clock). */
  timers: Timers = realTimers;

  constructor(protected app: FastifyInstance) {}

  /**
   * Pre-check of an upload from the browser (N2/m-n of Plan 5): what the panel knows without asking the
   * agent. A large upload that the agent rejects before reading it (server reserved) ends up in the browser as a
   * “network error” instead of with the reason; this way the web knows before it starts.
   */
  uploadCheck(serverId: string): void {
    this.target(serverId); // 404 / 409 offline
    const busy = this.app.jobs.activeForServer(serverId).find((j) => j.type === "backup" || j.type === "restore" || j.type === "migrate");
    if (busy?.type === "backup") throw new HttpError(409, "A backup is in progress: wait for it to finish before uploading files");
    if (busy?.type === "restore") throw new HttpError(409, "A restore is in progress: wait for it to finish before uploading files");
    if (busy || this.app.migrations.blockingServer(serverId)) throw new HttpError(409, "The server is being migrated: wait for it to finish (Migrate tab)");
  }

  /** Server and connection of its node: 404/409 before bothering the agent. */
  protected target(serverId: string) {
    const row = this.app.servers.get(serverId);
    if (!row) throw new HttpError(404, "Server not found");
    const conn = this.app.agents.get(row.node_id);
    if (!conn) throw new HttpError(409, "The node is offline");
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
    const res = await this.call(serverId, { case: "filesList", value: { serverId, path } }, "Could not list the folder");
    if (res.body.case !== "filesListResult") throw new HttpError(502, "Unexpected response from the agent");
    return { path, entries: res.body.value.entries.map(toEntryDto), truncated: res.body.value.truncated };
  }

  async stat(serverId: string, path: string): Promise<FileEntryDto> {
    const res = await this.call(serverId, { case: "filesStat", value: { serverId, path } }, "Could not query the file");
    if (res.body.case !== "filesStatResult" || !res.body.value.entry) throw new HttpError(502, "Unexpected response from the agent");
    return toEntryDto(res.body.value.entry);
  }

  async read(serverId: string, path: string): Promise<{ path: string; content: string; size: number }> {
    const res = await this.call(serverId, { case: "filesRead", value: { serverId, path, maxBytes: INLINE_MAX_BYTES } }, "Could not read the file");
    if (res.body.case !== "filesReadResult") throw new HttpError(502, "Unexpected response from the agent");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(res.body.value.content);
    } catch {
      throw new HttpError(415, "The file is not UTF-8 text: download it to open it");
    }
    if (content.includes("\u0000")) throw new HttpError(415, "The file looks binary: download it to open it");
    return { path, content, size: Number(res.body.value.size) };
  }

  async write(serverId: string, path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > INLINE_MAX_BYTES) throw new HttpError(413, "The content exceeds 2 MiB: upload it as a file");
    await this.call(serverId, { case: "filesWrite", value: { serverId, path, content: bytes } }, "Could not save the file");
  }

  async mkdir(serverId: string, path: string): Promise<void> {
    await this.call(serverId, { case: "filesMkdir", value: { serverId, path } }, "Could not create the folder");
  }

  async rename(serverId: string, from: string, to: string): Promise<void> {
    if (from === "/" || to === "/") throw new HttpError(400, "The root folder cannot be renamed");
    await this.call(serverId, { case: "filesRename", value: { serverId, from, to } }, "Could not rename");
  }

  async remove(serverId: string, path: string): Promise<void> {
    if (path === "/") throw new HttpError(400, "The root folder cannot be deleted");
    await this.call(serverId, { case: "filesDelete", value: { serverId, path } }, "Could not delete", REMOVE_TIMEOUT_MS);
  }

  /**
   * Download: the agent uploads the file via PUT /agent/transfer/:id and the stream is forwarded as is
   * to the browser. Agent errors before it starts uploading arrive as HttpError;
   * afterwards, the stream is cut (the browser sees it truncated thanks to Content-Length).
   *
   * `signal` is aborted if the browser leaves: the transfer is cancelled and the agent sees its PUT
   * cut (or a 404 if it had not started yet). The agent's WebSocket dropping with the
   * upload already under way does not cut it: the PUT is independent and the file arrives whole or not at all.
   * What cuts it is inactivity: IDLE_TIMEOUT_MS without a byte (node switched off, cable out).
   */
  async download(serverId: string, path: string, signal?: AbortSignal): Promise<Download> {
    if (signal?.aborted) throw new ClientGone("Download cancelled");
    const { row, conn } = this.target(serverId);
    const t = this.app.transfers.inbound(row.node_id);
    signal?.addEventListener("abort", () => t.cancel("the browser cancelled the download"), { once: true });
    const req = conn.request({ case: "filesDownload", value: { serverId, path, transferId: t.id } }, NO_DEADLINE_MS);
    const done = req.then(() => undefined);
    done.catch(() => {});
    try {
      const incoming = await Promise.race([
        t.incoming,
        req.then((): never => { throw new HttpError(502, "The agent finished without sending the file"); }),
      ]);
      // No bytes for IDLE_TIMEOUT_MS: cancelled (the agent's PUT is cut) and the browser
      // receives 504 if it had nothing yet, or the cut-off download if it had already started.
      const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
        t.cancel("the node stopped sending the file");
        return new HttpError(504, "The node stopped sending the file");
      }, this.timers);
      pipeline(incoming.stream, guard, () => { /* the response sees the result */ });
      return { stream: guard, size: incoming.size, done };
    } catch (e) {
      t.cancel("download failed");
      throw toHttpError(e, "Could not download the file");
    }
  }

  /**
   * Upload: the agent downloads the browser's body via GET /agent/transfer/:id, without going
   * through disk. `size` is the browser's Content-Length (null if chunked: the agent
   * receives -1 and applies its cap). Ends with the agent's response: Ack or its Error.
   *
   * No overall deadline: while bytes flow, it lasts as long as needed. With no bytes from the browser
   * for IDLE_TIMEOUT_MS it is cancelled (the agent sees its GET cut and discards the temp file); once
   * the body is delivered, the agent has ACK_TIMEOUT_MS to confirm. If the browser leaves
   * (`signal`), it is cancelled, the body is destroyed and the agent is not waited for.
   *
   * On failure, the body is left unread: whoever responds to the browser decides whether to drain it (see
   * `settleBody` in the routes).
   */
  async upload(serverId: string, path: string, body: Readable, size: number | null, signal?: AbortSignal): Promise<void> {
    let t: OutboundTransfer | undefined;
    let ack: { promise: Promise<never>; stop(): void } | undefined;
    try {
      if (signal?.aborted) throw new ClientGone("Upload cancelled"); // the agent is not even asked
      const { row, conn } = this.target(serverId);
      let claimed = false;
      const transfer = this.app.transfers.outbound(row.node_id, async () => {
        claimed = true;
        const guard = idleGuard(IDLE_TIMEOUT_MS, () => {
          transfer.cancel("the browser stopped sending the file");
          return new Error("The browser stopped sending the file");
        }, this.timers);
        pipeline(detachable(body), guard, () => { /* the agent's GET sees the result */ });
        return { stream: guard, size };
      });
      t = transfer;
      const req = conn.request({ case: "filesUpload", value: { serverId, path, transferId: t.id, size: BigInt(size ?? -1) } }, NO_DEADLINE_MS);
      ack = ackDeadline(t.done, ACK_TIMEOUT_MS, this.timers);
      await Promise.race([req, failOnExpiry(t.done), failOnAbort(signal, "Upload cancelled"), ack.promise]);
      // The Ack only counts if the agent really received the whole body (a faulty agent
      // could confirm without doing the GET). If it did, `done` resolves as soon as its GET's
      // response ends; if it was cut, it rejects (the inactivity watchdog bounds it).
      if (!claimed) throw new HttpError(502, "The agent confirmed the upload without having received the file");
      await Promise.race([t.done, failOnAbort(signal, "Upload cancelled")]).catch((e: unknown) => {
        throw e instanceof ClientGone ? e : new HttpError(502, "The agent confirmed the upload without having received the whole file");
      });
    } catch (e) {
      t?.cancel(signal?.aborted ? "the browser cancelled the upload" : "upload failed");
      if (signal?.aborted) body.destroy();
      throw toHttpError(e, "Could not upload the file");
    } finally {
      ack?.stop();
    }
  }
}
