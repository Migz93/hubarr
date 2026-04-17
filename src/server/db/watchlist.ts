import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { WatchlistGroupedItem, WatchlistItem, WatchlistPageResponse, WatchlistSortBy } from "../../shared/types.js";
import { mergeRawPayloadGuids } from "./guid-dedupe.js";
import { getDiscoverKeyForPlexItemId, upsertMediaItemIdentifiers } from "./identifiers.js";
import { getAppSettings } from "./settings.js";

type ItemSummaryRow = {
  plexItemId: string;
  title: string;
  type: "movie" | "show";
  year: number | null;
  addedAt: string;
  matchedRatingKey: string | null;
  userId: number;
  rawPayload: string;
  discoverKey: string | null;
};

type BaseWatchlistItemGroup = {
  plexItemId: string;
  title: string;
  year: number | null;
  type: "movie" | "show";
  addedAt: string;
  matchedRatingKey: string | null;
  plexAvailable: boolean;
  memberItemIds: Set<string>;
  userAddedAt: Map<number, string>;
};

class ItemDisjointSet {
  private readonly parent = new Map<string, string>();

  add(itemId: string): void {
    if (!this.parent.has(itemId)) {
      this.parent.set(itemId, itemId);
    }
  }

  find(itemId: string): string {
    const parent = this.parent.get(itemId);
    if (!parent || parent === itemId) return itemId;
    const root = this.find(parent);
    this.parent.set(itemId, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    }
  }
}

function compareRepresentativeCandidate(
  left: Pick<BaseWatchlistItemGroup, "matchedRatingKey" | "addedAt" | "userAddedAt" | "plexItemId">,
  right: Pick<BaseWatchlistItemGroup, "matchedRatingKey" | "addedAt" | "userAddedAt" | "plexItemId">
): number {
  if (Boolean(left.matchedRatingKey) !== Boolean(right.matchedRatingKey)) {
    return left.matchedRatingKey ? 1 : -1;
  }

  if (left.addedAt !== right.addedAt) {
    return left.addedAt > right.addedAt ? 1 : -1;
  }

  if (left.userAddedAt.size !== right.userAddedAt.size) {
    return left.userAddedAt.size > right.userAddedAt.size ? 1 : -1;
  }

  return right.plexItemId.localeCompare(left.plexItemId);
}

function compareGroupedItems(
  left: BaseWatchlistItemGroup,
  right: BaseWatchlistItemGroup,
  sortBy: WatchlistSortBy
): number {
  switch (sortBy) {
    case "added-asc": {
      const addedCmp = new Date(left.addedAt).getTime() - new Date(right.addedAt).getTime();
      if (addedCmp !== 0) return addedCmp;
      break;
    }
    case "title-asc": {
      const titleCmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      if (titleCmp !== 0) return titleCmp;
      break;
    }
    case "title-desc": {
      const titleCmp = right.title.localeCompare(left.title, undefined, { sensitivity: "base" });
      if (titleCmp !== 0) return titleCmp;
      break;
    }
    case "year-desc": {
      const yearCmp = (right.year ?? 0) - (left.year ?? 0);
      if (yearCmp !== 0) return yearCmp;
      break;
    }
    case "year-asc": {
      const yearCmp = (left.year ?? 0) - (right.year ?? 0);
      if (yearCmp !== 0) return yearCmp;
      break;
    }
    default: {
      const addedCmp = new Date(right.addedAt).getTime() - new Date(left.addedAt).getTime();
      if (addedCmp !== 0) return addedCmp;
      break;
    }
  }

  const titleCmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  if (titleCmp !== 0) return titleCmp;

  const yearCmp = (right.year ?? 0) - (left.year ?? 0);
  if (yearCmp !== 0) return yearCmp;

  return left.plexItemId.localeCompare(right.plexItemId);
}

function buildWhereClause(options: {
  allowSelectedDisabledOnly: boolean;
  userId?: number;
  mediaType?: "movie" | "show";
}): { sql: string; params: (string | number)[] } {
  const whereParts: string[] = [options.allowSelectedDisabledOnly ? "f.id = ?" : "f.enabled = 1"];
  const params: (string | number)[] = options.allowSelectedDisabledOnly && options.userId ? [options.userId] : [];

  if (options.mediaType) {
    whereParts.push("w.type = ?");
    params.push(options.mediaType);
  }

  return {
    sql: whereParts.join(" AND "),
    params
  };
}

function loadWatchlistItemSummaries(
  db: Database.Database,
  whereClause: string,
  whereParams: (string | number)[]
): ItemSummaryRow[] {
  return db.prepare(`
    SELECT
      w.plex_item_id AS plexItemId,
      w.title AS title,
      w.type AS type,
      w.year AS year,
      w.added_at AS addedAt,
      w.matched_rating_key AS matchedRatingKey,
      w.user_id AS userId,
      w.raw_payload AS rawPayload,
      w.discover_key AS discoverKey
    FROM watchlist_cache w
    JOIN users f ON f.id = w.user_id
    WHERE ${whereClause}
    ORDER BY
      w.added_at DESC,
      w.year DESC,
      w.title COLLATE NOCASE ASC,
      w.plex_item_id ASC,
      w.user_id ASC
  `).all(...whereParams) as ItemSummaryRow[];
}

function buildMergedWatchlistGroups(
  rows: ItemSummaryRow[]
): BaseWatchlistItemGroup[] {
  const itemsById = new Map<string, BaseWatchlistItemGroup>();
  const dsu = new ItemDisjointSet();
  const itemGuids = new Map<string, Set<string>>();

  for (const row of rows) {
    dsu.add(row.plexItemId);

    const existing = itemsById.get(row.plexItemId);
    if (existing) {
      const currentAddedAt = existing.userAddedAt.get(row.userId);
      if (!currentAddedAt || row.addedAt > currentAddedAt) {
        existing.userAddedAt.set(row.userId, row.addedAt);
      }
      if (row.addedAt > existing.addedAt) {
        existing.addedAt = row.addedAt;
      }
      if (row.matchedRatingKey && !existing.matchedRatingKey) {
        existing.matchedRatingKey = row.matchedRatingKey;
      }
      existing.plexAvailable = existing.plexAvailable || Boolean(row.matchedRatingKey);
      continue;
    }

    mergeRawPayloadGuids(itemGuids, row.plexItemId, row.rawPayload);
    if (row.discoverKey?.trim()) {
      const identifiers = itemGuids.get(row.plexItemId) ?? new Set<string>();
      identifiers.add(row.discoverKey.trim().toLowerCase());
      itemGuids.set(row.plexItemId, identifiers);
    }

    itemsById.set(row.plexItemId, {
      plexItemId: row.plexItemId,
      title: row.title,
      year: row.year,
      type: row.type,
      addedAt: row.addedAt,
      matchedRatingKey: row.matchedRatingKey,
      plexAvailable: Boolean(row.matchedRatingKey),
      memberItemIds: new Set([row.plexItemId]),
      userAddedAt: new Map([[row.userId, row.addedAt]])
    });
  }

  const firstItemByIdentifier = new Map<string, string>();
  for (const [itemId, identifiers] of itemGuids) {
    if (!itemsById.has(itemId)) continue;
    for (const identifier of identifiers) {
      const existing = firstItemByIdentifier.get(identifier);
      if (existing) {
        const existingItem = itemsById.get(existing);
        const currentItem = itemsById.get(itemId);
        if (existingItem && currentItem && existingItem.type === currentItem.type) {
          dsu.union(existing, itemId);
        }
      } else {
        firstItemByIdentifier.set(identifier, itemId);
      }
    }
  }

  const groupsByRoot = new Map<string, BaseWatchlistItemGroup>();
  for (const item of itemsById.values()) {
    const root = dsu.find(item.plexItemId);
    const existing = groupsByRoot.get(root);
    if (!existing) {
      groupsByRoot.set(root, {
        plexItemId: item.plexItemId,
        title: item.title,
        year: item.year,
        type: item.type,
        addedAt: item.addedAt,
        matchedRatingKey: item.matchedRatingKey,
        plexAvailable: item.plexAvailable,
        memberItemIds: new Set(item.memberItemIds),
        userAddedAt: new Map(item.userAddedAt)
      });
      continue;
    }

    if (compareRepresentativeCandidate(item, existing) > 0) {
      existing.plexItemId = item.plexItemId;
      existing.title = item.title;
      existing.year = item.year;
      existing.type = item.type;
    }

    if (item.addedAt > existing.addedAt) {
      existing.addedAt = item.addedAt;
    }
    if (item.matchedRatingKey && !existing.matchedRatingKey) {
      existing.matchedRatingKey = item.matchedRatingKey;
    }
    existing.plexAvailable = existing.plexAvailable || item.plexAvailable;

    for (const memberItemId of item.memberItemIds) {
      existing.memberItemIds.add(memberItemId);
    }
    for (const [userId, addedAt] of item.userAddedAt) {
      const currentAddedAt = existing.userAddedAt.get(userId);
      if (!currentAddedAt || addedAt > currentAddedAt) {
        existing.userAddedAt.set(userId, addedAt);
      }
    }
  }

  return Array.from(groupsByRoot.values());
}

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
  const { sql: whereClause, params: whereParams } = buildWhereClause({
    allowSelectedDisabledOnly,
    userId,
    mediaType
  });

  const itemRows = loadWatchlistItemSummaries(db, whereClause, whereParams);
  const allItems = buildMergedWatchlistGroups(itemRows);

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

  const userCounts = new Map<number, number>();
  for (const item of allItems) {
    for (const userEntryId of item.userAddedAt.keys()) {
      userCounts.set(userEntryId, (userCounts.get(userEntryId) ?? 0) + 1);
    }
  }

  const allUsersCount = allItems.length;

  const mediaFacetItems = allItems.filter((item) =>
    userId ? item.userAddedAt.has(userId) : true
  );
  const mediaCounts = {
    all: mediaFacetItems.length,
    movie: mediaFacetItems.filter((item) => item.type === "movie").length,
    show: mediaFacetItems.filter((item) => item.type === "show").length
  };

  const filteredItems = allItems.filter((item) => {
    if (userId && !item.userAddedAt.has(userId)) {
      return false;
    }
    if (availability === "available" && !item.plexAvailable) {
      return false;
    }
    if (availability === "missing" && item.plexAvailable) {
      return false;
    }
    return true;
  }).sort((left, right) => compareGroupedItems(left, right, sortBy));

  const pagedGroups = filteredItems.slice(offset, offset + pageSize);

  const pageMemberItemIds = Array.from(new Set(pagedGroups.flatMap((item) => Array.from(item.memberItemIds))));
  const posterByItemId = new Map<string, string | null>();
  if (pageMemberItemIds.length > 0) {
    const posterRows = db.prepare(`
      SELECT substr(cache_key, 8) AS plexItemId, local_web_path AS posterUrl
      FROM image_cache
      WHERE cache_key IN (${pageMemberItemIds.map(() => "?").join(", ")})
    `).all(...pageMemberItemIds.map((itemId) => `poster:${itemId}`)) as Array<{ plexItemId: string; posterUrl: string | null }>;

    for (const row of posterRows) {
      posterByItemId.set(row.plexItemId, row.posterUrl);
    }
  }

  const userLookup = new Map<number, { displayName: string; avatarUrl: string | null }>();
  for (const user of enabledUsers) {
    userLookup.set(user.userId, {
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    });
  }
  if (selectedUser) {
    userLookup.set(selectedUser.userId, {
      displayName: selectedUser.displayName,
      avatarUrl: selectedUser.avatarUrl
    });
  }

  const items: WatchlistGroupedItem[] = pagedGroups.map((item) => {
    const users = Array.from(item.userAddedAt.entries())
      .sort((left, right) => {
        const addedCmp = right[1].localeCompare(left[1]);
        return addedCmp !== 0 ? addedCmp : left[0] - right[0];
      })
      .map(([itemUserId, addedAt]) => ({
        userId: itemUserId,
        displayName: userLookup.get(itemUserId)?.displayName ?? `User ${itemUserId}`,
        avatarUrl: userLookup.get(itemUserId)?.avatarUrl ?? null,
        addedAt
      }));

    const posterUrl =
      posterByItemId.get(item.plexItemId)
      ?? Array.from(item.memberItemIds)
        .map((memberItemId) => posterByItemId.get(memberItemId) ?? null)
        .find((candidate): candidate is string => Boolean(candidate))
      ?? null;

    return {
      plexItemId: item.plexItemId,
      title: item.title,
      year: item.year,
      type: item.type,
      posterUrl,
      addedAt: item.addedAt,
      userCount: item.userAddedAt.size,
      users,
      plexAvailable: item.plexAvailable,
      matchedRatingKey: item.matchedRatingKey
    };
  });

  return {
    items,
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
