import path from "node:path";
import Database from "better-sqlite3";
import type {
  AppSettings,
  BootstrapStatus,
  DashboardResponse,
  ManagedUserRecord,
  OnboardingStep,
  PlexCollectionRecord,
  PlexOwnerRecord,
  PlexSettingsInput,
  PlexSettingsView,
  SessionUser,
  SyncRun,
  SyncRunActivity,
  SeerrRequestState,
  SeerrUserLink,
  UserRecord,
  WatchlistItem,
  WatchlistPageResponse,
  WatchlistSortBy
} from "../../shared/types.js";
import type { RuntimeConfig } from "../config.js";
import * as collectionsRepo from "./collections.js";
import * as identifiersRepo from "./identifiers.js";
import * as imageCacheRepo from "./image-cache.js";
import type { ImageCacheRow } from "./image-cache.js";
import { runMigrations } from "./migrations.js";
import * as settingsRepo from "./settings.js";
import type { SeerrStoredSettings } from "./settings.js";
import * as seerrRepo from "./seerr.js";
import type { UpsertSeerrUserLinkInput, UpsertSeerrRequestStateInput } from "./seerr.js";
import * as syncRepo from "./sync.js";
import * as usersRepo from "./users.js";
import * as watchlistRepo from "./watchlist.js";
import type { Logger } from "../logger.js";

export class HubarrDatabase {
  private readonly db: Database.Database;
  private readonly sessionSecret: string;
  private readonly logger?: Logger;

  constructor(config: RuntimeConfig, logger?: Logger) {
    this.db = new Database(path.join(config.dataDir, "hubarr.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.logger = logger;
    runMigrations(this.db, logger);
    // reconcileStaleRuns must run after migrations and before any job scheduling/registration
    // to prevent stale rows left in a `running` state during startup.
    syncRepo.reconcileStaleRuns(this.db, logger);
    settingsRepo.seedDefaultSettings(this.db);
    this.sessionSecret = settingsRepo.resolveSessionSecret(this.db);
  }

  getSessionSecret(): string {
    return this.sessionSecret;
  }

  // -------------------------------------------------------------------------
  // Bootstrap / Auth
  // -------------------------------------------------------------------------

  getBootstrapStatus(hasActiveSession: boolean): BootstrapStatus {
    return settingsRepo.getBootstrapStatus(this.db, hasActiveSession);
  }

  getCurrentOnboardingStep(): OnboardingStep {
    return settingsRepo.getCurrentOnboardingStep(this.db);
  }

  getPlexOwner(): PlexOwnerRecord | null {
    return settingsRepo.getPlexOwner(this.db);
  }

  savePlexOwner(owner: PlexOwnerRecord): void {
    settingsRepo.savePlexOwner(this.db, owner);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  createSession(id: string, plexId: string, expiresAt: string): void {
    settingsRepo.createSession(this.db, id, plexId, expiresAt);
  }

  getSession(id: string): SessionUser | null {
    return settingsRepo.getSession(this.db, id);
  }

  deleteSession(id: string): void {
    settingsRepo.deleteSession(this.db, id);
  }

  deleteAllSessions(): void {
    settingsRepo.deleteAllSessions(this.db);
  }

  // -------------------------------------------------------------------------
  // App Settings
  // -------------------------------------------------------------------------

  getAppSettings(): AppSettings {
    return settingsRepo.getAppSettings(this.db);
  }

  updateAppSettings(patch: Partial<AppSettings>): AppSettings {
    const next = settingsRepo.updateAppSettings(this.db, patch);
    if (patch.collectionNamePattern !== undefined) {
      usersRepo.refreshDerivedCollectionNames(this.db);
    }
    syncRepo.pruneSyncRuns(this.db, settingsRepo.calculateHistoryRetentionEvents(next));
    return next;
  }

  // -------------------------------------------------------------------------
  // Plex Server Settings
  // -------------------------------------------------------------------------

  getPlexSettings(): PlexSettingsInput | null {
    return settingsRepo.getPlexSettings(this.db);
  }

  savePlexSettings(input: PlexSettingsInput): void {
    settingsRepo.savePlexSettings(this.db, input);
  }

  updatePlexSettingsToken(token: string): void {
    settingsRepo.updatePlexSettingsToken(this.db, token);
  }

  getPlexSettingsView(): PlexSettingsView | null {
    return settingsRepo.getPlexSettingsView(this.db);
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  upsertUsers(
    users: Array<{
      plexUserId: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    }>
  ): UserRecord[] {
    return usersRepo.upsertUsers(this.db, users);
  }

  upsertSelfUser(account: {
    plexUserId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  }): void {
    usersRepo.upsertSelfUser(this.db, account);
  }

  listUsers(): UserRecord[] {
    return usersRepo.listUsers(this.db);
  }

  listDisabledUserIds(): number[] {
    return usersRepo.listDisabledUserIds(this.db);
  }

  upsertManagedUsers(
    users: Array<{
      plexUserId: string;
      displayName: string;
      avatarUrl: string | null;
      hasRestrictionProfile: boolean;
    }>
  ): ManagedUserRecord[] {
    return usersRepo.upsertManagedUsers(this.db, users);
  }

  listManagedUsers(): ManagedUserRecord[] {
    return usersRepo.listManagedUsers(this.db);
  }

  getUser(id: number): UserRecord | null {
    return usersRepo.getUser(this.db, id);
  }

  updateUser(
    id: number,
    patch: Partial<
      Pick<
        UserRecord,
        "enabled" | "movieLibraryId" | "showLibraryId" | "visibilityOverride" | "displayNameOverride" | "collectionNameOverride" | "collectionSortOrderOverride"
      >
    >
  ): UserRecord {
    return usersRepo.updateUser(this.db, id, patch);
  }

  bulkUpdateUsers(ids: number[], enabled: boolean): number[] {
    return usersRepo.bulkUpdateUsers(this.db, ids, enabled);
  }

  refreshDerivedCollectionNames(): void {
    usersRepo.refreshDerivedCollectionNames(this.db);
  }

  markUserSyncResult(userId: number, error: string | null): void {
    usersRepo.markUserSyncResult(this.db, userId, error);
  }

  upsertUserIdentifierAlias(userId: number, identifierValue: string): void {
    identifiersRepo.upsertUserIdentifierAlias(this.db, userId, identifierValue);
  }

  // -------------------------------------------------------------------------
  // Watchlist
  // -------------------------------------------------------------------------

  getWatchlistDiscoverKey(plexItemId: string): string | null {
    return watchlistRepo.getWatchlistDiscoverKey(this.db, plexItemId);
  }

  upsertWatchlistItem(userId: number, item: WatchlistItem): void {
    watchlistRepo.upsertWatchlistItem(this.db, userId, item);
  }

  clearMatchedRatingKey(userId: number, plexItemId: string): void {
    watchlistRepo.clearMatchedRatingKey(this.db, userId, plexItemId);
  }

  clearMatchedRatingKeyByValue(ratingKey: string): void {
    watchlistRepo.clearMatchedRatingKeyByValue(this.db, ratingKey);
  }

  deleteWatchlistItem(userId: number, plexItemId: string): number {
    return watchlistRepo.deleteWatchlistItem(this.db, userId, plexItemId);
  }

  upsertMediaItemIdentifiers(item: Pick<WatchlistItem, "plexItemId" | "type" | "guids" | "discoverKey">): void {
    identifiersRepo.upsertMediaItemIdentifiers(this.db, item);
  }

  batchUpsertMediaItemIdentifiers(items: Array<Pick<WatchlistItem, "plexItemId" | "type" | "guids" | "discoverKey">>): void {
    identifiersRepo.batchUpsertMediaItemIdentifiers(this.db, items);
  }

  replaceWatchlistItems(userId: number, items: WatchlistItem[]): void {
    watchlistRepo.replaceWatchlistItems(this.db, userId, items);
  }

  getWatchlistItems(userId?: number): WatchlistItem[] {
    return watchlistRepo.getWatchlistItems(this.db, userId);
  }

  getWatchlistGrouped(options: {
    userId?: number;
    mediaType?: "movie" | "show";
    availability?: "available" | "missing" | "requested";
    sortBy?: WatchlistSortBy;
    page: number;
    pageSize: number;
  }): WatchlistPageResponse {
    return watchlistRepo.getWatchlistGrouped(this.db, options, this.logger);
  }

  computeWatchlistHash(userId: number, mediaType: "movie" | "show"): string {
    return watchlistRepo.computeWatchlistHash(this.db, userId, mediaType);
  }

  upsertActivityCacheEntries(
    entries: Array<{ plexItemId: string; plexUserId: string; watchlistedAt: string }>
  ): void {
    watchlistRepo.upsertActivityCacheEntries(this.db, entries);
  }

  getActivityCacheDate(plexItemId: string, plexUserId: string): string | null {
    return watchlistRepo.getActivityCacheDate(this.db, plexItemId, plexUserId);
  }

  countUnresolvedWatchlistDatesAfterActivityCache(userId: number): number {
    return watchlistRepo.countUnresolvedWatchlistDatesAfterActivityCache(this.db, userId);
  }

  getActivityCacheDateForUserItem(userId: number, plexItemId: string): string | null {
    return identifiersRepo.getActivityCacheDateForUserItem(this.db, userId, plexItemId);
  }

  getActivityCacheDatesForUser(userId: number): Map<string, string> {
    return identifiersRepo.getActivityCacheDatesForUser(this.db, userId);
  }

  clearActivityCache(): number {
    return watchlistRepo.clearActivityCache(this.db);
  }

  deleteWatchlistItemsForUsers(userIds: number[]): number {
    return watchlistRepo.deleteWatchlistItemsForUsers(this.db, userIds);
  }

  // -------------------------------------------------------------------------
  // Image Cache
  // -------------------------------------------------------------------------

  getImageCacheEntry(cacheKey: string): ImageCacheRow | null {
    return imageCacheRepo.getImageCacheEntry(this.db, cacheKey);
  }

  upsertImageCacheEntry(entry: Parameters<typeof imageCacheRepo.upsertImageCacheEntry>[1]): void {
    imageCacheRepo.upsertImageCacheEntry(this.db, entry);
  }

  markImageCacheRefreshAttempt(cacheKey: string, attemptedAt: string): void {
    imageCacheRepo.markImageCacheRefreshAttempt(this.db, cacheKey, attemptedAt);
  }

  markImageCacheRefreshSuccess(cacheKey: string, opts: Parameters<typeof imageCacheRepo.markImageCacheRefreshSuccess>[2]): void {
    imageCacheRepo.markImageCacheRefreshSuccess(this.db, cacheKey, opts);
  }

  markImageCacheRefreshFailure(cacheKey: string, opts: { attemptedAt: string; error: string }): void {
    imageCacheRepo.markImageCacheRefreshFailure(this.db, cacheKey, opts);
  }

  listAllImageCacheWebPaths(): string[] {
    return imageCacheRepo.listAllImageCacheWebPaths(this.db);
  }

  deleteOrphanedPosterCacheEntries(): number {
    return imageCacheRepo.deleteOrphanedPosterCacheEntries(this.db);
  }

  clearImageCacheTable(): void {
    imageCacheRepo.clearImageCacheTable(this.db);
  }

  // -------------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------------

  upsertCollectionRecord(
    userId: number,
    mediaType: "movie" | "show",
    patch: Omit<PlexCollectionRecord, "id" | "userId" | "mediaType">
  ): void {
    collectionsRepo.upsertCollectionRecord(this.db, userId, mediaType, patch);
  }

  getCollectionRecord(userId: number, mediaType: "movie" | "show"): PlexCollectionRecord | null {
    return collectionsRepo.getCollectionRecord(this.db, userId, mediaType);
  }

  clearCollectionRatingKey(userId: number, mediaType: "movie" | "show"): void {
    collectionsRepo.clearCollectionRatingKey(this.db, userId, mediaType);
  }

  listCollections(): PlexCollectionRecord[] {
    return collectionsRepo.listCollections(this.db);
  }

  clearCollections(): void {
    collectionsRepo.clearCollections(this.db);
  }

  getIsolationFilterState(): settingsRepo.IsolationFilterState | null {
    return settingsRepo.getIsolationFilterState(this.db);
  }

  saveIsolationFilterState(inputHash: string): settingsRepo.IsolationFilterState {
    return settingsRepo.saveIsolationFilterState(this.db, inputHash);
  }

  clearIsolationFilterState(): void {
    settingsRepo.clearIsolationFilterState(this.db);
  }

  // -------------------------------------------------------------------------
  // Sync Runs
  // -------------------------------------------------------------------------

  getJobRunState(jobId: string): { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | null {
    return syncRepo.getJobRunState(this.db, jobId);
  }

  saveJobRunState(jobId: string, state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }): void {
    syncRepo.saveJobRunState(this.db, jobId, state);
  }

  createSyncRun(kind: SyncRun["kind"], summary: string): number {
    return syncRepo.createSyncRun(this.db, kind, summary);
  }

  completeSyncRun(id: number, status: SyncRun["status"], summary: string, error: string | null, activity?: SyncRunActivity): void {
    syncRepo.completeSyncRun(this.db, id, status, summary, error, activity);
  }

  updateSyncRunSummary(id: number, summary: string): void {
    syncRepo.updateSyncRunSummary(this.db, id, summary);
  }

  addSyncRunItem(runId: number, action: string, status: SyncRun["status"], details: unknown, userId?: number): void {
    syncRepo.addSyncRunItem(this.db, runId, action, status, details, userId);
  }

  listSyncRuns(limit = 10): SyncRun[] {
    return syncRepo.listSyncRuns(this.db, limit);
  }

  listSyncRunsPaginated(options: {
    page: number;
    pageSize: number;
    kind?: string;
    status?: string;
    activity?: string;
  }): { results: SyncRun[]; total: number } {
    return syncRepo.listSyncRunsPaginated(this.db, options);
  }

  getSyncRunWithItems(runId: number): (SyncRun & { items: Array<{ id: number; runId: number; userId: number | null; action: string; status: string; details: unknown; createdAt: string }> }) | null {
    return syncRepo.getSyncRunWithItems(this.db, runId);
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  buildDashboard(): DashboardResponse {
    return syncRepo.buildDashboard(this.db);
  }

  // -------------------------------------------------------------------------
  // Seerr settings
  // -------------------------------------------------------------------------

  getSeerrSettings(): SeerrStoredSettings {
    return settingsRepo.getSeerrSettings(this.db);
  }

  saveSeerrSettings(settings: SeerrStoredSettings): void {
    settingsRepo.saveSeerrSettings(this.db, settings);
  }

  updateSeerrSettings(patch: Partial<SeerrStoredSettings>): SeerrStoredSettings {
    return settingsRepo.updateSeerrSettings(this.db, patch);
  }

  // -------------------------------------------------------------------------
  // Seerr user links
  // -------------------------------------------------------------------------

  getSeerrUserLink(userId: number): SeerrUserLink | null {
    return seerrRepo.getSeerrUserLink(this.db, userId);
  }

  listSeerrUserLinks(): SeerrUserLink[] {
    return seerrRepo.listSeerrUserLinks(this.db);
  }

  upsertSeerrUserLink(input: UpsertSeerrUserLinkInput): SeerrUserLink {
    return seerrRepo.upsertSeerrUserLink(this.db, input);
  }

  deleteSeerrUserLink(userId: number): void {
    seerrRepo.deleteSeerrUserLink(this.db, userId);
  }

  // -------------------------------------------------------------------------
  // Seerr request state
  // -------------------------------------------------------------------------

  getSeerrRequestState(userId: number, plexItemId: string): SeerrRequestState | null {
    return seerrRepo.getSeerrRequestState(this.db, userId, plexItemId);
  }

  listSeerrRequestStatesForItem(plexItemId: string): SeerrRequestState[] {
    return seerrRepo.listSeerrRequestStatesForItem(this.db, plexItemId);
  }

  listSeerrRequestStatesForUser(userId: number): SeerrRequestState[] {
    return seerrRepo.listSeerrRequestStatesForUser(this.db, userId);
  }

  deleteSkippedUnlinkedSeerrRequestStatesForUser(userId: number): number {
    return seerrRepo.deleteSkippedUnlinkedRequestStatesForUser(this.db, userId);
  }

  listSeerrRequestedPlexItemIds(plexItemIds: string[]): Set<string> {
    return seerrRepo.listSeerrRequestedPlexItemIds(this.db, plexItemIds);
  }

  upsertSeerrRequestState(input: UpsertSeerrRequestStateInput): SeerrRequestState {
    return seerrRepo.upsertSeerrRequestState(this.db, input);
  }

  deleteSeerrRequestState(userId: number, plexItemId: string): void {
    seerrRepo.deleteSeerrRequestState(this.db, userId, plexItemId);
  }
}
