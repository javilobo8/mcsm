import { connectAddressSchema, portRangeSchema, publicUrlSchema, type ConnectAddress, type PortRange, type SettingsDto } from "@mcsm/shared";
import type { GuardText } from "./tab-guard";

export function passwordFormError(f: { current: string; next: string; repeat: string }): string | null {
  if (!f.current) return "Enter the current password";
  if (f.next.length < 8) return "The new password needs at least 8 characters";
  if (f.next !== f.repeat) return "The new passwords do not match";
  return null;
}

export const portRangeForm = (r: PortRange) => ({ from: String(r.from), to: String(r.to) });

export function parsePortRange(f: { from: string; to: string }): { ok: true; value: PortRange } | { ok: false; error: string } {
  const from = f.from.trim(), to = f.to.trim();
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return { ok: false, error: "Enter two port numbers" };
  const r = portRangeSchema.safeParse({ from: Number(from), to: Number(to) });
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid range" };
}

export const connectForm = (a: ConnectAddress) => ({ host: a.host, port: a.port === null ? "" : String(a.port) });

/** Connection address form: an empty port means each server's own port. */
export function parseConnectAddress(f: { host: string; port: string }): { ok: true; value: ConnectAddress } | { ok: false; error: string } {
  const port = f.port.trim();
  if (port !== "" && !/^\d+$/.test(port)) return { ok: false, error: "The port must be a number (or empty)" };
  const r = connectAddressSchema.safeParse({ host: f.host, port: port === "" ? null : Number(port) });
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid address" };
}

export function parsePublicUrl(v: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = publicUrlSchema.safeParse(v);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid URL" };
}

/** Explains where the URL used in the enrollment command comes from. */
export function publicUrlNote(s: SettingsDto): string {
  if (s.publicUrlSource === "settings") return `Saved here. ${s.envPublicUrl ? `If you delete it, the one from the environment (${s.envPublicUrl}) will be used.` : "If you delete it, the address you use to open the panel will be used."}`;
  if (s.publicUrlSource === "env") return `It comes from the environment (PANEL_PUBLIC_URL = ${s.envPublicUrl}). Saving another one here replaces it.`;
  return "Not configured: the enrollment command uses the address you use to open the panel (enter the LAN IP and port here).";
}

export function settingsLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? { title: "Unsaved settings", description: "There are unsaved changes in Settings. If you leave, they will be lost.", confirmLabel: "Leave without saving" } : null;
}
