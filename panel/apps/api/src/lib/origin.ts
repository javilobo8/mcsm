/**
 * L2: un navegador siempre envía Origin en el upgrade de un WebSocket y los WS no pasan por
 * CORS; SameSite=Strict no frena a páginas same-site (mismo host, otro puerto). Se acepta un
 * Origin cuyo host (con puerto) sea el de la petición o el origen de PANEL_PUBLIC_URL. Sin
 * Origin la petición no viene de un navegador (CLI, tests) y se permite.
 */
export function originAllowed(origin: string | undefined, host: string, publicUrl: string): boolean {
  if (origin === undefined) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (o.host.toLowerCase() === host.toLowerCase()) return true;
  if (!publicUrl) return false;
  try { return o.origin === new URL(publicUrl).origin; } catch { return false; }
}
