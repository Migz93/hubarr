import { test, expect } from "@playwright/test";

/**
 * Smoke tests — verify each main page loads without errors.
 * These are read-only and safe to run against a live instance.
 */

test.describe("Page smoke tests", () => {
  test("Dashboard loads", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("Watchlists loads", async ({ page }) => {
    await page.goto("/watchlists");
    await expect(page.getByRole("heading", { name: "Watchlists" })).toBeVisible();
  });

  test("Users loads", async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });

  test("History loads", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  });

  test("Settings loads", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("Sidebar navigation links are present", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: /dashboard/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /watchlists/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /users/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /history/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /settings/i })).toBeVisible();
  });

  test("Sidebar navigation works", async ({ page }) => {
    await page.goto("/dashboard");

    await page.getByRole("link", { name: /watchlists/i }).click();
    await expect(page).toHaveURL(/\/watchlists/);
    await expect(page.getByRole("heading", { name: "Watchlists" })).toBeVisible();

    await page.getByRole("link", { name: /users/i }).click();
    await expect(page).toHaveURL(/\/users/);

    await page.getByRole("link", { name: /history/i }).click();
    await expect(page).toHaveURL(/\/history/);

    await page.getByRole("link", { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings/);

    await page.getByRole("link", { name: /dashboard/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("Unauthenticated request redirects to login", async ({ browser }) => {
    // Use a fresh context with no stored session
    const freshContext = await browser.newContext({ storageState: undefined });
    const page = await freshContext.newPage();

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await freshContext.close();
  });
});
