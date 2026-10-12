import { join } from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db/db.js";
import { prepareDataDir, restrictDbFiles } from "./lib/data-dir.js";

const warnings = prepareDataDir(config.dataDir);
const dbPath = join(config.dataDir, "panel.db");
const db = openDb(dbPath);
warnings.push(...restrictDbFiles(dbPath));
const app = await buildApp({ db, logger: true });
for (const w of warnings) app.log.warn(w);
await app.listen({ host: config.host, port: config.port });
app.log.info(`panel escuchando en http://${config.host}:${config.port}`);
