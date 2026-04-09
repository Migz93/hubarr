import { test, expect } from "@playwright/test";

/**
 * API smoke tests — verify key endpoints return healthy responses.
 * Uses the request fixture (no browser), with the stored session cookie applied
 * automatically via storageState.
 * Read-only. Safe to run against a live instance.
 */

test.describe("API smoke tests", () => {
  test("GET /api/health returns 200 with uptime", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty("uptimeSeconds");
  });

  test("GET /api/auth/session returns authenticated session", async ({ request }) => {
    const response = await request.get("/api/auth/session");
    expect(response.status()).toBe(200);

    const body = await response.json() as { authenticated: boolean; user?: unknown };
    expect(body.authenticated).toBe(true);
    expect(body.user).toBeDefined();
  });

  test("GET /api/dashboard returns expected shape", async ({ request }) => {
    const response = await request.get("/api/dashboard");
    expect(response.status()).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty("stats");
    expect(body).toHaveProperty("recentlyAdded");
    expect(body).toHaveProperty("syncActivity");

    const stats = body.stats as Record<string, unknown>;
    expect(stats).toHaveProperty("enabledUsers");
    expect(stats).toHaveProperty("trackedMovies");
    expect(stats).toHaveProperty("trackedShows");
  });
});
