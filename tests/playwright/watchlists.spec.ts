import { test, expect } from "@playwright/test";

/**
 * Watchlists filter and sort tests — verify filter chips and sort options render
 * correctly and that clicking them updates the URL as expected.
 * Read-only. Safe to run against a live instance.
 */

test.describe("Watchlists filters and sorting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/watchlists");
    await expect(page.getByRole("heading", { name: "Watchlists" })).toBeVisible();
    await expect(page.getByText("Loading watchlists...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Media type filter chips are visible", async ({ page }) => {
    // Use /^label/i (no $) to tolerate count badges appended to the label (e.g. "Movies 42")
    await expect(page.getByRole("button", { name: /^movies/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^shows/i })).toBeVisible();
  });

  test("Availability filter chips are visible", async ({ page }) => {
    // Use /^label/i (no $) to tolerate count badges appended to the label (e.g. "In Library 42")
    await expect(page.getByRole("button", { name: /^in library/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^missing/i })).toBeVisible();
  });

  test("Sort options are all visible", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Watchlisted (Newest)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Watchlisted (Oldest)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Title (A\u2013Z)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Title (Z\u2013A)" })).toBeVisible();
  });

  test("Movies filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: /^movies/i }).click();
    await expect(page).toHaveURL(/[?&]type=movie/);
  });

  test("Shows filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: /^shows/i }).click();
    await expect(page).toHaveURL(/[?&]type=show/);
  });

  test("In Library filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: /^in library/i }).click();
    await expect(page).toHaveURL(/[?&]availability=available/);
  });

  test("Missing filter updates URL", async ({ page }) => {
    await page.getByRole("button", { name: /^missing/i }).click();
    await expect(page).toHaveURL(/[?&]availability=missing/);
  });

  test("Title A–Z sort updates URL", async ({ page }) => {
    await page.getByRole("button", { name: "Title (A\u2013Z)" }).click();
    await expect(page).toHaveURL(/[?&]sort=title-asc/);
  });
});
