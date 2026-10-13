import { expect, test } from "@playwright/test";
import { NODE_A, nodeId, poll, shot, watchCsp, watchForbidden } from "./helpers";

test("real token rotation and screenshots of the screens pending visual review", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const a = await nodeId(request, NODE_A);

  // Token rotation against the real agent: it reconnects with the new one and is no longer pending.
  const rot = await request.post(`/api/nodes/${a}/rotate-token`);
  expect(rot.status()).toBe(200);
  await poll(async () => {
    const n = ((await (await request.get("/api/nodes")).json()) as { id: string; status: string; tokenRotationPending: boolean }[]).find((x) => x.id === a);
    return n?.status === "online" && !n.tokenRotationPending;
  }, "node A with the new token", 60_000);

  // Connection address (Settings): the server list shows it next to each server.
  expect((await request.put("/api/settings", { data: { connectAddress: { host: "mc.example.com", port: 55567 } } })).status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Node usage" }).first()).toBeVisible({ timeout: 60_000 });
  const servers = page.getByRole("region", { name: "Servers" });
  await expect(servers.getByTestId("server-address").first()).toHaveText("mc.example.com:55567");
  await expect(servers.getByRole("link", { name: "New server" })).toBeVisible();
  await shot(page, "11-dashboard-node-cards");

  await page.goto("/nodes");
  await expect(page.getByRole("link", { name: NODE_A })).toBeVisible();
  await shot(page, "12-nodes-router");

  // The enrollment command fits in its dialog (long lines wrap instead of widening it).
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByLabel("Name", { exact: true }).fill("e2e-extra");
  await page.getByRole("button", { name: "Generate command" }).click();
  const cmd = page.getByTestId("docker-run");
  await expect(cmd).toContainText("ENROLL_TOKEN=");
  const fits = await cmd.evaluate((el) => {
    const dialog = el.closest("[role=dialog]")!.getBoundingClientRect();
    const pre = el.getBoundingClientRect();
    return el.scrollWidth <= el.clientWidth && pre.right <= dialog.right && dialog.right <= window.innerWidth;
  });
  expect(fits).toBe(true);
  await shot(page, "12b-add-node-command");
  await page.keyboard.press("Escape");

  await page.goto(`/nodes/${a}`);
  await expect(page.getByText(/No data in this range/)).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await shot(page, "13-node-detail");

  await page.goto(`/nodes/${a}/import`);
  await page.waitForLoadState("networkidle");
  await shot(page, "14-import");

  await page.goto("/settings");
  await expect(page.getByLabel("From")).toHaveValue("26600");
  await expect(page.getByLabel("Address", { exact: true })).toHaveValue("mc.example.com");
  await expect(page.getByLabel("External port", { exact: true })).toHaveValue("55567");
  await shot(page, "15-settings");

  await page.goto("/events");
  await expect(page.getByTestId("event-token_rotated").first()).toBeVisible();
  await shot(page, "16-events");

  await page.goto("/jobs");
  await shot(page, "17-jobs");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
