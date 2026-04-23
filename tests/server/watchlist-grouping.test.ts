import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-db.js";

test("getWatchlistGrouped resolves transitive GUID merge chains into one item", () => {
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

    const watchlist = db.getWatchlistGrouped({ page: 1, pageSize: 20 });

    assert.equal(watchlist.items.length, 1);
    assert.equal(watchlist.items[0]?.users.length, 3);
    assert.equal(watchlist.total, 1);
    assert.equal(watchlist.facets.media.movie, 1);
  } finally {
    cleanup();
  }
});

test("getWatchlistGrouped does not merge movie and show entries that share provider GUIDs", () => {
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

    const watchlist = db.getWatchlistGrouped({ page: 1, pageSize: 20 });

    assert.equal(watchlist.items.length, 2);
    assert.equal(watchlist.facets.media.movie, 1);
    assert.equal(watchlist.facets.media.show, 1);
  } finally {
    cleanup();
  }
});

test("getWatchlistGrouped counts merged duplicates once in user facets and totals", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null }
    ]);

    const [alice] = db.listUsers();
    db.updateUser(alice.id, { enabled: true });

    db.upsertWatchlistItem(alice.id, {
      plexItemId: "movie-a",
      title: "Duplicate Merge",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt2222222"],
      discoverKey: "movie-a",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(alice.id, {
      plexItemId: "movie-b",
      title: "Duplicate Merge",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt2222222"],
      discoverKey: "movie-b",
      source: "graphql",
      addedAt: "2026-04-12T10:05:00.000Z",
      matchedRatingKey: null
    });

    const watchlist = db.getWatchlistGrouped({ page: 1, pageSize: 20 });

    assert.equal(watchlist.total, 1);
    assert.equal(watchlist.facets.allUsersCount, 1);
    assert.equal(watchlist.facets.users[0]?.count, 1);
    assert.equal(watchlist.items[0]?.userCount, 1);
  } finally {
    cleanup();
  }
});

test("getWatchlistGrouped uses deterministic item and user ordering for pagination", () => {
  const { db, cleanup } = createTestDatabase();

  try {
    db.upsertUsers([
      { plexUserId: "plex-user-2", username: "bob", displayName: "Bob", avatarUrl: null },
      { plexUserId: "plex-user-1", username: "alice", displayName: "Alice", avatarUrl: null }
    ]);

    const users = db.listUsers();
    const alice = users.find((user) => user.username === "alice");
    const bob = users.find((user) => user.username === "bob");
    assert.ok(alice);
    assert.ok(bob);

    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });

    db.upsertWatchlistItem(bob.id, {
      plexItemId: "z-item",
      title: "Same Time",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt9000001"],
      discoverKey: "z-item",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(alice.id, {
      plexItemId: "a-item",
      title: "Same Time",
      type: "movie",
      year: 2024,
      releaseDate: "2024-01-01",
      thumb: null,
      guids: ["imdb://tt9000002"],
      discoverKey: "a-item",
      source: "graphql",
      addedAt: "2026-04-12T10:00:00.000Z",
      matchedRatingKey: null
    });

    db.upsertWatchlistItem(bob.id, {
      plexItemId: "merge-a",
      title: "Merged Users",
      type: "movie",
      year: 2023,
      releaseDate: "2023-01-01",
      thumb: null,
      guids: ["imdb://tt9000003"],
      discoverKey: "merge-a",
      source: "graphql",
      addedAt: "2026-04-11T10:00:00.000Z",
      matchedRatingKey: null
    });
    db.upsertWatchlistItem(alice.id, {
      plexItemId: "merge-b",
      title: "Merged Users",
      type: "movie",
      year: 2023,
      releaseDate: "2023-01-01",
      thumb: null,
      guids: ["imdb://tt9000003"],
      discoverKey: "merge-b",
      source: "graphql",
      addedAt: "2026-04-11T10:00:00.000Z",
      matchedRatingKey: null
    });

    const watchlist = db.getWatchlistGrouped({ page: 1, pageSize: 20, sortBy: "added-desc" });

    assert.deepEqual(
      watchlist.items.map((item) => item.plexItemId),
      ["a-item", "z-item", "merge-a"]
    );
    assert.deepEqual(
      watchlist.items[2]?.users.map((user) => user.userId),
      [Math.min(alice.id, bob.id), Math.max(alice.id, bob.id)]
    );
  } finally {
    cleanup();
  }
});
