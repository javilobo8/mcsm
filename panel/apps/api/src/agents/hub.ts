import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, type Envelope } from "@mcsm/proto";
import { AgentErrorCode } from "./error-codes.js";

/** Cuerpo del envelope en forma de inicializador: admite objetos planos sin $typeName. */
export type Body = NonNullable<MessageInitShape<typeof EnvelopeSchema>["body"]>;

/** Fallo de una petición al agente. `code`: catálogo en ./error-codes.ts (string: el agente puede enviar códigos nuevos). */
export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AgentError"; }
}

export interface HubLogger { warn(obj: object, msg: string): void }

export interface HubOptions {
  /** Logger para fallos de callbacks y mensajes ilegibles. */
  log?: HubLogger;
  /** Reloj inyectable (ms). */
  now?: () => number;
  /** Sin actividad durante este tiempo el agente se considera caído (spec §5.1). */
  idleTimeoutMs?: number;
  /** Cada cuánto se comprueba la actividad. */
  checkIntervalMs?: number;
  /** Primer id de envelope del panel (tests). Por defecto, aleatorio: ver `AgentHub.allocateId`. */
  firstId?: bigint;
}

type ResolvedOptions = Required<Omit<HubOptions, "log" | "firstId">> & { log: HubLogger };

/**
 * Cuerpos que son respuesta a una petición del panel: solo estos resuelven `pending`.
 * Convención del protocolo: toda respuesta con datos se llama `*Result` (CommandResult,
 * FilesListResult…), así cada área añade respuestas sin tocar esta función.
 */
export const isResponseCase = (c: string | undefined): boolean =>
  c === "ack" || c === "error" || (c?.endsWith("Result") ?? false);

interface Pending { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Stream { onFrame: (e: Envelope) => void; onClose: (reason: string) => void }

export class AgentConn {
  private pending = new Map<bigint, Pending>();
  private streams = new Map<bigint, Stream>();
  private lastActivity: number;
  private heartbeat: NodeJS.Timeout;
  private disposed = false;
  private isReady = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  /**
   * Se resuelve con el Ack de SyncSpecs (`markReady`) y se rechaza con `disconnected` si la
   * conexión cae antes. `request`/`openStream` lo esperan: ninguna petición sale al agente
   * antes de que tenga la foto del panel (salvo el propio SyncSpecs).
   */
  readonly ready: Promise<void>;

  constructor(
    readonly nodeId: string,
    private socket: WebSocket,
    private hub: AgentHub,
    private opts: ResolvedOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {}); // nadie está obligado a esperarla: sin rechazo no manejado
    this.lastActivity = opts.now();
    // Cualquier mensaje o ping del agente (lo envía cada 15 s) cuenta como actividad.
    socket.on("message", (data: Buffer) => {
      this.lastActivity = this.opts.now();
      this.handle(data);
    });
    socket.on("ping", () => { this.lastActivity = this.opts.now(); });
    socket.on("close", () => this.dispose("conexión cerrada"));
    socket.on("error", () => this.dispose("error de socket"));
    this.heartbeat = setInterval(() => {
      if (this.opts.now() - this.lastActivity > this.opts.idleTimeoutMs) {
        this.socket.terminate();
        this.dispose("sin actividad del agente");
      }
    }, opts.checkIntervalMs);
    this.heartbeat.unref();
  }

  send(body: Body, opts: { id?: bigint; streamId?: bigint } = {}): bigint {
    const id = opts.id ?? this.hub.allocateId();
    const env = create(EnvelopeSchema, { id, streamId: opts.streamId ?? 0n, body });
    this.socket.send(toBinary(EnvelopeSchema, env));
    return id;
  }

  /** Marca la sesión como sincronizada (Ack de SyncSpecs): libera las peticiones retenidas. */
  markReady() {
    if (this.disposed || this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }

  /**
   * Envía una petición y espera su respuesta (Ack, Error o CommandResult con el mismo id).
   * Hasta `ready` la petición queda retenida (salvo `syncSpecs`); `timeoutMs` cuenta desde
   * la llamada: si vence retenida falla con `syncing`, si vence ya enviada con `timeout`.
   */
  request(body: Body, timeoutMs = 30_000): Promise<Envelope> {
    return this.requestTracked(body, timeoutMs).response;
  }

  /**
   * Como `request`, pero devuelve también el id del envelope, ya fijado al volver: sirve para
   * correlacionar un mensaje no solicitado que lo cita (BackupInventory.request_id), que
   * puede llegar antes que la respuesta.
   */
  requestTracked(body: Body, timeoutMs = 30_000): { id: bigint; response: Promise<Envelope> } {
    const id = this.hub.allocateId();
    return { id, response: this.requestWithId(id, body, timeoutMs) };
  }

  private requestWithId(id: bigint, body: Body, timeoutMs: number): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      if (this.disposed || this.socket.readyState !== this.socket.OPEN) {
        reject(new AgentError(AgentErrorCode.Disconnected, "El nodo no está conectado"));
        return;
      }
      let sent = false;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(sent
          ? new AgentError(AgentErrorCode.Timeout, "El agente no respondió a tiempo")
          : new AgentError(AgentErrorCode.Syncing, "El nodo se está sincronizando; inténtalo de nuevo en unos segundos"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const go = () => {
        if (!this.pending.has(id)) return; // venció el plazo o la conexión cayó mientras esperaba
        try {
          this.send(body, { id });
          sent = true;
        } catch {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AgentError(AgentErrorCode.Disconnected, "No se pudo enviar al nodo"));
        }
      };
      if (this.isReady || body.case === "syncSpecs") go();
      else this.ready.then(go, () => { /* dispose ya rechazó la pendiente */ });
    });
  }

  async openStream(body: Body, onFrame: (e: Envelope) => void, onClose: (reason: string) => void): Promise<{ streamId: bigint; close(): void }> {
    // El protocolo fija stream_id = id de la petición: se registra ANTES de enviar, porque
    // el Ack y las primeras líneas pueden llegar en el mismo trozo y emitirse sin ceder el turno.
    const streamId = this.hub.allocateId();
    this.streams.set(streamId, { onFrame, onClose });
    try {
      const ack = await this.requestWithId(streamId, body, 30_000);
      if (ack.streamId !== streamId) throw new AgentError(AgentErrorCode.Protocol, "El agente no devolvió stream_id");
    } catch (e) {
      this.streams.delete(streamId);
      throw e;
    }
    return {
      streamId,
      close: () => {
        if (!this.streams.delete(streamId)) return;
        if (this.socket.readyState === this.socket.OPEN) {
          this.send({ case: "streamClose", value: { reason: "cerrado por el panel" } }, { streamId });
        }
      },
    };
  }

  private handle(data: Buffer) {
    let env: Envelope;
    try {
      env = fromBinary(EnvelopeSchema, new Uint8Array(data));
    } catch {
      this.opts.log.warn({ nodeId: this.nodeId }, "mensaje protobuf ilegible del agente");
      return;
    }
    try {
      this.dispatch(env);
    } catch (e) {
      this.opts.log.warn({ nodeId: this.nodeId, err: e, type: env.body.case }, "fallo procesando mensaje del agente");
    }
  }

  private dispatch(env: Envelope) {
    // Solo las respuestas (con id != 0) resuelven peticiones; un mensaje no solicitado
    // con el mismo id (hello, serverObserved, logLine...) nunca las consume.
    if (env.id !== 0n && isResponseCase(env.body.case)) {
      const p = this.pending.get(env.id);
      if (p) {
        this.pending.delete(env.id);
        clearTimeout(p.timer);
        if (env.body.case === "error") p.reject(new AgentError(env.body.value.code, env.body.value.message));
        else p.resolve(env);
        return;
      }
    }
    if (env.streamId !== 0n) {
      const s = this.streams.get(env.streamId);
      if (!s) return;
      if (env.body.case === "streamClose") {
        this.streams.delete(env.streamId);
        const reason = env.body.value.reason;
        this.safe(() => s.onClose(reason), "onClose de stream");
      } else {
        this.safe(() => s.onFrame(env), "onFrame de stream");
      }
      return;
    }
    this.hub.emit("message", this.nodeId, env);
  }

  private safe(fn: () => void, what: string) {
    try {
      fn();
    } catch (e) {
      this.opts.log.warn({ nodeId: this.nodeId, err: e }, `fallo en ${what}`);
    }
  }

  private dispose(reason: string) {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat);
    this.rejectReady(new AgentError(AgentErrorCode.Disconnected, "El nodo se desconectó"));
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentError(AgentErrorCode.Disconnected, "El nodo se desconectó"));
      this.pending.delete(id);
    }
    for (const [id, s] of this.streams) {
      this.streams.delete(id);
      this.safe(() => s.onClose(reason), "onClose de stream");
    }
    this.hub.detach(this.nodeId, this);
  }

  terminate() { this.socket.terminate(); }
  /** El socket está abierto y la conexión no se ha descartado: una petición saldrá de verdad. */
  get isOpen(): boolean { return !this.disposed && this.socket.readyState === this.socket.OPEN; }
}

export class AgentHub extends EventEmitter {
  private conns = new Map<string, AgentConn>();
  private opts: ResolvedOptions;
  private nextId: bigint;

  constructor(opts: HubOptions = {}) {
    super();
    const { firstId, ...rest } = opts;
    this.opts = { now: Date.now, idleTimeoutMs: 45_000, checkIntervalMs: 5_000, log: { warn: () => {} }, ...rest };
    // 0 es «no solicitado» y 1 lo usa el Hello del agente. Muy por debajo de 2^53.
    this.nextId = firstId ?? 2n + BigInt(randomInt(0, 2 ** 47));
  }

  /**
   * Id para un envelope del panel. Un solo contador para todas las sesiones del proceso, y
   * cada proceso empieza en un punto aleatorio: un id nunca se repite entre sesiones, así que
   * lo que el agente encoló en una sesión anterior (o para un panel anterior) y entrega en la
   * actual nunca cita una petición de esta (ver BackupInventory.request_id).
   */
  allocateId(): bigint {
    return this.nextId++;
  }

  attach(nodeId: string, socket: WebSocket): AgentConn {
    this.conns.get(nodeId)?.terminate(); // una sola sesión por nodo
    const conn = new AgentConn(nodeId, socket, this, this.opts);
    this.conns.set(nodeId, conn);
    this.emit("attached", nodeId);
    return conn;
  }

  detach(nodeId: string, conn?: AgentConn) {
    const current = this.conns.get(nodeId);
    if (conn && current !== conn) return; // ya fue reemplazada por una sesión nueva
    this.conns.delete(nodeId);
    this.emit("detached", nodeId);
  }

  get(nodeId: string): AgentConn | undefined { return this.conns.get(nodeId); }
  isOnline(nodeId: string): boolean { return this.conns.has(nodeId); }
}
