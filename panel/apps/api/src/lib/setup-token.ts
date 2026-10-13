/** Maximum length accepted by setup (`setupBody`): a longer token could never match. */
export const MAX_SETUP_TOKEN = 200;

/** Initial setup token: trimmed PANEL_SETUP_TOKEN or a random one. Too long: startup error. */
export function resolveSetupToken(env: string | undefined, generate: () => string): { token: string; fromEnv: boolean } {
  const fixed = env?.trim() ?? "";
  if (fixed.length > MAX_SETUP_TOKEN) {
    throw new Error(`PANEL_SETUP_TOKEN is too long (${fixed.length} characters; the maximum is ${MAX_SETUP_TOKEN})`);
  }
  return fixed ? { token: fixed, fromEnv: true } : { token: generate(), fromEnv: false };
}
