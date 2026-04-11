import type {
  AppSettings,
  CollectionSortOrder,
  UserRecord,
  PlexSettingsInput,
  WatchlistItem
} from "../shared/types.js";
import { HubarrDatabase } from "./db/index.js";
import { ImageCacheService } from "./image-cache.js";
import { Logger } from "./logger.js";
import { PlexIntegration, WATCHLIST_DATE_UNKNOWN_SENTINEL, type PlexLibraryItemMatch, type ResolvedWatchlistItem } from "./integrations/plex.js";
import { RssCache, type RssFeedItem } from "./rss-cache.js";

/**
 * Compare two watchlist items by release date for Plex collection ordering.
 *
 * YYYY-MM-DD strings compare correctly with a plain lexicographic sort, so no
 * Date parsing is needed.
 *
 * Sort key priority:
 *   1. releaseDate — primary, direction-aware (date-desc = newest first)
 *   2. title — secondary, always ascending (A–Z)
 *   3. plexItemId — tertiary, always ascending (guarantees a fully stable result
 *      when two items share the same date and title)
 *
 * Items with a null releaseDate are placed at the end of the list in both
 * directions. This ensures they do not interfere with properly-dated items.
 */
/** Sentinel value used for items whose watchlist date is unknown.
 *  Treated as "no date" and sorted to the end regardless of direction,
 *  mirroring how a null releaseDate is handled in compareByReleaseDate. */
const UNKNOWN_ADDED_AT = "2001-01-01T00:00:00.000Z";

function compareByWatchlistDate(
  a: WatchlistItem,
  b: WatchlistItem,
  direction: Extract<CollectionSortOrder, "watchlist-date-desc" | "watchlist-date-asc">
): number {
  const aSentinel = a.addedAt === UNKNOWN_ADDED_AT;
  const bSentinel = b.addedAt === UNKNOWN_ADDED_AT;

  // Both sentinel — unknown watchlist date, sort stably by title then ID.
  if (aSentinel && bSentinel) {
    const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return titleCmp !== 0 ? titleCmp : a.plexItemId.localeCompare(b.plexItemId);
  }
  // One sentinel — push it to the end regardless of direction.
  if (aSentinel) return 1;
  if (bSentinel) return -1;

  // Use numeric timestamps rather than localeCompare so that minor date-string
  // format variations (timezone offset vs Z, missing milliseconds, etc.) don't
  // produce incorrect ordering. Treat unparseable strings as sentinel.
  const aTime = new Date(a.addedAt).getTime();
  const bTime = new Date(b.addedAt).getTime();
  const aInvalid = isNaN(aTime);
  const bInvalid = isNaN(bTime);
  if (aInvalid && bInvalid) {
    const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return titleCmp !== 0 ? titleCmp : a.plexItemId.localeCompare(b.plexItemId);
  }
  if (aInvalid) return 1;
  if (bInvalid) return -1;

  const dateCmp = direction === "watchlist-date-desc"
    ? bTime - aTime // newest watchlist date first
    : aTime - bTime; // oldest watchlist date first

  if (dateCmp !== 0) return dateCmp;

  // Tie-break by title then ID for a fully stable result.
  const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  return titleCmp !== 0 ? titleCmp : a.plexItemId.localeCompare(b.plexItemId);
}

function compareByReleaseDate(
  a: WatchlistItem,
  b: WatchlistItem,
  direction: Extract<CollectionSortOrder, "date-desc" | "date-asc">
): number {
  const aDate = a.releaseDate ?? null;
  const bDate = b.releaseDate ?? null;

  // Both null — fall through to tie-breakers so order is still deterministic.
  if (aDate === null && bDate === null) {
    const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return titleCmp !== 0 ? titleCmp : a.plexItemId.localeCompare(b.plexItemId);
  }
  // One null — push it to the end regardless of direction.
  if (aDate === null) return 1;
  if (bDate === null) return -1;

  const dateCmp = direction === "date-desc"
    ? bDate.localeCompare(aDate)   // newest first
    : aDate.localeCompare(bDate);  // oldest first

  if (dateCmp !== 0) return dateCmp;

  // Tie-break by title then ID for a fully stable result.
  const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  return titleCmp !== 0 ? titleCmp : a.plexItemId.localeCompare(b.plexItemId);
}

export class HubarrServices {
  // Self RSS feed (admin's own watchlist)
  private selfRssUrl: string | null = null;
  private selfRssPrimed = false;
  private readonly selfRssCache = new RssCache();

  // Users RSS feed (combined feed for all users)
  private usersRssUrl: string | null = null;
  private usersRssPrimed = false;
  private readonly usersRssCache = new RssCache();

  constructor(
    private readonly db: HubarrDatabase,
    private readonly logger: Logger,
    private readonly imageCache: ImageCacheService
  ) {}

  getPlexIntegration() {
    const settings = this.db.getPlexSettings();
    if (!settings) {
      throw new Error("Plex is not configured yet.");
    }
    return new PlexIntegration(settings, this.logger);
  }

  validatePlexSettings(input: PlexSettingsInput) {
    return new PlexIntegration(input, this.logger).validate();
  }

  /**
   * Fetch the admin's own Plex account info and upsert the self user record.
   * Called automatically when Plex settings are saved. Non-throwing — logs
   * on failure so a bad account fetch doesn't block the settings save.
   */
  async upsertSelfUser(): Promise<void> {
    try {
      const plex = this.getPlexIntegration();
      const account = await plex.fetchSelfAccount();
      this.db.upsertSelfUser(account);
      this.logger.info("Self user upserted", {
        plexUserId: account.plexUserId,
        displayName: account.displayName
      });
      if (account.avatarUrl) {
        await this.imageCache.ensureAvatarCached(account.plexUserId, account.avatarUrl);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Could not upsert self user", { message });
    }
  }

  async discoverUsers() {
    const plex = this.getPlexIntegration();
    const [friendsResult, managedResult] = await Promise.allSettled([
      plex.discoverUsers(),
      plex.fetchManagedUsers()
    ]);

    if (friendsResult.status === "rejected") throw friendsResult.reason as Error;

    if (managedResult.status === "fulfilled") {
      this.db.upsertManagedUsers(managedResult.value);
      for (const user of managedResult.value) {
        if (user.avatarUrl) {
          await this.imageCache.ensureAvatarCached(user.plexUserId, user.avatarUrl);
        }
      }
    } else {
      const message = managedResult.reason instanceof Error ? managedResult.reason.message : String(managedResult.reason);
      this.logger.warn("Managed user fetch failed during discover — cache not updated", { message });
    }

    const users = this.db.upsertUsers(friendsResult.value);
    for (const user of friendsResult.value) {
      if (user.avatarUrl) {
        await this.imageCache.ensureAvatarCached(user.plexUserId, user.avatarUrl);
      }
    }
    return users;
  }

  getManagedUsers() {
    return this.db.listManagedUsers();
  }

  async refreshPlexToken() {
    const owner = this.db.getPlexOwner();
    if (!owner?.plexToken) {
      this.logger.warn("Skipping Plex token refresh — no owner token configured", {
        label: "Plex Refresh Token"
      });
      return;
    }

    await PlexIntegration.pingToken(owner.plexToken);
    this.logger.info("Plex token refresh ping succeeded", {
      label: "Plex Refresh Token"
    });
  }

  async runPlexRecentlyAddedScan(lastRunAt?: string | null) {
    const since = lastRunAt
      ? new Date(Math.max(0, Date.parse(lastRunAt) - 10 * 60 * 1000))
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.runPlexAvailabilityScan({
      mode: "recent",
      since
    });
  }

  async runPlexFullLibraryScan() {
    return this.runPlexAvailabilityScan({
      mode: "full"
    });
  }

  private getEffectiveLibraryIds(friend: UserRecord) {
    const appSettings = this.db.getAppSettings();
    return {
      movieLibraryId: friend.movieLibraryId ?? appSettings.defaultMovieLibraryId,
      showLibraryId: friend.showLibraryId ?? appSettings.defaultShowLibraryId
    };
  }

  private buildWatchlistIdentityMap(items: WatchlistItem[]) {
    const byItemId = new Map<string, WatchlistItem>();
    const byGuid = new Map<string, WatchlistItem>();
    const byTitleKey = new Map<string, WatchlistItem>();

    for (const item of items) {
      byItemId.set(item.plexItemId, item);
      for (const guid of item.guids ?? []) {
        byGuid.set(guid.toLowerCase(), item);
      }
      byTitleKey.set(this.buildWatchlistTitleKey(item), item);
    }

    return { byItemId, byGuid, byTitleKey };
  }

  private mergeFetchedWatchlistItems(existingItems: WatchlistItem[], fetchedItems: WatchlistItem[]) {
    const { byItemId, byGuid, byTitleKey } = this.buildWatchlistIdentityMap(existingItems);

    return fetchedItems.map((item) => {
      const existing =
        byItemId.get(item.plexItemId) ??
        item.guids?.map((guid) => byGuid.get(guid.toLowerCase())).find((candidate) => Boolean(candidate)) ??
        byTitleKey.get(this.buildWatchlistTitleKey(item));

      return {
        ...item,
        plexItemId: existing?.plexItemId ?? item.plexItemId,
        year: item.year ?? existing?.year ?? null,
        // Preserve an already-discovered releaseDate across ingestion passes so
        // a later partial update never drops a real date back to null.
        releaseDate: item.releaseDate ?? existing?.releaseDate ?? null,
        thumb: item.thumb ?? existing?.thumb ?? null,
        guids: item.guids && item.guids.length > 0 ? item.guids : existing?.guids,
        discoverKey: item.discoverKey ?? existing?.discoverKey,
        source: existing?.source ?? item.source,
        // Prefer a real date over the sentinel. A stored real date is always
        // preserved; the sentinel can be overwritten if a real date arrives later.
        addedAt: (() => {
          const existingDate = existing?.addedAt;
          const incomingDate = item.addedAt;
          if (existingDate && existingDate !== WATCHLIST_DATE_UNKNOWN_SENTINEL) return existingDate;
          if (incomingDate && incomingDate !== WATCHLIST_DATE_UNKNOWN_SENTINEL) return incomingDate;
          return WATCHLIST_DATE_UNKNOWN_SENTINEL;
        })(),
        matchedRatingKey: item.matchedRatingKey ?? existing?.matchedRatingKey ?? null
      };
    });
  }

  private buildWatchlistTitleKey(item: Pick<WatchlistItem, "title" | "type" | "year">) {
    return `${item.type}::${this.normalizeWatchlistTitle(item.title)}::${item.year ?? "unknown"}`;
  }

  private normalizeWatchlistTitle(title: string) {
    return title
      .trim()
      .replace(/\s+\((\d{4})\)$/, "")
      .toLowerCase();
  }

  private buildGuidToRatingKeyMap(items: PlexLibraryItemMatch[]) {
    const guidToRatingKey = new Map<string, string>();

    for (const item of items) {
      for (const guid of item.guids) {
        if (!guidToRatingKey.has(guid)) {
          guidToRatingKey.set(guid, item.ratingKey);
        }
      }
    }

    return guidToRatingKey;
  }

  private async runPlexAvailabilityScan(options: {
    mode: "recent" | "full";
    since?: Date;
  }) {
    const plex = this.getPlexIntegration();
    const enabledUsers = this.db.listUsers().filter((friend) => friend.enabled);
    const libraries = new Map<string, { libraryId: string; mediaType: "movie" | "show"; userIds: number[] }>();

    for (const friend of enabledUsers) {
      const effectiveLibraries = this.getEffectiveLibraryIds(friend);

      if (effectiveLibraries.movieLibraryId) {
        const key = `movie:${effectiveLibraries.movieLibraryId}`;
        const existing = libraries.get(key);
        if (existing) {
          existing.userIds.push(friend.id);
        } else {
          libraries.set(key, {
            libraryId: effectiveLibraries.movieLibraryId,
            mediaType: "movie",
            userIds: [friend.id]
          });
        }
      }

      if (effectiveLibraries.showLibraryId) {
        const key = `show:${effectiveLibraries.showLibraryId}`;
        const existing = libraries.get(key);
        if (existing) {
          existing.userIds.push(friend.id);
        } else {
          libraries.set(key, {
            libraryId: effectiveLibraries.showLibraryId,
            mediaType: "show",
            userIds: [friend.id]
          });
        }
      }
    }

    let matchedCount = 0;
    let affectedUsers = 0;

    for (const library of libraries.values()) {
      const libraryItems =
        options.mode === "recent"
          ? await plex.getRecentlyAddedLibraryItems(
              library.libraryId,
              library.mediaType,
              options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
            )
          : await plex.getAllLibraryItems(library.libraryId, library.mediaType);

      const guidToRatingKey = this.buildGuidToRatingKeyMap(libraryItems);
      if (guidToRatingKey.size === 0) {
        continue;
      }

      for (const friendId of library.userIds) {
        const friend = enabledUsers.find((entry) => entry.id === friendId);
        if (!friend) {
          continue;
        }

        const watchlistItems = this.db.getWatchlistItems(friendId);
        let friendChanged = false;

        for (const item of watchlistItems) {
          if (item.type !== library.mediaType || item.matchedRatingKey || !item.guids?.length) {
            continue;
          }

          const match = item.guids
            .map((guid) => guidToRatingKey.get(guid.toLowerCase()))
            .find((ratingKey): ratingKey is string => Boolean(ratingKey));

          if (!match) {
            continue;
          }

          this.db.upsertWatchlistItem(friendId, {
            ...item,
            matchedRatingKey: match
          });
          matchedCount++;
          friendChanged = true;

          this.logger.info("Watchlist item matched after Plex library scan", {
            label: options.mode === "recent" ? "Plex Recently Added Scan" : "Plex Full Library Scan",
            friendId,
            displayName: friend.displayName,
            title: item.title,
            type: item.type,
            ratingKey: match
          });
        }

        if (friendChanged) {
          affectedUsers++;
          this.db.markUserSyncResult(friendId, null);
        }
      }
    }

    this.logger.info("Plex library availability scan complete", {
      label: options.mode === "recent" ? "Plex Recently Added Scan" : "Plex Full Library Scan",
      mode: options.mode,
      since: options.since?.toISOString() ?? null,
      matchedCount,
      affectedUsers
    });

    return {
      matchedCount,
      affectedUsers
    };
  }

  async syncUser(friend: UserRecord, runId: number, rssDateMap?: Map<string, string>) {
    if (!friend.enabled) {
      throw new Error("Friend must be enabled before syncing.");
    }
    const { movieLibraryId, showLibraryId } = this.getEffectiveLibraryIds(friend);
    if (!movieLibraryId || !showLibraryId) {
      throw new Error("Friend must have both target libraries selected.");
    }

    const syncStart = Date.now();
    this.logger.info("Starting watchlist sync", {
      userId: friend.id,
      displayName: friend.displayName,
      isSelf: friend.isSelf
    });

    const plex = this.getPlexIntegration();

    // Self and friends both use the same GraphQL-safe watchlist baseline.
    // addedAt is intentionally left as WATCHLIST_DATE_UNKNOWN_SENTINEL here —
    // the merge and activity cache lookup below are responsible for resolving it.
    //
    // For the self user, also fetch their Plex UUID. Plex uses two ID formats
    // for the admin account: a legacy numeric ID (stored in users.plex_user_id)
    // and a hex UUID (used by the GraphQL activityFeed). The activity cache
    // stores events under the UUID, so we need both to resolve dates.
    const [rawItems, selfPlexUuid] = await (async () => {
      if (friend.isSelf) {
        const [items, uuid] = await Promise.all([
          plex.fetchSelfWatchlist(),
          plex.fetchSelfPlexUuid()
        ]);
        return [items, uuid] as const;
      }
      return [await plex.fetchUserWatchlist(friend.plexUserId), null] as const;
    })();

    const movieItems = await plex.resolveWatchlistItems(rawItems, "movie", movieLibraryId);
    const showItems = await plex.resolveWatchlistItems(rawItems, "show", showLibraryId);
    const fetched: ResolvedWatchlistItem[] = [...movieItems, ...showItems].sort((a, b) => a.title.localeCompare(b.title));

    const matchedCount = fetched.filter((i) => i.matchedRatingKey).length;
    const unmatchedItems = fetched.filter((i) => !i.matchedRatingKey);
    this.logger.info("Watchlist resolved", {
      userId: friend.id,
      displayName: friend.displayName,
      total: fetched.length,
      matched: matchedCount,
      unmatched: unmatchedItems.length
    });

    const existingItems = this.db.getWatchlistItems(friend.id);
    const merged = this.mergeFetchedWatchlistItems(existingItems, fetched);

    // Step 1: Resolve addedAt from the activity cache for items still carrying the sentinel.
    // The activity cache stores discover-key IDs (/library/metadata/<hex>) while the
    // watchlist cache stores plex:// GUIDs (plex://movie/<hex>). Try both so that
    // items fetched via either path can be matched.
    const afterActivityCache = merged.map((item) => {
      if (item.addedAt !== WATCHLIST_DATE_UNKNOWN_SENTINEL) return item;
      // Try all combinations of ID format (plex:// GUID vs discover key) and
      // user ID format (numeric legacy vs UUID). The activity cache stores
      // discover-key item IDs under the UUID form of the user ID, so for the
      // self user we must try both plexUserId ("8448953") and plexUuid ("77b5c…").
      const tryLookup = (userId: string) =>
        this.db.getActivityCacheDate(item.plexItemId, userId) ??
        (item.discoverKey ? this.db.getActivityCacheDate(item.discoverKey, userId) : null);
      const cached =
        tryLookup(friend.plexUserId) ??
        (selfPlexUuid ? tryLookup(selfPlexUuid) : null);
      if (cached) {
        this.logger.debug("Resolved addedAt from activity cache", { title: item.title, watchlistedAt: cached });
        return { ...item, addedAt: cached };
      }
      return item;
    });

    // Step 2: RSS date resolution — only available during ad-hoc syncs where a fresh
    // RSS snapshot was fetched before this call. Covers items added very recently that
    // have not yet propagated to the activity feed, keyed by any guid or plexItemId.
    const afterRss = rssDateMap
      ? afterActivityCache.map((item) => {
          if (item.addedAt !== WATCHLIST_DATE_UNKNOWN_SENTINEL) return item;
          const candidates = [
            item.plexItemId,
            ...(item.discoverKey ? [item.discoverKey] : []),
            ...(item.guids ?? [])
          ];
          for (const candidate of candidates) {
            const rssDate = rssDateMap.get(candidate.toLowerCase());
            if (rssDate) {
              this.logger.debug("Resolved addedAt from RSS date map", { title: item.title, pubDate: rssDate });
              return { ...item, addedAt: rssDate };
            }
          }
          return item;
        })
      : afterActivityCache;

    // Step 3: Track items still unresolved after all date sources have been tried.
    const unresolvedItems: Array<{ title: string; type: string }> = [];
    const mergedWithDates = afterRss.map((item) => {
      if (item.addedAt === WATCHLIST_DATE_UNKNOWN_SENTINEL) {
        unresolvedItems.push({ title: item.title, type: item.type });
      }
      return item;
    });

    this.db.replaceWatchlistItems(friend.id, mergedWithDates);

    const plexSettings = this.db.getPlexSettings();
    if (plexSettings) {
      for (const item of mergedWithDates) {
        if (!item.thumb) continue;
        if (item.thumb.startsWith("/")) {
          await this.imageCache.ensurePosterCached(item.plexItemId, {
            type: "plex-path",
            value: item.thumb,
            serverUrl: plexSettings.serverUrl,
            token: plexSettings.token
          });
        } else if (item.thumb.startsWith("https://")) {
          await this.imageCache.ensurePosterCached(item.plexItemId, {
            type: "public-url",
            value: item.thumb
          });
        }
      }
    }

    this.db.addSyncRunItem(
      runId,
      "watchlist.fetch",
      "success",
      {
        userId: friend.id,
        isSelf: friend.isSelf,
        itemCount: mergedWithDates.length,
        matched: matchedCount,
        unmatched: unmatchedItems.length
      },
      friend.id
    );

    for (const item of unmatchedItems) {
      this.db.addSyncRunItem(
        runId,
        "watchlist.match.failed",
        "error",
        {
          // Full raw watchlist item fields
          plexItemId: item.plexItemId,
          title: item.title,
          type: item.type,
          year: item.year ?? null,
          thumb: item.thumb ?? null,
          guids: item.guids ?? [],
          discoverKey: item.discoverKey ?? null,
          source: item.source,
          addedAt: item.addedAt,
          // Library context
          libraryId: item.type === "movie" ? movieLibraryId : showLibraryId,
          // All candidates Plex returned during the library search
          searchCandidates: item.searchCandidates ?? []
        },
        friend.id
      );
    }

    for (const item of unresolvedItems) {
      this.db.addSyncRunItem(
        runId,
        "watchlist.date_unresolved",
        "error",
        { title: item.title, type: item.type },
        friend.id
      );
    }

    if (unresolvedItems.length > 0) {
      this.logger.warn("Some watchlist items have no resolved addedAt date", {
        userId: friend.id,
        count: unresolvedItems.length
      });
    }

    this.db.markUserSyncResult(friend.id, null);

    this.logger.info("Watchlist sync complete", {
      userId: friend.id,
      displayName: friend.displayName,
      durationMs: Date.now() - syncStart
    });

    return mergedWithDates;
  }

  private async publishUserCollections(
    friend: UserRecord,
    items: WatchlistItem[],
    runId: number | null,
    plex = this.getPlexIntegration()
  ) {
    const appSettings = this.db.getAppSettings();
    // Per-user override takes precedence over the global setting; null means use global.
    const effectiveSortOrder = friend.collectionSortOrderOverride ?? appSettings.collectionSortOrder ?? "date-desc";
    this.logger.info("Publishing Plex collections for user", {
      userId: friend.id,
      displayName: friend.displayName,
      isSelf: friend.isSelf,
      totalItems: items.length,
      effectiveSortOrder,
      sortOrderOverride: friend.collectionSortOrderOverride
    });
    if (friend.collectionSortOrderOverride) {
      this.logger.info("Using per-user collection sort order override", {
        userId: friend.id,
        displayName: friend.displayName,
        override: friend.collectionSortOrderOverride,
        globalDefault: appSettings.collectionSortOrder
      });
    }

    const effectiveLibraries = this.getEffectiveLibraryIds(friend);

    for (const mediaType of ["movie", "show"] as const) {
      const libraryId = mediaType === "movie" ? effectiveLibraries.movieLibraryId : effectiveLibraries.showLibraryId;
      if (!libraryId) {
        continue;
      }

      const filteredItems = items.filter((item) => item.type === mediaType && item.matchedRatingKey);
      // Sort locally so Hubarr — not Plex — owns the ordering logic. The sorted
      // ratingKey list is then pushed into Plex via reorderCollectionItems, with
      // Plex's collectionSort set to custom (2) so it honours explicit positioning.
      if (effectiveSortOrder === "date-desc" || effectiveSortOrder === "date-asc") {
        filteredItems.sort((a, b) => compareByReleaseDate(a, b, effectiveSortOrder));
      } else if (effectiveSortOrder === "watchlist-date-desc" || effectiveSortOrder === "watchlist-date-asc") {
        // Warn about items whose watchlist date is unknown before sorting — they
        // will sort to the end. This usually means the item was added before the
        // activity cache feature existed and a full re-sync hasn't resolved it.
        const unknownDateItems = filteredItems.filter((item) => item.addedAt === UNKNOWN_ADDED_AT);
        if (unknownDateItems.length > 0) {
          this.logger.warn("Some items have no resolved watchlist date and will sort to the end of the collection", {
            userId: friend.id,
            displayName: friend.displayName,
            mediaType,
            count: unknownDateItems.length,
            titles: unknownDateItems.map((item) => item.title)
          });
        }
        filteredItems.sort((a, b) => compareByWatchlistDate(a, b, effectiveSortOrder));
      }
      const matchedRatingKeys = filteredItems.map((item) => item.matchedRatingKey as string);
      const collectionName = friend.collectionName;
      this.logger.info("Publishing media bucket", {
        userId: friend.id,
        mediaType,
        libraryId,
        collectionName,
        matchedItems: matchedRatingKeys.length
      });
      const collectionRatingKey = await plex.ensureCollection(collectionName, mediaType, libraryId);
      this.logger.info("Collection resolved", {
        userId: friend.id,
        mediaType,
        collectionRatingKey
      });
      await plex.updateCollectionSortTitle(collectionRatingKey, `!10_${collectionName}`);
      await plex.updateCollectionContentSort(collectionRatingKey, effectiveSortOrder);
      await plex.syncCollectionItems(collectionRatingKey, matchedRatingKeys);
      // Explicitly push item positions into Plex for all custom-ordered modes.
      // Title sort uses Plex's native alphabetical sort (collectionSort=1) and
      // doesn't need explicit reordering; all other modes use collectionSort=2.
      if (effectiveSortOrder !== "title") {
        await plex.reorderCollectionItems(collectionRatingKey, matchedRatingKeys);
      }
      this.logger.info("Collection items synced", {
        userId: friend.id,
        mediaType,
        collectionRatingKey,
        matchedItems: matchedRatingKeys.length
      });

      const labelName = plex.createCollectionLabel(friend.displayName);
      await plex.applyLabelToCollection(collectionRatingKey, labelName);
      this.logger.info("Collection label applied", {
        userId: friend.id,
        mediaType,
        collectionRatingKey,
        labelName
      });

      const visibility = friend.visibilityOverride ?? appSettings.visibilityDefaults;
      const hubIdentifier = await plex.updateCollectionVisibility(
        collectionRatingKey,
        libraryId,
        visibility
      );
      this.logger.info("Collection visibility updated", {
        userId: friend.id,
        mediaType,
        collectionRatingKey,
        hubIdentifier
      });
      const hash = plex.hashRatingKeys(matchedRatingKeys);
      this.db.upsertCollectionRecord(friend.id, mediaType, {
        collectionRatingKey,
        visibleName: collectionName,
        labelName,
        hubIdentifier,
        lastSyncedHash: hash,
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null
      });
      if (runId !== null) {
        this.db.addSyncRunItem(
          runId,
          "collection.publish",
          "success",
          {
            userId: friend.id,
            mediaType,
            collectionRatingKey,
            matchedItems: matchedRatingKeys.length
          },
          friend.id
        );
      }
    }
  }

  async runFullSync() {
    const syncStart = Date.now();
    const runId = this.db.createSyncRun("full", "Full sync started.");
    const friends = this.db.listUsers().filter((friend) => friend.enabled);
    const failures: string[] = [];

    this.logger.info("Full sync started", { userCount: friends.length });

    // Refresh self user account info (including avatar) on every full sync
    await this.upsertSelfUser();

    // Refresh the activity cache before syncing so date resolution uses the
    // freshest data available — avoids a second background pass just for dates.
    await this.syncActivityCache().catch((err) => {
      this.logger.warn("Activity cache sync failed before full sync — continuing with stale cache", {
        message: err instanceof Error ? err.message : String(err)
      });
    });

    // Fetch current RSS items once and build per-user date maps.
    // These catch items added very recently that haven't propagated to the
    // activity feed yet. Non-fatal — missing RSS data just means those items
    // fall back to the activity cache or sentinel as usual.
    let rssMaps: { self: Map<string, string>; byAuthor: Map<string, Map<string, string>> } | null = null;
    try {
      const owner = this.db.getPlexOwner();
      if (owner) {
        rssMaps = await this.buildAllRssDateMaps(owner.plexToken);
      }
    } catch (err) {
      this.logger.warn("RSS date map fetch failed before full sync — continuing without RSS date resolution", {
        message: err instanceof Error ? err.message : String(err)
      });
    }

    for (const friend of friends) {
      const rssDateMap = rssMaps
        ? (friend.isSelf ? rssMaps.self : (rssMaps.byAuthor.get(friend.plexUserId) ?? new Map()))
        : undefined;
      try {
        await this.syncUser(friend, runId, rssDateMap);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Friend sync failed during full sync — continuing with remaining users", {
          userId: friend.id,
          displayName: friend.displayName,
          message
        });
        this.db.markUserSyncResult(friend.id, message);
        this.db.addSyncRunItem(runId, "sync.user", "error", { userId: friend.id, message }, friend.id);
        failures.push(`${friend.displayName}: ${message}`);
      }
    }

    if (failures.length > 0) {
      const summary = `Full sync finished: ${friends.length - failures.length}/${friends.length} users succeeded.`;
      this.db.completeSyncRun(runId, "error", summary, failures.join(" | "));
      this.logger.info("Full sync complete", {
        succeeded: friends.length - failures.length,
        failed: failures.length,
        durationMs: Date.now() - syncStart
      });
    } else {
      this.db.completeSyncRun(runId, "success", `Full sync finished for ${friends.length} users.`, null);
      this.logger.info("Full sync complete", {
        succeeded: friends.length,
        failed: 0,
        durationMs: Date.now() - syncStart
      });
    }

    // Publish collections immediately so the updated watchlist is live in Plex
    // without waiting for the next scheduled collection-publish job.
    await this.runPublishPass().catch((err) => {
      this.logger.warn("Collection publish after full sync failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    });

    return this.db.listSyncRuns(1)[0];
  }

  async runUserSync(userId: number) {
    const friend = this.db.getUser(userId);
    if (!friend) {
      throw new Error("Friend not found.");
    }

    const label = friend.isSelf ? "self" : friend.displayName;
    const runId = this.db.createSyncRun("user", `Manual sync for ${label}.`);
    try {
      // Refresh the activity cache so date resolution uses the freshest data.
      await this.syncActivityCache().catch((err) => {
        this.logger.warn("Activity cache sync failed before user sync — continuing with stale cache", {
          userId: friend.id,
          message: err instanceof Error ? err.message : String(err)
        });
      });

      // Fetch current RSS items and build a date map scoped to this user.
      let rssDateMap: Map<string, string> | undefined;
      try {
        const owner = this.db.getPlexOwner();
        if (owner) {
          const allMaps = await this.buildAllRssDateMaps(owner.plexToken);
          rssDateMap = friend.isSelf ? allMaps.self : allMaps.byAuthor.get(friend.plexUserId);
        }
      } catch (err) {
        this.logger.warn("RSS date map fetch failed before user sync — continuing without RSS date resolution", {
          userId: friend.id,
          message: err instanceof Error ? err.message : String(err)
        });
      }

      const items = await this.syncUser(friend, runId, rssDateMap);
      this.db.completeSyncRun(runId, "success", `Manual sync finished for ${label}.`, null);

      // Publish collections immediately so the result is live in Plex.
      await this.runPublishPass().catch((err) => {
        this.logger.warn("Collection publish after user sync failed", {
          userId: friend.id,
          message: err instanceof Error ? err.message : String(err)
        });
      });

      return { run: this.db.listSyncRuns(1)[0], items };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Manual sync failed", { label, message });
      this.db.markUserSyncResult(friend.id, message);
      this.db.completeSyncRun(runId, "error", `Manual sync failed for ${label}.`, message);
      throw error;
    }
  }

  async refreshAllWatchlists() {
    return this.runFullSync();
  }

  async runPublishPass() {
    const syncStart = Date.now();
    const runId = this.db.createSyncRun("publish", "Collection sync started.");
    const friends = this.db.listUsers().filter((friend) => friend.enabled);
    const failures: string[] = [];
    const plex = this.getPlexIntegration();

    this.logger.info("Collection sync started", { userCount: friends.length });

    for (const friend of friends) {
      try {
        await this.publishUserCollections(friend, this.db.getWatchlistItems(friend.id), runId, plex);
        this.db.markUserSyncResult(friend.id, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Collection sync failed for user — continuing with remaining users", {
          userId: friend.id,
          displayName: friend.displayName,
          message
        });
        this.db.markUserSyncResult(friend.id, message);
        this.db.addSyncRunItem(runId, "collection.publish", "error", { userId: friend.id, message }, friend.id);
        failures.push(`${friend.displayName}: ${message}`);
      }
    }

    await this.applyIsolationFilters(friends, runId);

    if (failures.length > 0) {
      const summary = `Collection sync finished: ${friends.length - failures.length}/${friends.length} users succeeded.`;
      this.db.completeSyncRun(runId, "error", summary, failures.join(" | "));
      this.logger.info("Collection sync complete", {
        succeeded: friends.length - failures.length,
        failed: failures.length,
        durationMs: Date.now() - syncStart
      });
    } else {
      this.db.completeSyncRun(runId, "success", `Collection sync finished for ${friends.length} users.`, null);
      this.logger.info("Collection sync complete", {
        succeeded: friends.length,
        failed: 0,
        durationMs: Date.now() - syncStart
      });
    }

    return this.db.listSyncRuns(1)[0];
  }

  // ---------------------------------------------------------------------------
  // RSS — date map helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch both Plex RSS feeds and build per-user date maps that can be passed
   * into syncUser() to fill in sentinel dates for recently watchlisted items.
   *
   * Both feeds are fetched in parallel. Failures are surfaced so the caller
   * can decide whether to continue with a partial map or skip RSS resolution.
   *
   * Returns:
   *   self      — Map<lowercased-guid, ISO date> for the admin user
   *   byAuthor  — Map<plexUserId, Map<lowercased-guid, ISO date>> for friends
   */
  private async buildAllRssDateMaps(ownerToken: string): Promise<{
    self: Map<string, string>;
    byAuthor: Map<string, Map<string, string>>;
  }> {
    const plex = this.getPlexIntegration();

    const [selfResult, friendsResult] = await Promise.all([
      plex.fetchRssUrl("watchlist", ownerToken).then((url) =>
        url ? plex.fetchRssFeedItems(url) : null
      ),
      plex.fetchRssUrl("friendsWatchlist", ownerToken).then((url) =>
        url ? plex.fetchRssFeedItems(url) : null
      )
    ]);

    const self = new Map<string, string>();
    if (selfResult?.ok) {
      for (const item of selfResult.items) {
        if (!item.pubDate) continue;
        const date = new Date(item.pubDate);
        if (Number.isNaN(date.getTime())) continue;
        const iso = date.toISOString();
        for (const guid of item.guids) {
          self.set(guid.toLowerCase(), iso);
        }
      }
      this.logger.debug("Built self RSS date map", { itemCount: self.size });
    }

    const byAuthor = new Map<string, Map<string, string>>();
    if (friendsResult?.ok) {
      for (const item of friendsResult.items) {
        if (!item.pubDate || !item.author) continue;
        const date = new Date(item.pubDate);
        if (Number.isNaN(date.getTime())) continue;
        const iso = date.toISOString();
        if (!byAuthor.has(item.author)) byAuthor.set(item.author, new Map());
        const authorMap = byAuthor.get(item.author)!;
        for (const guid of item.guids) {
          authorMap.set(guid.toLowerCase(), iso);
        }
      }
      this.logger.debug("Built friends RSS date map", { authorCount: byAuthor.size });
    }

    return { self, byAuthor };
  }

  // ---------------------------------------------------------------------------
  // Activity Feed Cache
  // ---------------------------------------------------------------------------

  /**
   * Fetch WATCHLIST activity events from the Plex Community API and upsert
   * them into the local watchlist_activity_cache table.
   *
   * On the first run (no prior job_run_state) the entire feed history is
   * paginated. On subsequent runs only events since the last fetch are pulled,
   * keeping the incremental cost low.
   */
  async syncActivityCache(): Promise<void> {
    const plexSettings = this.db.getPlexSettings();
    if (!plexSettings) {
      this.logger.warn("Activity cache sync skipped — Plex is not configured yet.");
      return;
    }

    const plex = new PlexIntegration(plexSettings, this.logger);
    const lastState = this.db.getJobRunState("activity-cache-fetch");
    const since = lastState?.lastRunAt ?? null;
    const isInitial = since === null;

    this.logger.info("Activity cache sync started", { isInitial, since });

    try {
      const entries = await plex.fetchWatchlistActivityFeed(since);

      if (entries.length > 0) {
        this.db.upsertActivityCacheEntries(entries);
      }

      this.db.saveJobRunState("activity-cache-fetch", {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "success"
      });

      this.logger.info("Activity cache sync complete", { isInitial, fetched: entries.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Preserve the pre-failure cursor so the next run retries from the same
      // point rather than permanently skipping any events in the failed window.
      this.db.saveJobRunState("activity-cache-fetch", {
        lastRunAt: since,
        lastRunStatus: "error"
      });
      this.logger.error("Activity cache sync failed", { message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // RSS — initialization
  // ---------------------------------------------------------------------------

  /**
   * Fetch both RSS feed URLs and prime both in-memory caches with the current
   * feed state so the first real poll does not treat everything as new.
   *
   * Non-throwing. If either feed is unavailable (no Plex Pass, token issue,
   * Plex not yet configured) a warning is logged and that feed is skipped.
   * pollRss() retries initialization on its first tick for any feed that
   * was not successfully primed here.
   */
  async initRss(): Promise<void> {
    try {
      const owner = this.db.getPlexOwner();
      if (!owner) {
        this.logger.warn("RSS initialization skipped — no owner record found.");
        return;
      }
      const plex = this.getPlexIntegration();
      await Promise.all([this.initSelfRss(plex, owner.plexToken), this.initUsersRss(plex, owner.plexToken)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("RSS initialization failed at startup", { message });
    }
  }

  private async initSelfRss(plex: PlexIntegration, ownerToken: string): Promise<void> {
    this.selfRssUrl = await plex.fetchRssUrl("watchlist", ownerToken);
    if (!this.selfRssUrl) {
      this.logger.warn("Could not obtain self RSS feed URL. Plex Pass may not be active.");
      return;
    }
    const result = await plex.fetchRssFeedItems(this.selfRssUrl);
    if (!result.ok) {
      this.logger.warn("Failed to prime self RSS cache", { message: result.message, authError: result.authError });
      return;
    }
    this.selfRssCache.prime(result.items);
    this.selfRssPrimed = true;
    this.logger.info("Self RSS cache primed", { itemCount: this.selfRssCache.size });
  }

  private async initUsersRss(plex: PlexIntegration, ownerToken: string): Promise<void> {
    this.usersRssUrl = await plex.fetchRssUrl("friendsWatchlist", ownerToken);
    if (!this.usersRssUrl) {
      this.logger.warn("Could not obtain friends RSS feed URL. Plex Pass may not be active.");
      return;
    }
    const result = await plex.fetchRssFeedItems(this.usersRssUrl);
    if (!result.ok) {
      this.logger.warn("Failed to prime friends RSS cache", { message: result.message, authError: result.authError });
      return;
    }
    this.usersRssCache.prime(result.items);
    this.usersRssPrimed = true;
    this.logger.info("Friends RSS cache primed", { itemCount: this.usersRssCache.size });
  }

  // ---------------------------------------------------------------------------
  // RSS — polling
  // ---------------------------------------------------------------------------

  /**
   * Poll both Plex RSS feeds, diff against the in-memory caches, and process
   * any newly discovered watchlist items.
   *
   * Both feeds are polled in the same tick under a single sync run record.
   * If a feed was not yet primed (startup init failed or Plex wasn't configured)
   * initialization is retried before polling.
   */
  async pollRss() {
    const runId = this.db.createSyncRun("rss", "RSS sync started.");

    try {
      const plex = this.getPlexIntegration();

      // Retry init for any feed not yet primed
      if (!this.selfRssPrimed || !this.usersRssPrimed) {
        const owner = this.db.getPlexOwner();
        if (owner) {
          await Promise.all([
            !this.selfRssPrimed ? this.initSelfRss(plex, owner.plexToken) : Promise.resolve(),
            !this.usersRssPrimed ? this.initUsersRss(plex, owner.plexToken) : Promise.resolve()
          ]);
        }
      }

      if (!this.selfRssPrimed && !this.usersRssPrimed) {
        this.db.completeSyncRun(runId, "success", "RSS sync skipped: neither feed is initialized.", null);
        return this.db.listSyncRuns(1)[0];
      }

      let selfProcessed = 0;
      let friendsProcessed = 0;

      // Poll self feed
      if (this.selfRssPrimed && this.selfRssUrl) {
        const result = await plex.fetchRssFeedItems(this.selfRssUrl);
        if (!result.ok) {
          if (result.authError) {
            this.logger.warn("Self RSS auth error — check Plex Pass subscription and token RSS access", {
              message: result.message
            });
          } else {
            this.logger.warn("Self RSS fetch failed", { message: result.message });
          }
        } else {
          const newItems = this.selfRssCache.diff(result.items);
          if (newItems.length > 0) {
            this.logger.info("Self RSS feed detected new items", { count: newItems.length });
            selfProcessed = await this.processSelfRssNewItems(newItems, runId, plex);
          }
        }
      }

      // Poll friends feed
      if (this.usersRssPrimed && this.usersRssUrl) {
        const result = await plex.fetchRssFeedItems(this.usersRssUrl);
        if (!result.ok) {
          if (result.authError) {
            this.logger.warn("Friends RSS auth error — check Plex Pass subscription and token RSS access", {
              message: result.message
            });
          } else {
            this.logger.warn("Friends RSS fetch failed", { message: result.message });
          }
        } else {
          const newItems = this.usersRssCache.diff(result.items);
          if (newItems.length > 0) {
            this.logger.info("Friends RSS feed detected new items", { count: newItems.length });
            friendsProcessed = await this.processRssNewItems(newItems, runId, plex);
          }
        }
      }

      const total = selfProcessed + friendsProcessed;

      // Publish collections immediately when new items were found so the
      // watchlist is live in Plex without waiting for the next scheduled publish.
      if (total > 0) {
        this.logger.info("New RSS items processed — triggering collection publish", { count: total });
        try {
          await this.runPublishPass();
        } catch (publishErr) {
          this.logger.warn("Collection publish after RSS sync failed", {
            message: publishErr instanceof Error ? publishErr.message : String(publishErr)
          });
        }
      }

      this.db.completeSyncRun(
        runId,
        "success",
        total > 0
          ? `RSS sync: ${total} new item(s) processed (self: ${selfProcessed}, friends: ${friendsProcessed}).`
          : "RSS sync: 0 new items.",
        null
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("RSS sync failed", { message });
      this.db.completeSyncRun(runId, "error", "RSS sync failed.", message);
      throw error;
    }

    return this.db.listSyncRuns(1)[0];
  }

  // ---------------------------------------------------------------------------
  // RSS — item processing
  // ---------------------------------------------------------------------------

  /**
   * Process new items from the self (admin) RSS feed.
   * All items belong to the self user — no author matching needed.
   */
  private async processSelfRssNewItems(
    newItems: Array<RssFeedItem & { stableKey: string }>,
    runId: number,
    plex: PlexIntegration
  ): Promise<number> {
    const selfUser = this.db.listUsers().find((f) => f.isSelf);

    if (!selfUser) {
      this.logger.warn("Self RSS items detected but no self user record found — save Plex settings to create it");
      return 0;
    }

    if (!selfUser.enabled) {
      this.logger.debug("Self user is not enabled, skipping self RSS items");
      return 0;
    }

    const selfLibraries = this.getEffectiveLibraryIds(selfUser);
    if (!selfLibraries.movieLibraryId || !selfLibraries.showLibraryId) {
      this.logger.debug("Self user has no target libraries configured, skipping self RSS items");
      return 0;
    }

    let processedCount = 0;

    for (const item of newItems) {
      const libraryId = item.type === "movie" ? selfLibraries.movieLibraryId : selfLibraries.showLibraryId;
      const plexGuid = item.guids.find((g) => g.startsWith("plex://"));
      const plexItemId = plexGuid ?? item.stableKey;

      let matchedRatingKey: string | null = null;
      let watchlistItem: WatchlistItem = {
        plexItemId,
        title: item.title,
        type: item.type,
        year: item.year,
        // RSS pubDate is watchlist/feed timing, not the media release date.
        // releaseDate is populated by enrichWatchlistItem via discover metadata.
        releaseDate: null,
        thumb: item.thumb,
        guids: item.guids,
        source: "rss",
        addedAt: item.pubDate && !Number.isNaN(new Date(item.pubDate).getTime())
          ? new Date(item.pubDate).toISOString()
          : WATCHLIST_DATE_UNKNOWN_SENTINEL,
        matchedRatingKey: null
      };

      watchlistItem = await plex.enrichWatchlistItem(watchlistItem);

      try {
        const match = await plex.searchLibraryItem(item.title, item.type, libraryId, watchlistItem.year || undefined, item.guids);
        matchedRatingKey = match.ratingKey ?? null;
      } catch {
        // Not in local library yet
      }

      if (matchedRatingKey) {
        this.logger.debug("Self RSS item matched in library", {
          title: item.title,
          type: item.type,
          ratingKey: matchedRatingKey
        });
      } else {
        this.logger.warn("Self RSS item not matched in library", {
          title: item.title,
          type: item.type,
          year: watchlistItem.year ?? null,
          guids: item.guids
        });
      }

      watchlistItem = {
        ...watchlistItem,
        matchedRatingKey
      };

      this.db.upsertWatchlistItem(selfUser.id, watchlistItem);
      processedCount++;

      // Cache poster immediately for RSS-ingested items
      const plexSettings = this.db.getPlexSettings();
      if (plexSettings && watchlistItem.thumb) {
        if (watchlistItem.thumb.startsWith("/")) {
          await this.imageCache.ensurePosterCached(watchlistItem.plexItemId, {
            type: "plex-path",
            value: watchlistItem.thumb,
            serverUrl: plexSettings.serverUrl,
            token: plexSettings.token
          });
        } else if (watchlistItem.thumb.startsWith("https://")) {
          await this.imageCache.ensurePosterCached(watchlistItem.plexItemId, {
            type: "public-url",
            value: watchlistItem.thumb
          });
        }
      }

      this.logger.info("Self RSS item cached", {
        title: item.title,
        type: item.type,
        matchedRatingKey: matchedRatingKey ?? "(not in library)"
      });

      this.db.addSyncRunItem(runId, "watchlist.rss.self", "success", {
        title: item.title,
        type: item.type,
        matchedRatingKey
      }, selfUser.id);
    }

    return processedCount;
  }

  /**
   * Process new items from the friends RSS feed.
   * Groups by author field to attribute each item to the correct friend.
   */
  private async processRssNewItems(
    newItems: Array<RssFeedItem & { stableKey: string }>,
    runId: number,
    plex: PlexIntegration
  ): Promise<number> {
    const enabledUsers = this.db.listUsers().filter((f) => f.enabled && !f.isSelf);
    let processedCount = 0;

    for (const item of newItems) {
      const friend = item.author
        ? enabledUsers.find((f) => f.plexUserId === item.author)
        : null;

      if (!friend) {
        this.logger.warn("RSS item author not matched to any enabled friend — will be caught by full sync", {
          title: item.title,
          author: item.author || "(none)",
          knownFriendIds: enabledUsers.map((f) => f.plexUserId)
        });
        continue;
      }

      const effectiveLibraries = this.getEffectiveLibraryIds(friend);
      if (!effectiveLibraries.movieLibraryId || !effectiveLibraries.showLibraryId) {
        this.logger.debug("Friend not fully configured, skipping RSS item", {
          userId: friend.id,
          title: item.title
        });
        continue;
      }

      const libraryId = item.type === "movie" ? effectiveLibraries.movieLibraryId : effectiveLibraries.showLibraryId;
      const plexGuid = item.guids.find((g) => g.startsWith("plex://"));
      const plexItemId = plexGuid ?? item.stableKey;

      let matchedRatingKey: string | null = null;
      let watchlistItem: WatchlistItem = {
        plexItemId,
        title: item.title,
        type: item.type,
        year: item.year,
        // RSS pubDate is watchlist/feed timing, not the media release date.
        // releaseDate is populated by enrichWatchlistItem via discover metadata.
        releaseDate: null,
        thumb: item.thumb,
        guids: item.guids,
        source: "rss",
        addedAt: item.pubDate && !Number.isNaN(new Date(item.pubDate).getTime())
          ? new Date(item.pubDate).toISOString()
          : WATCHLIST_DATE_UNKNOWN_SENTINEL,
        matchedRatingKey: null
      };

      watchlistItem = await plex.enrichWatchlistItem(watchlistItem);

      try {
        const match = await plex.searchLibraryItem(item.title, item.type, libraryId, watchlistItem.year || undefined, item.guids);
        matchedRatingKey = match.ratingKey ?? null;
      } catch {
        // Not in local library yet
      }

      if (matchedRatingKey) {
        this.logger.debug("RSS item matched in library", {
          userId: friend.id,
          title: item.title,
          type: item.type,
          ratingKey: matchedRatingKey
        });
      } else {
        this.logger.warn("RSS item not matched in library", {
          userId: friend.id,
          title: item.title,
          type: item.type,
          year: watchlistItem.year ?? null,
          guids: item.guids
        });
      }

      watchlistItem = {
        ...watchlistItem,
        matchedRatingKey
      };

      this.db.upsertWatchlistItem(friend.id, watchlistItem);
      processedCount++;

      // Cache poster immediately for RSS-ingested items
      const plexSettings = this.db.getPlexSettings();
      if (plexSettings && watchlistItem.thumb) {
        if (watchlistItem.thumb.startsWith("/")) {
          await this.imageCache.ensurePosterCached(watchlistItem.plexItemId, {
            type: "plex-path",
            value: watchlistItem.thumb,
            serverUrl: plexSettings.serverUrl,
            token: plexSettings.token
          });
        } else if (watchlistItem.thumb.startsWith("https://")) {
          await this.imageCache.ensurePosterCached(watchlistItem.plexItemId, {
            type: "public-url",
            value: watchlistItem.thumb
          });
        }
      }

      this.logger.info("RSS item cached", {
        userId: friend.id,
        title: item.title,
        type: item.type,
        matchedRatingKey: matchedRatingKey ?? "(not in library)"
      });

      this.db.addSyncRunItem(runId, "watchlist.rss", "success", {
        userId: friend.id,
        title: item.title,
        type: item.type,
        matchedRatingKey
      }, friend.id);
    }

    return processedCount;
  }

  // ---------------------------------------------------------------------------
  // Isolation
  // ---------------------------------------------------------------------------

  /**
   * Apply per-user Plex content filter exclusions so each managed Plex user
   * only sees their own watchlist hub row. Non-throwing — a failure here is
   * logged as a warning so it doesn't abort a sync run.
   */
  async applyIsolationFilters(enabledUsers: UserRecord[], runId: number): Promise<void> {
    try {
      const plex = this.getPlexIntegration();
      const { updated, skipped } = await plex.syncIsolationFilters(enabledUsers);
      this.logger.info("Isolation filters applied", { updated, skipped });
      this.db.addSyncRunItem(runId, "isolation.filters", "success", { updated, skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Isolation filter sync failed — collections are still published, but visibility isolation may be incomplete", { message });
      this.db.addSyncRunItem(runId, "isolation.filters", "error", { message });
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings() {
    return this.db.getAppSettings();
  }

  updateSettings(patch: Partial<AppSettings>) {
    return this.db.updateAppSettings(patch);
  }

  async resetCollections() {
    const plex = this.getPlexIntegration();

    let deleted = 0;
    let skipped = 0;

    // Scan all Plex libraries for collections carrying a hubarr:* label.
    // This catches both DB-tracked collections and any orphaned ones.
    const libraries = await plex.getLibraries();

    for (const library of libraries) {
      const plexCollections = await plex.getCollections(library.key);
      for (const collection of plexCollections) {
        const labels = await plex.getCollectionLabels(collection.ratingKey);
        if (!labels.some((label) => label.toLowerCase().startsWith("hubarr:"))) {
          skipped++;
          continue;
        }
        await plex.deleteCollection(collection.ratingKey);
        deleted++;
      }
    }

    const isolation = await plex.clearHubarrIsolationFilters();
    this.db.clearCollections();

    this.logger.info("Hubarr collections reset", {
      deleted,
      skipped,
      isolationUpdated: isolation.updated,
      isolationSkipped: isolation.skipped
    });

    return {
      deleted,
      skipped,
      isolationUpdated: isolation.updated,
      isolationSkipped: isolation.skipped
    };
  }
}
