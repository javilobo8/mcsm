import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, type Envelope } from "@mcsm/proto";

/** Cuerpo del envelope en forma de inicializador: admite objetos planos sin $typeName. */
export type Body = NonNullable<MessageInitShape<typeof EnvelopeSchema>["body"]>;

export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AgentError"; }
}

export interface HubOptions {
  /** Reloj inyectable (ms). */
  now?: () => number;
  /** Sin actividad durante este tiempo el agente se considera caído (spec §5.1). */
  idleTimeoutMs?: number;
  /** Cada cuánto se comprueba la actividad. */
  checkIntervalMs?: number;
}

interface Pending { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Stream { onFrame: (e: Envelope) => void; onClose: (reason: string) => void }

export class AgentConn {
  private nextId = 2n; // 1 lo usa el Hello del agente
  private pending = new Map<bigint, Pending>();
  private streams = new Map<bigint, Stream>();
  private lastActivity: number;
  private heartbeat: NodeJS.Timeout;
  private disposed = false;

  constructor(
    readonly nodeId: string,
    private socket: WebSocket,
    private hub: AgentHub,
    private opts: Required<HubOptions>,
  ) {
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
    const id = opts.id ?? this.nextId++;
    const env = create(EnvelopeSchema, { id, streamId: opts.streamId ?? 0n, body });
    this.socket.send(toBinary(EnvelopeSchema, env));
    return id;
  }

  request(body: Body, timeoutMs = 30_000): Promise<Envelope> {
    return this.requestWithId(this.nextId++, body, timeoutMs);
  }

  private requestWithId(id: bigint, body: Body, timeoutMs: number): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      this.send(body, { id });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("timeout", "El agente no respondió a tiempo"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async openStream(body: Body, onFrame: (e: Envelope) => void, onClose: (reason: string) => void): Promise<{ streamId: bigint; close(): void }> {
    // El protocolo fija stream_id = id de la petición: se registra ANTES de enviar, porque
    // el Ack y las primeras líneas pueden llegar en el mismo trozo y emitirse sin ceder el turno.
    const streamId = this.nextId++;
    this.streams.set(streamId, { onFrame, onClose });
    try {
      const ack = await this.requestWithId(streamId, body, 30_000);
      if (ack.streamId !== streamId) throw new AgentError("protocol", "El agente no devolvió stream_id");
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
      return;
    }
    if (env.streamId !== 0n && env.body.case !== "ack") {
      const s = this.streams.get(env.streamId);
      if (!s) return;
      if (env.body.case === "streamClose") {
        this.streams.delete(env.streamId);
        s.onClose(env.body.value.reason);
      } else {
        s.onFrame(env);
      }
      return;
    }
    const p = this.pending.get(env.id);
    if (p) {
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      if (env.body.case === "error") p.reject(new AgentError(env.body.value.code, env.body.value.message));
      else p.resolve(env);
      return;
    }
    this.hub.emit("message", this.nodeId, env);
  }

  private dispose(reason: string) {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentError("disconnected", "El nodo se desconectó"));
      this.pending.delete(id);
    }
    for (const [id, s] of this.streams) {
      this.streams.delete(id);
      s.onClose(reason);
    }
    this.hub.detach(this.nodeId, this);
  }

  terminate() { this.socket.terminate(); }
}

export class AgentHub extends EventEmitter {
  private conns = new Map<string, AgentConn>();
  private opts: Required<HubOptions>;

  constructor(opts: HubOptions = {}) {
    super();
    this.opts = { now: Date.now, idleTimeoutMs: 45_000, checkIntervalMs: 5_000, ...opts };
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
