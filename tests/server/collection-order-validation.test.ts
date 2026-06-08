import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionSortOrder, UserRecord, WatchlistItem } from "../../src/shared/types.js";
import { HubarrServices } from "../../src/server/services.js";
import type { ImageCacheService } from "../../src/server/image-cache.js";
import type { Logger } from "../../src/server/logger.js";
import { createTestDatabase } from "./test-db.js";
import { createCapturingLogger } from "./test-helpers.js";

function createMovie(plexItemId: string, title: string, releaseDate: string, matchedRatingKey: string): WatchlistItem {
  return {
    plexItemId,
    title,
    type: "movie",
    year: Number(releaseDate.slice(0, 4)),
    releaseDate,
    thumb: null,
    guids: [],
    discoverKey: plexItemId,
    source: "graphql",
    addedAt: `${releaseDate}T00:00:00.000Z`,
    matchedRatingKey
  };
}

function createPlexMock(options: {
  collectionOrder: string[];
  collectionExistsError?: Error;
  reorderAppliesOrder?: boolean;
}) {
  let collectionOrder = [...options.collectionOrder];
  let collectionExistsError = options.collectionExistsError;
  const calls = {
    collectionExists: 0,
    ensureCollection: 0,
    getCollectionItems: 0,
    reorderCollectionItems: 0,
    syncCollectionItems: 0
  };

  return {
    calls,
    setCollectionOrder(nextOrder: string[]) {
      collectionOrder = [...nextOrder];
    },
    setCollectionExistsError(error: Error | undefined) {
      collectionExistsError = error;
    },
    createCollectionLabel(username: string) {
      return `hubarr:${username}`;
    },
    async collectionExists() {
      calls.collectionExists += 1;
      if (collectionExistsError) {
        throw collectionExistsError;
      }
      return true;
    },
    async ensureCollection() {
      calls.ensureCollection += 1;
      return "collection-1";
    },
    async updateCollectionSortTitle() {},
    async updateCollectionContentSort() {},
    async syncCollectionItems(_collectionRatingKey: string, ratingKeys: string[]) {
      calls.syncCollectionItems += 1;
      const desired = new Set(ratingKeys);
      collectionOrder = [
        ...collectionOrder.filter((key) => desired.has(key)),
        ...ratingKeys.filter((key) => !collectionOrder.includes(key))
      ];
      return { staleKeys: new Set<string>() };
    },
    async reorderCollectionItems(_collectionRatingKey: string, orderedRatingKeys: string[]) {
      calls.reorderCollectionItems += 1;
      if (options.reorderAppliesOrder !== false) {
        collectionOrder = [...orderedRatingKeys];
      }
      return {
        staleKeys: new Set<string>(),
        converged: options.reorderAppliesOrder !== false,
        finalOrder: [...collectionOrder]
      };
    },
    async getCollectionItems() {
      calls.getCollectionItems += 1;
      return [...collectionOrder];
    },
    async applyLabelToCollection() {},
    async updateCollectionVisibility() {
      return "hub-1";
    }
  };
}

function createService(logger: Logger) {
  const { db, cleanup } = createTestDatabase();
  const service = new HubarrServices(db, logger, {} as ImageCacheService) as unknown as {
    publishUserCollections: (
      friend: UserRecord,
      items: WatchlistItem[],
      runId: number | null,
      force: boolean,
      plex: unknown
    ) => Promise<string[]>;
    applyCollectionPoster: () => Promise<void>;
  };
  service.applyCollectionPoster = async () => {};

  return { db, service, cleanup };
}

function createUser(db: ReturnType<typeof createTestDatabase>["db"], sortOrder: CollectionSortOrder) {
  db.updateAppSettings({
    collectionSortOrder: sortOrder,
    defaultMovieLibraryId: "movies",
    defaultShowLibraryId: null
  });
  db.upsertUsers([{ plexUserId: "plex-1", username: "alex", displayName: "Alex", avatarUrl: null }]);
  const user = db.listUsers()[0];
  assert.ok(user);
  return db.updateUser(user.id, { enabled: true });
}

test("custom collection sort republishes when stored hash matches but live order drifted", async () => {
  const { logger, entries } = createCapturingLogger();
  const { db, service, cleanup } = createService(logger);

  try {
    const user = createUser(db, "date-desc");
    const items = [
      createMovie("movie-new", "New Movie", "2026-01-01", "rk-new"),
      createMovie("movie-old", "Old Movie", "2024-01-01", "rk-old")
    ];
    const plex = createPlexMock({ collectionOrder: ["rk-new", "rk-old"] });

    await service.publishUserCollections(user, items, null, false, plex);
    assert.equal(plex.calls.ensureCollection, 1);

    plex.setCollectionOrder(["rk-old", "rk-new"]);
    await service.publishUserCollections(user, items, null, false, plex);

    assert.equal(plex.calls.ensureCollection, 2);
    assert.equal(plex.calls.reorderCollectionItems, 2);
    assert.deepEqual(await plex.getCollectionItems(), ["rk-new", "rk-old"]);
    assert.ok(entries.some((entry) => entry.message === "Collection item order differs from desired state, republishing"));
  } finally {
    cleanup();
  }
});

test("title collection sort still skips on hash match after existence validation", async () => {
  const { logger } = createCapturingLogger();
  const { service, db, cleanup } = createService(logger);

  try {
    const user = createUser(db, "title");
    const items = [
      createMovie("movie-new", "New Movie", "2026-01-01", "rk-new"),
      createMovie("movie-old", "Old Movie", "2024-01-01", "rk-old")
    ];
    const plex = createPlexMock({ collectionOrder: ["rk-old", "rk-new"] });
    const runId = db.createSyncRun("publish", "Collection sync started.");

    await service.publishUserCollections(user, items, null, false, plex);
    await service.publishUserCollections(user, items, runId, false, plex);

    assert.equal(plex.calls.collectionExists, 1);
    assert.equal(plex.calls.ensureCollection, 1);
    const run = db.getSyncRunWithItems(runId);
    assert.ok(run);
    const skippedItem = run.items.find((item) => item.action === "collection.publish.skipped");
    assert.ok(skippedItem);
    assert.deepEqual(skippedItem.details, {
      userId: user.id,
      displayName: "alex",
      mediaType: "movie",
      collectionName: "alexs Watchlist",
      collectionRatingKey: "collection-1",
      matchedItems: 2,
      reason: "state-unchanged"
    });
  } finally {
    cleanup();
  }
});

test("collection existence validation errors do not clear the stored collection key", async () => {
  const { logger, entries } = createCapturingLogger();
  const { service, db, cleanup } = createService(logger);

  try {
    const user = createUser(db, "title");
    const items = [
      createMovie("movie-new", "New Movie", "2026-01-01", "rk-new"),
      createMovie("movie-old", "Old Movie", "2024-01-01", "rk-old")
    ];
    const plex = createPlexMock({ collectionOrder: ["rk-old", "rk-new"] });
    const originalClearCollectionRatingKey = db.clearCollectionRatingKey.bind(db);
    let clearCollectionRatingKeyCalls = 0;
    db.clearCollectionRatingKey = ((userId, mediaType) => {
      clearCollectionRatingKeyCalls += 1;
      return originalClearCollectionRatingKey(userId, mediaType);
    }) as typeof db.clearCollectionRatingKey;

    await service.publishUserCollections(user, items, null, false, plex);
    plex.setCollectionExistsError(new Error("Plex temporarily unavailable"));
    await service.publishUserCollections(user, items, null, false, plex);

    assert.equal(plex.calls.collectionExists, 1);
    assert.equal(plex.calls.ensureCollection, 2);
    assert.equal(clearCollectionRatingKeyCalls, 0);
    assert.ok(entries.some((entry) => entry.message === "Could not validate collection existence, proceeding with full publish"));
  } finally {
    cleanup();
  }
});

test("custom collection sort leaves lastSyncedHash dirty when post-reorder order validation fails", async () => {
  const { logger, entries } = createCapturingLogger();
  const { service, db, cleanup } = createService(logger);

  try {
    const user = createUser(db, "date-desc");
    const items = [
      createMovie("movie-new", "New Movie", "2026-01-01", "rk-new"),
      createMovie("movie-old", "Old Movie", "2024-01-01", "rk-old")
    ];
    const plex = createPlexMock({
      collectionOrder: ["rk-old", "rk-new"],
      reorderAppliesOrder: false
    });

    await service.publishUserCollections(user, items, null, false, plex);

    const stored = db.getCollectionRecord(user.id, "movie");
    assert.ok(stored);
    assert.equal(stored.lastSyncedHash, null);
    assert.ok(entries.some((entry) => entry.message === "Collection item order still differs after reorder; leaving sync hash dirty"));
  } finally {
    cleanup();
  }
});

test("custom collection sort records a failed history item when bounded reorder does not converge", async () => {
  const { logger } = createCapturingLogger();
  const { service, db, cleanup } = createService(logger);

  try {
    const user = createUser(db, "date-desc");
    const items = [
      createMovie("movie-new", "New Movie", "2026-01-01", "rk-new"),
      createMovie("movie-old", "Old Movie", "2024-01-01", "rk-old")
    ];
    const plex = createPlexMock({
      collectionOrder: ["rk-old", "rk-new"],
      reorderAppliesOrder: false
    });
    const runId = db.createSyncRun("publish", "Collection sync started.");

    const failures = await service.publishUserCollections(user, items, runId, false, plex);
    const run = db.getSyncRunWithItems(runId);

    assert.equal(failures.length, 1);
    assert.ok(run);
    const failedItem = run.items.find((item) => item.action === "collection.publish" && item.status === "error");
    assert.ok(failedItem);
    assert.deepEqual(failedItem.details, {
      userId: user.id,
      displayName: "alex",
      mediaType: "movie",
      collectionName: "alexs Watchlist",
      collectionRatingKey: "collection-1",
      effectiveSortOrder: "date-desc",
      matchedItems: 2,
      reason: "reorder-did-not-converge",
      message: "Plex collection order does not match Hubarr's desired order after bounded reorder attempts.",
      expectedCount: 2,
      actualCount: 2,
      firstMismatchIndex: 0,
      expectedSample: ["rk-new", "rk-old"],
      actualSample: ["rk-old", "rk-new"]
    });
  } finally {
    cleanup();
  }
});
