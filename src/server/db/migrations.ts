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
