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
