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
    await expect(historyPage.locator("div.space-y-2 > div").first()).toContainText("running");

    const initialRequestCount = historyRequestCount;
    expect(initialRequestCount).toBeGreaterThanOrEqual(1);

    const otherPage = await context.newPage();
    await otherPage.goto("/dashboard");
    await expect(otherPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await otherPage.bringToFront();

    await historyPage.waitForTimeout(6_000);

    expect(historyRequestCount).toBeGreaterThan(initialRequestCount);

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

    await historyPage.waitForTimeout(6_000);

    expect(detailRequestCount).toBeGreaterThan(initialDetailRequestCount);

    await context.close();
  });
});
