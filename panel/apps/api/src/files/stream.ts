import { PassThrough, type Readable } from "node:stream";
import { finished } from "node:stream/promises";

/**
 * Envuelve el cuerpo de una subida del navegador para dárselo al agente. Si el agente corta,
 * el cuerpo original no se destruye (se desengancha y se sigue leyendo), para que el navegador
 * termine de enviar y reciba la respuesta de error en vez de un corte de red. Si es el
 * navegador el que corta, la copia se destruye y el agente ve la transferencia truncada.
 *
 * "El agente corta" incluye que `TransferService` cancele la transferencia: destruye la copia
 * (sin error) y el cuerpo se sigue drenando igual.
 */
export function detachable(src: Readable): Readable {
  const out = new PassThrough();
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

/** Lee y descarta lo que quede de un cuerpo para poder responder con un error limpio. */
export async function drain(body: Readable): Promise<void> {
  if (body.readableEnded || body.destroyed) return;
  body.resume();
  await finished(body).catch(() => {});
}
