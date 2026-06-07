// Basic shell smoke test — the three-panel UI mounts and Settings opens.
import { test, expect } from "@playwright/test";

test.describe("app shell", () => {
  test("loads the three-panel UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".header-brand")).toHaveText("openshuki");
    // Right panel hosts the live "Running tasks" list.
    await expect(page.getByText("Running tasks")).toBeVisible();
    // Left panel tab bar.
    await expect(page.locator('button[title="Agents"]')).toBeVisible();
  });

  test("settings view opens and shows the Channels section", async ({
    page
  }) => {
    await page.goto("/");
    await page.locator('button[aria-label="Settings"]').click();
    await expect(
      page.locator(".section-title", { hasText: "Channels" })
    ).toBeVisible();
    await expect(
      page.locator(".section-title", { hasText: "Endpoints" })
    ).toBeVisible();
  });

  test("agents list is reachable and lists built-in agents", async ({
    page
  }) => {
    await page.goto("/");
    await page.locator('button[title="Agents"]').click();
    const left = page.locator(".panel.left");
    await expect(
      left.locator(".list-item", { hasText: "Ask demo" })
    ).toBeVisible();
    await expect(
      left.locator(".list-item", { hasText: "Weather forecast" })
    ).toBeVisible();
  });
});
