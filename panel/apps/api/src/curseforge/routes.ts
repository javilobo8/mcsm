import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatZodError } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";

const bodySchema = z.object({
  apiKey: z.string().trim().max(200, "La API key es demasiado larga").regex(/^\S*$/, "La API key no puede contener espacios"),
});

/** GET/PUT de la API key global de CurseForge. Nunca devuelve la key: solo si está configurada. */
export async function curseforgeRoutes(app: FastifyInstance) {
  app.get("/api/settings/curseforge", async () => ({ configured: app.curseforge.get() !== null }));

  app.put("/api/settings/curseforge", async (req) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new HttpError(400, formatZodError(body.error));
    if (app.curseforge.set(body.data.apiKey)) {
      // Los servidores que usan CurseForge deben recrearse con la key nueva (o sin ella).
      app.serversService.reapplyCurseForge();
    }
    return { configured: app.curseforge.get() !== null };
  });
}
