import type Database from "better-sqlite3";

interface Migration {
  version: number;
  up(db: Database.Database): void;
}

const v1Tables = [
  "settings",
  "users",
  "watchlist_cache",
  "plex_collections",
  "sync_runs",
  "sync_run_items",
  "job_run_state",
  "sessions"
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { 1: number } | undefined;

  return Boolean(row);
}

function inferSchemaVersion(db: Database.Database): number {
  if (v1Tables.every((table) => tableExists(db, table))) {
    return 1;
  }

  return 0;
}

function normalizeIdentifierValue(value: string): string {
  return value.trim().toLowerCase();
}

function inferUserIdentifierType(value: string): "plex_user" | "plex_numeric" | "plex_uuid" {
  if (/^\d+$/.test(value)) return "plex_numeric";
  if (/^[a-f0-9-]{32,36}$/i.test(value)) return "plex_uuid";
  return "plex_user";
}

function inferMediaIdentifierType(value: string): "plex_guid" | "discover_key" | "imdb" | "tmdb" | "tvdb" | "guid" {
  if (value.startsWith("plex://")) return "plex_guid";
  if (value.startsWith("/library/metadata/")) return "discover_key";
  if (value.startsWith("imdb://")) return "imdb";
  if (value.startsWith("tmdb://")) return "tmdb";
  if (value.startsWith("tvdb://")) return "tvdb";
  return "guid";
}

const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_user_id TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          display_name_override TEXT,
          avatar_url TEXT,
          is_self INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 0,
          movie_library_id TEXT,
          show_library_id TEXT,
          visibility_mode TEXT NOT NULL DEFAULT 'shared-home',
          visibility_override TEXT,
          collection_name_override TEXT,
          collection_name TEXT NOT NULL,
          last_synced_at TEXT,
          last_sync_error TEXT
        );

        CREATE TABLE watchlist_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          plex_item_id TEXT NOT NULL,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          year INTEGER,
          thumb TEXT,
          source TEXT NOT NULL,
          added_at TEXT NOT NULL,
          matched_rating_key TEXT,
          raw_payload TEXT NOT NULL,
          UNIQUE(user_id, plex_item_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE plex_collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          media_type TEXT NOT NULL,
          collection_rating_key TEXT,
          visible_name TEXT NOT NULL,
          label_name TEXT,
          hub_identifier TEXT,
          last_synced_hash TEXT,
          last_synced_at TEXT,
          last_sync_error TEXT,
          UNIQUE(user_id, media_type),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          summary TEXT NOT NULL,
          error TEXT
        );

        CREATE TABLE sync_run_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          user_id INTEGER,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES sync_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE job_run_state (
          job_id TEXT PRIMARY KEY,
          last_run_at TEXT,
          last_run_status TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE managed_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_user_id TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          has_restriction_profile INTEGER NOT NULL DEFAULT 0
        );
      `);
    }
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        ALTER TABLE watchlist_cache ADD COLUMN cached_thumb TEXT;
        ALTER TABLE users ADD COLUMN cached_avatar_url TEXT;
        ALTER TABLE managed_users ADD COLUMN cached_avatar_url TEXT;
      `);
    }
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        ALTER TABLE watchlist_cache DROP COLUMN cached_thumb;
        ALTER TABLE users DROP COLUMN cached_avatar_url;
        ALTER TABLE managed_users DROP COLUMN cached_avatar_url;

        CREATE TABLE image_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cache_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('poster', 'avatar')),
          entity_id TEXT NOT NULL,
          source_type TEXT CHECK(source_type IN ('plex-path', 'public-url')),
          source_value TEXT,
          local_file_path TEXT,
          local_web_path TEXT,
          cached_at TEXT,
          last_refresh_at TEXT,
          refresh_after TEXT,
          last_attempted_at TEXT,
          last_error TEXT
        );

        CREATE INDEX idx_image_cache_kind_entity ON image_cache(kind, entity_id);
      `);
    }
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE watchlist_activity_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_item_id TEXT NOT NULL,
          plex_user_id TEXT NOT NULL,
          watchlisted_at TEXT NOT NULL,
          UNIQUE(plex_item_id, plex_user_id)
        );

        CREATE INDEX idx_wac_item_user ON watchlist_activity_cache(plex_item_id, plex_user_id);

        INSERT OR IGNORE INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
        VALUES ('activity-cache-fetch', NULL, NULL, datetime('now'));
      `);
    }
  },
  {
    version: 6,
    up(db) {
      // Stores an optional per-user collection sort order override.
      // NULL means the user inherits the global collectionSortOrder setting.
      db.exec(`
        ALTER TABLE users ADD COLUMN collection_sort_order_override TEXT;
      `);
    }
  },
  {
    version: 7,
    up(db) {
      // Add a dedicated discover_key column to watchlist_cache so the
      // /library/metadata/<hex> form of each item's ID is queryable without
      // JSON-parsing raw_payload. Populated from raw_payload on migration.
      db.exec(`
        ALTER TABLE watchlist_cache ADD COLUMN discover_key TEXT;

        UPDATE watchlist_cache
        SET discover_key = json_extract(raw_payload, '$.discoverKey')
        WHERE discover_key IS NULL;
      `);

      // Normalise RSS item plex_item_ids that were stored as stableKeys
      // (e.g. "<userUUID>::imdb://...|tmdb://...") to the canonical plex://
      // GUID format used by all GraphQL items. The plex:// GUID is already
      // present in the raw_payload guids array after enrichment.
      //
      // If a row with the target plex:// ID already exists for the same user
      // (i.e. the item was also cached via GraphQL), the stale RSS row is
      // deleted to eliminate the duplicate. Otherwise the plex_item_id and
      // discover_key are updated in place.
      //
      // image_cache poster entries keyed on the old stableKey are updated or
      // removed to match.
      const rssRows = db.prepare(`
        SELECT id, user_id, plex_item_id, raw_payload
        FROM watchlist_cache
        WHERE plex_item_id NOT LIKE 'plex://%'
          AND source = 'rss'
      `).all() as Array<{ id: number; user_id: number; plex_item_id: string; raw_payload: string }>;

      const findExisting = db.prepare(
        "SELECT id FROM watchlist_cache WHERE user_id = ? AND plex_item_id = ?"
      );
      const updateRow = db.prepare(
        "UPDATE watchlist_cache SET plex_item_id = ?, discover_key = ? WHERE id = ?"
      );
      const deleteRow = db.prepare("DELETE FROM watchlist_cache WHERE id = ?");
      const updateImageCache = db.prepare(
        "UPDATE image_cache SET cache_key = ?, entity_id = ? WHERE cache_key = ?"
      );
      const deleteImageCache = db.prepare(
        "DELETE FROM image_cache WHERE cache_key = ?"
      );
      const checkImageCacheKey = db.prepare(
        "SELECT 1 FROM image_cache WHERE cache_key = ?"
      );

      db.transaction(() => {
        for (const row of rssRows) {
          let payload: { guids?: string[]; discoverKey?: string };
          try {
            payload = JSON.parse(row.raw_payload) as typeof payload;
          } catch {
            continue;
          }

          const plexGuid = payload.guids?.find((g) => g.startsWith("plex://"));
          if (!plexGuid) continue;

          const discoverKey = payload.discoverKey ?? null;
          const oldCacheKey = `poster:${row.plex_item_id}`;
          const newCacheKey = `poster:${plexGuid}`;

          const existing = findExisting.get(row.user_id, plexGuid) as { id: number } | undefined;
          if (existing) {
            // A canonical GraphQL row already exists — delete the stale RSS duplicate.
            deleteRow.run(row.id);
            deleteImageCache.run(oldCacheKey);
          } else {
            updateRow.run(plexGuid, discoverKey, row.id);
            if (checkImageCacheKey.get(newCacheKey)) {
              // The canonical poster key already exists (from a prior GraphQL fetch or a
              // sibling RSS row processed earlier in this loop) — drop the stale duplicate
              // rather than attempting a rename that would violate the UNIQUE constraint.
              deleteImageCache.run(oldCacheKey);
            } else {
              updateImageCache.run(newCacheKey, plexGuid, oldCacheKey);
            }
          }
        }
      })();

      // Clear the activity cache so it repopulates with normalised plex://
      // IDs on the next scheduled fetch (the fetcher now requests the guid
      // field and prefers it over the raw /library/metadata/ key).
      db.exec(`
        DELETE FROM watchlist_activity_cache;
        UPDATE job_run_state
        SET last_run_at = NULL, updated_at = datetime('now')
        WHERE job_id = 'activity-cache-fetch';
      `);
    }
  },
  {
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_plex_item_id TEXT NOT NULL UNIQUE,
          media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'show'))
        );

        CREATE TABLE media_item_identifiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          media_item_id INTEGER NOT NULL,
          identifier_type TEXT NOT NULL,
          identifier_value TEXT NOT NULL,
          UNIQUE(identifier_type, identifier_value),
          FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_media_item_identifiers_media_item_id
          ON media_item_identifiers(media_item_id);

        CREATE TABLE user_identifier_aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          identifier_type TEXT NOT NULL,
          identifier_value TEXT NOT NULL,
          UNIQUE(identifier_type, identifier_value),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_user_identifier_aliases_user_id
          ON user_identifier_aliases(user_id);
      `);

      const upsertMediaItem = db.prepare(`
        INSERT INTO media_items (canonical_plex_item_id, media_type)
        VALUES (?, ?)
        ON CONFLICT(canonical_plex_item_id) DO UPDATE SET
          media_type = excluded.media_type
      `);
      const findMediaItem = db.prepare(
        "SELECT id FROM media_items WHERE canonical_plex_item_id = ?"
      );
      const upsertMediaIdentifier = db.prepare(`
        INSERT INTO media_item_identifiers (media_item_id, identifier_type, identifier_value)
        VALUES (?, ?, ?)
        ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
          media_item_id = excluded.media_item_id
      `);
      const upsertUserAlias = db.prepare(`
        INSERT INTO user_identifier_aliases (user_id, identifier_type, identifier_value)
        VALUES (?, ?, ?)
        ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
          user_id = excluded.user_id
      `);

      const users = db.prepare("SELECT id, plex_user_id FROM users").all() as Array<{
        id: number;
        plex_user_id: string;
      }>;
      for (const user of users) {
        const normalized = normalizeIdentifierValue(user.plex_user_id);
        if (!normalized) continue;
        upsertUserAlias.run(user.id, inferUserIdentifierType(normalized), normalized);
      }

      const watchlistRows = db.prepare(`
        SELECT plex_item_id, type, discover_key, raw_payload
        FROM watchlist_cache
      `).all() as Array<{
        plex_item_id: string;
        type: "movie" | "show";
        discover_key: string | null;
        raw_payload: string;
      }>;

      db.transaction(() => {
        for (const row of watchlistRows) {
          const canonicalPlexItemId = normalizeIdentifierValue(row.plex_item_id);
          if (!canonicalPlexItemId) continue;

          upsertMediaItem.run(canonicalPlexItemId, row.type);
          const mediaItem = findMediaItem.get(canonicalPlexItemId) as { id: number } | undefined;
          if (!mediaItem) continue;

          const identifiers = new Set<string>([canonicalPlexItemId]);
          if (row.discover_key) {
            identifiers.add(normalizeIdentifierValue(row.discover_key));
          }

          try {
            const payload = JSON.parse(row.raw_payload) as { guids?: unknown[]; discoverKey?: string };
            if (typeof payload.discoverKey === "string" && payload.discoverKey.trim()) {
              identifiers.add(normalizeIdentifierValue(payload.discoverKey));
            }
            for (const guid of payload.guids ?? []) {
              if (typeof guid === "string" && guid.trim()) {
                identifiers.add(normalizeIdentifierValue(guid));
              }
            }
          } catch {
            // Keep the canonical item record even if the payload is not parseable.
          }

          for (const identifier of identifiers) {
            upsertMediaIdentifier.run(mediaItem.id, inferMediaIdentifierType(identifier), identifier);
          }
        }
      })();
    }
  },
  {
    version: 9,
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_identifier_aliases_value
          ON user_identifier_aliases(identifier_value);
        CREATE INDEX IF NOT EXISTS idx_media_item_identifiers_value
          ON media_item_identifiers(identifier_value);
      `);
    }
  }
];

export function runMigrations(db: Database.Database): void {
  let currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion === 0) {
    const inferredVersion = inferSchemaVersion(db);
    if (inferredVersion > 0) {
      db.pragma(`user_version = ${inferredVersion}`);
      currentVersion = inferredVersion;
    }
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
