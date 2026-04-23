import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-db.js";

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

test("buildDashboard resolves transitive GUID merge chains into one card", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-user-2", username: "bob", displayName: "Bob", avatarUrl: null },
      { plexUserId: "plex-user-3", username: "cara", displayName: "Cara", avatarUrl: null }
    ]);

    const [alice, bob, cara] = db.listUsers();
    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });
    db.updateUser(cara.id, { enabled: true });

    db.upsertWatchlistItem(alice.id, {
      plexItemId: "movie-a",
      title: "Chain Merge",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt1111111"],
      discoverKey: "movie-a",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(bob.id, {
      plexItemId: "movie-b",
      title: "Chain Merge",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt1111111", "tmdb://55"],
      discoverKey: "movie-b",
      source: "graphql",
      addedAt: "2026-04-12T10:05:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(cara.id, {
      plexItemId: "movie-c",
      title: "Chain Merge",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["tmdb://55"],
      discoverKey: "movie-c",
      source: "graphql",
      addedAt: "2026-04-12T10:10:00.000Z",
      matchedRatingKey: null
    });

    const dashboard = db.buildDashboard();

    assert.equal(dashboard.recentlyAdded.length, 1);
    assert.equal(dashboard.recentlyAdded[0]?.users.length, 3);
    assert.equal(dashboard.stats.trackedMovies, 1);
  } finally {
    cleanup();
  }
});

test("buildDashboard does not merge movie and show entries that share provider GUIDs", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-user-2", username: "bob", displayName: "Bob", avatarUrl: null }
    ]);

    const [alice, bob] = db.listUsers();
    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });

    db.upsertWatchlistItem(alice.id, {
      plexItemId: "movie-1",
      title: "Scoped Movie",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["tmdb://999"],
      discoverKey: "movie-1",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(bob.id, {
      plexItemId: "show-1",
      title: "Scoped Show",
      type: "show",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["tmdb://999"],
      discoverKey: "show-1",
      source: "graphql",
      addedAt: "2026-04-12T10:05:00.000Z",
      matchedRatingKey: null
    });

    const dashboard = db.buildDashboard();

    assert.equal(dashboard.recentlyAdded.length, 2);
    assert.equal(dashboard.stats.trackedMovies, 1);
    assert.equal(dashboard.stats.trackedShows, 1);
  } finally {
    cleanup();
  }
});
