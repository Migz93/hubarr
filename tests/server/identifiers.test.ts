import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-db.js";

test("batchUpsertMediaItemIdentifiers seeds canonical, discover, and guid lookups for all items", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null }
    ]);

    const [alice] = db.listUsers();
    db.upsertUserIdentifierAlias(alice.id, "plex-user-1");

    db.batchUpsertMediaItemIdentifiers([
      {
        plexItemId: "movie-a",
        type: "movie",
        discoverKey: "/library/metadata/101",
        guids: ["imdb://tt1234567", "tmdb://101"]
      },
      {
        plexItemId: "show-a",
        type: "show",
        discoverKey: "/library/metadata/202",
        guids: ["tvdb://202", "plex://show/202"]
      }
    ]);

    db.upsertActivityCacheEntries([
      {
        plexItemId: "imdb://tt1234567",
        plexUserId: "plex-user-1",
        watchlistedAt: "2026-04-10T12:00:00.000Z"
      },
      {
        plexItemId: "tvdb://202",
        plexUserId: "plex-user-1",
        watchlistedAt: "2026-04-11T12:00:00.000Z"
      }
    ]);

    const dates = db.getActivityCacheDatesForUser(alice.id);

    assert.equal(dates.get("movie-a"), "2026-04-10T12:00:00.000Z");
    assert.equal(dates.get("/library/metadata/101"), "2026-04-10T12:00:00.000Z");
    assert.equal(dates.get("imdb://tt1234567"), "2026-04-10T12:00:00.000Z");
    assert.equal(dates.get("tmdb://101"), "2026-04-10T12:00:00.000Z");

    assert.equal(dates.get("show-a"), "2026-04-11T12:00:00.000Z");
    assert.equal(dates.get("/library/metadata/202"), "2026-04-11T12:00:00.000Z");
    assert.equal(dates.get("tvdb://202"), "2026-04-11T12:00:00.000Z");
    assert.equal(dates.get("plex://show/202"), "2026-04-11T12:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("countUnresolvedWatchlistDatesAfterActivityCache uses identifier aliases", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null }
    ]);

    const [alice] = db.listUsers();
    db.upsertUserIdentifierAlias(alice.id, "plex-user-1");

    db.replaceWatchlistItems(alice.id, [
      {
        plexItemId: "movie-a",
        title: "Movie A",
        type: "movie",
        year: 2026,
        releaseDate: "2026-01-01",
        thumb: null,
        guids: ["imdb://tt1234567"],
        discoverKey: "/library/metadata/101",
        source: "graphql",
        addedAt: "2001-01-01T00:00:00.000Z",
        matchedRatingKey: null
      },
      {
        plexItemId: "movie-b",
        title: "Movie B",
        type: "movie",
        year: 2026,
        releaseDate: "2026-02-01",
        thumb: null,
        guids: ["imdb://tt7654321"],
        discoverKey: "/library/metadata/102",
        source: "graphql",
        addedAt: "2001-01-01T00:00:00.000Z",
        matchedRatingKey: null
      }
    ]);
    db.batchUpsertMediaItemIdentifiers(db.getWatchlistItems(alice.id));

    assert.equal(db.countUnresolvedWatchlistDatesAfterActivityCache(alice.id), 2);

    db.upsertActivityCacheEntries([
      {
        plexItemId: "imdb://tt1234567",
        plexUserId: "plex-user-1",
        watchlistedAt: "2026-04-10T12:00:00.000Z"
      }
    ]);

    assert.equal(db.countUnresolvedWatchlistDatesAfterActivityCache(alice.id), 1);
  } finally {
    cleanup();
  }
});
