import type { Readable } from "node:stream";
import { randomToken } from "../lib/tokens.js";

/** Cuerpo de una transferencia: stream y tamaño (null si se desconoce). */
export interface TransferPayload { stream: Readable; size: number | null }
/** Fuente perezosa de una transferencia panel → agente: se invoca cuando el agente hace GET. */
export type TransferSource = () => Promise<TransferPayload>;

export type TransferErrorCode = "expired" | "cancelled" | "aborted";

export class TransferError extends Error {
  constructor(public code: TransferErrorCode, message: string) { super(message); this.name = "TransferError"; }
}

/** Panel → agente: el agente hace GET /agent/transfer/:id. */
export interface OutboundTransfer {
  id: string;
  /** Se resuelve cuando el agente ha recibido todo el cuerpo; se rechaza si caduca, se cancela o se corta. */
  done: Promise<void>;
  cancel(reason?: string): void;
}

/** Agente → panel: el agente hace PUT /agent/transfer/:id. */
export interface InboundTransfer {
  id: string;
  /** Se resuelve cuando llega el PUT del agente, con su cuerpo en streaming. */
  incoming: Promise<TransferPayload>;
  cancel(reason?: string): void;
}

/** Lo que obtiene la ruta HTTP al reclamar un transferId. */
export type ClaimedTransfer =
  | { kind: "outbound"; source: TransferSource; complete(): void; fail(err: Error): void }
  | { kind: "inbound"; deliver(payload: TransferPayload): void };

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // quien no la espere no provoca un unhandledRejection
  return { promise, resolve, reject };
}

type Entry =
  | { kind: "outbound"; nodeId: string; createdAt: number; source: TransferSource; done: Deferred<void> }
  | { kind: "inbound"; nodeId: string; createdAt: number; incoming: Deferred<TransferPayload> };

export interface TransferServiceOptions {
  /** Reloj inyectable (ms). */
  now?: () => number;
  /** Tiempo que tiene el agente para reclamar la transferencia. */
  claimTtlMs?: number;
}

const EXPIRED = "El agente no inició la transferencia a tiempo";
const CLOSING = "el panel se está cerrando";

/**
 * Transferencias HTTP entre panel y agentes (spec §5.1). Cada transferId es aleatorio
 * (32 bytes), de un solo uso, ligado al nodo que debe reclamarlo y caduca si nadie lo
 * reclama a tiempo. El cuerpo nunca se carga en memoria: se pasan streams.
 *
 * El plazo solo cubre el reclamo (lo que tarda el agente en hacer el GET/PUT); la duración
 * de la transferencia en sí la vigilan la ruta HTTP y quien la pidió.
 */
export class TransferService {
  private pending = new Map<string, Entry>();
  private now: () => number;
  private ttl: number;
  private closed = false;

  constructor(opts: TransferServiceOptions = {}) {
    this.now = opts.now ?? (() => Date.now()); // se lee al llamar: los tests pueden falsear Date
    this.ttl = opts.claimTtlMs ?? 60_000;
  }

  /** Transferencias aún sin reclamar. */
  get pendingCount(): number { return this.pending.size; }

  outbound(nodeId: string, source: TransferSource): OutboundTransfer {
    const id = randomToken();
    const done = deferred<void>();
    this.add(id, { kind: "outbound", nodeId, createdAt: this.now(), source, done });
    return { id, done: done.promise, cancel: (reason = "cancelada") => this.cancel(id, reason) };
  }

  inbound(nodeId: string): InboundTransfer {
    const id = randomToken();
    const incoming = deferred<TransferPayload>();
    this.add(id, { kind: "inbound", nodeId, createdAt: this.now(), incoming });
    return { id, incoming: incoming.promise, cancel: (reason = "cancelada") => this.cancel(id, reason) };
  }

  /**
   * Reclama un transferId (un solo uso). Devuelve null sin consumirlo si es de otro nodo o del
   * otro sentido (un nodo no puede quemar transferencias ajenas), y null consumiéndolo si caducó.
   */
  claim(id: string, nodeId: string, method: "GET" | "PUT"): ClaimedTransfer | null {
    const e = this.pending.get(id);
    if (!e || e.nodeId !== nodeId) return null;
    if ((method === "GET") !== (e.kind === "outbound")) return null;
    this.pending.delete(id);
    if (this.expired(e)) {
      this.reject(e, new TransferError("expired", EXPIRED));
      return null;
    }
    if (e.kind === "outbound") {
      return { kind: "outbound", source: e.source, complete: () => e.done.resolve(), fail: (err) => e.done.reject(err) };
    }
    return { kind: "inbound", deliver: (p) => e.incoming.resolve(p) };
  }

  /** Caduca las transferencias no reclamadas a tiempo. Devuelve cuántas. */
  sweep(): number {
    let n = 0;
    for (const [id, e] of this.pending) {
      if (!this.expired(e)) continue;
      this.pending.delete(id);
      this.reject(e, new TransferError("expired", EXPIRED));
      n++;
    }
    return n;
  }

  /**
   * Cancela todo lo pendiente (cierre del panel). Lo que se pida después nace cancelado: tras
   * el cierre ya no hay barrido ni rutas que lo atiendan, y quedaría esperando para siempre.
   */
  closeAll(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id, CLOSING);
  }

  private add(id: string, e: Entry) {
    if (this.closed) this.reject(e, new TransferError("cancelled", `Transferencia cancelada: ${CLOSING}`));
    else this.pending.set(id, e);
  }

  private expired(e: Entry): boolean {
    return this.now() - e.createdAt > this.ttl;
  }

  private cancel(id: string, reason: string) {
    const e = this.pending.get(id);
    if (!e) return; // ya reclamada: su ruta HTTP gestiona el corte
    this.pending.delete(id);
    this.reject(e, new TransferError("cancelled", `Transferencia cancelada: ${reason}`));
  }

  private reject(e: Entry, err: TransferError) {
    if (e.kind === "outbound") e.done.reject(err);
    else e.incoming.reject(err);
  }
}
