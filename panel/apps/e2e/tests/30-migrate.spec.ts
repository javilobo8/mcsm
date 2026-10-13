import { expect, test } from "@playwright/test";
import { NODE_B, SERVER, nodeId, poll, serverByName, shot, watchCsp, watchForbidden } from "./helpers";

test("migrate the server to the second node (dind) and see it running there", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const s = await serverByName(request, SERVER);
  const target = await nodeId(request, NODE_B);
  await page.goto(`/servers/${s.id}`);
  await page.getByRole("tab", { name: "Migrate" }).click();
  await page.locator("#mig-target").click();
  await page.getByRole("option", { name: NODE_B }).click();
  await expect(page.locator("#mig-port")).toHaveAttribute("placeholder", /^\d+$/);
  await shot(page, "09-migrar");
  await page.getByRole("button", { name: /Migrate…/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Migrate" }).click();
  await poll(async () => {
    const m = (await (await request.get(`/api/servers/${s.id}/migration`)).json()).migration as { phase: string; error: string | null } | null;
    if (m?.phase === "failed") throw new Error(`migration failed: ${m.error}`);
    return m?.phase === "done";
  }, "the migration", 10 * 60_000, 3_000);
  await poll(async () => {
    const x = await (await request.get(`/api/servers/${s.id}`)).json();
    return x.nodeId === target && x.observed?.mc?.online;
  }, "the server running on node B", 5 * 60_000);
  await page.reload();
  await expect(page.getByText(NODE_B).first()).toBeVisible();
  await shot(page, "10-migrado");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
