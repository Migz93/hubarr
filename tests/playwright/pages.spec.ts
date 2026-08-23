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
    // exact: true prevents matching section headings like "General Settings"
    await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
  });

  test("Sidebar navigation links are present", async ({ page }) => {
    await page.goto("/dashboard");
    // Scope to the <nav> element to avoid matching same-named links in the page body
    // (e.g. the dashboard stat chips also have a "Users" link)
    const nav = page.locator("nav");
    await expect(nav.getByRole("link", { name: /dashboard/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /watchlists/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /users/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /history/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /settings/i })).toBeVisible();
  });

  test("Sidebar navigation works", async ({ page }) => {
    await page.goto("/dashboard");
    const nav = page.locator("nav");

    await nav.getByRole("link", { name: /watchlists/i }).click();
    await expect(page).toHaveURL(/\/watchlists/);
    await expect(page.getByRole("heading", { name: "Watchlists" })).toBeVisible();

    await nav.getByRole("link", { name: /users/i }).click();
    await expect(page).toHaveURL(/\/users/);

    await nav.getByRole("link", { name: /history/i }).click();
    await expect(page).toHaveURL(/\/history/);

    await nav.getByRole("link", { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings/);

    await nav.getByRole("link", { name: /dashboard/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("Mobile navigation closes from its backdrop or Escape and returns focus to its trigger", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/dashboard");

    const menuButton = page.getByRole("button", { name: "Toggle navigation" });
    const sidebar = page.locator("aside");
    const pageContent = page.locator("[data-overlay-page-content]");
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(pageContent).not.toHaveAttribute("inert", "");
    await menuButton.focus();
    await menuButton.click();

    const dialog = page.getByRole("dialog", { name: "Navigation" });
    await expect(dialog).toBeVisible();
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(pageContent).toHaveAttribute("inert", "");
    await expect(dialog.getByRole("link", { name: "Dashboard" })).toBeFocused();

    await page.locator("[data-overlay-backdrop]").click({ position: { x: 350, y: 700 } });
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await expect(pageContent).not.toHaveAttribute("inert", "");

    await menuButton.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();
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
