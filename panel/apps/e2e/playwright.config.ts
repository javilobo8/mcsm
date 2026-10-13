import { defineConfig } from "@playwright/test";

/** Minimal E2E (Plan 9, spec §11): one browser, serial, against the compose brought up by deploy/e2e/run.sh. */
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
    locale: "en-GB",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "e2e", testMatch: /\.spec\.ts/, dependencies: ["setup"], use: { storageState: ".auth/admin.json" } },
  ],
});
