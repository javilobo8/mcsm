import { z } from "zod";

/** Range of game ports the panel assigns when creating servers without a port. */
export interface PortRange { from: number; to: number }

const portNumber = z.number().int().min(1024, "Use ports from 1024 up").max(65535, "The maximum port is 65535");
export const portRangeSchema = z.object({ from: portNumber, to: portNumber })
  .refine((r) => r.from <= r.to, { message: "The first port cannot be greater than the last", path: ["to"] })
  .refine((r) => r.to - r.from <= 10_000, { message: "The range cannot have more than 10,001 ports", path: ["to"] });

/** http(s) origin without path, query, fragment or credentials: it is what goes in the enrollment command's PANEL_URL. */
export function isPanelOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === ""
      && u.pathname === "/" && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** The panel URL embedded in the enrollment command and that the WS accepts as Origin. "" = the environment's. */
export const publicUrlSchema = z.string().trim().max(200)
  .refine((v) => v === "" || isPanelOrigin(v), "Invalid URL: use http(s)://host[:port], without a path (e.g. http://192.168.1.10:8080)")
  .transform((v) => (v === "" ? "" : new URL(v).origin));

export const settingsPutSchema = z.object({
  publicUrl: publicUrlSchema.optional(),
  gamePortRange: portRangeSchema.optional(),
}).strict();
export type SettingsPut = z.infer<typeof settingsPutSchema>;

export interface SettingsDto {
  /** The one in use: the one stored in Settings or, if none, the environment's (PANEL_PUBLIC_URL). "" = the browser's. */
  publicUrl: string;
  publicUrlSource: "settings" | "env" | "request";
  envPublicUrl: string;
  gamePortRange: PortRange;
  defaultGamePortRange: PortRange;
  curseforge: { configured: boolean; valid: boolean };
}

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Enter the current password").max(200),
  newPassword: z.string().min(8, "The new password needs at least 8 characters").max(200),
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;
