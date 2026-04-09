import { test, expect } from "@playwright/test";

/**
 * Settings tab tests — verify all tabs are present, tab navigation updates the URL,
 * and each tab's content loads without error.
 * Read-only. Safe to run against a live instance.
 */

const TABS = ["General", "Plex", "Collections", "Logs", "Jobs", "About"] as const;

test.describe("Settings tabs", () => {
  test("All six tabs are visible", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    for (const tab of TABS) {
      await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
    }
  });

  test("Clicking a tab updates the URL", async ({ page }) => {
    await page.goto("/settings");

    await page.getByRole("button", { name: "Plex", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=plex/);

    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=jobs/);

    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=about/);
  });

  test("General tab shows Startup Sync toggle and History Retention field", async ({ page }) => {
    await page.goto("/settings?tab=general");
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Startup Sync")).toBeVisible();
    await expect(page.getByText("History Retention")).toBeVisible();
  });

  test("Jobs tab shows the jobs table", async ({ page }) => {
    await page.goto("/settings?tab=jobs");
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Loading jobs...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Job Name")).toBeVisible();
  });

  test("About tab shows version and support info", async ({ page }) => {
    await page.goto("/settings?tab=about");
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("About Hubarr")).toBeVisible();
    await expect(page.getByText("Version")).toBeVisible();
  });
});
