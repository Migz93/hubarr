import { test, expect } from "@playwright/test";

/**
 * Dashboard UI tests — verify stat chips, key sections, and action buttons.
 * Read-only. Safe to run against a live instance.
 */

test.describe("Dashboard UI", () => {
  test("Stat chips are visible after load", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });

    // "Media" only appears as a stat chip label — not in the sidebar nav
    await expect(page.getByText("Media")).toBeVisible();
    await expect(page.getByText("Movies")).toBeVisible();
    await expect(page.getByText("Shows")).toBeVisible();
  });

  test("Movies stat chip links to filtered watchlist", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('a[href="/watchlists?type=movie"]')).toBeVisible();
  });

  test("Shows stat chip links to filtered watchlist", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('a[href="/watchlists?type=show"]')).toBeVisible();
  });

  test("Recently Added section heading is visible", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Recently Added" })).toBeVisible();
  });

  test("Recent Syncs panel is visible and links to history", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
    // The entire Recent Syncs panel is an <a> linking to /history.
    // Use its accessible name to distinguish it from the sidebar History link.
    await expect(page.getByRole("link", { name: /recent syncs/i })).toBeVisible();
  });

  test("Run Sync button is present", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /run sync/i })).toBeVisible();
  });
});
