import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE_A, nodeId, poll, shot, watchCsp, watchForbidden } from "./helpers";
import { stubContent } from "./content-stub";

/**
 * Content browser (plan 11). The browser's /api/content/** requests are answered from fixtures (no Internet, no upstream
 * drift); the PATCH, the backup job, the agent and the container are real. The tests share one Fabric server, in order.
 */
test.describe.configure({ mode: "serial" });

type Dto = { id: string; specVersion: number; spec: { mods?: { modrinthProjects: string[] }; version: string; modpack?: { versionId: string } }; observed?: { appliedVersion?: number } | null };
type Job = { type: string; status: string; message: string };

const MODS = "AANobbMI:Pb3OQ6HN";
const FABRIC_API = "P7dR8mSH:Ya5r1c1M";

let serverId = "";
let packId = "";

async function createServer(request: APIRequestContext, name: string, spec: Record<string, unknown>): Promise<string> {
  const node = await nodeId(request, NODE_A);
  const res = await request.post("/api/servers", { data: { nodeId: node, name, desiredState: "stopped", spec } });
  expect(res.status(), await res.text()).toBe(201);
  const s = (await res.json()) as { id: string };
  await applied(request, s.id, 1);
  // "Has a world": the Save confirmation only offers "Back up first" when there is something to protect.
  const mkdir = await request.post(`/api/servers/${s.id}/files/mkdir`, { data: { path: "world" } });
  expect(mkdir.status(), await mkdir.text()).toBeLessThan(300);
  return s.id;
}

const getServer = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/servers/${id}`)).json()) as Dto;
const applied = (request: APIRequestContext, id: string, v: number) =>
  poll(async () => { const d = await getServer(request, id); return d.specVersion >= v && d.observed?.appliedVersion === d.specVersion ? d : null; }, `spec v${v} applied`, 4 * 60_000);

async function openVersionTab(page: Page, id: string): Promise<void> {
  await page.goto(`/servers/${id}`);
  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByTestId("config-form")).toBeVisible();
  await page.getByRole("tab", { name: "Version and mods" }).click();
}

/** Picks a Minecraft version in the combobox (list entry with Internet, “Use …” without). */
async function pickVersion(page: Page, version: string, option = new RegExp(`^(Use “)?${version}”?$`)): Promise<void> {
  await page.locator("#sf-version").click();
  await page.getByPlaceholder("Search or type a version…").fill(version);
  await page.getByRole("option", { name: option }).first().click();
  await expect(page.locator("#sf-version")).toContainText(version, { ignoreCase: true });
}

test("browse, add with dependencies, save; remove with back up first", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  const calls = await stubContent(page);
  serverId = await createServer(request, "test-e2e-content", { type: "FABRIC", version: "1.21.1", imageTag: "java21", memory: "2G" });

  await openVersionTab(page, serverId);
  const mods = page.getByTestId("content-section-mods");
  await expect(mods).toContainText("No mods yet");
  await mods.getByRole("button", { name: "Browse" }).click();

  const dialog = page.getByTestId("content-browser");
  const results = dialog.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("button", { name: /Sodium/ })).toBeVisible();
  await results.getByRole("button", { name: /Sodium/ }).click();
  const details = dialog.getByRole("region", { name: "Details" });
  await expect(details.getByRole("heading", { name: "Sodium", level: 3 })).toBeVisible();
  await expect(details.getByText("Dependencies of this version")).toBeVisible();
  await expect(details.getByText("required · added with it")).toBeVisible();
  await details.getByRole("button", { name: "Select", exact: true }).click();
  await shot(page, "60-content-browser");

  await dialog.getByTestId("content-add").click();
  await expect(dialog.getByTestId("content-review")).toContainText("Add 1 project + 1 dependency");
  await expect(dialog.getByTestId("content-review")).toContainText("dependency of Sodium");
  await shot(page, "60b-content-review");
  await dialog.getByTestId("content-confirm").click();
  await expect(dialog).toBeHidden();

  // Installed list: Sodium with its update, Fabric API as its dependency.
  const rows = mods.getByTestId("installed-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Sodium");
  await expect(rows.nth(0)).toContainText("Update to mc1.21.1-0.6.1-fabric");
  await expect(rows.nth(1)).toContainText("Fabric API");
  await expect(rows.nth(1)).toContainText("Dependency of Sodium");
  await shot(page, "61-installed-list");

  await page.getByRole("button", { name: "Review and apply" }).click();
  await expect(page.getByTestId("spec-diff")).toContainText("Modrinth mods");
  await expect(page.getByTestId("backup-first")).toBeHidden(); // nothing is removed
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const v2 = await applied(request, serverId, 2);
  expect(v2.spec.mods?.modrinthProjects).toEqual([MODS, FABRIC_API]);

  // Saving reloads the form (back on its first section): the installed list now comes from the saved server.
  await page.getByRole("tab", { name: "Version and mods" }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Review and apply" })).toBeEnabled();

  // Remove Sodium and the dependency nobody else needs, backing up first.
  await mods.getByRole("button", { name: "Remove Sodium" }).click();
  const removal = page.getByTestId("content-remove");
  await expect(removal.getByRole("group", { name: "Also remove unused dependencies" })).toBeVisible();
  await expect(removal.getByRole("checkbox", { name: /Fabric API/ })).toBeChecked();
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(rows).toHaveCount(0);

  await page.getByRole("button", { name: "Review and apply" }).click();
  await expect(page.getByTestId("spec-diff")).toContainText("Modrinth mods");
  const backup = page.getByTestId("backup-first");
  await expect(backup.getByRole("checkbox", { name: "Back up first" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Back up and apply" })).toBeVisible();
  await shot(page, "62-back-up-first");
  await page.getByRole("button", { name: "Back up and apply" }).click();

  await poll(async () => {
    const jobs = (await (await request.get(`/api/jobs?serverId=${serverId}`)).json()) as Job[];
    const j = jobs.find((x) => x.type === "spec_apply");
    if (j?.status === "failed") throw new Error(`apply after backup failed: ${j.message}`);
    return j?.status === "ok";
  }, "the Apply after backup job", 5 * 60_000);
  await expect(page.getByTestId("backup-first-outcome")).toBeVisible();
  await shot(page, "62b-back-up-first-done");
  const v3 = await applied(request, serverId, 3);
  expect(v3.spec.mods?.modrinthProjects ?? []).toEqual([]);

  expect(calls.all).toContain("POST /api/content/resolve");
  expect(calls.all).toContain("POST /api/content/lookup");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});

test("installed states, compatibility findings on Save and the floating-version notice", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  await stubContent(page);
  await openVersionTab(page, serverId);
  const mods = page.getByTestId("content-section-mods");

  // Typed by hand: a pinned project with an update, a dependency whose update check failed, and an entry the source cannot describe.
  await mods.getByRole("button", { name: "Edit as text" }).click();
  await page.locator("#sf-mods-modrinth").fill(`${MODS}\nP7dR8mSH:Zk2r9cQ4\nlithium`);
  await mods.getByRole("button", { name: "Edit as text" }).click();
  const rows = mods.getByTestId("installed-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Update to mc1.21.1-0.6.1-fabric");
  await expect(rows.nth(1)).toContainText("Dependency of Sodium");
  await expect(rows.nth(1)).toContainText("Couldn't check for updates");
  await expect(rows.nth(2)).toContainText("Details are not available right now: shown as typed");
  await shot(page, "63-installed-states");

  // Moving to another Minecraft version: the pinned entries no longer fit, and the confirmation says so.
  await pickVersion(page, "1.20.4");
  await page.getByRole("button", { name: "Review and apply" }).click();
  const findings = page.getByTestId("compat-findings");
  await expect(findings).toContainText("2 pinned entries do not fit this server");
  await expect(findings).toContainText("Sodium: its pinned version does not support Minecraft 1.20.4");
  await expect(findings.getByRole("button", { name: "Update to compatible versions" })).toBeVisible();
  await shot(page, "64-save-compat");
  await page.getByRole("button", { name: "Cancel" }).click();

  // LATEST: browsing needs a concrete version.
  await pickVersion(page, "LATEST", /latest/i);
  await mods.getByRole("button", { name: "Browse" }).click();
  const dialog = page.getByTestId("content-browser");
  await expect(dialog.getByText("Choose a Minecraft version")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Pin Minecraft version to|The version list is not available/ })).toBeVisible({ timeout: 60_000 });
  await shot(page, "65-pin-version");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Discard changes" }).click();
  expect((await getServer(request, serverId)).spec.mods?.modrinthProjects ?? []).toEqual([]); // nothing was saved
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});

test("modpack: card, switching and the backup offer; wizard starting point", async ({ page, request }) => {
  const csp = watchCsp(page);
  const forbidden = watchForbidden(page);
  await stubContent(page);
  packId = await createServer(request, "test-e2e-pack", {
    type: "MODRINTH", version: "1.21.1", imageTag: "java21", memory: "2G",
    modpack: { platform: "MODRINTH", slugOrUrl: "BYfVnHa7", versionId: "Jk4Qm9Rv", loader: "" },
  });

  await openVersionTab(page, packId);
  const card = page.getByTestId("pack-card");
  await expect(card).toContainText("Fabulously Optimized");
  await expect(card).toContainText("Minecraft 1.21.1 · fabric 0.16.9");
  await expect(card).toContainText("Update available: Fabulously Optimized 6.2.0");
  await shot(page, "66-pack-card");

  await card.getByRole("button", { name: "Switch modpack" }).click();
  const dialog = page.getByTestId("content-browser");
  await dialog.getByRole("list", { name: "Search results" }).getByRole("button", { name: /Better MC/ }).click();
  const details = dialog.getByRole("region", { name: "Details" });
  await expect(details.getByRole("heading", { name: "Better MC [FABRIC]", level: 3 })).toBeVisible();
  await details.getByRole("button", { name: "Select", exact: true }).click();
  await dialog.getByTestId("content-add").click();
  await expect(dialog.getByTestId("content-review")).toContainText("Better MC [FABRIC]");
  await expect(dialog.getByTestId("content-confirm")).toHaveText("Switch to this modpack");
  await shot(page, "67-pack-review");
  await dialog.getByTestId("content-confirm").click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Review and apply" }).click();
  await expect(page.getByTestId("backup-first")).toBeVisible();
  await expect(page.getByTestId("backup-first")).toContainText("modpack");
  await shot(page, "68-pack-switch-save");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  expect((await getServer(request, packId)).spec.modpack?.versionId).toBe("Jk4Qm9Rv");

  // New server wizard: the first step is “Starting point” and offers a modpack.
  await page.goto("/servers/new");
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("Starting point");
  await shot(page, "69-wizard-start");
  await page.getByRole("radio", { name: /Start from a modpack/ }).click();
  const pick = page.getByTestId("content-browser");
  await pick.getByRole("list", { name: "Search results" }).getByRole("button", { name: /Fabulously Optimized/ }).click();
  await pick.getByRole("region", { name: "Details" }).getByRole("button", { name: "Select", exact: true }).click();
  await pick.getByTestId("content-add").click();
  await expect(pick.getByTestId("content-confirm")).toHaveText("Use this modpack");
  await pick.getByTestId("content-confirm").click();
  await expect(pick).toBeHidden();
  await shot(page, "69b-wizard-modpack");
  expect(csp).toEqual([]);
  expect(forbidden).toEqual([]);
});
