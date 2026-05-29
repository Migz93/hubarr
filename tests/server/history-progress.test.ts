import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-db.js";

test("updateSyncRunSummary refreshes the live history summary for running syncs", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    const runId = db.createSyncRun("full", "Full sync started.");

    db.updateSyncRunSummary(runId, "Full sync: working on Alice (1/3).");

    const run = db.listSyncRuns(1)[0];
    assert.equal(run?.summary, "Full sync: working on Alice (1/3).");
    assert.equal(run?.status, "running");

    db.completeSyncRun(runId, "success", "Full sync finished for 3 users.", null);
    db.updateSyncRunSummary(runId, "Full sync: working on Bob (2/3).");

    const completedRun = db.listSyncRuns(1)[0];
    assert.equal(completedRun?.summary, "Full sync finished for 3 users.");
    assert.equal(completedRun?.status, "success");
  } finally {
    cleanup();
  }
});

test("history activity filtering separates changes from no-change success runs", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    const changesRunId = db.createSyncRun("rss", "RSS sync started.");
    db.completeSyncRun(changesRunId, "success", "RSS sync: 1 new item processed.", null, "changes");

    const noChangesRunId = db.createSyncRun("rss", "RSS sync started.");
    db.completeSyncRun(noChangesRunId, "success", "RSS sync: 0 new items.", null, "no_changes");

    const runningRunId = db.createSyncRun("publish", "Collection sync started.");
    const errorRunId = db.createSyncRun("full", "Full sync started.");
    db.completeSyncRun(errorRunId, "error", "Full sync failed.", "Boom");

    const changes = db.listSyncRunsPaginated({ page: 1, pageSize: 10, activity: "changes" }).results;
    assert.deepEqual(
      changes.map((run) => run.id).sort((a, b) => a - b),
      [changesRunId, runningRunId, errorRunId].sort((a, b) => a - b)
    );

    const noChanges = db.listSyncRunsPaginated({ page: 1, pageSize: 10, activity: "no_changes" }).results;
    assert.deepEqual(noChanges.map((run) => run.id), [noChangesRunId]);

    const all = db.listSyncRunsPaginated({ page: 1, pageSize: 10, activity: "all" }).results;
    assert.equal(all.length, 4);
  } finally {
    cleanup();
  }
});
