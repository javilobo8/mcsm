import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { formatZodError, settingsPutSchema } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { SettingsService } from "./service.js";

/** Decora `app.settings` en la raíz (comando de alta, Origin del WS, reparto de puertos, migración) y registra las rutas. */
export const settingsRoutes = fp(async function settingsRoutes(root: FastifyInstance) {
  root.decorate("settings", new SettingsService(root.db, root.config));
  await root.register(async (app) => {
    app.get("/api/settings", async () => app.settings.dto(app.curseforge.get()));
    app.put("/api/settings", async (req) => {
      const body = settingsPutSchema.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, formatZodError(body.error));
      app.settings.update(body.data);
      return app.settings.dto(app.curseforge.get());
    });
  });
});

declare module "fastify" {
  interface FastifyInstance { settings: SettingsService }
}
