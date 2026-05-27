import { test, expect } from "@playwright/test";
import type { JobInfo, SettingsResponse, UserRecord } from "../../src/shared/types";

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

  test("Disabled users never show a Sync Watchlist button", async ({ page }) => {
    const disabledToggle = page.getByRole("button", { name: /^Disabled \(/ });
    await expect(disabledToggle).toBeVisible();
    await disabledToggle.click();

    const disabledSection = page.locator("div.mb-6").filter({
      has: page.getByRole("button", { name: /^Disabled \(/ })
    }).first();

    await expect(disabledSection.getByRole("button", { name: /sync watchlist/i })).toHaveCount(0);
  });

  test("Refresh Users button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /refresh users/i })).toBeVisible();
  });

  test("Edit modal shows collection ordering override section", async ({ page }) => {
    // Open the first user's edit modal via the "Edit user" button
    const editButton = page.getByTitle("Edit user").first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    // The modal should appear — confirm it's open by checking for the Cancel button
    const modal = page.locator("div.fixed.inset-0.z-50");
    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Navigate to the Collection tab
    await modal.getByRole("button", { name: "Collection", exact: true }).click();

    // The Sort Order field should now be visible
    await expect(modal.getByText("Sort Order", { exact: true })).toBeVisible();

    // The ordering dropdown should include watchlist date options
    const select = modal.getByRole("combobox").last();
    await expect(select.locator("option[value='watchlist-date-desc']")).toHaveText("Watchlisted Date (New to Old)");
    await expect(select.locator("option[value='watchlist-date-asc']")).toHaveText("Watchlisted Date (Old to New)");

    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("Watchlist tab is only available when editing the self user", async ({ page, request }) => {
    const users = await request.get("/api/users").then((response) => response.json() as Promise<UserRecord[]>);
    const selfUser = users.find((user) => user.isSelf);
    expect(selfUser, "Expected the live instance to have a self user").toBeTruthy();

    const selfCard = page.locator("div.relative").filter({ hasText: "You" }).first();
    await expect(selfCard).toBeVisible();
    await selfCard.getByTitle("Edit user").click();

    const modal = page.locator("div.fixed.inset-0.z-50");
    await expect(modal.getByRole("button", { name: "Watchlist", exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();

    const friend = users.find((user) => !user.isSelf);
    test.skip(!friend, "No non-self user exists on this live instance.");

    const friendLabel = friend!.displayNameOverride?.trim() || friend!.displayName || friend!.username;
    const friendCard = page.locator("div.relative").filter({ hasText: friendLabel }).first();
    await expect(friendCard).toBeVisible();
    await friendCard.getByTitle("Edit user").click();

    await expect(modal.getByRole("button", { name: "Watchlist", exact: true })).toHaveCount(0);
  });

  test("Self Watchlist tab shows cleanup options without changing them", async ({ page }) => {
    const selfCard = page.locator("div.relative").filter({ hasText: "You" }).first();
    await expect(selfCard).toBeVisible();
    await selfCard.getByTitle("Edit user").click();

    const modal = page.locator("div.fixed.inset-0.z-50");
    await modal.getByRole("button", { name: "Watchlist", exact: true }).click();

    await expect(modal.getByLabel("Remove Movie When Watched")).toBeVisible();
    await expect(modal.getByLabel("Remove Show When Watched")).toBeVisible();
    await expect(modal.getByText(/fully viewed after they were watchlisted/i)).toBeVisible();

    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Watchlist Cleanup job is enabled when cleanup settings are already enabled", async ({ page, request }) => {
    const settings = await request.get("/api/settings").then((response) => response.json() as Promise<SettingsResponse>);
    const cleanupEnabled = settings.watchlistCleanup.movieEnabled || settings.watchlistCleanup.showEnabled;
    test.skip(!cleanupEnabled, "Watchlist cleanup is currently disabled on this live instance.");

    await page.goto("/settings?tab=jobs");
    await expect(page.getByText("Loading jobs...")).not.toBeVisible({ timeout: 10_000 });

    const cleanupRow = page.locator("tr", { hasText: "Watchlist Cleanup" });
    await expect(cleanupRow).toBeVisible();

    const jobs = await request.get("/api/settings/jobs").then((response) => response.json() as Promise<JobInfo[]>);
    const cleanupJob = jobs.find((job) => job.id === "watchlist-cleanup");
    expect(cleanupJob?.isEnabled).toBe(true);
    expect(cleanupJob?.intervalDescription).toBeTruthy();
    await expect(cleanupRow).toContainText(cleanupJob!.intervalDescription);
    await expect(cleanupRow.getByRole("button", { name: "Run Now", exact: true })).toBeEnabled();
  });
});
