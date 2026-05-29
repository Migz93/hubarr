import assert from "node:assert/strict";
import test from "node:test";
import type { WatchlistItem } from "../../src/shared/types.js";
import { HubarrServices } from "../../src/server/services.js";
import type { ImageCacheService } from "../../src/server/image-cache.js";
import { createTestDatabase } from "./test-db.js";
import { createCapturingLogger } from "./test-helpers.js";

function missingItem(id: string, title: string): WatchlistItem {
  return {
    plexItemId: id,
    title,
    type: "movie",
    year: 2026,
    releaseDate: "2026-01-01",
    thumb: null,
    guids: [`tmdb://${id.replace(/\D/g, "") || "1"}`],
    discoverKey: id,
    source: "graphql",
    addedAt: "2026-05-01T00:00:00.000Z",
    matchedRatingKey: null
  };
}

test("Seerr request work only counts linked users with automatic requests enabled", () => {
  const { db, cleanup } = createTestDatabase();
  const { logger } = createCapturingLogger();
  const service = new HubarrServices(db, logger, {} as ImageCacheService) as unknown as {
    buildSeerrRequestWork: (scope: { mode: "all"; triggeredBy: "manual" }) => Array<{
      user: { id: number; displayName: string };
      items: WatchlistItem[];
    }>;
  };

  try {
    db.saveSeerrSettings({
      enabled: true,
      baseUrl: "http://seerr:5055",
      apiKey: "test-key",
      autoRequestEnabled: false,
      useServiceAccount: false,
      serviceAccountSeerrUserId: null
    });
    db.upsertUsers([
      { plexUserId: "plex-1", username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-2", username: "bob", displayName: "Bob", avatarUrl: null },
      { plexUserId: "plex-3", username: "cara", displayName: "Cara", avatarUrl: null }
    ]);

    const [alice, bob, cara] = db.listUsers();
    assert.ok(alice);
    assert.ok(bob);
    assert.ok(cara);
    db.updateUser(alice.id, { enabled: true });
    db.updateUser(bob.id, { enabled: true });
    db.updateUser(cara.id, { enabled: true });

    db.upsertWatchlistItem(alice.id, missingItem("movie-101", "Alice Missing"));
    db.upsertWatchlistItem(bob.id, missingItem("movie-202", "Bob Missing"));
    db.upsertWatchlistItem(cara.id, missingItem("movie-303", "Cara Missing"));

    db.upsertSeerrUserLink({
      userId: alice.id,
      manualSeerrUserId: 1001,
      autoRequestEnabledOverride: true
    });
    db.upsertSeerrUserLink({
      userId: bob.id,
      manualSeerrUserId: 1002,
      autoRequestEnabledOverride: false
    });

    const work = service.buildSeerrRequestWork({ mode: "all", triggeredBy: "manual" });

    assert.equal(work.length, 1);
    assert.equal(work[0]?.user.id, alice.id);
    assert.equal(work[0]?.items.length, 1);
    assert.equal(work[0]?.items[0]?.title, "Alice Missing");
  } finally {
    cleanup();
  }
});
