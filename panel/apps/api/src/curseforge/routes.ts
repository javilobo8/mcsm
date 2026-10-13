import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CURSEFORGE_API_KEY_RE, formatZodError } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { curseforgeStatus } from "../settings/service.js";

/** "" (after trimming) deletes the key; otherwise validates it like the agent: a NUL or a line break would break the env of every CurseForge server. */
const bodySchema = z.object({
  apiKey: z.string().trim().max(200, "The API key is too long (max. 200 characters)")
    .refine((k) => k === "" || CURSEFORGE_API_KEY_RE.test(k), "The API key only allows printable ASCII characters, without spaces"),
});

/** GET/PUT of the global CurseForge API key. Never returns the key: only whether it is configured. */
export async function curseforgeRoutes(app: FastifyInstance) {
  app.get("/api/settings/curseforge", async () => (curseforgeStatus(app.curseforge.get())));

  app.put("/api/settings/curseforge", async (req) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new HttpError(400, formatZodError(body.error));
    if (app.curseforge.set(body.data.apiKey)) {
      // Servers that use CurseForge must be recreated with the new key (or without it).
      app.serversService.reapplyCurseForge();
    }
    return curseforgeStatus(app.curseforge.get());
  });
}
