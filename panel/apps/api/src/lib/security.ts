import type { FastifyInstance } from "fastify";

/**
 * L10 of Plan 1. CSP without inline scripts; inline styles are needed (Radix positions with style="", uPlot and
 * CodeMirror too). 'self' in connect-src covers the same-origin WebSocket.
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

/** Adds the headers to all responses. Registered at the root BEFORE the routes (hooks are fixed at registration). */
export function securityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}

/** Per-IP rate-limit key (L6 of Plan 1): an IPv6 machine with SLAAC has thousands of addresses in its /64. */
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

/** Global limit of login failures (L6 of Plan 1): in addition to each IP's, which a network with many addresses does not get around. */
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
