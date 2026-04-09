import { test, expect, type Page } from "@playwright/test";

/**
 * Image cache tests — verify that cached poster and avatar images load
 * correctly from the local /images/ path, that the /images/ route requires
 * authentication, and that the Users page renders avatar images.
 *
 * Images are served from /images/<sha256>.jpg after being downloaded and
 * cached at sync time. Items that have not yet been synced since the cache
 * was introduced render a fallback icon rather than an <img>, so they are
 * naturally excluded from load-failure checks.
 *
 * Images use loading="lazy", so we wait for network idle before checking.
 */

async function checkPosters(page: Page, context: string) {
  await page.waitForLoadState("networkidle");

  const results = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img.object-cover[src*='/images/']")).map((el) => {
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
    console.log(`  No cached poster images found on ${context} — skipping image checks (run a sync first?)`);
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

test.describe("Image cache — authentication", () => {
  test("/images/ route requires authentication", async ({ browser }) => {
    // Fresh context with no session cookies
    const ctx = await browser.newContext({ storageState: undefined });
    const request = ctx.request;
    const response = await request.get("/images/test.jpg", { maxRedirects: 0 });
    // Expect either a 401 or a redirect to login (302/303)
    expect([401, 302, 303]).toContain(response.status());
    await ctx.close();
  });
});

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

test.describe("User avatar loading", () => {
  test("Users page avatar images load from /images/ or show fallback", async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await page.waitForLoadState("networkidle");

    const avatarResults = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img[src*='/images/']")).map((el) => {
        const img = el as HTMLImageElement;
        return {
          alt: img.alt,
          src: img.src,
          complete: img.complete,
          loaded: img.complete && img.naturalWidth > 0
        };
      })
    );

    if (avatarResults.length === 0) {
      console.log("  No cached avatar images found on Users page — skipping (run a sync first?)");
      return;
    }

    const failed = avatarResults.filter((r) => r.complete && !r.loaded);
    if (failed.length > 0) {
      const details = failed.map((r) => `  - "${r.alt}" (${r.src})`).join("\n");
      throw new Error(`${failed.length} avatar(s) failed to load on Users:\n${details}`);
    }

    console.log(`  ${avatarResults.length} avatar(s) loaded successfully on Users`);
  });
});
