/** Lone UTF-16 surrogates: encodeURIComponent would throw URIError with them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Content-Disposition header to download `filename` (RFC 6266 + RFC 5987): a quoted ASCII
 * fallback name and the real name in percent-encoded UTF-8. Quotes, backslashes, %,
 * “;” and control characters never reach the header raw: the result
 * contains only visible ASCII and spaces, so it cannot inject another header.
 */
export function contentDisposition(filename: string): string {
  const name = (filename || "download").replace(LONE_SURROGATE, "\uFFFD");
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
