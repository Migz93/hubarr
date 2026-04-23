import { test, expect } from "@playwright/test";

/**
 * Seerr integration tests — verify the Settings Seerr tab renders correctly,
 * the History page renders Seerr action labels, and the Users edit modal
 * respects the Seerr-enabled flag.
 *
 * Read-only. Safe to run against a live instance whether or not Seerr is
 * configured. Tests that depend on Seerr being enabled are skipped gracefully
 * when the integration is off.
 */

// ---------------------------------------------------------------------------
// Settings — Seerr tab
// ---------------------------------------------------------------------------

test.describe("Settings — Seerr tab", () => {
  test("Seerr tab button is visible", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Seerr", exact: true })).toBeVisible();
  });

  test("Clicking the Seerr tab updates the URL", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Seerr", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=seerr/);
  });

  test("Seerr tab loads without error and shows the connection form", async ({ page }) => {
    await page.goto("/settings?tab=seerr");
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });

    // Card heading and URL field
    await expect(page.getByRole("heading", { name: "Seerr Integration" })).toBeVisible();
    await expect(page.getByPlaceholder("http://seerr:5055")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test Connection" })).toBeVisible();
  });

  test("Seerr tab shows the Behaviour section with request toggles", async ({ page }) => {
    await page.goto("/settings?tab=seerr");
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });

    // Behaviour divider and the two request-control toggles
    await expect(page.getByText("Behaviour", { exact: true })).toBeVisible();
    await expect(page.getByText("Automatic Requests")).toBeVisible();
    await expect(page.getByText("Use Hubarr Service Account")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// History — Seerr filter
// ---------------------------------------------------------------------------

test.describe("History — Seerr filter", () => {
  test("Seerr filter button is visible and sets the URL param", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "Seerr", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Seerr", exact: true }).click();
    await expect(page).toHaveURL(/[?&]type=seerr/);
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Seerr history entries render without error when present", async ({ page }) => {
    await page.goto("/history?type=seerr");
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    // Either a run row or the empty-state message must be visible — never an unhandled error.
    const hasRuns = await page.locator("div.space-y-2 > div").first().isVisible().catch(() => false);
    if (!hasRuns) {
      await expect(page.getByText("No sync history matches the current filter.")).toBeVisible();
      return;
    }

    // Seerr runs exist on this instance — expand the first one and verify it loads.
    const firstRun = page.locator("div.space-y-2 > div").first();
    await firstRun.getByRole("button").first().click();
    await expect(page.getByText("Loading details...")).not.toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Users — Seerr section conditional rendering
// ---------------------------------------------------------------------------

test.describe("Users edit modal — Seerr section", () => {
  test("Edit modal Seerr section visibility matches the Seerr enabled state", async ({ page }) => {
    // Fetch settings to determine whether Seerr is enabled
    const settingsRes = await page.request.get("/api/settings");
    const settings = await settingsRes.json() as { seerr?: { enabled?: boolean } };
    const seerrEnabled = settings?.seerr?.enabled ?? false;

    await page.goto("/users");
    await expect(page.getByText("Loading users...")).not.toBeVisible({ timeout: 10_000 });

    // Open the first user's edit modal
    const editButton = page.getByTitle("Edit user").first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const modal = page.locator("div.fixed.inset-0.z-50");
    await expect(modal).toBeVisible();

    if (seerrEnabled) {
      // When Seerr is enabled a Seerr tab should be present
      await expect(modal.getByRole("button", { name: "Seerr", exact: true })).toBeVisible();
    } else {
      // When Seerr is disabled no Seerr tab should appear in the modal
      await expect(modal.getByRole("button", { name: "Seerr", exact: true })).not.toBeVisible();
    }

    await modal.getByRole("button", { name: "Cancel" }).click();
  });
});
