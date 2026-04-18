import type {
  AppSettings,
  CollectionSortOrder,
  PreloadPhase,
  PreloadProgressEvent,
  UserRecord,
  PlexSettingsInput,
  WatchlistItem
} from "../shared/types.js";
import pLimit from "p-limit";
import { HubarrDatabase } from "./db/index.js";
import { ImageCacheService } from "./image-cache.js";
import { Logger } from "./logger.js";
import { PlexIntegration, WATCHLIST_DATE_UNKNOWN_SENTINEL, type PlexLibraryItemMatch, type ResolvedWatchlistItem } from "./integrations/plex.js";
import { RssCache, type RssFeedItem } from "./rss-cache.js";

const PLEX_SYNC_CONCURRENCY = 3;

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
function compareByWatchlistDate(
  a: WatchlistItem,
  b: WatchlistItem,
  direction: Extract<CollectionSortOrder, "watchlist-date-desc" | "watchlist-date-asc">
): number {
  const aSentinel = a.addedAt === WATCHLIST_DATE_UNKNOWN_SENTINEL;
  const bSentinel = b.addedAt === WATCHLIST_DATE_UNKNOWN_SENTINEL;

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
  private onboardingPreloadSession: {
    events: PreloadProgressEvent[];
    listeners: Set<(event: PreloadProgressEvent) => void>;
    promise: Promise<void>;
    completed: boolean;
  } | null = null;

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

  private updateRunProgressSummary(
    runId: number,
    kind: "full" | "publish",
    completed: number,
    total: number
  ): void {
    if (kind === "publish") {
      this.db.updateSyncRunSummary(runId, `Collection sync: publishing collections (${completed}/${total} users).`);
      return;
    }

    this.db.updateSyncRunSummary(runId, `Full sync: syncing watchlists (${completed}/${total} users).`);
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

  async runUsersDiscoverJob() {
    this.logger.info("User discovery started", {
      label: "Refresh Users"
    });

    try {
      const users = await this.discoverUsers();
      this.logger.info("User discovery complete", {
        label: "Refresh Users",
        discoveredUsers: users.length,
        managedUsers: this.db.listManagedUsers().length
      });
      return users;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("User discovery failed", {
        label: "Refresh Users",
        message
      });
      throw error;
    }
  }

  /**
   * Runs the three-phase onboarding preload sequence and streams progress
   * events back to the caller via the provided callback.
   *
   * Phases:
   *  1. activity-cache  — initial watchlist activity feed sync
   *  2. graphql-sync    — watchlist GraphQL sync for all tracked users
   *  3. publish-collections — create/update Plex collections for enabled users
   *
   * Individual phase failures are reported but do not abort the remaining
   * phases — the sequence always runs to completion. If the client refreshes
   * mid-run, reconnecting callers subscribe to the same in-flight preload
   * session instead of starting over.
   */
  async runOnboardingPreload(onProgress: (event: PreloadProgressEvent) => void): Promise<void> {
    if (this.onboardingPreloadSession !== null) {
      const session = this.onboardingPreloadSession;
      const snapshot = Array.from(session.events);
      session.listeners.add(onProgress);
      try {
        for (const event of snapshot) {
          this.deliverPreloadEvent(session, onProgress, event);
        }
        if (session.completed) {
          session.listeners.delete(onProgress);
          return;
        }

        await session.promise;
      } finally {
        session.listeners.delete(onProgress);
      }
      return;
    }

    const session = {
      events: [] as PreloadProgressEvent[],
      listeners: new Set<(event: PreloadProgressEvent) => void>([onProgress]),
      promise: Promise.resolve(),
      completed: false
    };
    this.onboardingPreloadSession = session;

    const emit = (
      phase: PreloadPhase,
      status: PreloadProgressEvent["status"],
      message: string,
      extra?: Pick<PreloadProgressEvent, "progress" | "total">
    ) => {
      const event: PreloadProgressEvent = { phase, status, message, ...extra };
      session.events.push(event);
      for (const listener of [...session.listeners]) {
        this.deliverPreloadEvent(session, listener, event);
      }
    };

    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<T>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
      });
      return Promise.race([promise, timer]).finally(() => clearTimeout(timerId));
    };

    session.promise = (async () => {
      this.logger.info("Onboarding preload started");

      // ------------------------------------------------------------------
      // Phase 1: Activity cache sync
      // ------------------------------------------------------------------
      emit("activity-cache", "running", "Syncing activity feed...");
      try {
        await withTimeout(this.syncActivityCache(), 120_000, "Activity cache sync");
        emit("activity-cache", "done", "Activity feed synced");
        this.logger.info("Onboarding preload: activity cache sync complete");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Onboarding preload: activity cache sync failed — continuing", { message });
        emit("activity-cache", "error", `Could not sync activity feed: ${message}`);
      }

      // ------------------------------------------------------------------
      // Phase 2: GraphQL watchlist sync for tracked users
      // ------------------------------------------------------------------
      const { trackedUsers } = this.getUserScopes();
      if (trackedUsers.length === 0) {
        emit("graphql-sync", "done", "No users to sync yet", { progress: 0, total: 0 });
        this.logger.info("Onboarding preload: no tracked users, skipping watchlist sync");
      } else {
        const total = trackedUsers.length;
        emit("graphql-sync", "running", `Syncing watchlists for ${total} user${total !== 1 ? "s" : ""}...`, { progress: 0, total });

        const runId = this.db.createSyncRun("full", "Onboarding preload watchlist sync.");
        let succeeded = 0;
        let onboardingCompleted = 0;
        const failures: string[] = [];

        const onboardingLimit = pLimit(PLEX_SYNC_CONCURRENCY);
        await Promise.all(trackedUsers.map((user) =>
          onboardingLimit(async () => {
            const syncPromise = this.syncUser(user, runId);
            let timedOut = false;
            try {
              await withTimeout(syncPromise, 60_000, `User sync for ${user.displayName}`);
            } catch {
              timedOut = true;
            } finally {
              // Always await the underlying sync before recording the outcome so
              // a timeout rejection doesn't prematurely mark a user as failed
              // when syncUser() completes successfully moments later.
              const outcome = await syncPromise.then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) })
              );

              if (outcome.ok) {
                succeeded++;
                if (timedOut) {
                  this.logger.warn("Onboarding preload: user sync exceeded timeout but eventually completed", {
                    userId: user.id,
                    displayName: user.displayName
                  });
                }
              } else {
                failures.push(`${user.displayName}: ${outcome.message}`);
                this.logger.warn("Onboarding preload: user sync failed — continuing", {
                  userId: user.id,
                  displayName: user.displayName,
                  message: outcome.message
                });
                this.db.addSyncRunItem(runId, "sync.user", "error", {
                  userId: user.id,
                  displayName: user.displayName,
                  message: outcome.message
                }, user.id);
              }

              onboardingCompleted++;
              emit("graphql-sync", "running", `Syncing watchlists (${onboardingCompleted}/${total})...`, { progress: onboardingCompleted, total });
            }
          })
        ));

        const runStatus = succeeded === total ? "success" : "error";
        this.db.completeSyncRun(
          runId,
          runStatus,
          `Onboarding preload: ${succeeded}/${total} users synced.`,
          failures.length > 0 ? failures.join(" | ") : null
        );
        emit("graphql-sync", "done", `Synced watchlists for ${succeeded} of ${total} user${total !== 1 ? "s" : ""}`, { progress: total, total });
        this.logger.info("Onboarding preload: watchlist sync complete", { succeeded, failed: total - succeeded });
      }

      // ------------------------------------------------------------------
      // Phase 3: Publish collections so they are live in Plex immediately
      // ------------------------------------------------------------------
      emit("publish-collections", "running", "Publishing collections...");
      try {
        await withTimeout(this.runPublishPass(), 120_000, "Publish collections");
        emit("publish-collections", "done", "Collections published");
        this.logger.info("Onboarding preload: collection publish complete");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Onboarding preload: collection publish failed — continuing", { message });
        emit("publish-collections", "error", `Could not publish collections: ${message}`);
      }

      emit("complete", "done", "Hubarr is ready");
      session.completed = true;
      this.logger.info("Onboarding preload complete");
    })().catch((error) => {
      if (this.onboardingPreloadSession === session) {
        this.onboardingPreloadSession = null;
      }
      throw error;
    });

    try {
      await session.promise;
    } finally {
      session.listeners.delete(onProgress);
    }
  }

  /**
   * Protect the shared preload workflow from listener-specific failures such
   * as disconnected SSE responses throwing while we replay or broadcast.
   */
  private deliverPreloadEvent(
    session: NonNullable<HubarrServices["onboardingPreloadSession"]>,
    listener: (event: PreloadProgressEvent) => void,
    event: PreloadProgressEvent
  ): void {
    try {
      listener(event);
    } catch (error) {
      session.listeners.delete(listener);
      this.logger.debug("Dropped onboarding preload listener after delivery failure", {
        phase: event.phase,
        status: event.status,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  isPreloadComplete(): boolean {
    return this.onboardingPreloadSession?.completed === true;
  }

  clearOnboardingPreloadSession(): void {
    this.onboardingPreloadSession = null;
  }

  runMaintenanceTasks() {
    this.logger.info("Maintenance tasks started", {
      label: "Maintenance Tasks"
    });

    const result = this.imageCache.runMaintenanceTasks();

    this.logger.info("Maintenance tasks complete", {
      label: "Maintenance Tasks",
      ...result
    });

    return result;
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

  private getUserScopes() {
    const settings = this.db.getAppSettings();
    const users = this.db.listUsers();
    return {
      settings,
      users,
      trackedUsers: users.filter((user) => user.enabled || settings.trackAllUsers),
      publishingUsers: users.filter((user) => user.enabled)
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
        // item.matchedRatingKey comes from resolveWatchlistItems which always
        // sets it explicitly (string or null). Using !== undefined lets a null
        // (meaning "not in library right now") clear a stale stored key, while
        // undefined (not yet resolved) falls back to whatever is stored.
        matchedRatingKey: (() => {
          if (item.matchedRatingKey !== undefined) {
            if (item.matchedRatingKey === null && existing?.matchedRatingKey) {
              this.logger.info("Clearing stale Plex match for watchlist item", {
                title: item.title,
                type: item.type,
                staleRatingKey: existing.matchedRatingKey
              });
            }
            return item.matchedRatingKey;
          }
          return existing?.matchedRatingKey ?? null;
        })()
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
    const { trackedUsers } = this.getUserScopes();
    const libraries = new Map<string, { libraryId: string; mediaType: "movie" | "show"; userIds: number[] }>();

    for (const friend of trackedUsers) {
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

    const userMap = new Map(trackedUsers.map((u) => [u.id, u]));
    const watchlistByUser = new Map(trackedUsers.map((u) => [u.id, this.db.getWatchlistItems(u.id)]));

    let matchedCount = 0;
    let clearedCount = 0;
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
      // Pre-build a set of all ratingKey values so items that lack GUIDs can
      // still have their stored matchedRatingKey validated against the library.
      const libraryRatingKeys = new Set(guidToRatingKey.values());

      // If Plex returned items but none had GUIDs, skip this library entirely.
      // GUIDs are the only reliable cross-reference between Plex library items
      // and stored watchlist rating keys. Without them, neither matching nor
      // stale-key detection is safe — any attempt to clear or update keys would
      // risk false positives. Skipping preserves all existing keys unchanged
      // until GUIDs become available on a future scan.
      if (libraryItems.length > 0 && guidToRatingKey.size === 0) {
        this.logger.warn("Skipping library scan for missing GUIDs", {
          libraryId: library.libraryId,
          mediaType: library.mediaType,
          mode: options.mode,
          libraryItemCount: libraryItems.length
        });
        continue;
      }

      // If a full scan returned zero library items, the library appears empty.
      // Clear all stored matches for users in this library so they don't keep
      // pointing at keys that no longer exist. Recent scans are skipped here —
      // an empty "recently added" result just means nothing was added lately.
      if (libraryItems.length === 0) {
        if (options.mode === "full") {
          for (const friendId of library.userIds) {
            const watchlistItems = watchlistByUser.get(friendId) ?? [];
            let friendChanged = false;
            for (const item of watchlistItems) {
              if (item.type !== library.mediaType || !item.matchedRatingKey) continue;
              this.db.clearMatchedRatingKey(friendId, item.plexItemId);
              clearedCount++;
              friendChanged = true;
              this.logger.info("Clearing stale Plex match — library returned empty during full scan", {
                friendId,
                title: item.title,
                type: item.type,
                staleRatingKey: item.matchedRatingKey,
                libraryId: library.libraryId
              });
            }
            if (friendChanged) {
              affectedUsers++;
              this.db.markUserSyncResult(friendId, null);
            }
          }
        }
        continue;
      }

      for (const friendId of library.userIds) {
        const friend = userMap.get(friendId);
        if (!friend) {
          continue;
        }

        const watchlistItems = watchlistByUser.get(friendId) ?? [];
        let friendChanged = false;

        for (const item of watchlistItems) {
          if (item.type !== library.mediaType) {
            continue;
          }

          if (!item.guids?.length) {
            // No GUIDs — GUID-based matching and re-match detection are not
            // possible, but we can still validate a stored matchedRatingKey by
            // checking whether it appears anywhere in the current library.
            if (item.matchedRatingKey && !libraryRatingKeys.has(item.matchedRatingKey) && options.mode === "full") {
              this.db.clearMatchedRatingKey(friendId, item.plexItemId);
              clearedCount++;
              friendChanged = true;
              this.logger.info("Clearing stale Plex match for item without GUIDs during full library scan", {
                friendId,
                displayName: friend.displayName,
                title: item.title,
                type: item.type,
                staleRatingKey: item.matchedRatingKey
              });
            }
            continue;
          }

          const match = item.guids
            .map((guid) => guidToRatingKey.get(guid.toLowerCase()))
            .find((ratingKey): ratingKey is string => Boolean(ratingKey));

          if (item.matchedRatingKey) {
            // Item already has a stored match — verify it against the current library.
            if (match === item.matchedRatingKey) {
              continue; // Still valid, nothing to do
            }
            if (match) {
              // Item was re-imported under a new ratingKey — update to the new one
              this.db.upsertWatchlistItem(friendId, { ...item, matchedRatingKey: match });
              matchedCount++;
              friendChanged = true;
              this.logger.info("Updated stale Plex match to new rating key during library scan", {
                label: options.mode === "recent" ? "Plex Recently Added Scan" : "Plex Full Library Scan",
                friendId,
                displayName: friend.displayName,
                title: item.title,
                type: item.type,
                oldRatingKey: item.matchedRatingKey,
                newRatingKey: match
              });
            } else if (options.mode === "full") {
              // Full scan covers the entire library; absence of the GUID means
              // the item was deleted. Clear the stale match so the watchlist row
              // stays but the library link is severed. Recent scans are skipped
              // here — the item may exist but simply wasn't recently added.
              this.db.clearMatchedRatingKey(friendId, item.plexItemId);
              clearedCount++;
              friendChanged = true;
              this.logger.info("Clearing stale Plex match during full library scan", {
                friendId,
                displayName: friend.displayName,
                title: item.title,
                type: item.type,
                staleRatingKey: item.matchedRatingKey
              });
            }
            continue;
          }

          // No existing match — try to match against the current library
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
      clearedCount,
      affectedUsers
    });

    return {
      matchedCount,
      affectedUsers
    };
  }

  async syncUser(friend: UserRecord, runId: number, rssDateMap?: Map<string, string>) {
    const { movieLibraryId, showLibraryId } = this.getEffectiveLibraryIds(friend);
    if (!movieLibraryId || !showLibraryId) {
      throw new Error("Friend must have both target libraries selected.");
    }

    const syncStart = Date.now();
    this.logger.info("Starting watchlist sync", {
      userId: friend.id,
      displayName: friend.displayName,
      isSelf: friend.isSelf,
      enabled: friend.enabled
    });

    const plex = this.getPlexIntegration();

    // Self and friends both use the same GraphQL-safe watchlist baseline.
    // addedAt is intentionally left as WATCHLIST_DATE_UNKNOWN_SENTINEL here —
    // the merge and activity cache lookup below are responsible for resolving it.
    //
    // For the self user, also fetch their Plex UUID. Plex uses two ID formats
    // for the admin account: a legacy numeric ID and a GraphQL UUID. We store
    // both as explicit aliases on the same local user record so downstream
    // lookups can resolve activity rows without hand-written fallback chains.
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

    const [movieItems, showItems] = await Promise.all([
      plex.resolveWatchlistItems(rawItems, "movie", movieLibraryId),
      plex.resolveWatchlistItems(rawItems, "show", showLibraryId)
    ]);
    const fetched: ResolvedWatchlistItem[] = [...movieItems, ...showItems].sort((a, b) => a.title.localeCompare(b.title));

    if (selfPlexUuid) {
      this.db.upsertUserIdentifierAlias(friend.id, selfPlexUuid);
    }

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

    // Pre-register merged item identifiers before the activity-cache lookup so
    // newly fetched items can resolve dates through the alias catalog on this
    // same sync pass, before replaceWatchlistItems persists the watchlist.
    // All writes go in one transaction to avoid per-item auto-commit overhead.
    this.db.batchUpsertMediaItemIdentifiers(merged);

    // Step 1: Resolve addedAt from the activity cache for items still carrying
    // the sentinel. One bulk query fetches all cached dates for this user at
    // once; the resulting map is keyed by normalized identifier value so any
    // plexItemId that matches a stored identifier or canonical key will hit.
    const activityCacheDates = this.db.getActivityCacheDatesForUser(friend.id);
    const afterActivityCache = merged.map((item) => {
      if (item.addedAt !== WATCHLIST_DATE_UNKNOWN_SENTINEL) return item;
      const cached = activityCacheDates.get(item.plexItemId.trim().toLowerCase());
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
      const imageLimit = pLimit(5);
      await Promise.all(mergedWithDates.map((item) =>
        imageLimit(async () => {
          try {
            if (!item.thumb) return;
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
          } catch (err) {
            this.logger.warn("Failed to cache poster image; skipping", {
              userId: friend.id,
              displayName: friend.displayName,
              plexItemId: item.plexItemId,
              thumb: item.thumb,
              message: err instanceof Error ? err.message : String(err)
            });
          }
        })
      ));
    }

    this.db.addSyncRunItem(
      runId,
      "watchlist.fetch",
      "success",
      {
        userId: friend.id,
        displayName: friend.displayName,
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
        const unknownDateItems = filteredItems.filter((item) => item.addedAt === WATCHLIST_DATE_UNKNOWN_SENTINEL);
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
      const { staleKeys: syncStaleKeys } = await plex.syncCollectionItems(collectionRatingKey, matchedRatingKeys);
      if (syncStaleKeys.size > 0) {
        this.logger.warn("Clearing stale matched rating keys found during collection sync", {
          userId: friend.id,
          mediaType,
          staleKeys: [...syncStaleKeys]
        });
        for (const key of syncStaleKeys) {
          this.db.clearMatchedRatingKeyByValue(key);
        }
      }
      // Exclude stale keys from reorder so move operations don't fail on items
      // that were never successfully added to the collection.
      const reorderKeys = syncStaleKeys.size > 0
        ? matchedRatingKeys.filter((k) => !syncStaleKeys.has(k))
        : matchedRatingKeys;
      // Push explicit item positions for all custom-ordered modes. For title
      // sort, Plex manages ordering so the moves are no-ops from the user's
      // perspective, but the call still detects keys that are no longer valid
      // in Plex via move failures (404).
      const { staleKeys: reorderStaleKeys } = await plex.reorderCollectionItems(collectionRatingKey, reorderKeys);
      if (reorderStaleKeys.size > 0) {
        this.logger.warn("Clearing stale matched rating keys found during collection reorder", {
          userId: friend.id,
          mediaType,
          staleKeys: [...reorderStaleKeys]
        });
        for (const key of reorderStaleKeys) {
          this.db.clearMatchedRatingKeyByValue(key);
        }
      }
      // Build the cleaned key list that was actually published — excludes any
      // stale keys discovered during sync or reorder.
      const cleanedKeys = (syncStaleKeys.size > 0 || reorderStaleKeys.size > 0)
        ? matchedRatingKeys.filter((k) => !syncStaleKeys.has(k) && !reorderStaleKeys.has(k))
        : matchedRatingKeys;
      this.logger.info("Collection items synced", {
        userId: friend.id,
        mediaType,
        collectionRatingKey,
        matchedItems: cleanedKeys.length
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
      const hash = plex.hashRatingKeys(cleanedKeys);
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
            displayName: friend.displayName,
            mediaType,
            collectionName,
            collectionRatingKey,
            matchedItems: cleanedKeys.length
          },
          friend.id
        );
      }
    }
  }

  async runFullSync() {
    const syncStart = Date.now();
    const runId = this.db.createSyncRun("full", "Full sync started.");
    const { trackedUsers, publishingUsers } = this.getUserScopes();
    const friends = trackedUsers;
    const failures: string[] = [];

    this.logger.info("Full sync started", {
      userCount: friends.length,
      trackedUsers: friends.length,
      publishingUsers: publishingUsers.length
    });

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

    const limit = pLimit(PLEX_SYNC_CONCURRENCY);
    let completed = 0;

    await Promise.all(friends.map((friend) =>
      limit(async () => {
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
          this.db.addSyncRunItem(runId, "sync.user", "error", {
            userId: friend.id,
            displayName: friend.displayName,
            message
          }, friend.id);
          failures.push(`${friend.displayName}: ${message}`);
        } finally {
          completed++;
          this.updateRunProgressSummary(runId, "full", completed, friends.length);
        }
      })
    ));

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
    await this.runPublishPass().then(() => {
      this.db.addSyncRunItem(runId, "collection.publish.followup", "success", {
        sourceRunKind: "full",
        message: "Triggered collection publish after full sync."
      });
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Collection publish after full sync failed", {
        message
      });
      this.db.addSyncRunItem(runId, "collection.publish.followup", "error", {
        sourceRunKind: "full",
        message
      });
    });

    return this.db.listSyncRuns(1)[0];
  }

  async runUserSync(userId: number) {
    const friend = this.db.getUser(userId);
    if (!friend) {
      throw new Error("Friend not found.");
    }
    if (!friend.enabled) {
      this.logger.warn("Manual sync rejected for disabled user", {
        userId: friend.id,
        displayName: friend.displayName
      });
      throw new Error("Disabled users can only be tracked by background sync.");
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
    const { publishingUsers } = this.getUserScopes();
    const friends = publishingUsers;
    const failures: string[] = [];
    const plex = this.getPlexIntegration();

    this.logger.info("Collection sync started", { userCount: friends.length });

    const publishLimit = pLimit(PLEX_SYNC_CONCURRENCY);
    let publishCompleted = 0;

    await Promise.all(friends.map((friend) =>
      publishLimit(async () => {
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
          this.db.addSyncRunItem(runId, "collection.publish", "error", {
            userId: friend.id,
            displayName: friend.displayName,
            message
          }, friend.id);
          failures.push(`${friend.displayName}: ${message}`);
        } finally {
          publishCompleted++;
          this.updateRunProgressSummary(runId, "publish", publishCompleted, friends.length);
        }
      })
    ));

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
    const { settings, trackedUsers, publishingUsers } = this.getUserScopes();

    try {
      const plex = this.getPlexIntegration();
      this.logger.info("RSS sync started", {
        trackedUsers: trackedUsers.length,
        publishingUsers: publishingUsers.length
      });

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
          this.db.addSyncRunItem(runId, "rss.feed.check.self", "error", {
            feed: "self",
            checked: true,
            found: 0,
            authError: result.authError,
            message: result.message
          });
          if (result.authError) {
            this.logger.warn("Self RSS auth error — check Plex Pass subscription and token RSS access", {
              message: result.message
            });
          } else {
            this.logger.warn("Self RSS fetch failed", { message: result.message });
          }
        } else {
          const newItems = this.selfRssCache.diff(result.items);
          this.db.addSyncRunItem(runId, "rss.feed.check.self", "success", {
            feed: "self",
            checked: true,
            found: newItems.length
          });
          if (newItems.length > 0) {
            this.logger.info("Self RSS feed detected new items", { count: newItems.length });
            selfProcessed = await this.processSelfRssNewItems(newItems, runId, plex, settings);
          }
        }
      } else {
        this.db.addSyncRunItem(runId, "rss.feed.check.self", "success", {
          feed: "self",
          checked: false,
          found: 0
        });
      }

      // Poll friends feed
      if (this.usersRssPrimed && this.usersRssUrl) {
        const result = await plex.fetchRssFeedItems(this.usersRssUrl);
        if (!result.ok) {
          this.db.addSyncRunItem(runId, "rss.feed.check.friends", "error", {
            feed: "friends",
            checked: true,
            found: 0,
            authError: result.authError,
            message: result.message
          });
          if (result.authError) {
            this.logger.warn("Friends RSS auth error — check Plex Pass subscription and token RSS access", {
              message: result.message
            });
          } else {
            this.logger.warn("Friends RSS fetch failed", { message: result.message });
          }
        } else {
          const newItems = this.usersRssCache.diff(result.items);
          this.db.addSyncRunItem(runId, "rss.feed.check.friends", "success", {
            feed: "friends",
            checked: true,
            found: newItems.length
          });
          if (newItems.length > 0) {
            this.logger.info("Friends RSS feed detected new items", { count: newItems.length });
            friendsProcessed = await this.processRssNewItems(
              newItems,
              runId,
              plex,
              trackedUsers.filter((user) => !user.isSelf)
            );
          }
        }
      } else {
        this.db.addSyncRunItem(runId, "rss.feed.check.friends", "success", {
          feed: "friends",
          checked: false,
          found: 0
        });
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
    plex: PlexIntegration,
    settings: AppSettings
  ): Promise<number> {
    const selfUser = this.db.listUsers().find((f) => f.isSelf);

    if (!selfUser) {
      this.logger.warn("Self RSS items detected but no self user record found — save Plex settings to create it");
      return 0;
    }

    if (!selfUser.enabled && !settings.trackAllUsers) {
      this.logger.debug("Self user is not currently tracked, skipping self RSS items");
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

      let matchedRatingKey: string | null = null;
      let watchlistItem: WatchlistItem = {
        // Use stableKey as a temporary ID — replaced below after enrichment
        // adds the plex:// GUID to the guids array if the RSS feed omitted it.
        plexItemId: item.stableKey,
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

      // Resolve the canonical plex:// GUID now that enrichment has populated
      // the full guids array. The RSS feed itself often omits the plex:// GUID,
      // so we defer this until after enrichment rather than using item.guids.
      const enrichedPlexGuid = watchlistItem.guids?.find((g) => g.startsWith("plex://"));
      if (enrichedPlexGuid) {
        const hex = enrichedPlexGuid.replace(/^plex:\/\/(?:movie|show)\//, "");
        watchlistItem = {
          ...watchlistItem,
          plexItemId: enrichedPlexGuid,
          discoverKey: `/library/metadata/${hex}`
        };
      }

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
        displayName: selfUser.displayName,
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
    plex: PlexIntegration,
    trackedUsers: UserRecord[]
  ): Promise<number> {
    let processedCount = 0;

    for (const item of newItems) {
      const friend = item.author
        ? trackedUsers.find((f) => f.plexUserId === item.author)
        : null;

      if (!friend) {
        this.logger.warn("RSS item author not matched to any tracked friend — will be caught by full sync", {
          title: item.title,
          author: item.author || "(none)",
          knownFriendIds: trackedUsers.map((f) => f.plexUserId)
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

      let matchedRatingKey: string | null = null;
      let watchlistItem: WatchlistItem = {
        // Use stableKey as a temporary ID — replaced below after enrichment
        // adds the plex:// GUID to the guids array if the RSS feed omitted it.
        plexItemId: item.stableKey,
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

      // Resolve the canonical plex:// GUID now that enrichment has populated
      // the full guids array. The RSS feed itself often omits the plex:// GUID,
      // so we defer this until after enrichment rather than using item.guids.
      const enrichedPlexGuid = watchlistItem.guids?.find((g) => g.startsWith("plex://"));
      if (enrichedPlexGuid) {
        const hex = enrichedPlexGuid.replace(/^plex:\/\/(?:movie|show)\//, "");
        watchlistItem = {
          ...watchlistItem,
          plexItemId: enrichedPlexGuid,
          discoverKey: `/library/metadata/${hex}`
        };
      }

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
        enabled: friend.enabled,
        title: item.title,
        type: item.type,
        matchedRatingKey: matchedRatingKey ?? "(not in library)"
      });

      this.db.addSyncRunItem(runId, "watchlist.rss", "success", {
        userId: friend.id,
        displayName: friend.displayName,
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
    const current = this.db.getAppSettings();
    const next = this.db.updateAppSettings(patch);

    if (current.trackAllUsers && !next.trackAllUsers) {
      const removed = this.db.deleteWatchlistItemsForUsers(this.db.listDisabledUserIds());
      this.logger.info("Disabled-user watchlist cache deleted after Track All Users was disabled", {
        removed
      });
    }

    return next;
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