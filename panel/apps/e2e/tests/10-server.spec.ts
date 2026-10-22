import { expect, test } from "@playwright/test";
import { NODE_A, SERVER, defaultGateway, poll, rconExec, serverByName, shot, watchCsp, watchForbidden } from "./helpers";

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
  await shot(page, "02-wizard-review");
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
  await shot(page, "03-overview-charts");

  await page.getByRole("tab", { name: "Console" }).click();
  const log = page.getByRole("log", { name: "Server log" });
  await expect(log).toContainText("Done (", { timeout: 60_000 });
  await page.getByLabel("Command", { exact: true }).fill("list");
  await page.keyboard.press("Enter");
  await expect(log).toContainText(/There are 0 of a max of \d+ players online/);
  await shot(page, "04-console");

  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByTestId("config-form")).toBeVisible();
  await shot(page, "05-configuration");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});

type Dto = { id: string; specVersion: number; spec: { ports: { game: number; rcon?: number }; rconPassword: string }; observed?: { appliedVersion?: number; mc?: { online?: boolean } } };

test("publish RCON: turn it on, see the port everywhere, log in over the published port, turn it off", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const s = await serverByName(request, SERVER);
  const get = async () => (await (await request.get(`/api/servers/${s.id}`)).json()) as Dto;
  const applied = (v: number) => poll(async () => { const d = await get(); return d.specVersion >= v && d.observed?.appliedVersion === d.specVersion && d.observed?.mc?.online ? d : null; }, "the recreated server running", 6 * 60_000);
  expect((await get()).spec.ports.rcon).toBeUndefined();

  await page.goto(`/servers/${s.id}`);
  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByTestId("config-form")).toBeVisible();
  await page.getByRole("tab", { name: "Network" }).click();
  const toggle = page.getByTestId("rcon-publish");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByPlaceholder("Assigned when you apply")).toBeVisible();
  await shot(page, "18-network-rcon");
  await page.getByRole("button", { name: "Review and apply" }).click();
  await expect(page.getByTestId("spec-diff")).toContainText("Published RCON port");
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  const on = await applied((await get()).specVersion);
  const port = on.spec.ports.rcon!;
  expect(Number.isInteger(port)).toBe(true);
  expect(port).toBeGreaterThanOrEqual(26600); // Settings range
  expect(port).toBeLessThanOrEqual(26620);
  expect(port).not.toBe(on.spec.ports.game);

  // General: the address (without a configured Connection address it is just the port).
  await page.getByRole("tab", { name: "General" }).click();
  await expect(page.getByTestId("rcon-address")).toHaveText(new RegExp(`^(.+:)?${port}$`));
  // Dashboard row.
  await page.goto("/");
  await expect(page.getByTestId("server-rcon-address").first()).toHaveText(new RegExp(`^RCON (.+:)?${port}$`));
  await shot(page, "19-dashboard-rcon");

  // Real RCON over the published port.
  const host = process.env.E2E_RCON_HOST ?? (await defaultGateway());
  expect(host, "an address of the node's host to reach the published port").toBeTruthy();
  const out = await poll(() => rconExec(host!, port, on.spec.rconPassword, "list").catch(() => null), "RCON over the published port", 2 * 60_000, 3_000);
  expect(out).toMatch(/There are 0 of a max of \d+ players online/);

  // Back to the original state: not published.
  await page.goto(`/servers/${s.id}`);
  await page.getByRole("tab", { name: "Configuration" }).click();
  await page.getByRole("tab", { name: "Network" }).click();
  await page.getByTestId("rcon-publish").uncheck();
  await page.getByRole("button", { name: "Review and apply" }).click();
  await expect(page.getByTestId("spec-diff")).toContainText("not published");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const off = await applied(on.specVersion + 1);
  expect(off.spec.ports.rcon).toBeUndefined();
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
