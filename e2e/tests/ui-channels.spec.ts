// Test plan §1 — #5.9 Channels settings UI: create, toggle, delete.
import { test, expect } from "@playwright/test";

test.describe("#5.9 channels settings UI", () => {
  test("create, toggle, then delete a user channel", async ({ page }) => {
    const name = `ui-chan-${Date.now()}`;

    await page.goto("/");
    await page.locator('button[aria-label="Settings"]').click();
    await expect(
      page.locator(".section-title", { hasText: "Channels" })
    ).toBeVisible();

    // --- Create -----------------------------------------------------------
    await page.getByPlaceholder("My chat bridge").fill(name);
    // An out_only notifications kind needs no network endpoint.
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="notifications.windows"]') })
      .selectOption("notifications.windows");
    await page.getByRole("button", { name: "Create channel" }).click();

    const row = page.locator(".list-item", { hasText: name });
    await expect(row).toBeVisible();
    // Newly created channels are disabled → toggle button reads "Enable".
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();

    // --- Toggle -----------------------------------------------------------
    await row.getByRole("button", { name: "Enable" }).click();
    await expect(row.getByRole("button", { name: "Disable" })).toBeVisible();
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();

    // --- Delete (confirm() dialog) ---------------------------------------
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".list-item", { hasText: name })).toHaveCount(0);
  });
});
