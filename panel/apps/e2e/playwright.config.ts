import { defineConfig } from "@playwright/test";

/** E2E mínima (Plan 9, spec §11): un navegador, en serie, contra el compose levantado por deploy/e2e/run.sh. */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 12 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://panel:8080",
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "es-ES",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "e2e", testMatch: /\.spec\.ts/, dependencies: ["setup"], use: { storageState: ".auth/admin.json" } },
  ],
});
