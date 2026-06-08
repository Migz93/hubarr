import assert from "node:assert/strict";
import test from "node:test";
import type { UserRecord } from "../../src/shared/types.js";
import { HubarrServices } from "../../src/server/services.js";
import type { ImageCacheService } from "../../src/server/image-cache.js";
import { createTestDatabase } from "./test-db.js";
import { createCapturingLogger } from "./test-helpers.js";

function createUser(db: ReturnType<typeof createTestDatabase>["db"]): UserRecord {
  db.upsertUsers([{ plexUserId: "plex-1", username: "alex", displayName: "Alex", avatarUrl: null }]);
  const user = db.listUsers()[0];
  assert.ok(user);
  return db.updateUser(user.id, { enabled: true });
}

function createPlexMock() {
  const calls = {
    syncIsolationFilters: 0
  };

  return {
    calls,
    createCollectionLabel(username: string) {
      return `hubarr:${username}`;
    },
    async syncIsolationFilters() {
      calls.syncIsolationFilters += 1;
      return { updated: 1, skipped: 0 };
    }
  };
}

function createService() {
  const { logger } = createCapturingLogger();
  const { db, cleanup } = createTestDatabase();
  const service = new HubarrServices(db, logger, {} as ImageCacheService) as unknown as {
    applyIsolationFilters: (enabledUsers: UserRecord[], runId: number, force?: boolean, plex?: unknown) => Promise<string | null>;
  };

  return { db, service, cleanup };
}

test("scheduled isolation filters skip when isolation inputs are unchanged", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const plex = createPlexMock();
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.applyIsolationFilters([user], runId, false, plex);
    await service.applyIsolationFilters([user], runId, false, plex);

    assert.equal(plex.calls.syncIsolationFilters, 1);

    const run = db.getSyncRunWithItems(runId);
    assert.ok(run);
    const applied = run.items.find((item) => item.action === "isolation.filters");
    const skipped = run.items.find((item) => item.action === "isolation.filters.skipped");
    assert.ok(applied);
    assert.ok(skipped);
    assert.equal((skipped.details as { reason: string }).reason, "inputs-unchanged");
  } finally {
    cleanup();
  }
});

test("forced isolation filters run even when isolation inputs are unchanged", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const plex = createPlexMock();
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.applyIsolationFilters([user], runId, false, plex);
    await service.applyIsolationFilters([user], runId, true, plex);

    assert.equal(plex.calls.syncIsolationFilters, 2);

    const run = db.getSyncRunWithItems(runId);
    assert.ok(run);
    const appliedItems = run.items.filter((item) => item.action === "isolation.filters");
    assert.equal(appliedItems.length, 2);
    assert.equal((appliedItems[1]?.details as { forced: boolean }).forced, true);
  } finally {
    cleanup();
  }
});

test("scheduled isolation filters rerun when label inputs change", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const renamedUser = { ...user, username: "alex-renamed" };
    const plex = createPlexMock();
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.applyIsolationFilters([user], runId, false, plex);
    await service.applyIsolationFilters([renamedUser], runId, false, plex);

    assert.equal(plex.calls.syncIsolationFilters, 2);
  } finally {
    cleanup();
  }
});

test("isolation filters rerun after reset clears stored state", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const plex = createPlexMock();
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.applyIsolationFilters([user], runId, false, plex);
    db.clearIsolationFilterState();
    await service.applyIsolationFilters([user], runId, false, plex);

    assert.equal(plex.calls.syncIsolationFilters, 2);
  } finally {
    cleanup();
  }
});

test("isolation filters rerun after a failed sync clears stored state", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const failOnce = { shouldFail: true };
    const calls = { syncIsolationFilters: 0 };
    const plex = {
      createCollectionLabel(username: string) { return `hubarr:${username}`; },
      async syncIsolationFilters() {
        calls.syncIsolationFilters += 1;
        if (failOnce.shouldFail) {
          failOnce.shouldFail = false;
          throw new Error("Plex API error");
        }
        return { updated: 1, skipped: 0 };
      }
    };
    const runId = db.createSyncRun("publish", "Collection sync started.");

    const failure = await service.applyIsolationFilters([user], runId, false, plex);
    assert.equal(failure, "Plex API error");
    assert.equal(calls.syncIsolationFilters, 1);

    // State should be cleared on error so the next run retries
    await service.applyIsolationFilters([user], runId, false, plex);
    assert.equal(calls.syncIsolationFilters, 2);
  } finally {
    cleanup();
  }
});

test("collection sync run is marked error when isolation filters fail", async () => {
  const { logger } = createCapturingLogger();
  const { db, cleanup } = createTestDatabase();
  const service = new HubarrServices(db, logger, {} as ImageCacheService) as unknown as {
    runPublishPass: (force?: boolean) => Promise<{ id: number; status: string; error: string | null }>;
    publishUserCollections: () => Promise<string[]>;
    getPlexIntegration: () => unknown;
  };

  try {
    const user = createUser(db);
    db.updateAppSettings({
      defaultMovieLibraryId: "movies",
      defaultShowLibraryId: "shows"
    });
    service.publishUserCollections = async () => [];
    service.getPlexIntegration = () => ({
      createCollectionLabel(username: string) { return `hubarr:${username}`; },
      async syncIsolationFilters() {
        throw new Error("Plex API error");
      }
    });

    const run = await service.runPublishPass(false);

    assert.equal(run.status, "error");
    assert.equal(run.error, "Isolation filters: Plex API error");
    const detail = db.getSyncRunWithItems(run.id);
    assert.ok(detail);
    assert.ok(detail.items.some((item) => item.action === "isolation.filters" && item.status === "error"));
    assert.equal(db.getUser(user.id)?.lastSyncError, null);
  } finally {
    cleanup();
  }
});

test("scheduled isolation filters rerun when effective visibility inputs change", async () => {
  const { db, service, cleanup } = createService();

  try {
    const user = createUser(db);
    const sharedHomeUser = {
      ...user,
      visibilityOverride: {
        recommended: false,
        home: true,
        shared: true
      }
    };
    const plex = createPlexMock();
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.applyIsolationFilters([user], runId, false, plex);
    await service.applyIsolationFilters([sharedHomeUser], runId, false, plex);

    assert.equal(plex.calls.syncIsolationFilters, 2);
  } finally {
    cleanup();
  }
});
