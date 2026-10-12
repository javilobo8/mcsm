import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db/db.js";

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, "panel.db"));
const app = await buildApp({ db, logger: true });
await app.listen({ host: config.host, port: config.port });
app.log.info(`panel escuchando en http://${config.host}:${config.port}`);
