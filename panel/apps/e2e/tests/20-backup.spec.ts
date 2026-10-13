import { expect, test } from "@playwright/test";
import { SERVER, poll, serverByName, shot, watchCsp, watchForbidden } from "./helpers";

type Job = { type: string; status: string; message: string };

test("manual backup and restore: what was written after the backup disappears", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const s = await serverByName(request, SERVER);
  await page.goto(`/servers/${s.id}`);
  await page.getByRole("tab", { name: "Backups" }).click();
  await page.getByRole("button", { name: /Create backup now/ }).click();
  const backup = await poll(async () => {
    const list = (await (await request.get(`/api/servers/${s.id}/backups`)).json()) as { id: string; filename: string; trigger: string; status: string }[];
    return list.find((b) => b.trigger === "manual" && b.status === "ok");
  }, "the manual backup", 3 * 60_000);
  await expect(page.getByTestId(`backup-row-${backup.filename}`)).toBeVisible();
  await shot(page, "06-backups");

  // A file created after the backup: it must not be there after restoring.
  const write = await request.post(`/api/servers/${s.id}/files/content`, { data: { path: "/e2e-marker.txt", content: "created after the backup" } });
  expect(write.status()).toBe(204);

  await page.getByTestId(`backup-row-${backup.filename}`).getByRole("button", { name: "Restore" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
  await poll(async () => {
    const jobs = (await (await request.get(`/api/jobs?serverId=${s.id}`)).json()) as Job[];
    const r = jobs.find((j) => j.type === "restore");
    if (r?.status === "failed") throw new Error(`restore failed: ${r.message}`);
    return r?.status === "ok";
  }, "the restore", 5 * 60_000);
  expect((await request.get(`/api/servers/${s.id}/files/content?path=${encodeURIComponent("/e2e-marker.txt")}`)).status()).toBe(404);
  await poll(async () => (await (await request.get(`/api/servers/${s.id}`)).json()).observed?.mc?.online, "the server running again", 5 * 60_000);

  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByText("server.properties")).toBeVisible();
  await shot(page, "07-archivos");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("region", { name: "Server jobs" })).toBeVisible();
  await shot(page, "08-historial");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
