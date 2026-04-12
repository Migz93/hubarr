import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubarrDatabase } from "../../src/server/db/index.js";
import type { RuntimeConfig } from "../../src/server/config.js";

function createTestDatabase(): { db: HubarrDatabase; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hubarr-dashboard-test-"));
  const config: RuntimeConfig = {
    port: 9301,
    dataDir,
    sessionSecret: "test-session-secret",
    sessionCookieName: "hubarr_session",
    sessionTtlMs: 1000 * 60 * 60,
    logLevel: "error"
  };

  return {
    db: new HubarrDatabase(config),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true })
  };
}

test("buildDashboard merges duplicate watchlist items that share GUIDs", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      {
        plexUserId: "plex-user-1",
        username: "alice",
        displayName: "Alice",
        avatarUrl: null
      },
      {
        plexUserId: "plex-user-2",
        username: "bob",
        displayName: "Bob",
        avatarUrl: null
      }
    ]);

    const [alice, bob] = db.listUsers();
    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });

    const sharedGuids = ["imdb://tt1234567", "tmdb://42"];

    db.upsertWatchlistItem(alice.id, {
      plexItemId: "discover-42",
      title: "A Life of a King",
      type: "movie",
      year: 2013,
      releaseDate: "2013-06-01",
      thumb: null,
      guids: sharedGuids,
      discoverKey: "discover-42",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });

    db.upsertWatchlistItem(bob.id, {
      plexItemId: "plex://movie/abcdef",
      title: "A Life of a King",
      type: "movie",
      year: 2013,
      releaseDate: "2013-06-01",
      thumb: null,
      guids: sharedGuids,
      discoverKey: "discover-42",
      source: "graphql",
      addedAt: "2026-04-12T10:05:00.000Z",
      matchedRatingKey: "98765"
    });

    const dashboard = db.buildDashboard();

    assert.equal(dashboard.recentlyAdded.length, 1);
    assert.equal(dashboard.recentlyAdded[0]?.title, "A Life of a King");
    assert.equal(dashboard.recentlyAdded[0]?.users.length, 2);
    assert.equal(dashboard.recentlyAdded[0]?.addedAt, "2026-04-12T10:05:00.000Z");
    assert.equal(dashboard.recentlyAdded[0]?.plexAvailable, true);
    assert.equal(dashboard.stats.trackedMovies, 1);
    assert.equal(dashboard.stats.trackedShows, 0);
  } finally {
    cleanup();
  }
});
