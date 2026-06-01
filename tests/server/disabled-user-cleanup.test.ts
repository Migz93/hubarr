import assert from "node:assert/strict";
import test from "node:test";
import type { UserRecord } from "../../src/shared/types.js";
import { HubarrServices } from "../../src/server/services.js";
import type { ImageCacheService } from "../../src/server/image-cache.js";
import { createTestDatabase } from "./test-db.js";
import { createCapturingLogger } from "./test-helpers.js";

type CleanupResult = {
  users: number;
  deleted: number;
  failed: number;
  localRecordsDeleted: number;
};

type CleanupCapableService = {
  cleanupDisabledUserCollections(users: UserRecord[]): Promise<CleanupResult>;
  getPlexIntegration: () => unknown;
};

function createUser(
  db: ReturnType<typeof createTestDatabase>["db"],
  plexUserId: string,
  username: string,
  displayName: string
): UserRecord {
  db.upsertUsers([{ plexUserId, username, displayName, avatarUrl: null }]);
  const user = db.listUsers().find((candidate) => candidate.plexUserId === plexUserId);
  assert.ok(user);
  return db.updateUser(user.id, { enabled: true });
}

function addCollectionRecord(
  db: ReturnType<typeof createTestDatabase>["db"],
  userId: number,
  mediaType: "movie" | "show",
  collectionRatingKey: string
): void {
  db.upsertCollectionRecord(userId, mediaType, {
    collectionRatingKey,
    visibleName: `${mediaType} collection`,
    labelName: `hubarr:${userId}`,
    hubIdentifier: null,
    lastSyncedHash: "hash",
    lastSyncedAt: "2026-06-01T00:00:00.000Z",
    lastSyncError: null
  });
}

function createService(plex: unknown) {
  const { logger, entries } = createCapturingLogger();
  const { db, cleanup } = createTestDatabase();
  const service = new HubarrServices(db, logger, {} as ImageCacheService) as unknown as CleanupCapableService;
  service.getPlexIntegration = () => plex;
  return { db, service, cleanup, entries };
}

test("disabled-user cleanup deletes DB-tracked and exact-label orphaned Plex collections", async () => {
  const deleted: string[] = [];
  const plex = {
    createCollectionLabel(username: string) {
      return `hubarr:${username}-watchlist`;
    },
    async getLibraries() {
      return [{ key: "movies", title: "Movies", type: "movie" as const }];
    },
    async getCollections() {
      return [
        { ratingKey: "orphan-alex", title: "Renamed Alex Watchlist" },
        { ratingKey: "other-user", title: "Other Watchlist" },
        { ratingKey: "near-match", title: "Near Match" }
      ];
    },
    async getCollectionLabels(ratingKey: string) {
      return {
        "orphan-alex": ["hubarr:alex-watchlist"],
        "other-user": ["hubarr:bob-watchlist"],
        "near-match": ["hubarr:alex-watchlist-extra"]
      }[ratingKey] ?? [];
    },
    async deleteCollection(ratingKey: string) {
      deleted.push(ratingKey);
    }
  };
  const { db, service, cleanup } = createService(plex);

  try {
    const alex = createUser(db, "plex-alex", "alex", "Alex");
    const bob = createUser(db, "plex-bob", "bob", "Bob");
    addCollectionRecord(db, alex.id, "movie", "tracked-alex");
    addCollectionRecord(db, bob.id, "movie", "tracked-bob");
    db.saveIsolationFilterState("unchanged-inputs");

    const result = await service.cleanupDisabledUserCollections([alex]);

    assert.deepEqual(deleted.sort(), ["orphan-alex", "tracked-alex"]);
    assert.equal(result.deleted, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.localRecordsDeleted, 1);
    assert.deepEqual(db.listCollections().map((collection) => collection.collectionRatingKey), ["tracked-bob"]);
    assert.equal(db.getIsolationFilterState(), null);
  } finally {
    cleanup();
  }
});

test("disabled-user cleanup only clears local DB records and isolation state when Plex is not configured", async () => {
  const { db, service, cleanup } = createService(null);
  service.getPlexIntegration = () => {
    throw new Error("Plex is not configured yet.");
  };

  try {
    const alex = createUser(db, "plex-alex", "alex", "Alex");
    addCollectionRecord(db, alex.id, "movie", "tracked-alex");
    db.saveIsolationFilterState("some-inputs");

    const result = await service.cleanupDisabledUserCollections([alex]);

    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.localRecordsDeleted, 1);
    assert.equal(db.listCollections().length, 0);
    assert.equal(db.getIsolationFilterState(), null);
  } finally {
    cleanup();
  }
});

test("disabled-user cleanup falls back to DB-only when getLibraries throws", async () => {
  const deleted: string[] = [];
  const plex = {
    createCollectionLabel(username: string) {
      return `hubarr:${username}-watchlist`;
    },
    async getLibraries(): Promise<never> {
      throw new Error("Plex unreachable");
    },
    async getCollections() {
      return [];
    },
    async getCollectionLabels() {
      return [];
    },
    async deleteCollection(ratingKey: string) {
      deleted.push(ratingKey);
    }
  };
  const { db, service, cleanup, entries } = createService(plex);

  try {
    const alex = createUser(db, "plex-alex", "alex", "Alex");
    addCollectionRecord(db, alex.id, "movie", "tracked-alex");

    const result = await service.cleanupDisabledUserCollections([alex]);

    // DB-tracked collection deleted even though library scan was skipped.
    assert.deepEqual(deleted, ["tracked-alex"]);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.localRecordsDeleted, 1);
    assert.equal(db.listCollections().length, 0);
    assert.ok(entries.some((entry) => entry.level === "warn" && entry.message.includes("Could not list Plex libraries")));
  } finally {
    cleanup();
  }
});

test("disabled-user cleanup scans Plex collections once for a bulk user cleanup", async () => {
  const calls = {
    getCollections: 0,
    getCollectionLabels: 0
  };
  const deleted: string[] = [];
  const plex = {
    createCollectionLabel(username: string) {
      return `hubarr:${username}-watchlist`;
    },
    async getLibraries() {
      return [{ key: "movies", title: "Movies", type: "movie" as const }];
    },
    async getCollections() {
      calls.getCollections += 1;
      return [
        { ratingKey: "orphan-alex", title: "Alex Watchlist" },
        { ratingKey: "orphan-bob", title: "Bob Watchlist" }
      ];
    },
    async getCollectionLabels(ratingKey: string) {
      calls.getCollectionLabels += 1;
      return {
        "orphan-alex": ["hubarr:alex-watchlist"],
        "orphan-bob": ["hubarr:bob-watchlist"]
      }[ratingKey] ?? [];
    },
    async deleteCollection(ratingKey: string) {
      deleted.push(ratingKey);
    }
  };
  const { db, service, cleanup } = createService(plex);

  try {
    const alex = createUser(db, "plex-alex", "alex", "Alex");
    const bob = createUser(db, "plex-bob", "bob", "Bob");

    await service.cleanupDisabledUserCollections([alex, bob]);

    assert.equal(calls.getCollections, 1);
    assert.equal(calls.getCollectionLabels, 2);
    assert.deepEqual(deleted.sort(), ["orphan-alex", "orphan-bob"]);
  } finally {
    cleanup();
  }
});

test("disabled-user cleanup logs deletion failures and continues with other users", async () => {
  const deleted: string[] = [];
  const plex = {
    createCollectionLabel(username: string) {
      return `hubarr:${username}-watchlist`;
    },
    async getLibraries() {
      return [];
    },
    async getCollections() {
      return [];
    },
    async getCollectionLabels() {
      return [];
    },
    async deleteCollection(ratingKey: string) {
      if (ratingKey === "tracked-alex") {
        throw new Error("delete failed");
      }
      deleted.push(ratingKey);
    }
  };
  const { db, service, cleanup, entries } = createService(plex);

  try {
    const alex = createUser(db, "plex-alex", "alex", "Alex");
    const bob = createUser(db, "plex-bob", "bob", "Bob");
    addCollectionRecord(db, alex.id, "movie", "tracked-alex");
    addCollectionRecord(db, bob.id, "movie", "tracked-bob");

    const result = await service.cleanupDisabledUserCollections([alex, bob]);

    assert.deepEqual(deleted, ["tracked-bob"]);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.localRecordsDeleted, 2);
    assert.equal(db.listCollections().length, 0);
    assert.ok(entries.some((entry) => entry.level === "error" && entry.message === "Could not delete Plex collection during disabled-user cleanup"));
  } finally {
    cleanup();
  }
});
