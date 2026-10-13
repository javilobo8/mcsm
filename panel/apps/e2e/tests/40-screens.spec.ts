import { expect, test } from "@playwright/test";
import { NODE_A, nodeId, poll, shot, watchCsp, watchForbidden } from "./helpers";

test("rotación real de un token y capturas de las pantallas pendientes de revisión visual", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const a = await nodeId(request, NODE_A);

  // Rotación de token contra el agente real: vuelve a conectar con el nuevo y deja de estar pendiente.
  const rot = await request.post(`/api/nodes/${a}/rotate-token`);
  expect(rot.status()).toBe(200);
  await poll(async () => {
    const n = ((await (await request.get("/api/nodes")).json()) as { id: string; status: string; tokenRotationPending: boolean }[]).find((x) => x.id === a);
    return n?.status === "online" && !n.tokenRotationPending;
  }, "el nodo A con el token nuevo", 60_000);

  await page.goto("/");
  await expect(page.getByRole("group", { name: "Uso del nodo" }).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "11-panel-tarjetas-nodo");

  await page.goto("/nodes");
  await expect(page.getByRole("link", { name: NODE_A })).toBeVisible();
  await shot(page, "12-nodos-router");

  await page.goto(`/nodes/${a}`);
  await expect(page.getByText(/Sin datos en este rango/)).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await shot(page, "13-nodo-detalle");

  await page.goto(`/nodes/${a}/import`);
  await page.waitForLoadState("networkidle");
  await shot(page, "14-importar");

  await page.goto("/settings");
  await expect(page.getByLabel("Desde")).toHaveValue("26600");
  await shot(page, "15-ajustes");

  await page.goto("/events");
  await expect(page.getByTestId("event-token_rotated").first()).toBeVisible();
  await shot(page, "16-eventos");

  await page.goto("/jobs");
  await shot(page, "17-jobs");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
