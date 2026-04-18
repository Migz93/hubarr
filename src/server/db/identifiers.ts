import type Database from "better-sqlite3";
import type { WatchlistItem } from "../../shared/types.js";

type MediaIdentifierType = "plex_guid" | "discover_key" | "imdb" | "tmdb" | "tvdb" | "guid";
type UserIdentifierType = "plex_user" | "plex_numeric" | "plex_uuid";

function normalizeIdentifierValue(value: string): string {
  return value.trim().toLowerCase();
}

function inferMediaIdentifierType(value: string): MediaIdentifierType {
  if (value.startsWith("plex://")) return "plex_guid";
  if (value.startsWith("/library/metadata/")) return "discover_key";
  if (value.startsWith("imdb://")) return "imdb";
  if (value.startsWith("tmdb://")) return "tmdb";
  if (value.startsWith("tvdb://")) return "tvdb";
  return "guid";
}

function inferUserIdentifierType(value: string): UserIdentifierType {
  if (/^\d+$/.test(value)) return "plex_numeric";
  if (/^[a-f0-9-]{32,36}$/i.test(value)) return "plex_uuid";
  return "plex_user";
}

export function upsertUserIdentifierAlias(
  db: Database.Database,
  userId: number,
  identifierValue: string,
  identifierType?: UserIdentifierType
): void {
  const normalizedValue = normalizeIdentifierValue(identifierValue);
  if (!normalizedValue) return;

  db.prepare(`
    INSERT INTO user_identifier_aliases (user_id, identifier_type, identifier_value)
    VALUES (?, ?, ?)
    ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
      user_id = excluded.user_id
  `).run(userId, identifierType ?? inferUserIdentifierType(normalizedValue), normalizedValue);
}

export function upsertMediaItemIdentifiers(
  db: Database.Database,
  item: Pick<WatchlistItem, "plexItemId" | "type" | "guids" | "discoverKey">
): void {
  const canonicalPlexItemId = normalizeIdentifierValue(item.plexItemId);
  if (!canonicalPlexItemId) return;

  const mediaItem = db.prepare(`
    INSERT INTO media_items (canonical_plex_item_id, media_type)
    VALUES (?, ?)
    ON CONFLICT(canonical_plex_item_id) DO UPDATE SET
      media_type = excluded.media_type
    RETURNING id
  `).get(canonicalPlexItemId, item.type) as { id: number } | undefined;
  if (!mediaItem) return;

  const identifiers = new Set<string>([canonicalPlexItemId]);
  if (item.discoverKey) identifiers.add(normalizeIdentifierValue(item.discoverKey));
  for (const guid of item.guids ?? []) {
    if (typeof guid === "string" && guid.trim()) {
      identifiers.add(normalizeIdentifierValue(guid));
    }
  }

  const stmt = db.prepare(`
    INSERT INTO media_item_identifiers (media_item_id, identifier_type, identifier_value)
    VALUES (?, ?, ?)
    ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
      media_item_id = excluded.media_item_id
  `);

  for (const identifier of identifiers) {
    stmt.run(mediaItem.id, inferMediaIdentifierType(identifier), identifier);
  }
}

export function getDiscoverKeyForPlexItemId(db: Database.Database, plexItemId: string): string | null {
  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  const row = db.prepare(`
    WITH target_media AS (
      SELECT id
      FROM media_items
      WHERE canonical_plex_item_id = ?
      UNION
      SELECT media_item_id
      FROM media_item_identifiers
      WHERE identifier_value = ?
    )
    SELECT mii.identifier_value AS discoverKey
    FROM media_item_identifiers mii
    JOIN target_media tm ON tm.id = mii.media_item_id
    WHERE mii.identifier_type = 'discover_key'
    LIMIT 1
  `).get(normalizedPlexItemId, normalizedPlexItemId) as { discoverKey: string } | undefined;

  return row?.discoverKey ?? null;
}

export function getActivityCacheDateForUserItem(
  db: Database.Database,
  userId: number,
  plexItemId: string
): string | null {
  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  const row = db.prepare(`
    WITH target_media AS (
      SELECT id
      FROM media_items
      WHERE canonical_plex_item_id = ?
      UNION
      SELECT media_item_id
      FROM media_item_identifiers
      WHERE identifier_value = ?
    )
    SELECT wac.watchlisted_at AS watchlistedAt
    FROM watchlist_activity_cache wac
    JOIN user_identifier_aliases uia
      ON uia.user_id = ?
     AND uia.identifier_value = lower(wac.plex_user_id)
    WHERE EXISTS (
      SELECT 1
      FROM target_media tm
      JOIN media_item_identifiers mii ON mii.media_item_id = tm.id
      WHERE mii.identifier_value = lower(wac.plex_item_id)
    )
    ORDER BY wac.watchlisted_at DESC
    LIMIT 1
  `).get(normalizedPlexItemId, normalizedPlexItemId, userId) as { watchlistedAt: string } | undefined;

  return row?.watchlistedAt ?? null;
}

/**
 * Wraps multiple upsertMediaItemIdentifiers calls in a single transaction.
 * Batching the writes this way avoids an auto-commit round-trip per item,
 * which matters when pre-registering a full watchlist before the activity
 * cache lookup.
 */
export function batchUpsertMediaItemIdentifiers(
  db: Database.Database,
  items: Array<Pick<WatchlistItem, "plexItemId" | "type" | "guids" | "discoverKey">>
): void {
  const mediaSeeds = new Map<string, { mediaType: WatchlistItem["type"]; identifiers: Set<string> }>();

  for (const item of items) {
    const canonicalPlexItemId = normalizeIdentifierValue(item.plexItemId);
    if (!canonicalPlexItemId) continue;

    const existing = mediaSeeds.get(canonicalPlexItemId);
    const seed = existing ?? {
      mediaType: item.type,
      identifiers: new Set<string>()
    };

    seed.mediaType = item.type;
    seed.identifiers.add(canonicalPlexItemId);

    if (item.discoverKey) {
      const normalizedDiscoverKey = normalizeIdentifierValue(item.discoverKey);
      if (normalizedDiscoverKey) {
        seed.identifiers.add(normalizedDiscoverKey);
      }
    }

    for (const guid of item.guids ?? []) {
      if (typeof guid !== "string") continue;
      const normalizedGuid = normalizeIdentifierValue(guid);
      if (normalizedGuid) {
        seed.identifiers.add(normalizedGuid);
      }
    }

    mediaSeeds.set(canonicalPlexItemId, seed);
  }

  if (mediaSeeds.size === 0) return;

  db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_media_item_seed (
        canonical_plex_item_id TEXT PRIMARY KEY,
        media_type TEXT NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS temp_media_identifier_seed (
        canonical_plex_item_id TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        identifier_value TEXT NOT NULL,
        PRIMARY KEY (identifier_type, identifier_value)
      );
      DELETE FROM temp_media_item_seed;
      DELETE FROM temp_media_identifier_seed;
    `);

    const insertMediaSeed = db.prepare(`
      INSERT INTO temp_media_item_seed (canonical_plex_item_id, media_type)
      VALUES (?, ?)
      ON CONFLICT(canonical_plex_item_id) DO UPDATE SET
        media_type = excluded.media_type
    `);
    const insertIdentifierSeed = db.prepare(`
      INSERT INTO temp_media_identifier_seed (canonical_plex_item_id, identifier_type, identifier_value)
      VALUES (?, ?, ?)
      ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
        canonical_plex_item_id = excluded.canonical_plex_item_id
    `);

    for (const [canonicalPlexItemId, seed] of mediaSeeds) {
      insertMediaSeed.run(canonicalPlexItemId, seed.mediaType);
      for (const identifier of seed.identifiers) {
        insertIdentifierSeed.run(
          canonicalPlexItemId,
          inferMediaIdentifierType(identifier),
          identifier
        );
      }
    }

    db.prepare(`
      INSERT OR IGNORE INTO media_items (canonical_plex_item_id, media_type)
      SELECT canonical_plex_item_id, media_type
      FROM temp_media_item_seed
    `).run();

    db.prepare(`
      UPDATE media_items
      SET media_type = (
        SELECT seed.media_type
        FROM temp_media_item_seed seed
        WHERE seed.canonical_plex_item_id = media_items.canonical_plex_item_id
      )
      WHERE canonical_plex_item_id IN (
        SELECT canonical_plex_item_id
        FROM temp_media_item_seed
      )
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO media_item_identifiers (media_item_id, identifier_type, identifier_value)
      SELECT mi.id, seed.identifier_type, seed.identifier_value
      FROM temp_media_identifier_seed seed
      JOIN media_items mi ON mi.canonical_plex_item_id = seed.canonical_plex_item_id
    `).run();

    db.exec(`
      DELETE FROM temp_media_item_seed;
      DELETE FROM temp_media_identifier_seed;
    `);
  })();
}

/**
 * Bulk variant of getActivityCacheDateForUserItem. Returns a map of
 * normalized identifier value → best watchlisted_at for every media item
 * that has an activity cache entry for the given user. A single query
 * replaces the per-item loop that would otherwise run once per watchlist item.
 */
export function getActivityCacheDatesForUser(
  db: Database.Database,
  userId: number
): Map<string, string> {
  const rows = db.prepare(`
    WITH user_aliases AS (
      SELECT lower(identifier_value) AS plex_user_id
      FROM user_identifier_aliases
      WHERE user_id = ?
    ),
    user_cache AS (
      SELECT lower(plex_item_id) AS plex_item_id, watchlisted_at
      FROM watchlist_activity_cache
      WHERE lower(plex_user_id) IN (SELECT plex_user_id FROM user_aliases)
    ),
    media_via_identifier AS (
      SELECT mii.media_item_id, uce.watchlisted_at
      FROM user_cache uce
      JOIN media_item_identifiers mii ON mii.identifier_value = uce.plex_item_id
    ),
    media_via_canonical AS (
      SELECT mi.id AS media_item_id, uce.watchlisted_at
      FROM user_cache uce
      JOIN media_items mi ON mi.canonical_plex_item_id = uce.plex_item_id
    ),
    all_matched_media AS (
      SELECT media_item_id, watchlisted_at FROM media_via_identifier
      UNION ALL
      SELECT media_item_id, watchlisted_at FROM media_via_canonical
    ),
    all_lookup_keys AS (
      SELECT mii.identifier_value AS lookup_key, amm.watchlisted_at
      FROM all_matched_media amm
      JOIN media_item_identifiers mii ON mii.media_item_id = amm.media_item_id
      UNION ALL
      SELECT mi.canonical_plex_item_id AS lookup_key, amm.watchlisted_at
      FROM all_matched_media amm
      JOIN media_items mi ON mi.id = amm.media_item_id
    )
    SELECT lookup_key, MAX(watchlisted_at) AS watchlistedAt
    FROM all_lookup_keys
    GROUP BY lookup_key
  `).all(userId) as Array<{ lookup_key: string; watchlistedAt: string }>;

  return new Map(rows.map((r) => [r.lookup_key, r.watchlistedAt]));
}
