import { test, expect } from "@playwright/test";

/**
 * History filter tests — verify that type/status filter buttons and the page-size
 * selector render correctly, and that clicking filters updates the URL.
 * Read-only. Safe to run against a live instance.
 */

test.describe("History filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Type filter buttons are all visible", async ({ page }) => {
    // exact: true prevents matching history run-row buttons that contain these words
    await expect(page.getByRole("button", { name: "All types", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "GraphQL", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "RSS", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manual", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Collection", exact: true })).toBeVisible();
  });

  test("Status filter buttons are all visible", async ({ page }) => {
    // exact: true prevents matching history run-row buttons whose names include these words
    await expect(page.getByRole("button", { name: "All status", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^success$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^error$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^running$/i })).toBeVisible();
  });

  test("Page size select is visible", async ({ page }) => {
    await expect(page.locator("select")).toBeVisible();
  });

  test("RSS type filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: "RSS", exact: true }).click();
    await expect(page).toHaveURL(/[?&]type=rss/);
  });

  test("Success status filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: /^success$/i }).click();
    await expect(page).toHaveURL(/[?&]status=success/);
  });
});
