import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";

interface Migration {
  version: number;
  up(db: Database.Database): void;
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
          last_sync_error TEXT,
          collection_sort_order_override TEXT
        );

        CREATE TABLE managed_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_user_id TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          has_restriction_profile INTEGER NOT NULL DEFAULT 0
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
          discover_key TEXT,
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

        INSERT INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
        VALUES ('activity-cache-fetch', NULL, NULL, datetime('now'));

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE watchlist_activity_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_item_id TEXT NOT NULL,
          plex_user_id TEXT NOT NULL,
          watchlisted_at TEXT NOT NULL,
          UNIQUE(plex_item_id, plex_user_id)
        );

        CREATE INDEX idx_wac_item_user ON watchlist_activity_cache(plex_item_id, plex_user_id);

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
        CREATE INDEX idx_media_item_identifiers_value
          ON media_item_identifiers(identifier_value);

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
        CREATE INDEX idx_user_identifier_aliases_value
          ON user_identifier_aliases(identifier_value);

        CREATE TABLE seerr_user_links (
          user_id INTEGER PRIMARY KEY,
          manual_seerr_user_id INTEGER,
          auto_matched_seerr_user_id INTEGER,
          effective_seerr_user_id INTEGER,
          mapping_status TEXT NOT NULL DEFAULT 'unlinked',
          auto_request_enabled INTEGER,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE seerr_request_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          plex_item_id TEXT NOT NULL,
          seerr_request_id INTEGER,
          seerr_media_id INTEGER,
          tmdb_id INTEGER,
          last_attempted_at TEXT,
          outcome TEXT,
          last_error TEXT,
          effective_seerr_user_id INTEGER,
          execution_seerr_user_id INTEGER,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, plex_item_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_seerr_request_state_user_id
          ON seerr_request_state(user_id);
        CREATE INDEX idx_seerr_request_state_plex_item_id
          ON seerr_request_state(plex_item_id);
      `);
    }
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE sync_runs
          ADD COLUMN activity TEXT NOT NULL DEFAULT 'unknown'
            CHECK(activity IN ('changes', 'no_changes', 'unknown'));
      `);
    }
  }
];

export function runMigrations(db: Database.Database, logger?: Logger): void {
  let currentVersion = db.pragma("user_version", { simple: true }) as number;

  const latestVersion = migrations[migrations.length - 1]?.version ?? 0;
  if (currentVersion >= latestVersion) {
    logger?.debug("Database schema is up to date", { version: currentVersion });
    return;
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    logger?.info("Applying database migration", { from: currentVersion, to: migration.version });
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    logger?.info("Database migration applied", { version: migration.version });
    currentVersion = migration.version;
  }
}
