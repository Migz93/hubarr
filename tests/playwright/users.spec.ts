import { test, expect } from "@playwright/test";

/**
 * Users page structure tests — verify the Active/Disabled sections and key action
 * buttons render correctly.
 * Read-only. Safe to run against a live instance.
 */

test.describe("Users page structure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(page.getByText("Loading users...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Active users section heading is visible", async ({ page }) => {
    // Heading text is "Active (N)" — match the prefix
    await expect(page.getByText(/^Active \(/)).toBeVisible();
  });

  test("Disabled users accordion toggle is visible", async ({ page }) => {
    // Toggle button text is "Disabled (N)"
    await expect(page.getByRole("button", { name: /^Disabled \(/ })).toBeVisible();
  });

  test("Refresh Users button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /refresh users/i })).toBeVisible();
  });
});
