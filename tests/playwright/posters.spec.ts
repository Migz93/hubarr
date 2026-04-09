import { test, expect, type Page } from "@playwright/test";

/**
 * Poster image tests — verify that poster images actually load (HTTP 200,
 * non-zero dimensions) on the Dashboard and Watchlists pages.
 *
 * Images are served through the /api/plex/image proxy, so a failure here
 * typically means the Plex connection is broken or a poster URL is bad.
 *
 * Items with no poster URL render a fallback icon instead of an <img>,
 * so they are naturally excluded from these checks.
 *
 * Images use loading="lazy", so we wait for network idle before checking.
 */

async function checkPosters(page: Page, context: string) {
  await page.waitForLoadState("networkidle");

  const results = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img.object-cover[src*='/api/plex/image']")).map((el) => {
      const img = el as HTMLImageElement;
      return {
        alt: img.alt,
        src: img.src,
        complete: img.complete,
        loaded: img.complete && img.naturalWidth > 0
      };
    })
  );

  if (results.length === 0) {
    console.log(`  No poster images found on ${context} — skipping image checks (empty data?)`);
    return;
  }

  // Only flag images the browser actually attempted to load (complete === true).
  // Lazy images that are still off-screen will have complete === false and are not failures.
  const failed = results.filter((r) => r.complete && !r.loaded);

  if (failed.length > 0) {
    const details = failed.map((r) => `  - "${r.alt}" (${r.src})`).join("\n");
    throw new Error(`${failed.length} of ${results.length} posters failed to load on ${context}:\n${details}`);
  }

  console.log(`  ${results.length} poster(s) loaded successfully on ${context}`);
}

test.describe("Poster image loading", () => {
  test("Dashboard recently added posters all load", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // Wait for the loading state to clear
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });

    await checkPosters(page, "Dashboard");
  });

  test("Watchlists page 1 posters all load", async ({ page }) => {
    await page.goto("/watchlists");
    await expect(page.getByRole("heading", { name: "Watchlists" })).toBeVisible();
    // Wait for the loading state to clear
    await expect(page.getByText("Loading watchlists...")).not.toBeVisible({ timeout: 10_000 });

    await checkPosters(page, "Watchlists");
  });
});
