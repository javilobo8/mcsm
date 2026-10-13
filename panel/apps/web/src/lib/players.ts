/**
 * L5 of Plan 3: without online mode the server does not check accounts, so anyone can join with the name of an
 * operator or of someone on the whitelist.
 */
export function offlineModeWarning(spec: { properties?: Record<string, string>; env?: Record<string, string>; ops?: string[]; whitelist?: { players: string[] } }): string | null {
  const off = (v: string | undefined) => v?.trim().toLowerCase() === "false";
  if (!off(spec.properties?.["online-mode"]) && !off(spec.env?.ONLINE_MODE)) return null; // itzg: ONLINE_MODE also sets it
  if (!(spec.ops?.length || spec.whitelist?.players.length)) return null;
  return "Online mode is disabled: anyone can join with the name of an operator or of someone on the whitelist. Enable it (Properties → online-mode) if the server is reachable from outside your home.";
}
