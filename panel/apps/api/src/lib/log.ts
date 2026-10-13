import type { FastifyServerOptions } from "fastify";

/** L1 of Plan 5: a transfer's id (single use, 60 s) does not go in the access log. */
export function redactUrl(url: string): string {
  return url.replace(/^(\/agent\/transfer\/)[^/?#]+/, "$1[hidden]");
}

/** Production logger options (main.ts): the access log with the URL redacted. */
export const loggerOptions: FastifyServerOptions["logger"] = {
  serializers: {
    req(req: { method: string; url: string; host?: string; ip?: string }) {
      return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip };
    },
  },
};
