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

  test("Edit modal shows collection ordering override section", async ({ page }) => {
    // Open the first user's edit modal via the "Edit user" button
    const editButton = page.getByTitle("Edit user").first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    // The modal should appear
    await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();

    // The Collection Ordering section header should be present
    await expect(page.getByText("Collection Ordering")).toBeVisible();

    // The ordering dropdown should include watchlist date options
    const select = page.getByRole("combobox", { name: "" }).last();
    await expect(select.locator("option[value='watchlist-date-desc']")).toHaveText("Watchlisted Date (New to Old)");
    await expect(select.locator("option[value='watchlist-date-asc']")).toHaveText("Watchlisted Date (Old to New)");

    // "Restore to global default" button should not appear when no override is set
    // (the modal opens with user's current state; just verify the section renders correctly)
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});
