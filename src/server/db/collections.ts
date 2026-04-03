import type Database from "better-sqlite3";
import type { PlexCollectionRecord } from "../../shared/types.js";

export function upsertCollectionRecord(
  db: Database.Database,
  userId: number,
  mediaType: "movie" | "show",
  patch: Omit<PlexCollectionRecord, "id" | "userId" | "mediaType">
): void {
  db.prepare(`
    INSERT INTO plex_collections (
      user_id, media_type, collection_rating_key, visible_name, label_name,
      hub_identifier, last_synced_hash, last_synced_at, last_sync_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, media_type) DO UPDATE SET
      collection_rating_key = excluded.collection_rating_key,
      visible_name = excluded.visible_name,
      label_name = excluded.label_name,
      hub_identifier = excluded.hub_identifier,
      last_synced_hash = excluded.last_synced_hash,
      last_synced_at = excluded.last_synced_at,
      last_sync_error = excluded.last_sync_error
  `).run(
    userId,
    mediaType,
    patch.collectionRatingKey,
    patch.visibleName,
    patch.labelName,
    patch.hubIdentifier,
    patch.lastSyncedHash,
    patch.lastSyncedAt,
    patch.lastSyncError
  );
}

export function listCollections(db: Database.Database): PlexCollectionRecord[] {
  return db
    .prepare(`
      SELECT id, user_id AS userId, media_type AS mediaType, collection_rating_key AS collectionRatingKey,
             visible_name AS visibleName, label_name AS labelName, hub_identifier AS hubIdentifier,
             last_synced_hash AS lastSyncedHash, last_synced_at AS lastSyncedAt, last_sync_error AS lastSyncError
      FROM plex_collections ORDER BY user_id, media_type
    `)
    .all() as PlexCollectionRecord[];
}

export function clearCollections(db: Database.Database): void {
  db.prepare("DELETE FROM plex_collections").run();
}
