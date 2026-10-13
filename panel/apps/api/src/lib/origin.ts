/**
 * L2: a browser always sends Origin on a WebSocket upgrade and WS do not go through
 * CORS; SameSite=Strict does not stop same-site pages (same host, another port). An
 * Origin whose host (with port) is the request's or the origin of PANEL_PUBLIC_URL is accepted. Without
 * Origin the request does not come from a browser (CLI, tests) and is allowed.
 */
export function originAllowed(origin: string | undefined, host: string, publicUrl: string): boolean {
  if (origin === undefined) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (o.host.toLowerCase() === host.toLowerCase()) return true;
  if (!publicUrl) return false;
  try { return o.origin === new URL(publicUrl).origin; } catch { return false; }
}
