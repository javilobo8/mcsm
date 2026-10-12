/** Sustitutos UTF-16 sueltos: encodeURIComponent lanzaría URIError con ellos. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Cabecera Content-Disposition para descargar `filename` (RFC 6266 + RFC 5987): un nombre ASCII
 * de reserva entre comillas y el nombre real en UTF-8 percent-encoded. Comillas, barras
 * invertidas, %, «;» y caracteres de control nunca llegan crudos a la cabecera: el resultado
 * solo contiene ASCII visible y espacios, así que no puede inyectar otra cabecera.
 */
export function contentDisposition(filename: string): string {
  const name = (filename || "descarga").replace(LONE_SURROGATE, "\uFFFD");
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
