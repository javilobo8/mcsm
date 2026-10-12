import { finished, PassThrough, Transform, type Readable } from "node:stream";

/** Temporizadores inyectables: `set` arma uno y devuelve la función que lo desarma. */
export interface Timers {
  set(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
};

/**
 * Sin un solo byte durante este tiempo, una transferencia con el navegador se da por muerta: un
 * nodo que se apaga o un portátil que se suspende no siempre cierran la conexión, y sin plazo
 * la dejarían abierta para siempre. Es el doble del vigilante del agente (60 s), que suele
 * cortar antes cuando es el agente quien deja de leer o de enviar.
 */
export const IDLE_TIMEOUT_MS = 120_000;

/**
 * Lo que se drena, como mucho, del cuerpo de una subida que ya ha fallado para que el navegador
 * reciba el error en JSON: cortarle mientras envía suele acabar en "error de red" en vez de en el
 * mensaje. Más allá no compensa recibir (quizá GiB) para tirarlo: se responde con
 * `Connection: close` y se cierra.
 */
export const DRAIN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Envuelve el cuerpo de una subida del navegador para dárselo al agente. Si el agente corta,
 * el cuerpo original no se destruye (se desengancha y se sigue leyendo), para que el navegador
 * termine de enviar y reciba la respuesta de error en vez de un corte de red. Si es el
 * navegador el que corta, la copia se destruye y el agente ve la transferencia truncada.
 *
 * "El agente corta" incluye que `TransferService` cancele la transferencia: destruye la copia
 * (sin error) y el cuerpo se sigue drenando igual. Un origen ya destruido o terminado (sus
 * eventos ya pasaron) da una copia que falla en el acto, nunca una que se queda esperando.
 */
export function detachable(src: Readable): Readable {
  const out = new PassThrough();
  if (src.destroyed || src.readableEnded) {
    out.destroy(src.errored ?? new Error("La subida se interrumpió"));
    return out;
  }
  src.on("error", (e) => out.destroy(e));
  src.on("close", () => { if (!src.readableEnded) out.destroy(new Error("La subida se interrumpió")); });
  out.on("close", () => {
    if (!src.readableEnded) {
      src.unpipe(out);
      src.resume();
    }
  });
  src.pipe(out);
  return out;
}

/**
 * Paso intermedio que vigila la inactividad de un flujo: si pasan `ms` sin que entre ningún trozo,
 * llama a `onIdle` (que corta lo que haga falta) y se destruye con el error que devuelva. El plazo
 * cuenta desde que se crea, se rearma con cada trozo y se desarma cuando quien lee recibe el
 * final o la guarda se destruye: un lector que deja de leer tras el último trozo también vence.
 */
export function idleGuard(ms: number, onIdle: () => Error, timers: Timers = realTimers): Transform {
  let disarm = () => {};
  const arm = () => {
    disarm();
    disarm = timers.set(() => guard.destroy(onIdle()), ms);
  };
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      arm();
      cb(null, chunk);
    },
    destroy(err, cb) {
      disarm();
      cb(err);
    },
  });
  guard.once("end", () => disarm());
  arm();
  return guard;
}

export interface DrainOptions {
  /** Más de esto sin llegar al final: se deja de esperar (por defecto DRAIN_MAX_BYTES). */
  maxBytes?: number;
  /** Sin datos durante este tiempo: se destruye el cuerpo (por defecto IDLE_TIMEOUT_MS). */
  idleMs?: number;
  timers?: Timers;
}

/**
 * Lee y descarta lo que quede de un cuerpo para poder responder con un error limpio. Devuelve
 * true si llegó a su final y false si no: se pasó de `maxBytes` (el cuerpo sigue fluyendo y se
 * descarta hasta que se cierre la conexión), se calló durante `idleMs` (se destruye) o falló.
 */
export function drain(body: Readable, opts: DrainOptions = {}): Promise<boolean> {
  if (body.readableEnded) return Promise.resolve(true);
  if (body.destroyed) return Promise.resolve(false);
  const { maxBytes = DRAIN_MAX_BYTES, idleMs = IDLE_TIMEOUT_MS, timers = realTimers } = opts;
  return new Promise((resolve) => {
    let n = 0;
    let settled = false;
    let disarm = () => {};
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      disarm();
      body.off("data", onData);
      stop();
      resolve(ok);
    };
    const arm = () => {
      disarm();
      disarm = timers.set(() => {
        done(false);
        body.destroy();
      }, idleMs);
    };
    const onData = (chunk: Buffer) => {
      n += chunk.length;
      if (n > maxBytes) done(false);
      else arm();
    };
    const stop = finished(body, (err) => done(!err && body.readableEnded));
    body.on("data", onData);
    arm();
    body.resume();
  });
}
