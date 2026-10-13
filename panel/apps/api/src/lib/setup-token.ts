/** Longitud máxima que admite el alta (`setupBody`): un token más largo no podría coincidir nunca. */
export const MAX_SETUP_TOKEN = 200;

/** Token de configuración inicial: PANEL_SETUP_TOKEN recortado o uno aleatorio. Demasiado largo: error de arranque. */
export function resolveSetupToken(env: string | undefined, generate: () => string): { token: string; fromEnv: boolean } {
  const fixed = env?.trim() ?? "";
  if (fixed.length > MAX_SETUP_TOKEN) {
    throw new Error(`PANEL_SETUP_TOKEN es demasiado largo (${fixed.length} caracteres; el máximo es ${MAX_SETUP_TOKEN})`);
  }
  return fixed ? { token: fixed, fromEnv: true } : { token: generate(), fromEnv: false };
}
