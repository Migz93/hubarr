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
// History — Seerr action labels
// ---------------------------------------------------------------------------

test.describe("History — Seerr action labels", () => {
  test("Seerr action labels render correctly when stubbed into the history API", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const run = {
      id: 9010,
      kind: "full" as const,
      status: "success" as const,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date(Date.now() - 55_000).toISOString(),
      summary: "Full sync finished: 1/1 users succeeded.",
      error: null
    };

    await historyPage.route("**/api/history?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [run],
          pageInfo: { page: 1, pageSize: 10, pages: 1, total: 1 }
        })
      });
    });

    await historyPage.route("**/api/history/9010", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...run,
          items: [
            { id: 1, runId: 9010, userId: 1, action: "seerr.request.created", status: "success", details: { displayName: "Alice", title: "The Matrix" }, createdAt: run.startedAt },
            { id: 2, runId: 9010, userId: 1, action: "seerr.request.existing", status: "success", details: { displayName: "Alice", title: "Inception" }, createdAt: run.startedAt },
            { id: 3, runId: 9010, userId: 1, action: "seerr.request.skipped", status: "success", details: { displayName: "Alice", title: "Interstellar" }, createdAt: run.startedAt }
          ]
        })
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    // Expand the run row
    const runRow = historyPage.locator("div.space-y-2 > div").first();
    await runRow.getByRole("button").click();
    await expect(historyPage.getByText("Loading details...")).not.toBeVisible({ timeout: 10_000 });

    // Reveal the completed steps
    await historyPage.getByRole("button", { name: /Show \d+ completed steps/ }).click();

    await expect(historyPage.getByText("Seerr request created")).toBeVisible();
    await expect(historyPage.getByText("Already in Seerr")).toBeVisible();
    await expect(historyPage.getByText("Seerr request skipped")).toBeVisible();

    await context.close();
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
