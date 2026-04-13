import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { WatchlistGroupedItem, WatchlistItem, WatchlistPageResponse, WatchlistSortBy } from "../../shared/types.js";
import { buildGuidMergePlan, mergeRawPayloadGuids } from "./guid-dedupe.js";
import { getDiscoverKeyForPlexItemId, upsertMediaItemIdentifiers } from "./identifiers.js";
import { getAppSettings } from "./settings.js";

export function getWatchlistDiscoverKey(db: Database.Database, plexItemId: string): string | null {
  const explicitDiscoverKey = getDiscoverKeyForPlexItemId(db, plexItemId);
  if (explicitDiscoverKey) return explicitDiscoverKey;

  const row = db
    .prepare("SELECT raw_payload FROM watchlist_cache WHERE plex_item_id = ? LIMIT 1")
    .get(plexItemId) as { raw_payload: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.raw_payload) as { discoverKey?: string };
    return payload.discoverKey ?? null;
  } catch {
    return null;
  }
}

export function upsertWatchlistItem(db: Database.Database, userId: number, item: WatchlistItem): void {
  const discoverKey = item.discoverKey ?? null;
  db.prepare(`
    INSERT INTO watchlist_cache (
      user_id, plex_item_id, title, type, year, thumb, source, added_at, matched_rating_key, raw_payload, discover_key
    )
    VALUES (@userId, @plexItemId, @title, @type, @year, @thumb, @source, @addedAt, @matchedRatingKey, @rawPayload, @discoverKey)
    ON CONFLICT(user_id, plex_item_id) DO UPDATE SET
      title = excluded.title,
      year = excluded.year,
      thumb = excluded.thumb,
      matched_rating_key = COALESCE(excluded.matched_rating_key, matched_rating_key),
      source = excluded.source,
      raw_payload = excluded.raw_payload,
      discover_key = COALESCE(excluded.discover_key, discover_key),
      added_at = CASE
        WHEN added_at = '2001-01-01T00:00:00.000Z' THEN excluded.added_at
        ELSE added_at
      END
  `).run({ userId, ...item, rawPayload: JSON.stringify(item), discoverKey });
  upsertMediaItemIdentifiers(db, item);
}

export function replaceWatchlistItems(db: Database.Database, userId: number, items: WatchlistItem[]): void {
  const del = db.prepare("DELETE FROM watchlist_cache WHERE user_id = ?");
  const insert = db.prepare(`
    INSERT INTO watchlist_cache (
      user_id, plex_item_id, title, type, year, thumb, source, added_at, matched_rating_key, raw_payload, discover_key
    )
    VALUES (@userId, @plexItemId, @title, @type, @year, @thumb, @source, @addedAt, @matchedRatingKey, @rawPayload, @discoverKey)
  `);

  db.transaction(() => {
    del.run(userId);
    for (const item of items) {
      insert.run({ userId, ...item, rawPayload: JSON.stringify(item), discoverKey: item.discoverKey ?? null });
      upsertMediaItemIdentifiers(db, item);
    }
  })();
}

export function getWatchlistItems(db: Database.Database, userId?: number): WatchlistItem[] {
  const query = userId
    ? db.prepare(`
        SELECT plex_item_id AS plexItemId, title, type, year, thumb, source, added_at AS addedAt,
               matched_rating_key AS matchedRatingKey, raw_payload AS rawPayload, discover_key AS discoverKey
        FROM watchlist_cache WHERE user_id = ? ORDER BY added_at DESC, title ASC
      `)
    : db.prepare(`
        SELECT plex_item_id AS plexItemId, title, type, year, thumb, source, added_at AS addedAt,
               matched_rating_key AS matchedRatingKey, raw_payload AS rawPayload, discover_key AS discoverKey
        FROM watchlist_cache ORDER BY added_at DESC, title ASC
      `);

  const rows = (userId ? query.all(userId) : query.all()) as Array<
    WatchlistItem & { rawPayload: string }
  >;

  return rows.map(({ rawPayload, ...row }) => {
    try {
      const parsed = JSON.parse(rawPayload) as Partial<WatchlistItem>;
      return {
        ...row,
        // guids and releaseDate are stored only in raw_payload — they are wide/variable-length
        // arrays not needed for SQL filtering. discoverKey is now a dedicated column but
        // we fall back to raw_payload for any rows written before migration v7.
        guids: Array.isArray(parsed.guids) ? parsed.guids : undefined,
        discoverKey: row.discoverKey ?? (typeof parsed.discoverKey === "string" ? parsed.discoverKey : undefined),
        releaseDate: typeof parsed.releaseDate === "string" ? parsed.releaseDate : (row.releaseDate ?? null)
      };
    } catch {
      return row;
    }
  });
}

export function getWatchlistGrouped(
  db: Database.Database,
  options: {
    userId?: number;
    mediaType?: "movie" | "show";
    availability?: "available" | "missing";
    sortBy?: WatchlistSortBy;
    page: number;
    pageSize: number;
  }
): WatchlistPageResponse {
  const { userId, mediaType, availability, sortBy = "added-desc", page, pageSize } = options;
  const offset = (page - 1) * pageSize;
  const selectedUser = userId
    ? (db.prepare(`
        SELECT
          u.id AS userId,
          COALESCE(u.display_name_override, u.username) AS displayName,
          ic.local_web_path AS avatarUrl,
          u.enabled
        FROM users u
        LEFT JOIN image_cache ic ON ic.cache_key = 'avatar:' || u.plex_user_id
        WHERE u.id = ?
      `).get(userId) as
        | { userId: number; displayName: string; avatarUrl: string | null; enabled: number }
        | undefined)
    : undefined;
  const allowSelectedDisabledOnly = Boolean(
    selectedUser &&
    !selectedUser.enabled &&
    getAppSettings(db).trackAllUsers
  );

  type RawRow = {
    plex_item_id: string;
    title: string;
    type: string;
    year: number | null;
    thumb: string | null;
    added_at: string;
    matched_rating_key: string | null;
    raw_payload: string;
    user_id: number;
    friend_display_name: string;
    friend_avatar_url: string | null;
  };

  const rawRows = db
    .prepare(`
      SELECT w.plex_item_id, w.title, w.type, w.year,
             ip.local_web_path AS thumb,
             w.added_at, w.matched_rating_key, w.raw_payload,
             f.id AS user_id,
             COALESCE(f.display_name_override, f.username) AS friend_display_name,
             ia.local_web_path AS friend_avatar_url
      FROM watchlist_cache w
      JOIN users f ON f.id = w.user_id
      LEFT JOIN image_cache ip ON ip.cache_key = 'poster:' || w.plex_item_id
      LEFT JOIN image_cache ia ON ia.cache_key = 'avatar:' || f.plex_user_id
      WHERE ${allowSelectedDisabledOnly ? "f.id = ?" : "f.enabled = 1"}
      ORDER BY w.added_at DESC
    `)
    .all(...(allowSelectedDisabledOnly && userId ? [userId] : [])) as RawRow[];

  const enabledUsers = db
    .prepare(`
      SELECT u.id AS userId, COALESCE(u.display_name_override, u.username) AS displayName,
             ic.local_web_path AS avatarUrl
      FROM users u
      LEFT JOIN image_cache ic ON ic.cache_key = 'avatar:' || u.plex_user_id
      WHERE u.enabled = 1
      ORDER BY u.is_self DESC, LOWER(u.display_name) ASC
    `)
    .all() as Array<{ userId: number; displayName: string; avatarUrl: string | null }>;

  const grouped = new Map<string, WatchlistGroupedItem>();
  // Track GUIDs per item so we can merge items that share GUIDs but have
  // different plex_item_id values (e.g. old discover ratingKey vs new plex:// GUID).
  const itemGuids = new Map<string, Set<string>>();
  const itemTypes = new Map<string, "movie" | "show">();

  for (const row of rawRows) {
    itemTypes.set(row.plex_item_id, row.type as "movie" | "show");
    mergeRawPayloadGuids(itemGuids, row.plex_item_id, row.raw_payload);

    const existing = grouped.get(row.plex_item_id);
    const userEntry = {
      userId: row.user_id,
      displayName: row.friend_display_name,
      avatarUrl: row.friend_avatar_url,
      addedAt: row.added_at
    };
    if (existing) {
      existing.users.push(userEntry);
      existing.userCount++;
      if (row.added_at > existing.addedAt) existing.addedAt = row.added_at;
      if (row.matched_rating_key && !existing.matchedRatingKey) {
        existing.matchedRatingKey = row.matched_rating_key;
      }
      existing.plexAvailable = existing.plexAvailable || Boolean(row.matched_rating_key);
    } else {
      grouped.set(row.plex_item_id, {
        plexItemId: row.plex_item_id,
        title: row.title,
        year: row.year,
        type: row.type as "movie" | "show",
        posterUrl: row.thumb,
        addedAt: row.added_at,
        userCount: 1,
        users: [userEntry],
        plexAvailable: Boolean(row.matched_rating_key),
        matchedRatingKey: row.matched_rating_key
      });
    }
  }

  // Second pass: merge entries whose GUIDs overlap but have different plex_item_id.
  // This handles legacy data where the same media was cached under different ID formats
  // (e.g. discover ratingKey for self vs plex:// GUID for friend).
  const mergeInto = buildGuidMergePlan(itemGuids, itemTypes);

  for (const [sourceId, targetId] of mergeInto) {
    const source = grouped.get(sourceId);
    const target = grouped.get(targetId);
    if (!source || !target) continue;
    for (const user of source.users) {
      if (!target.users.some((u) => u.userId === user.userId)) {
        target.users.push(user);
        target.userCount++;
      }
    }
    if (source.addedAt > target.addedAt) target.addedAt = source.addedAt;
    if (source.matchedRatingKey && !target.matchedRatingKey) {
      target.matchedRatingKey = source.matchedRatingKey;
    }
    target.plexAvailable = target.plexAvailable || source.plexAvailable;
    grouped.delete(sourceId);
  }

  const sortFn = (a: WatchlistGroupedItem, b: WatchlistGroupedItem): number => {
    switch (sortBy) {
      case "added-asc":  return new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime();
      case "title-asc":  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      case "title-desc": return b.title.localeCompare(a.title, undefined, { sensitivity: "base" });
      case "year-desc":  return (b.year ?? 0) - (a.year ?? 0);
      case "year-asc":   return (a.year ?? 0) - (b.year ?? 0);
      default:           return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(); // added-desc
    }
  };

  const allItems = Array.from(grouped.values()).sort(sortFn);

  const userFacetRows = rawRows.filter((row) =>
    mediaType ? row.type === mediaType : true
  );
  const userCounts = new Map<number, number>();
  for (const row of userFacetRows) {
    userCounts.set(row.user_id, (userCounts.get(row.user_id) ?? 0) + 1);
  }

  const allUsersCount = allItems.filter((item) =>
    mediaType ? item.type === mediaType : true
  ).length;

  const mediaFacetItems = allItems.filter((item) =>
    userId ? item.users.some((user) => user.userId === userId) : true
  );
  const mediaCounts = {
    all: mediaFacetItems.length,
    movie: mediaFacetItems.filter((item) => item.type === "movie").length,
    show: mediaFacetItems.filter((item) => item.type === "show").length
  };

  const filteredItems = allItems.filter((item) => {
    if (userId && !item.users.some((user) => user.userId === userId)) {
      return false;
    }
    if (mediaType && item.type !== mediaType) {
      return false;
    }
    if (availability === "available" && !item.plexAvailable) {
      return false;
    }
    if (availability === "missing" && item.plexAvailable) {
      return false;
    }
    return true;
  });

  return {
    items: filteredItems.slice(offset, offset + pageSize),
    total: filteredItems.length,
    page,
    pageSize,
    filters: {
      userId: userId ?? null,
      mediaType: mediaType ?? "all",
      sortBy
    },
    facets: {
      allUsersCount,
      users: [
        ...enabledUsers.map((user) => ({
          ...user,
          count: userCounts.get(user.userId) ?? 0
        })),
        ...(allowSelectedDisabledOnly && selectedUser
          ? [{
              userId: selectedUser.userId,
              displayName: selectedUser.displayName,
              avatarUrl: selectedUser.avatarUrl,
              count: userCounts.get(selectedUser.userId) ?? 0
            }]
          : [])
      ],
      media: mediaCounts
    },
    selectedUser: selectedUser
      ? {
          userId: selectedUser.userId,
          displayName: selectedUser.displayName,
          avatarUrl: selectedUser.avatarUrl,
          enabled: Boolean(selectedUser.enabled)
        }
      : null
  };
}

export function computeWatchlistHash(db: Database.Database, userId: number, mediaType: "movie" | "show"): string {
  const items = getWatchlistItems(db, userId).filter((item) => item.type === mediaType);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(items.map((item) => [item.plexItemId, item.matchedRatingKey])))
    .digest("hex");
}

/**
 * Upsert a batch of activity cache entries into watchlist_activity_cache.
 * On conflict (same plex_item_id + plex_user_id) keeps the more recent date.
 */
export function upsertActivityCacheEntries(
  db: Database.Database,
  entries: Array<{ plexItemId: string; plexUserId: string; watchlistedAt: string }>
): void {
  const stmt = db.prepare(`
    INSERT INTO watchlist_activity_cache (plex_item_id, plex_user_id, watchlisted_at)
    VALUES (@plexItemId, @plexUserId, @watchlistedAt)
    ON CONFLICT(plex_item_id, plex_user_id) DO UPDATE SET
      watchlisted_at = CASE
        WHEN excluded.watchlisted_at > watchlisted_at THEN excluded.watchlisted_at
        ELSE watchlisted_at
      END
  `);
  db.transaction(() => {
    for (const entry of entries) stmt.run(entry);
  })();
}

/**
 * Look up the watchlisted_at date from the activity cache for a specific
 * plex_item_id + plex_user_id pair. Returns null if not found.
 */
export function getActivityCacheDate(
  db: Database.Database,
  plexItemId: string,
  plexUserId: string
): string | null {
  const row = db
    .prepare("SELECT watchlisted_at FROM watchlist_activity_cache WHERE plex_item_id = ? AND plex_user_id = ?")
    .get(plexItemId, plexUserId) as { watchlisted_at: string } | undefined;
  return row?.watchlisted_at ?? null;
}

/**
 * Delete all rows from watchlist_activity_cache and reset the job run state
 * so the next scheduled fetch performs a full re-population.
 * Returns the number of rows deleted.
 */
export function clearActivityCache(db: Database.Database): number {
  const result = db.prepare("DELETE FROM watchlist_activity_cache").run();
  db.prepare("UPDATE job_run_state SET last_run_at = NULL, updated_at = datetime('now') WHERE job_id = 'activity-cache-fetch'").run();
  return result.changes;
}

export function deleteWatchlistItemsForUsers(db: Database.Database, userIds: number[]): number {
  if (userIds.length === 0) return 0;
  const placeholders = userIds.map(() => "?").join(", ");
  const result = db.prepare(`DELETE FROM watchlist_cache WHERE user_id IN (${placeholders})`).run(...userIds);
  return result.changes;
}
