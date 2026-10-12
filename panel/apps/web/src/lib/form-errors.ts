/** Mapa de errores de campo del formulario (id del campo -> mensaje). Funciones puras, sin React. */
export type FormErrors = Readonly<Record<string, string>>;

/** Ids que no son un elemento del DOM (errores calculados): nunca se purgan por "no montado". */
export const VIRTUAL_ERROR_IDS: ReadonlySet<string> = new Set(["sf-memlimit-rel", "sf-extra-ports"]);

/** Fija o quita (message null) el error de un campo; devuelve el mismo objeto si no cambia nada. */
export function applyError(prev: FormErrors, field: string, message: string | null): FormErrors {
  if (message === null) {
    if (!(field in prev)) return prev;
    const { [field]: _gone, ...rest } = prev;
    return rest;
  }
  return prev[field] === message ? prev : { ...prev, [field]: message };
}

/** Quita los errores de campos que ya no están montados (p. ej. un fieldset oculto al cambiar el tipo). */
export function pruneErrors(prev: FormErrors, isMounted: (field: string) => boolean): FormErrors {
  let next = prev;
  for (const f of Object.keys(prev)) if (!VIRTUAL_ERROR_IDS.has(f) && !f.startsWith("sf-extra-") && !isMounted(f)) next = applyError(next, f, null);
  return next;
}
