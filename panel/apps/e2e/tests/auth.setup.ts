import { expect, test as setup } from "@playwright/test";
import { shot } from "./helpers";

setup("sign in with the administrator password", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await shot(page, "01-login");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "New server" }).first()).toBeVisible();
  await page.context().storageState({ path: ".auth/admin.json" });
});
