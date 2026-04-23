import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageCacheService } from "../../src/server/image-cache.js";
import { createTestDatabase } from "./test-db.js";

test("maintenance tasks remove orphaned watchlist poster cache rows and preserve active caches", () => {
  const { db, cleanup } = createTestDatabase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hubarr-maintenance-test-"));

  try {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
    const imageCache = new ImageCacheService(dataDir, db, logger);
    const cacheDir = path.join(dataDir, "image-cache");

    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-user-2", username: "bob", displayName: "Bob", avatarUrl: null }
    ]);

    const [alice, bob] = db.listUsers();
    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });

    db.upsertWatchlistItem(alice.id, {
      plexItemId: "active-item",
      title: "Still Watched",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: "/library/metadata/1/thumb/1",
      guids: ["plex://movie/active-item"],
      discoverKey: "/library/metadata/1",
      source: "graphql",
      addedAt: "2026-04-13T10:00:00.000Z",
      matchedRatingKey: null
    });

    const orphanPosterFilePath = path.join(cacheDir, "orphan-poster.jpg");
    const activePosterFilePath = path.join(cacheDir, "active-poster.jpg");
    const avatarFilePath = path.join(cacheDir, "avatar.jpg");
    fs.writeFileSync(orphanPosterFilePath, "orphan-poster");
    fs.writeFileSync(activePosterFilePath, "active-poster");
    fs.writeFileSync(avatarFilePath, "avatar");

    db.upsertImageCacheEntry({
      cacheKey: "poster:removed-item",
      kind: "poster",
      entityId: "removed-item",
      sourceType: "plex-path",
      sourceValue: "/library/metadata/2/thumb/2",
      localFilePath: orphanPosterFilePath,
      localWebPath: "/images/orphan-poster.jpg",
      cachedAt: "2026-04-13T10:00:00.000Z",
      lastRefreshAt: "2026-04-13T10:00:00.000Z",
      refreshAfter: "2026-04-14T10:00:00.000Z"
    });

    db.upsertImageCacheEntry({
      cacheKey: "poster:active-item",
      kind: "poster",
      entityId: "active-item",
      sourceType: "plex-path",
      sourceValue: "/library/metadata/1/thumb/1",
      localFilePath: activePosterFilePath,
      localWebPath: "/images/active-poster.jpg",
      cachedAt: "2026-04-13T10:00:00.000Z",
      lastRefreshAt: "2026-04-13T10:00:00.000Z",
      refreshAfter: "2026-04-14T10:00:00.000Z"
    });

    db.upsertImageCacheEntry({
      cacheKey: "avatar:plex-user-1",
      kind: "avatar",
      entityId: "plex-user-1",
      sourceType: "public-url",
      sourceValue: "https://example.com/avatar.jpg",
      localFilePath: avatarFilePath,
      localWebPath: "/images/avatar.jpg",
      cachedAt: "2026-04-13T10:00:00.000Z",
      lastRefreshAt: "2026-04-13T10:00:00.000Z",
      refreshAfter: "2026-04-14T10:00:00.000Z"
    });

    const result = imageCache.runMaintenanceTasks();

    assert.deepEqual(result, {
      orphanedPosterRowsRemoved: 1,
      orphanedFilesRemoved: 1
    });
    assert.equal(db.getImageCacheEntry("poster:removed-item"), null);
    assert.notEqual(db.getImageCacheEntry("poster:active-item"), null);
    assert.notEqual(db.getImageCacheEntry("avatar:plex-user-1"), null);
    assert.equal(fs.existsSync(orphanPosterFilePath), false);
    assert.equal(fs.existsSync(activePosterFilePath), true);
    assert.equal(fs.existsSync(avatarFilePath), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    cleanup();
  }
});
