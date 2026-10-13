export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  publicUrl: (process.env.PANEL_PUBLIC_URL ?? "").replace(/\/$/, ""),
  webDist: process.env.WEB_DIST ?? "",
  /** Image in the `docker run` of “Add node”. The published panel image sets the agent of its own version. */
  agentImage: process.env.MCSM_AGENT_IMAGE || "mcsm-agent:latest",
  sessionTtlSeconds: 30 * 24 * 3600,
  enrollTtlSeconds: 15 * 60,
  gamePortRange: { from: 25565, to: 25600 },
  /** L3: single-purpose token to create the password (set by main.ts). "" = not required (tests). */
  setupToken: "",
};
export type Config = typeof config;
