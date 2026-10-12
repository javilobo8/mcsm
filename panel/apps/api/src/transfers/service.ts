import { finished, type Readable } from "node:stream";
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
  /**
   * Sin reclamar: la invalida y rechaza `done`. En curso: además aborta la `signal` de la ruta y
   * destruye el stream de la fuente. Ya terminada: no hace nada.
   */
  cancel(reason?: string): void;
}

/** Agente → panel: el agente hace PUT /agent/transfer/:id. */
export interface InboundTransfer {
  id: string;
  /** Se resuelve cuando llega el PUT del agente, con su cuerpo en streaming. */
  incoming: Promise<TransferPayload>;
  /**
   * Sin reclamar: la invalida y rechaza `incoming`. En curso: además aborta la `signal` de la ruta
   * y destruye el cuerpo entregado (quien lo lee ve el corte). Ya terminada: no hace nada.
   */
  cancel(reason?: string): void;
}

/**
 * Lo que obtiene la ruta HTTP al reclamar un transferId. `signal` se aborta (con un
 * TransferError "cancelled") si la transferencia se cancela o el panel se cierra con ella en
 * curso: la ruta debe enlazarla con su petición/respuesta HTTP y cortarla.
 * - outbound: `complete()` al entregarse entero; `fail(err)` en cualquier otra salida.
 * - inbound: `deliver(payload)` con el cuerpo; sale del registro al terminar ese stream.
 *   `fail(err)` si la ruta no puede entregarlo.
 */
export type ClaimedTransfer =
  | { kind: "outbound"; signal: AbortSignal; source: TransferSource; complete(): void; fail(err: Error): void }
  | { kind: "inbound"; signal: AbortSignal; deliver(payload: TransferPayload): void; fail(err: Error): void };

interface Deferred<T> { promise: Promise<T>; settled: boolean; resolve(v: T): void; reject(e: Error): void }

function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { res = a; rej = b; });
  promise.catch(() => {}); // quien no la espere no provoca un unhandledRejection
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => { if (!d.settled) { d.settled = true; res(v); } },
    reject: (e) => { if (!d.settled) { d.settled = true; rej(e); } },
  };
  return d;
}

type Entry =
  | { kind: "outbound"; nodeId: string; createdAt: number; source: TransferSource; done: Deferred<void> }
  | { kind: "inbound"; nodeId: string; createdAt: number; incoming: Deferred<TransferPayload> };

/** Transferencia reclamada y aún en curso. */
interface Active { entry: Entry; controller: AbortController; stream?: Readable }

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
 * de la transferencia en sí la vigilan la ruta HTTP y quien la pidió. Las reclamadas quedan en
 * un registro de transferencias en curso hasta que terminan, para que `cancel` y `closeAll`
 * puedan cortarlas.
 */
export class TransferService {
  private pending = new Map<string, Entry>();
  private active = new Map<string, Active>();
  private now: () => number;
  private ttl: number;
  private closed = false;

  constructor(opts: TransferServiceOptions = {}) {
    this.now = opts.now ?? (() => Date.now()); // se lee al llamar: los tests pueden falsear Date
    this.ttl = opts.claimTtlMs ?? 60_000;
  }

  /** Transferencias aún sin reclamar. */
  get pendingCount(): number { return this.pending.size; }

  /** Transferencias reclamadas que aún no han terminado. */
  get activeCount(): number { return this.active.size; }

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
    const a: Active = { entry: e, controller: new AbortController() };
    this.active.set(id, a);
    const signal = a.controller.signal;

    if (e.kind === "outbound") {
      return {
        kind: "outbound",
        signal,
        source: async () => {
          signal.throwIfAborted(); // cancelada antes del GET efectivo: no se abre la fuente
          const p = await e.source();
          if (signal.aborted) {
            p.stream.destroy(); // cancelada mientras se abría
            signal.throwIfAborted();
          }
          a.stream = p.stream;
          return p;
        },
        complete: () => { this.release(id, a); e.done.resolve(); },
        fail: (err) => { this.release(id, a); e.done.reject(err); },
      };
    }
    return {
      kind: "inbound",
      signal,
      deliver: (p) => {
        if (signal.aborted || e.incoming.settled) {
          p.stream.destroy(); // nadie lo va a leer: que el PUT del agente no se quede esperando
          return;
        }
        a.stream = p.stream;
        finished(p.stream, () => this.release(id, a));
        e.incoming.resolve(p);
      },
      fail: (err) => { this.release(id, a); e.incoming.reject(err); },
    };
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
   * Cierre del panel: cancela lo pendiente y aborta lo que está en curso (rechaza sus promesas,
   * aborta la signal de su ruta y destruye sus streams). Lo que se pida después nace cancelado:
   * tras el cierre ya no hay barrido ni rutas que lo atiendan, y quedaría esperando para siempre.
   */
  closeAll(): void {
    this.closed = true;
    for (const id of [...this.pending.keys(), ...this.active.keys()]) this.cancel(id, CLOSING);
  }

  private add(id: string, e: Entry) {
    if (this.closed) this.reject(e, new TransferError("cancelled", `Transferencia cancelada: ${CLOSING}`));
    else this.pending.set(id, e);
  }

  private expired(e: Entry): boolean {
    return this.now() - e.createdAt > this.ttl;
  }

  private cancel(id: string, reason: string) {
    const err = new TransferError("cancelled", `Transferencia cancelada: ${reason}`);
    const e = this.pending.get(id);
    if (e) {
      this.pending.delete(id);
      this.reject(e, err);
      return;
    }
    const a = this.active.get(id);
    if (!a) return; // ya terminada
    this.active.delete(id);
    // Primero la promesa: si la ruta reacciona a la signal llamando a fail(aborted), no la pisa.
    this.reject(a.entry, err);
    a.controller.abort(err);
    // Sin error: destroy(err) en un stream sin oyente de 'error' tumbaría el proceso; quien lo
    // lee recibe igualmente un cierre prematuro.
    a.stream?.destroy();
  }

  private release(id: string, a: Active) {
    if (this.active.get(id) === a) this.active.delete(id);
  }

  private reject(e: Entry, err: TransferError) {
    if (e.kind === "outbound") e.done.reject(err);
    else e.incoming.reject(err);
  }
}
