import { test, expect } from "@playwright/test";

/**
 * History filter tests — verify that type/status/activity filter buttons and
 * the page-size selector render correctly, and that clicking filters updates the URL.
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
    const filter = page.getByRole("group", { name: "Type filter" });
    await expect(filter.getByRole("button", { name: "All", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "GraphQL", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "RSS", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "Manual", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "Collection", exact: true })).toBeVisible();
  });

  test("Status filter buttons are all visible", async ({ page }) => {
    // exact: true prevents matching history run-row buttons whose names include these words
    const filter = page.getByRole("group", { name: "Status filter" });
    await expect(filter.getByRole("button", { name: "All", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: /^success$/i })).toBeVisible();
    await expect(filter.getByRole("button", { name: /^error$/i })).toBeVisible();
    await expect(filter.getByRole("button", { name: /^running$/i })).toBeVisible();
  });

  test("Activity filter buttons are all visible", async ({ page }) => {
    const filter = page.getByRole("group", { name: "Activity filter" });
    await expect(filter.getByRole("button", { name: "All", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "Changes", exact: true })).toBeVisible();
    await expect(filter.getByRole("button", { name: "No Changes", exact: true })).toBeVisible();
  });

  test("Activity filter starts with All", async ({ page }) => {
    const activityButtons = page.getByRole("group", { name: "Activity filter" }).getByRole("button");
    await expect(activityButtons.nth(0)).toHaveText("All");
    await expect(activityButtons.nth(1)).toHaveText("Changes");
    await expect(activityButtons.nth(2)).toHaveText("No Changes");
  });

  test("Page size select is visible", async ({ page }) => {
    await expect(page.locator("select")).toBeVisible();
  });

  test("RSS type filter updates URL", async ({ page }) => {
    await page.getByRole("group", { name: "Type filter" }).getByRole("button", { name: "RSS", exact: true }).click();
    await expect(page).toHaveURL(/[?&]type=rss/);
  });

  test("Success status filter updates URL", async ({ page }) => {
    await page.getByRole("group", { name: "Status filter" }).getByRole("button", { name: /^success$/i }).click();
    await expect(page).toHaveURL(/[?&]status=success/);
  });

  test("No Changes activity filter updates URL", async ({ page }) => {
    await page.getByRole("group", { name: "Activity filter" }).getByRole("button", { name: "No Changes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]activity=no_changes/);
  });

  test("All activity filter updates URL", async ({ page }) => {
    await page.getByRole("group", { name: "Activity filter" }).getByRole("button", { name: "All", exact: true }).click();
    await expect(page).toHaveURL(/[?&]activity=all/);
  });
});
