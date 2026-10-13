import { portRangeSchema, publicUrlSchema, type PortRange, type SettingsDto } from "@mcsm/shared";
import type { GuardText } from "./tab-guard";

export function passwordFormError(f: { current: string; next: string; repeat: string }): string | null {
  if (!f.current) return "Escribe la contraseña actual";
  if (f.next.length < 8) return "La contraseña nueva necesita al menos 8 caracteres";
  if (f.next !== f.repeat) return "Las contraseñas nuevas no coinciden";
  return null;
}

export const portRangeForm = (r: PortRange) => ({ from: String(r.from), to: String(r.to) });

export function parsePortRange(f: { from: string; to: string }): { ok: true; value: PortRange } | { ok: false; error: string } {
  const from = f.from.trim(), to = f.to.trim();
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return { ok: false, error: "Escribe dos números de puerto" };
  const r = portRangeSchema.safeParse({ from: Number(from), to: Number(to) });
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Rango inválido" };
}

export function parsePublicUrl(v: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = publicUrlSchema.safeParse(v);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "URL inválida" };
}

/** Explica de dónde sale la URL que va en el comando de alta. */
export function publicUrlNote(s: SettingsDto): string {
  if (s.publicUrlSource === "settings") return `Guardada aquí. ${s.envPublicUrl ? `Si la borras se usará la del entorno (${s.envPublicUrl}).` : "Si la borras se usará la dirección con la que abres el panel."}`;
  if (s.publicUrlSource === "env") return `Viene del entorno (PANEL_PUBLIC_URL = ${s.envPublicUrl}). Guardar otra aquí la sustituye.`;
  return "Sin configurar: el comando de alta usa la dirección con la que abres el panel (pon aquí la IP de la LAN y el puerto).";
}

export function settingsLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? { title: "Ajustes sin guardar", description: "Hay cambios sin guardar en Ajustes. Si sales, se perderán.", confirmLabel: "Salir sin guardar" } : null;
}
