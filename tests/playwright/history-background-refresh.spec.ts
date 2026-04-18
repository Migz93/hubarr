import { test, expect } from "@playwright/test";

type SyncRun = {
  id: number;
  kind: "full" | "user" | "rss" | "publish";
  status: "idle" | "running" | "success" | "error";
  startedAt: string;
  completedAt: string | null;
  summary: string;
  error: string | null;
};

type SyncRunDetail = SyncRun & {
  items: Array<{
    id: number;
    runId: number;
    userId: number | null;
    action: string;
    status: "success" | "error";
    details: unknown;
    createdAt: string;
  }>;
};

test.describe("History background refresh", () => {
  test("Running history rows show Just now and live elapsed text", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const startedAt = new Date(Date.now() - 42_000).toISOString();
    const runningRun: SyncRun = {
      id: 9000,
      kind: "full",
      status: "running",
      startedAt,
      completedAt: null,
      summary: "Full sync: syncing watchlist for Alice (1/2).",
      error: null
    };

    await historyPage.route("**/api/history?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [runningRun],
          pageInfo: {
            page: 1,
            pageSize: 10,
            pages: 1,
            total: 1
          }
        })
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    const runRow = historyPage.locator("div.space-y-2 > div").first();
    await expect(runRow).toContainText("Running");
    await expect(runRow).toContainText("Just now");
    await expect(runRow).toContainText(/Running for \d+s/);

    await context.close();
  });

  test("History list keeps polling while the tab is hidden when a run is active", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const runningRun: SyncRun = {
      id: 9001,
      kind: "full",
      status: "running",
      startedAt: "2026-04-14T10:00:00.000Z",
      completedAt: null,
      summary: "Full sync: syncing watchlist for Alice (1/2).",
      error: null
    };

    let historyRequestCount = 0;

    await historyPage.route("**/api/history?*", async (route) => {
      historyRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [runningRun],
          pageInfo: {
            page: 1,
            pageSize: 10,
            pages: 1,
            total: 1
          }
        })
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });
    await expect(historyPage.locator("div.space-y-2 > div").first()).toContainText("Running");

    const initialRequestCount = historyRequestCount;
    expect(initialRequestCount).toBeGreaterThanOrEqual(1);

    const otherPage = await context.newPage();
    await otherPage.goto("/dashboard");
    await expect(otherPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await otherPage.bringToFront();

    await expect.poll(() => historyRequestCount, { timeout: 10_000 }).toBeGreaterThan(initialRequestCount);

    await context.close();
  });

  test("Expanded history details keep polling while the tab is hidden when a run is active", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const runningRun: SyncRun = {
      id: 9002,
      kind: "publish",
      status: "running",
      startedAt: "2026-04-14T10:05:00.000Z",
      completedAt: null,
      summary: "Collection sync: publishing collections for Bob (1/3).",
      error: null
    };

    let detailRequestCount = 0;

    await historyPage.route("**/api/history?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [runningRun],
          pageInfo: {
            page: 1,
            pageSize: 10,
            pages: 1,
            total: 1
          }
        })
      });
    });

    await historyPage.route("**/api/history/9002", async (route) => {
      detailRequestCount += 1;
      const detail: SyncRunDetail = {
        ...runningRun,
        summary: `Collection sync: publishing collections for Bob (${Math.min(detailRequestCount, 3)}/3).`,
        items: [
          {
            id: detailRequestCount,
            runId: 9002,
            userId: 42,
            action: "collection.publish",
            status: "success",
            details: {
              userId: 42,
              displayName: "Bob",
              mediaType: "movie",
              matchedItems: 12
            },
            createdAt: "2026-04-14T10:05:00.000Z"
          }
        ]
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail)
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    const runRow = historyPage.locator("div.space-y-2 > div").first();
    await runRow.getByRole("button").click();
    await expect(historyPage.getByText("Loading details...")).not.toBeVisible({ timeout: 10_000 });

    const initialDetailRequestCount = detailRequestCount;
    expect(initialDetailRequestCount).toBeGreaterThanOrEqual(1);

    const otherPage = await context.newPage();
    await otherPage.goto("/dashboard");
    await expect(otherPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await otherPage.bringToFront();

    await expect.poll(() => detailRequestCount, { timeout: 10_000 }).toBeGreaterThan(initialDetailRequestCount);

    await context.close();
  });

  test("Expanded errors stay collapsed by default and grouped steps render readable labels", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const completedRun: SyncRun = {
      id: 9003,
      kind: "full",
      status: "error",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date(Date.now() - 20_000).toISOString(),
      summary: "Full sync finished: 1/2 users succeeded.",
      error: "Full sync partially failed"
    };

    await historyPage.route("**/api/history?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [completedRun],
          pageInfo: {
            page: 1,
            pageSize: 10,
            pages: 1,
            total: 1
          }
        })
      });
    });

    await historyPage.route("**/api/history/9003", async (route) => {
      const detail: SyncRunDetail = {
        ...completedRun,
        items: [
          {
            id: 1,
            runId: 9003,
            userId: 10,
            action: "watchlist.fetch",
            status: "success",
            details: {
              userId: 10,
              displayName: "Alice",
              itemCount: 12,
              matched: 11,
              unmatched: 1
            },
            createdAt: "2026-04-14T10:05:00.000Z"
          },
          {
            id: 2,
            runId: 9003,
            userId: 11,
            action: "watchlist.fetch",
            status: "success",
            details: {
              userId: 11,
              displayName: "Bob",
              itemCount: 5,
              matched: 5,
              unmatched: 0
            },
            createdAt: "2026-04-14T10:05:02.000Z"
          },
          {
            id: 3,
            runId: 9003,
            userId: 10,
            action: "sync.user",
            status: "error",
            details: {
              userId: 10,
              displayName: "Alice",
              message: "Plex request failed"
            },
            createdAt: "2026-04-14T10:05:04.000Z"
          },
          {
            id: 4,
            runId: 9003,
            userId: null,
            action: "collection.publish.followup",
            status: "success",
            details: {
              message: "Triggered collection publish after full sync."
            },
            createdAt: "2026-04-14T10:05:05.000Z"
          }
        ]
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail)
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    const runRow = historyPage.locator("div.space-y-2 > div").first();
    await runRow.getByRole("button").click();
    await expect(historyPage.getByText("Loading details...")).not.toBeVisible({ timeout: 10_000 });

    await expect(historyPage.getByRole("button", { name: /Show Errors \(2\)/ })).toBeVisible();
    await expect(historyPage.getByText("Run error", { exact: true })).toHaveCount(0);

    await historyPage.getByRole("button", { name: /Show 3 completed steps/ }).click();
    await expect(historyPage.getByText("Watchlist fetch for Alice", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("12 items (11 matched, 1 unmatched)", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("Watchlist fetch for Bob", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("5 items (5 matched, 0 unmatched)", { exact: true })).toBeVisible();
    await expect(historyPage.locator("div", { hasText: "Triggered collection publish after full sync." }).first()).toBeVisible();

    await historyPage.getByRole("button", { name: /Show Errors \(2\)/ }).click();
    await expect(historyPage.getByText("Run error", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("User sync failed for Alice", { exact: true })).toBeVisible();

    await context.close();
  });

  test("RSS runs show feed checks and descriptive item labels", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "tests/playwright/.auth/storageState.json" });
    const historyPage = await context.newPage();

    const rssRun: SyncRun = {
      id: 9004,
      kind: "rss",
      status: "success",
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      completedAt: new Date(Date.now() - 25_000).toISOString(),
      summary: "RSS sync: 1 new item(s) processed (self: 0, friends: 1).",
      error: null
    };

    await historyPage.route("**/api/history?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [rssRun],
          pageInfo: {
            page: 1,
            pageSize: 10,
            pages: 1,
            total: 1
          }
        })
      });
    });

    await historyPage.route("**/api/history/9004", async (route) => {
      const detail: SyncRunDetail = {
        ...rssRun,
        items: [
          {
            id: 1,
            runId: 9004,
            userId: null,
            action: "rss.feed.check.self",
            status: "success",
            details: {
              feed: "self",
              checked: true,
              found: 0
            },
            createdAt: "2026-04-14T10:05:00.000Z"
          },
          {
            id: 2,
            runId: 9004,
            userId: null,
            action: "rss.feed.check.friends",
            status: "success",
            details: {
              feed: "friends",
              checked: true,
              found: 1
            },
            createdAt: "2026-04-14T10:05:02.000Z"
          },
          {
            id: 3,
            runId: 9004,
            userId: 22,
            action: "watchlist.rss",
            status: "success",
            details: {
              userId: 22,
              displayName: "Alice",
              title: "The Matrix",
              type: "movie",
              matchedRatingKey: "1234"
            },
            createdAt: "2026-04-14T10:05:04.000Z"
          }
        ]
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail)
      });
    });

    await historyPage.goto("/history");
    await expect(historyPage.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(historyPage.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });

    const runRow = historyPage.locator("div.space-y-2 > div").first();
    await runRow.getByRole("button").click();
    await expect(historyPage.getByText("Loading details...")).not.toBeVisible({ timeout: 10_000 });

    await historyPage.getByRole("button", { name: /Show 3 completed steps/ }).click();
    await expect(historyPage.getByText("Self RSS feed checked", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("Friends RSS feed checked", { exact: true })).toBeVisible();
    await expect(historyPage.getByText("Found RSS item for Alice: The Matrix (movie)", { exact: true })).toBeVisible();

    await context.close();
  });
});
