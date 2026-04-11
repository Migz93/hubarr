export type SyncStatus = "idle" | "running" | "success" | "error";
export type MediaType = "movie" | "show";

export interface BootstrapStatus {
  hasOwner: boolean;
  setupComplete: boolean;
  hasActiveSession: boolean;
}

export type OnboardingStep = "auth" | "plex" | "collections";

export interface SessionUser {
  plexId: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface PlexOwnerRecord {
  plexId: string;
  plexToken: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface PlexSettingsInput {
  serverUrl: string;
  token: string;
  machineIdentifier: string;
  movieLibraryId: string;
  showLibraryId: string;
}

export interface PlexSettingsView {
  serverUrl: string;
  machineIdentifier: string;
  tokenConfigured: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
}

export interface VisibilityConfig {
  recommended: boolean;
  home: boolean;
  shared: boolean;
}

export type CollectionSortOrder = "date-desc" | "date-asc" | "title" | "watchlist-date-desc" | "watchlist-date-asc";

export type WatchlistSortBy = "added-desc" | "added-asc" | "title-asc" | "title-desc" | "year-desc" | "year-asc";

export interface AppSettings {
  reconciliationIntervalMinutes: number;
  activityCacheFetchIntervalMinutes: number;
  rssPollIntervalSeconds: number;
  rssEnabled: boolean;
  collectionPublishIntervalMinutes: number;
  plexRecentlyAddedScanIntervalMinutes: number;
  plexFullLibraryScanIntervalMinutes: number;
  historyRetentionDays: number;
  collectionNamePattern: string;
  collectionSortOrder: CollectionSortOrder;
  visibilityDefaults: VisibilityConfig;
  fullSyncOnStartup: boolean;
  defaultMovieLibraryId: string | null;
  defaultShowLibraryId: string | null;
}

export interface UserRecord {
  id: number;
  plexUserId: string;
  username: string;
  displayNameOverride: string | null;
  displayName: string;
  avatarUrl: string | null;
  isSelf: boolean;
  enabled: boolean;
  movieLibraryId: string | null;
  showLibraryId: string | null;
  visibilityOverride: VisibilityConfig | null;
  collectionNameOverride: string | null;
  collectionName: string;
  /** Per-user collection sort order. null means fall back to the global collectionSortOrder setting. */
  collectionSortOrderOverride: CollectionSortOrder | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface ManagedUserRecord {
  plexUserId: string;
  displayName: string;
  avatarUrl: string | null;
  hasRestrictionProfile: boolean;
}

export interface WatchlistItem {
  plexItemId: string;
  title: string;
  type: MediaType;
  /** The title's release year. Kept for display, matching, and as a fallback
   *  when a full releaseDate is not available. Not used for collection ordering. */
  year: number | null;
  /** ISO date string (YYYY-MM-DD) representing the media's original release date.
   *  Sourced from Plex discover metadata `originallyAvailableAt`.
   *  Used for collection sort ordering.
   *
   *  Distinct from `addedAt`, which records when the item entered the watchlist/feed
   *  and must never be used as a proxy for the media release date.
   *
   *  null when not yet discovered; synthesised as YYYY-01-01 from `year` as a
   *  last resort when no full date is available. */
  releaseDate: string | null;
  thumb: string | null;
  guids?: string[];
  discoverKey?: string;
  source: "graphql" | "rss";
  /** ISO timestamp of when this item entered the watchlist or RSS feed.
   *  Used for watchlist recency views and RSS diffing only — not for collection ordering. */
  addedAt: string;
  matchedRatingKey: string | null;
}

export interface RichItemMetadata {
  summary: string | null;
  tagline: string | null;
  contentRating: string | null;
  audienceRating: number | null;
  duration: number | null;
  studio: string | null;
  genres: string[];
}

export interface WatchlistUser {
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  addedAt: string;
}

export interface WatchlistGroupedItem {
  plexItemId: string;
  title: string;
  year: number | null;
  type: MediaType;
  posterUrl: string | null;
  addedAt: string;
  userCount: number;
  users: WatchlistUser[];
  plexAvailable: boolean;
  matchedRatingKey: string | null;
}

export interface WatchlistPageResponse {
  items: WatchlistGroupedItem[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    userId: number | null;
    mediaType: "all" | MediaType;
    sortBy: WatchlistSortBy;
  };
  facets: {
    allUsersCount: number;
    users: Array<{
      userId: number;
      displayName: string;
      avatarUrl: string | null;
      count: number;
    }>;
    media: {
      all: number;
      movie: number;
      show: number;
    };
  };
}

export interface PlexCollectionRecord {
  id: number;
  userId: number;
  mediaType: MediaType;
  collectionRatingKey: string | null;
  visibleName: string;
  labelName: string | null;
  hubIdentifier: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface SyncRun {
  id: number;
  kind: "full" | "user" | "rss" | "publish";
  status: SyncStatus;
  startedAt: string;
  completedAt: string | null;
  summary: string;
  error: string | null;
}

export interface RecentlyAddedItem {
  plexItemId: string;
  title: string;
  year: number | null;
  type: MediaType;
  posterUrl: string | null;
  users: WatchlistUser[];
  addedAt: string;
  plexAvailable: boolean;
}

export interface DashboardStats {
  enabledUsers: number;
  trackedMovies: number;
  trackedShows: number;
}

export interface DashboardResponse {
  recentlyAdded: RecentlyAddedItem[];
  stats: DashboardStats;
  syncActivity: SyncRun[];
}

export interface SetupStatusResponse {
  configured: boolean;
  plex: PlexSettingsView | null;
  collectionsConfigured: boolean;
  currentStep: OnboardingStep;
}

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
}

export interface HealthResponse {
  ok: true;
  appName: string;
  version: string;
  timestamp: string;
  uptimeSeconds: number;
  scheduler: {
    reconciliationIntervalMinutes: number;
    rssPollIntervalSeconds: number;
    rssEnabled: boolean;
  };
}

export interface PlexServer {
  name: string;
  machineIdentifier: string;
  connections: Array<{
    uri: string;
    address: string;
    port: number;
    protocol: string;
    local: boolean;
    status: number | null;
    message: string | null;
  }>;
}

export interface PlexLibrary {
  id: string;
  name: string;
  type: "movie" | "show";
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

export interface LogsPageResponse {
  results: LogEntry[];
  pageInfo: {
    page: number;
    pageSize: number;
    pages: number;
    total: number;
  };
}

export interface SearchCandidate {
  title: string;
  year: number | null;
  ratingKey: string;
  guids: string[];
}

export interface SyncRunItem {
  id: number;
  runId: number;
  userId: number | null;
  action: string;
  status: "success" | "error";
  details: unknown;
  createdAt: string;
}

export interface SyncRunDetail extends SyncRun {
  items: SyncRunItem[];
}

export interface HistoryPageResponse {
  results: SyncRun[];
  pageInfo: {
    page: number;
    pageSize: number;
    pages: number;
    total: number;
  };
}

export interface JobInfo {
  id: string;
  name: string;
  intervalDescription: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
}

export interface AboutInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  dataDir: string;
  tz: string;
}

export interface SettingsResponse {
  general: {
    fullSyncOnStartup: boolean;
    historyRetentionDays: number;
  };
  sync: {
    reconciliationIntervalMinutes: number;
    rssPollIntervalSeconds: number;
    rssEnabled: boolean;
  };
  plex: PlexSettingsView | null;
  collections: {
    collectionNamePattern: string;
    collectionSortOrder: CollectionSortOrder;
    movieLibraryId: string | null;
    showLibraryId: string | null;
    visibilityDefaults: VisibilityConfig;
  };
}

export interface PlexConnectionOption {
  name: string;
  machineIdentifier: string;
  uri: string;
  address: string;
  port: number;
  protocol: string;
  local: boolean;
  status: number | null;
  message: string | null;
}

export interface PlexConfigPayload {
  mode: "preset" | "manual";
  machineIdentifier?: string;
  serverUrl?: string;
  hostname?: string;
  port?: number;
  useSsl?: boolean;
}
