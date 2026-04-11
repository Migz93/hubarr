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
  UserRecord,
  WatchlistItem,
  WatchlistPageResponse,
  WatchlistSortBy
} from "../../shared/types.js";
import type { RuntimeConfig } from "../config.js";
import * as collectionsRepo from "./collections.js";
import * as imageCacheRepo from "./image-cache.js";
import type { ImageCacheRow } from "./image-cache.js";
import { runMigrations } from "./migrations.js";
import * as settingsRepo from "./settings.js";
import * as syncRepo from "./sync.js";
import * as usersRepo from "./users.js";
import * as watchlistRepo from "./watchlist.js";

export class HubarrDatabase {
  private readonly db: Database.Database;

  constructor(config: RuntimeConfig) {
    this.db = new Database(path.join(config.dataDir, "hubarr.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    runMigrations(this.db);
    settingsRepo.seedDefaultSettings(this.db);
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
        "enabled" | "movieLibraryId" | "showLibraryId" | "visibilityOverride" | "displayNameOverride" | "collectionNameOverride"
      >
    >
  ): UserRecord | null {
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

  // -------------------------------------------------------------------------
  // Watchlist
  // -------------------------------------------------------------------------

  getWatchlistDiscoverKey(plexItemId: string): string | null {
    return watchlistRepo.getWatchlistDiscoverKey(this.db, plexItemId);
  }

  upsertWatchlistItem(userId: number, item: WatchlistItem): void {
    watchlistRepo.upsertWatchlistItem(this.db, userId, item);
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
    availability?: "available" | "missing";
    sortBy?: WatchlistSortBy;
    page: number;
    pageSize: number;
  }): WatchlistPageResponse {
    return watchlistRepo.getWatchlistGrouped(this.db, options);
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

  clearActivityCache(): number {
    return watchlistRepo.clearActivityCache(this.db);
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

  listCollections(): PlexCollectionRecord[] {
    return collectionsRepo.listCollections(this.db);
  }

  clearCollections(): void {
    collectionsRepo.clearCollections(this.db);
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

  completeSyncRun(id: number, status: SyncRun["status"], summary: string, error: string | null): void {
    syncRepo.completeSyncRun(this.db, id, status, summary, error);
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
}
