import { join } from "node:path";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { TransferService } from "./service.js";
import { Staging } from "./staging.js";
import { transferRoutes } from "./routes.js";

const SWEEP_EVERY_MS = 10_000;
const STAGING_SWEEP_EVERY_MS = 3600_000;
const STAGING_MAX_AGE_MS = 24 * 3600_000;

/**
 * Transfers and staging (spec §5.1). Decorates `app.transfers` and `app.staging` at the root
 * (fastify-plugin) and registers the agents' routes in its own context.
 */
export const transfersPlugin = fp(async function transfersPlugin(app: FastifyInstance) {
  app.decorate("transfers", new TransferService());
  app.decorate("staging", new Staging(join(app.config.dataDir, "staging")));
  await app.register(transferRoutes);

  let transferSweep: NodeJS.Timeout | undefined;
  let stagingSweep: NodeJS.Timeout | undefined;
  let stagingSweeping: Promise<unknown> = Promise.resolve();

  app.addHook("onReady", async () => {
    const n = await app.staging.init();
    if (n) app.log.info({ n }, "staging: deleted leftovers from a previous run");
    transferSweep = setInterval(() => app.transfers.sweep(), SWEEP_EVERY_MS);
    transferSweep.unref();
    stagingSweep = setInterval(() => {
      stagingSweeping = app.staging.sweep(STAGING_MAX_AGE_MS).catch((e) => app.log.warn({ err: e }, "staging cleanup failed"));
    }, STAGING_SWEEP_EVERY_MS);
    stagingSweep.unref();
  });
  // preClose runs before the server waits for in-flight requests: a claimed transfer
  // (hours, if large) would block the shutdown. closeAll cuts its connection.
  app.addHook("preClose", async () => {
    app.transfers.closeAll();
  });
  // onClose too, in case the app is closed without having started (no preClose).
  app.addHook("onClose", async () => {
    clearInterval(transferSweep);
    clearInterval(stagingSweep);
    app.transfers.closeAll();
    await stagingSweeping;
    await app.staging.settled();
  });
}, { name: "transfers" });

declare module "fastify" {
  interface FastifyInstance { transfers: TransferService; staging: Staging }
}
