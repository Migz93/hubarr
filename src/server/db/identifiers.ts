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

  db.prepare(`
    INSERT INTO media_items (canonical_plex_item_id, media_type)
    VALUES (?, ?)
    ON CONFLICT(canonical_plex_item_id) DO UPDATE SET
      media_type = excluded.media_type
  `).run(canonicalPlexItemId, item.type);

  const existing = db
    .prepare("SELECT id FROM media_items WHERE canonical_plex_item_id = ?")
    .get(canonicalPlexItemId) as { id: number } | undefined;
  if (!existing) return;

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
    stmt.run(existing.id, inferMediaIdentifierType(identifier), identifier);
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
