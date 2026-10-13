import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CURSEFORGE_API_KEY_RE, formatZodError } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { curseforgeStatus } from "../settings/service.js";

/** "" (tras recortar) borra la key; si no, la valida como el agente: un NUL o un salto rompería el env de todos los servidores CurseForge. */
const bodySchema = z.object({
  apiKey: z.string().trim().max(200, "La API key es demasiado larga (máx. 200 caracteres)")
    .refine((k) => k === "" || CURSEFORGE_API_KEY_RE.test(k), "La API key solo admite caracteres ASCII imprimibles, sin espacios"),
});

/** GET/PUT de la API key global de CurseForge. Nunca devuelve la key: solo si está configurada. */
export async function curseforgeRoutes(app: FastifyInstance) {
  app.get("/api/settings/curseforge", async () => (curseforgeStatus(app.curseforge.get())));

  app.put("/api/settings/curseforge", async (req) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new HttpError(400, formatZodError(body.error));
    if (app.curseforge.set(body.data.apiKey)) {
      // Los servidores que usan CurseForge deben recrearse con la key nueva (o sin ella).
      app.serversService.reapplyCurseForge();
    }
    return curseforgeStatus(app.curseforge.get());
  });
}
