export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  publicUrl: (process.env.PANEL_PUBLIC_URL ?? "").replace(/\/$/, ""),
  webDist: process.env.WEB_DIST ?? "",
  sessionTtlSeconds: 30 * 24 * 3600,
  enrollTtlSeconds: 15 * 60,
  gamePortRange: { from: 25565, to: 25600 },
  /** L3: token de un solo propósito para crear la contraseña (lo fija main.ts). "" = no se exige (tests). */
  setupToken: "",
};
export type Config = typeof config;
