import type { FastifyServerOptions } from "fastify";

/** L1 del Plan 5: el id de una transferencia (un solo uso, 60 s) no va al log de acceso. */
export function redactUrl(url: string): string {
  return url.replace(/^(\/agent\/transfer\/)[^/?#]+/, "$1[oculto]");
}

/** Opciones del logger de producción (main.ts): el log de acceso con la URL redactada. */
export const loggerOptions: FastifyServerOptions["logger"] = {
  serializers: {
    req(req: { method: string; url: string; host?: string; ip?: string }) {
      return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip };
    },
  },
};
