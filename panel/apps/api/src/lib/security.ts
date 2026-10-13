import type { FastifyInstance } from "fastify";

/**
 * L10 del Plan 1. CSP sin scripts en línea; los estilos en línea hacen falta (Radix posiciona con style="", uPlot y
 * CodeMirror también). 'self' en connect-src cubre el WebSocket del mismo origen.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Añade las cabeceras a todas las respuestas. Se registra en la raíz ANTES que las rutas (los hooks se fijan al registrar). */
export function securityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}

/** Clave del rate-limit por IP (L6 del Plan 1): una máquina IPv6 con SLAAC tiene miles de direcciones de su /64. */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const addr = ip.split("%")[0]!.toLowerCase();
  const [head = "", tail] = addr.split("::", 2) as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Límite global de fallos de login (L6 del Plan 1): además del de cada IP, que una red con muchas direcciones no sortea. */
export class FailureLimiter {
  private fails: number[] = [];
  constructor(private max = 30, private windowMs = 60_000, private now: () => number = Date.now) {}

  private prune(): void {
    const from = this.now() - this.windowMs;
    while (this.fails.length && this.fails[0]! <= from) this.fails.shift();
  }

  blocked(): boolean {
    this.prune();
    return this.fails.length >= this.max;
  }

  fail(): void {
    this.prune();
    this.fails.push(this.now());
  }
}
