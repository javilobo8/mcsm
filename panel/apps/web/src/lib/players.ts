/**
 * L5 del Plan 3: sin modo online el servidor no comprueba las cuentas, así que cualquiera entra con el nombre de un
 * operador o de alguien de la whitelist.
 */
export function offlineModeWarning(spec: { properties?: Record<string, string>; env?: Record<string, string>; ops?: string[]; whitelist?: { players: string[] } }): string | null {
  const off = (v: string | undefined) => v?.trim().toLowerCase() === "false";
  if (!off(spec.properties?.["online-mode"]) && !off(spec.env?.ONLINE_MODE)) return null; // itzg: ONLINE_MODE también lo fija
  if (!(spec.ops?.length || spec.whitelist?.players.length)) return null;
  return "El modo online está desactivado: cualquiera puede entrar con el nombre de un operador o de alguien de la whitelist. Actívalo (Propiedades → online-mode) si el servidor es accesible desde fuera de casa.";
}
