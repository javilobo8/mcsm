import { expect, test as setup } from "@playwright/test";
import { shot } from "./helpers";

setup("entrar con la contraseña de administrador", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await shot(page, "01-login");
  await page.getByLabel("Contraseña", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Nuevo servidor" })).toBeVisible();
  await page.context().storageState({ path: ".auth/admin.json" });
});
