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

  await page.goto("/");
  await expect(page.getByRole("group", { name: "Node usage" }).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "11-panel-tarjetas-nodo");

  await page.goto("/nodes");
  await expect(page.getByRole("link", { name: NODE_A })).toBeVisible();
  await shot(page, "12-nodos-router");

  await page.goto(`/nodes/${a}`);
  await expect(page.getByText(/No data in this range/)).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await shot(page, "13-nodo-detalle");

  await page.goto(`/nodes/${a}/import`);
  await page.waitForLoadState("networkidle");
  await shot(page, "14-importar");

  await page.goto("/settings");
  await expect(page.getByLabel("From")).toHaveValue("26600");
  await shot(page, "15-ajustes");

  await page.goto("/events");
  await expect(page.getByTestId("event-token_rotated").first()).toBeVisible();
  await shot(page, "16-eventos");

  await page.goto("/jobs");
  await shot(page, "17-jobs");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
