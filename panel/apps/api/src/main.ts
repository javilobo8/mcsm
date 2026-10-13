import { join } from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db/db.js";
import { prepareDataDir, restrictDbFiles } from "./lib/data-dir.js";
import { loggerOptions } from "./lib/log.js";
import { resolveSetupToken } from "./lib/setup-token.js";
import { randomToken } from "./lib/tokens.js";

const warnings = prepareDataDir(config.dataDir);
const dbPath = join(config.dataDir, "panel.db");
const db = openDb(dbPath);
warnings.push(...restrictDbFiles(dbPath));
// L3: with no password, only whoever reads the panel log (or set PANEL_SETUP_TOKEN) can create it.
const { token: setupToken, fromEnv: setupTokenFromEnv } = resolveSetupToken(process.env.PANEL_SETUP_TOKEN, randomToken);
const app = await buildApp({ db, logger: loggerOptions, config: { setupToken } });
for (const w of warnings) app.log.warn(w);
if (app.auth.getSetting("admin_password_hash") === null) {
  app.log.warn(setupTokenFromEnv
    ? "Panel without a password: to create it, use the PANEL_SETUP_TOKEN token"
    : `Panel without a password. Initial setup token (paste it in the web to create the password): ${setupToken}`);
}
await app.listen({ host: config.host, port: config.port });
app.log.info(`panel listening on http://${config.host}:${config.port}`);
