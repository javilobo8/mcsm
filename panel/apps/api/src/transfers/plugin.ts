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
 * Transferencias y staging (spec §5.1). Decora `app.transfers` y `app.staging` en la raíz
 * (fastify-plugin) y registra las rutas de los agentes en un contexto propio.
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
    if (n) app.log.info({ n }, "staging: borrados restos de una ejecución anterior");
    transferSweep = setInterval(() => app.transfers.sweep(), SWEEP_EVERY_MS);
    transferSweep.unref();
    stagingSweep = setInterval(() => {
      stagingSweeping = app.staging.sweep(STAGING_MAX_AGE_MS).catch((e) => app.log.warn({ err: e }, "limpieza de staging fallida"));
    }, STAGING_SWEEP_EVERY_MS);
    stagingSweep.unref();
  });
  // preClose corre antes de que el servidor espere a las peticiones en curso: una transferencia
  // reclamada (horas, si es grande) bloquearía el cierre. closeAll corta su conexión.
  app.addHook("preClose", async () => {
    app.transfers.closeAll();
  });
  // onClose también, por si la app se cierra sin haber arrancado (sin preClose).
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
