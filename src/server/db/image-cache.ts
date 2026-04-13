import type Database from "better-sqlite3";

export interface ImageCacheRow {
  id: number;
  cacheKey: string;
  kind: "poster" | "avatar";
  entityId: string;
  sourceType: "plex-path" | "public-url" | null;
  sourceValue: string | null;
  localFilePath: string | null;
  localWebPath: string | null;
  cachedAt: string | null;
  lastRefreshAt: string | null;
  refreshAfter: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
}

type RawRow = {
  id: number;
  cache_key: string;
  kind: "poster" | "avatar";
  entity_id: string;
  source_type: "plex-path" | "public-url" | null;
  source_value: string | null;
  local_file_path: string | null;
  local_web_path: string | null;
  cached_at: string | null;
  last_refresh_at: string | null;
  refresh_after: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
};

function mapRow(row: RawRow): ImageCacheRow {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    kind: row.kind,
    entityId: row.entity_id,
    sourceType: row.source_type,
    sourceValue: row.source_value,
    localFilePath: row.local_file_path,
    localWebPath: row.local_web_path,
    cachedAt: row.cached_at,
    lastRefreshAt: row.last_refresh_at,
    refreshAfter: row.refresh_after,
    lastAttemptedAt: row.last_attempted_at,
    lastError: row.last_error
  };
}

export function getImageCacheEntry(db: Database.Database, cacheKey: string): ImageCacheRow | null {
  const row = db
    .prepare(`
      SELECT id, cache_key, kind, entity_id, source_type, source_value,
             local_file_path, local_web_path, cached_at, last_refresh_at,
             refresh_after, last_attempted_at, last_error
      FROM image_cache WHERE cache_key = ?
    `)
    .get(cacheKey) as RawRow | undefined;

  return row ? mapRow(row) : null;
}

export function upsertImageCacheEntry(
  db: Database.Database,
  entry: {
    cacheKey: string;
    kind: "poster" | "avatar";
    entityId: string;
    sourceType: "plex-path" | "public-url" | null;
    sourceValue: string | null;
    localFilePath: string;
    localWebPath: string;
    cachedAt: string;
    lastRefreshAt: string;
    refreshAfter: string;
  }
): void {
  db.prepare(`
    INSERT INTO image_cache (
      cache_key, kind, entity_id, source_type, source_value,
      local_file_path, local_web_path, cached_at, last_refresh_at, refresh_after,
      last_attempted_at, last_error
    ) VALUES (
      @cacheKey, @kind, @entityId, @sourceType, @sourceValue,
      @localFilePath, @localWebPath, @cachedAt, @lastRefreshAt, @refreshAfter,
      @cachedAt, NULL
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      source_type = excluded.source_type,
      source_value = excluded.source_value,
      local_file_path = excluded.local_file_path,
      local_web_path = excluded.local_web_path,
      last_refresh_at = excluded.last_refresh_at,
      refresh_after = excluded.refresh_after,
      last_attempted_at = excluded.last_attempted_at,
      last_error = NULL
  `).run(entry);
}

export function markImageCacheRefreshAttempt(
  db: Database.Database,
  cacheKey: string,
  attemptedAt: string
): void {
  db.prepare(`
    UPDATE image_cache SET last_attempted_at = ? WHERE cache_key = ?
  `).run(attemptedAt, cacheKey);
}

export function markImageCacheRefreshSuccess(
  db: Database.Database,
  cacheKey: string,
  opts: {
    localFilePath: string;
    localWebPath: string;
    sourceType: "plex-path" | "public-url" | null;
    sourceValue: string | null;
    lastRefreshAt: string;
    refreshAfter: string;
  }
): void {
  db.prepare(`
    UPDATE image_cache SET
      local_file_path = @localFilePath,
      local_web_path = @localWebPath,
      source_type = @sourceType,
      source_value = @sourceValue,
      last_refresh_at = @lastRefreshAt,
      refresh_after = @refreshAfter,
      last_attempted_at = @lastRefreshAt,
      last_error = NULL
    WHERE cache_key = @cacheKey
  `).run({ cacheKey, ...opts });
}

export function markImageCacheRefreshFailure(
  db: Database.Database,
  cacheKey: string,
  opts: { attemptedAt: string; error: string }
): void {
  db.prepare(`
    UPDATE image_cache SET
      last_attempted_at = @attemptedAt,
      last_error = @error
    WHERE cache_key = @cacheKey
  `).run({ cacheKey, ...opts });
}

export function listAllImageCacheWebPaths(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT local_web_path FROM image_cache WHERE local_web_path IS NOT NULL")
    .all() as Array<{ local_web_path: string }>;
  return rows.map((r) => r.local_web_path);
}

export function deleteOrphanedPosterCacheEntries(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT cache_key
    FROM image_cache ic
    WHERE ic.kind = 'poster'
      AND NOT EXISTS (
        SELECT 1
        FROM watchlist_cache w
        WHERE w.plex_item_id = ic.entity_id
      )
  `).all() as Array<{ cache_key: string }>;

  if (rows.length === 0) {
    return 0;
  }

  const del = db.prepare("DELETE FROM image_cache WHERE cache_key = ?");

  db.transaction(() => {
    for (const row of rows) {
      del.run(row.cache_key);
    }
  })();

  return rows.length;
}

export function clearImageCacheTable(db: Database.Database): void {
  db.prepare("DELETE FROM image_cache").run();
}
