import { expect, test } from "@playwright/test";
import { NODE_A, SERVER, poll, shot, watchCsp, watchForbidden } from "./helpers";

test("create a server, watch it start, use the console and see its charts", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  await page.goto("/servers/new");
  await page.getByRole("radio", { name: /From scratch/ }).click();
  await page.locator("#sf-type").click();
  await page.getByRole("option", { name: "Vanilla", exact: true }).click();
  // plan-10: combobox. With network the list option appears; without it, “Use “1.21.4””.
  await page.locator("#sf-version").click();
  await page.getByPlaceholder("Search or type a version…").fill("1.21.4");
  await shot(page, "01b-selector-version");
  await page.getByRole("option", { name: /^(Use “)?1\.21\.4”?$/ }).first().click();
  await expect(page.locator("#sf-version")).toContainText("1.21.4");
  await page.locator("#sf-java").click();
  await page.getByRole("option", { name: "java21", exact: true }).click();
  await page.locator("#sf-memory").fill("1G");
  await page.getByRole("button", { name: /Next/ }).click();
  await page.locator("#ns-node").click();
  await page.getByRole("option", { name: NODE_A }).click();
  await page.locator("#ns-name").fill(SERVER);
  await page.getByRole("button", { name: /Next/ }).click();
  await shot(page, "02-asistente-revisar");
  await page.getByRole("button", { name: "Create server" }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
  const id = page.url().split("/").pop()!;
  const created = await (await request.get(`/api/servers/${id}`)).json();
  expect(created.spec.ports.game).toBeGreaterThanOrEqual(26600); // Settings range
  expect(created.spec.ports.game).toBeLessThanOrEqual(26620);

  // Real itzg start: download of the 1.21.4 jar and world generation.
  await poll(async () => (await (await request.get(`/api/servers/${id}`)).json()).observed?.mc?.online, "the server running", 6 * 60_000);

  // Overview charts: one sample every 10 s while it is running.
  await expect(page.getByText(/No data in this range/)).toBeHidden({ timeout: 90_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await shot(page, "03-resumen-graficas");

  await page.getByRole("tab", { name: "Console" }).click();
  const log = page.getByRole("log", { name: "Server log" });
  await expect(log).toContainText("Done (", { timeout: 60_000 });
  await page.getByLabel("Command", { exact: true }).fill("list");
  await page.keyboard.press("Enter");
  await expect(log).toContainText(/There are 0 of a max of \d+ players online/);
  await shot(page, "04-consola");

  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByTestId("config-form")).toBeVisible();
  await shot(page, "05-configuracion");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
