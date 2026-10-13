import { expect, test } from "@playwright/test";
import { NODE_A, SERVER, poll, shot, watchCsp, watchForbidden } from "./helpers";

test("crear un servidor, verlo arrancar, usar la consola y ver sus gráficas", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  await page.goto("/servers/new");
  await page.getByRole("radio", { name: /Desde cero/ }).click();
  await page.locator("#sf-type").click();
  await page.getByRole("option", { name: "Vanilla", exact: true }).click();
  // plan-10: combobox. Con red sale la opción de la lista; sin ella, «Usar «1.21.4»».
  await page.locator("#sf-version").click();
  await page.getByPlaceholder("Buscar o escribir una versión…").fill("1.21.4");
  await shot(page, "01b-selector-version");
  await page.getByRole("option", { name: /^(Usar «)?1\.21\.4»?$/ }).first().click();
  await expect(page.locator("#sf-version")).toContainText("1.21.4");
  await page.locator("#sf-java").click();
  await page.getByRole("option", { name: "java21", exact: true }).click();
  await page.locator("#sf-memory").fill("1G");
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.locator("#ns-node").click();
  await page.getByRole("option", { name: NODE_A }).click();
  await page.locator("#ns-name").fill(SERVER);
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await shot(page, "02-asistente-revisar");
  await page.getByRole("button", { name: "Crear servidor" }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
  const id = page.url().split("/").pop()!;
  const created = await (await request.get(`/api/servers/${id}`)).json();
  expect(created.spec.ports.game).toBeGreaterThanOrEqual(26600); // rango de Ajustes
  expect(created.spec.ports.game).toBeLessThanOrEqual(26620);

  // Arranque real de itzg: descarga del jar de 1.21.4 y generación del mundo.
  await poll(async () => (await (await request.get(`/api/servers/${id}`)).json()).observed?.mc?.online, "el servidor en marcha", 6 * 60_000);

  // Gráficas del Resumen: una muestra cada 10 s mientras está en marcha.
  await expect(page.getByText(/Sin datos en este rango/)).toBeHidden({ timeout: 90_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await shot(page, "03-resumen-graficas");

  await page.getByRole("tab", { name: "Consola" }).click();
  const log = page.getByRole("log", { name: "Registro del servidor" });
  await expect(log).toContainText("Done (", { timeout: 60_000 });
  await page.getByLabel("Comando", { exact: true }).fill("list");
  await page.keyboard.press("Enter");
  await expect(log).toContainText(/There are 0 of a max of \d+ players online/);
  await shot(page, "04-consola");

  await page.getByRole("tab", { name: "Configuración" }).click();
  await expect(page.getByTestId("config-form")).toBeVisible();
  await shot(page, "05-configuracion");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
