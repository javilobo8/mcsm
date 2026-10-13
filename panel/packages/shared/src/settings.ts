import { z } from "zod";

/** Rango de puertos de juego que reparte el panel al crear servidores sin puerto. */
export interface PortRange { from: number; to: number }

const portNumber = z.number().int().min(1024, "Usa puertos a partir del 1024").max(65535, "El puerto máximo es 65535");
export const portRangeSchema = z.object({ from: portNumber, to: portNumber })
  .refine((r) => r.from <= r.to, { message: "El primer puerto no puede ser mayor que el último", path: ["to"] })
  .refine((r) => r.to - r.from <= 10_000, { message: "El rango no puede tener más de 10 001 puertos", path: ["to"] });

/** Origen http(s) sin ruta, consulta, fragmento ni credenciales: es lo que va en PANEL_URL del comando de alta. */
export function isPanelOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === ""
      && u.pathname === "/" && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** URL del panel que se incrusta en el comando de alta y que el WS acepta como Origin. "" = la del entorno. */
export const publicUrlSchema = z.string().trim().max(200)
  .refine((v) => v === "" || isPanelOrigin(v), "URL inválida: usa http(s)://host[:puerto], sin ruta (p. ej. http://192.168.1.10:8080)")
  .transform((v) => (v === "" ? "" : new URL(v).origin));

export const settingsPutSchema = z.object({
  publicUrl: publicUrlSchema.optional(),
  gamePortRange: portRangeSchema.optional(),
}).strict();
export type SettingsPut = z.infer<typeof settingsPutSchema>;

export interface SettingsDto {
  /** La que se usa: la guardada en Ajustes o, si no hay, la del entorno (PANEL_PUBLIC_URL). "" = la del navegador. */
  publicUrl: string;
  publicUrlSource: "settings" | "env" | "request";
  envPublicUrl: string;
  gamePortRange: PortRange;
  defaultGamePortRange: PortRange;
  curseforge: { configured: boolean; valid: boolean };
}

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Escribe la contraseña actual").max(200),
  newPassword: z.string().min(8, "La contraseña nueva necesita al menos 8 caracteres").max(200),
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;
