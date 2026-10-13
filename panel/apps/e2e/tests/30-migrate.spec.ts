import { expect, test } from "@playwright/test";
import { NODE_B, SERVER, nodeId, poll, serverByName, shot, watchCsp, watchForbidden } from "./helpers";

test("migrar el servidor al segundo nodo (dind) y verlo en marcha allí", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const s = await serverByName(request, SERVER);
  const target = await nodeId(request, NODE_B);
  await page.goto(`/servers/${s.id}`);
  await page.getByRole("tab", { name: "Migrar" }).click();
  await page.locator("#mig-target").click();
  await page.getByRole("option", { name: NODE_B }).click();
  await expect(page.locator("#mig-port")).toHaveAttribute("placeholder", /^\d+$/);
  await shot(page, "09-migrar");
  await page.getByRole("button", { name: /Migrar…/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Migrar" }).click();
  await poll(async () => {
    const m = (await (await request.get(`/api/servers/${s.id}/migration`)).json()).migration as { phase: string; error: string | null } | null;
    if (m?.phase === "failed") throw new Error(`migración fallida: ${m.error}`);
    return m?.phase === "done";
  }, "la migración", 10 * 60_000, 3_000);
  await poll(async () => {
    const x = await (await request.get(`/api/servers/${s.id}`)).json();
    return x.nodeId === target && x.observed?.mc?.online;
  }, "el servidor en marcha en el nodo B", 5 * 60_000);
  await page.reload();
  await expect(page.getByText(NODE_B).first()).toBeVisible();
  await shot(page, "10-migrado");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
