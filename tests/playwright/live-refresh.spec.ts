import { test, expect, type APIRequestContext } from "@playwright/test";

type SyncRun = {
  id: number;
  kind: "full" | "user" | "rss" | "publish";
  status: "idle" | "running" | "success" | "error";
  startedAt: string;
  completedAt: string | null;
  summary: string;
  error: string | null;
};

type JobInfo = {
  id: string;
  name: string;
  intervalDescription: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  isRunning: boolean;
};

/**
 * Live refresh tests.
 *
 * These intentionally trigger real background work against a live Hubarr
 * instance, then verify the open page updates without a browser reload.
 */

test.describe("Live refresh", () => {
  test.setTimeout(180_000);

  test("Dashboard recent syncs updates after a background collection sync starts and finishes", async ({ page, request }) => {
    const latestBefore = await getLatestRun(request, "publish");

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });

    const recentSyncsPanel = page.getByRole("link", { name: /recent syncs/i });
    await expect(recentSyncsPanel).toBeVisible();
    const panelTextBefore = await recentSyncsPanel.innerText();

    const triggerResponse = await request.post("/api/settings/jobs/collection-publish/run");
    expect(triggerResponse.ok()).toBe(true);

    const runningRun = await waitForNewRun(request, "publish", latestBefore?.startedAt ?? null, "running");
    const completedRun = await waitForRunCompletion(request, "publish", runningRun.startedAt);
    await expect(recentSyncsPanel).not.toHaveText(panelTextBefore, { timeout: 30_000 });
    await expect(recentSyncsPanel).toContainText("Publish", { timeout: 30_000 });
    await expect(recentSyncsPanel).toContainText("success", { timeout: 30_000 });
    await expect(recentSyncsPanel).toContainText(compactDashboardSummary(completedRun), { timeout: 30_000 });
  });

  test("History shows a new collection sync row move from running to its terminal status without reload", async ({ page, request }) => {
    const latestBefore = await getLatestRun(request, "publish");

    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });
    const firstRunRow = page.locator("div.space-y-2 > div").first();
    const firstRowTextBefore = await firstRunRow.innerText();

    const triggerResponse = await request.post("/api/settings/jobs/collection-publish/run");
    expect(triggerResponse.ok()).toBe(true);

    const runningRun = await waitForNewRun(request, "publish", latestBefore?.startedAt ?? null, "running");
    const completedRun = await waitForRunCompletion(request, "publish", runningRun.startedAt);
    await expect(firstRunRow).not.toHaveText(firstRowTextBefore, { timeout: 30_000 });
    await expect(firstRunRow).toContainText("Collection Sync", { timeout: 30_000 });
    await expect(firstRunRow).toContainText(completedRun.status, { timeout: 30_000 });
    await expect(firstRunRow).toContainText(stripHistorySummary(completedRun.summary), { timeout: 30_000 });
  });

  test("Jobs shows a scheduler-managed job running and then returning to Run Now after polling catches completion", async ({ page, request }) => {
    await page.goto("/settings?tab=jobs");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Loading jobs...")).not.toBeVisible({ timeout: 10_000 });

    const row = page.locator("tr", { hasText: "Collection Sync" });
    await expect(row).toBeVisible();

    const before = await getJob(request, "collection-publish");
    await row.getByRole("button", { name: "Run Now", exact: true }).click();

    await expect(row.getByRole("button", { name: "Running...", exact: true })).toBeVisible({ timeout: 10_000 });

    await waitForJobRunningState(request, "collection-publish", true);
    const completedJob = await waitForJobCompletion(request, "collection-publish", before?.lastRunAt ?? null);

    await expect(row.getByRole("button", { name: "Run Now", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(completedJob.lastRunStatus ?? "success", { timeout: 30_000 });
  });
});

async function getLatestRun(request: APIRequestContext, kind: SyncRun["kind"]): Promise<SyncRun | null> {
  const response = await request.get(`/api/history?page=1&pageSize=10&kind=${kind}&status=all`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { results: SyncRun[] };
  return body.results[0] ?? null;
}

async function waitForNewRun(
  request: APIRequestContext,
  kind: SyncRun["kind"],
  previousStartedAt: string | null,
  expectedStatus: SyncRun["status"]
): Promise<SyncRun> {
  await expect.poll(async () => {
    const run = await getLatestRun(request, kind);
    if (!run || run.startedAt === previousStartedAt) {
      return null;
    }
    return run.status;
  }, { timeout: 30_000 }).toBe(expectedStatus);

  const run = await getLatestRun(request, kind);
  if (!run || run.startedAt === previousStartedAt) {
    throw new Error(`Expected a new ${kind} run to appear.`);
  }
  return run;
}

async function waitForRunCompletion(
  request: APIRequestContext,
  kind: SyncRun["kind"],
  startedAt: string
): Promise<SyncRun> {
  await expect.poll(async () => {
    const run = await getLatestRun(request, kind);
    if (!run || run.startedAt !== startedAt) {
      return null;
    }
    return run.status === "running" ? null : run.status;
  }, { timeout: 180_000 }).not.toBeNull();

  const run = await getLatestRun(request, kind);
  if (!run || run.startedAt !== startedAt || run.status === "running") {
    throw new Error(`Expected ${kind} run ${startedAt} to complete.`);
  }
  return run;
}

async function getJob(request: APIRequestContext, jobId: string): Promise<JobInfo | null> {
  const response = await request.get("/api/settings/jobs");
  expect(response.ok()).toBe(true);
  const jobs = await response.json() as JobInfo[];
  return jobs.find((job) => job.id === jobId) ?? null;
}

async function waitForJobRunningState(request: APIRequestContext, jobId: string, expectedRunning: boolean): Promise<void> {
  await expect.poll(async () => {
    const job = await getJob(request, jobId);
    return job?.isRunning ?? null;
  }, { timeout: 30_000 }).toBe(expectedRunning);
}

async function waitForJobCompletion(request: APIRequestContext, jobId: string, previousLastRunAt: string | null): Promise<JobInfo> {
  await waitForJobRunningState(request, jobId, false);

  await expect.poll(async () => {
    const job = await getJob(request, jobId);
    if (!job) return null;
    if (job.lastRunAt === null || job.lastRunAt === previousLastRunAt) {
      return null;
    }
    return job.lastRunStatus;
  }, { timeout: 180_000 }).not.toBeNull();

  const job = await getJob(request, jobId);
  if (!job || job.lastRunAt === null || job.lastRunAt === previousLastRunAt) {
    throw new Error(`Expected job ${jobId} to record a new completion.`);
  }
  return job;
}

function compactDashboardSummary(run: SyncRun): string {
  if (run.kind === "full" || run.kind === "publish") {
    const partial = run.summary.match(/(\d+\/\d+) users? succeeded/i);
    if (partial) return `${partial[1]} Users`;

    const full = run.summary.match(/for (\d+) users?/i);
    if (full) return `${full[1]} Users`;
  }

  return "Running";
}

function stripHistorySummary(summary: string): string {
  return summary.replace(/^(RSS sync|Full sync|Manual sync|Collection publish|Collection sync)[:\s]*/i, "").trim();
}
