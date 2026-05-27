import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AppSettings,
  BootstrapStatus,
  OnboardingStep,
  PlexOwnerRecord,
  PlexSettingsInput,
  PlexSettingsView,
  SessionUser
} from "../../shared/types.js";

export type SettingKey = "admin" | "plex" | "app" | "session_secret" | "seerr";

export const defaultAppSettings: AppSettings = {
  reconciliationIntervalMinutes: 60,
  activityCacheFetchIntervalMinutes: 60,
  watchlistCleanupIntervalMinutes: 30,
  watchlistCleanupMovies: false,
  watchlistCleanupShows: false,
  rssPollIntervalSeconds: 300,
  rssEnabled: true,
  trackAllUsers: false,
  collectionPublishIntervalMinutes: 5,
  plexRecentlyAddedScanIntervalMinutes: 5,
  plexFullLibraryScanIntervalMinutes: 1440,
  historyRetentionDays: 7,
  collectionNamePattern: "{user}s Watchlist",
  collectionSortOrder: "date-desc",
  visibilityDefaults: {
    recommended: false,
    home: true,
    shared: false
  },
  fullSyncOnStartup: false,
  defaultMovieLibraryId: null,
  defaultShowLibraryId: null,
  trustProxy: false,
  usersStepComplete: false,
  onboardingComplete: false
};

export function getSetting<T>(db: Database.Database, key: SettingKey): T | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.value) as T;
}

export function setSetting(db: Database.Database, key: SettingKey, value: unknown): void {
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), updatedAt);
}

export function seedDefaultSettings(db: Database.Database): void {
  if (!getSetting<AppSettings>(db, "app")) {
    setSetting(db, "app", defaultAppSettings);
  }
}

export function resolveSessionSecret(db: Database.Database): string {
  const stored = getSetting<string>(db, "session_secret");
  if (stored) return stored;
  const secret = crypto.randomBytes(48).toString("hex");
  setSetting(db, "session_secret", secret);
  return secret;
}

// -------------------------------------------------------------------------
// Bootstrap / Auth
// -------------------------------------------------------------------------

/**
 * Reports whether the instance has enough persisted configuration to run and
 * whether the onboarding wizard has been formally completed.
 */
export function getBootstrapStatus(db: Database.Database, hasActiveSession: boolean): BootstrapStatus {
  const plexSettings = getSetting<PlexSettingsInput>(db, "plex");
  const appSettings = getAppSettings(db);
  const configurationValid = Boolean(
    plexSettings?.serverUrl &&
      appSettings.defaultMovieLibraryId &&
      appSettings.defaultShowLibraryId
  );

  return {
    hasOwner: Boolean(getSetting<PlexOwnerRecord>(db, "admin")),
    configurationValid,
    onboardingComplete: appSettings.onboardingComplete,
    hasActiveSession
  };
}

/**
 * Resumes onboarding from the earliest step that still lacks a persisted
 * completion marker.
 */
export function getCurrentOnboardingStep(db: Database.Database): OnboardingStep {
  const owner = getPlexOwner(db);
  if (!owner) {
    return "auth";
  }

  // General comes before Plex in the onboarding order. General has no
  // persistent completion marker, so if Plex isn't configured yet we resume
  // at General (the earliest un-gated step before Plex).
  const plexSettings = getPlexSettings(db);
  if (!plexSettings?.serverUrl) {
    return "general";
  }

  const appSettings = getAppSettings(db);
  if (!appSettings.defaultMovieLibraryId || !appSettings.defaultShowLibraryId) {
    return "collections";
  }

  if (!appSettings.usersStepComplete) {
    return "users";
  }

  return "preload";
}

export function getPlexOwner(db: Database.Database): PlexOwnerRecord | null {
  return getSetting<PlexOwnerRecord>(db, "admin");
}

export function savePlexOwner(db: Database.Database, owner: PlexOwnerRecord): void {
  setSetting(db, "admin", owner);
}

// -------------------------------------------------------------------------
// Sessions
// -------------------------------------------------------------------------

export function createSession(
  db: Database.Database,
  id: string,
  plexId: string,
  expiresAt: string
): void {
  db.prepare(`
    INSERT INTO sessions (id, username, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, plexId, expiresAt, new Date().toISOString());
}

export function getSession(db: Database.Database, id: string): SessionUser | null {
  const row = db
    .prepare("SELECT username AS plexId, expires_at FROM sessions WHERE id = ?")
    .get(id) as { plexId: string; expires_at: string } | undefined;

  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    deleteSession(db, id);
    return null;
  }

  const owner = getPlexOwner(db);
  if (!owner || owner.plexId !== row.plexId) return null;

  // Resolve avatar from image_cache — local path only, no external URL fallback
  const avatarRow = db
    .prepare("SELECT ic.local_web_path FROM image_cache ic WHERE ic.cache_key = 'avatar:' || ?")
    .get(owner.plexId) as { local_web_path: string | null } | undefined;

  return {
    plexId: owner.plexId,
    username: owner.username,
    displayName: owner.displayName,
    email: owner.email ?? null,
    avatarUrl: avatarRow?.local_web_path ?? null
  };
}

export function deleteSession(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function deleteAllSessions(db: Database.Database): void {
  db.prepare("DELETE FROM sessions").run();
}

// -------------------------------------------------------------------------
// App Settings
// -------------------------------------------------------------------------

export function getAppSettings(db: Database.Database): AppSettings {
  const stored = getSetting<AppSettings>(db, "app");
  return { ...defaultAppSettings, ...stored };
}

export function updateAppSettings(db: Database.Database, patch: Partial<AppSettings>): AppSettings {
  const current = getAppSettings(db);
  const next: AppSettings = {
    ...current,
    ...patch,
    visibilityDefaults: {
      ...current.visibilityDefaults,
      ...(patch.visibilityDefaults ?? {})
    }
  };
  setSetting(db, "app", next);
  return next;
}

export function calculateHistoryRetentionEvents(settings: AppSettings): number {
  const fullSyncsPerDay = 1440 / settings.reconciliationIntervalMinutes;
  const rssSyncsPerDay = settings.rssEnabled ? 86400 / settings.rssPollIntervalSeconds : 0;
  const publishSyncsPerDay = 1440 / settings.collectionPublishIntervalMinutes;
  const cleanupSyncsPerDay = (settings.watchlistCleanupMovies || settings.watchlistCleanupShows)
    ? 1440 / settings.watchlistCleanupIntervalMinutes
    : 0;
  const totalSyncsPerDay = fullSyncsPerDay + rssSyncsPerDay + publishSyncsPerDay + cleanupSyncsPerDay;
  return Math.max(1, Math.floor(settings.historyRetentionDays * totalSyncsPerDay));
}

// -------------------------------------------------------------------------
// Plex Server Settings
// -------------------------------------------------------------------------

export function getPlexSettings(db: Database.Database): PlexSettingsInput | null {
  return getSetting<PlexSettingsInput>(db, "plex");
}

export function savePlexSettings(db: Database.Database, input: PlexSettingsInput): void {
  setSetting(db, "plex", input);
}

export function updatePlexSettingsToken(db: Database.Database, token: string): void {
  const settings = getPlexSettings(db);
  if (!settings) return;
  savePlexSettings(db, { ...settings, token });
}

// -------------------------------------------------------------------------
// Seerr Settings
// -------------------------------------------------------------------------

export interface SeerrStoredSettings {
  enabled: boolean;
  baseUrl: string;
  /** Admin API key — never sent to the client. */
  apiKey: string;
  autoRequestEnabled: boolean;
  useServiceAccount: boolean;
  serviceAccountSeerrUserId: number | null;
}

const defaultSeerrSettings: SeerrStoredSettings = {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  autoRequestEnabled: false,
  useServiceAccount: false,
  serviceAccountSeerrUserId: null
};

export function getSeerrSettings(db: Database.Database): SeerrStoredSettings {
  const stored = getSetting<SeerrStoredSettings>(db, "seerr");
  return { ...defaultSeerrSettings, ...stored };
}

export function saveSeerrSettings(db: Database.Database, settings: SeerrStoredSettings): void {
  setSetting(db, "seerr", settings);
}

export function updateSeerrSettings(
  db: Database.Database,
  patch: Partial<SeerrStoredSettings>
): SeerrStoredSettings {
  const current = getSeerrSettings(db);
  const next: SeerrStoredSettings = { ...current, ...patch };
  setSetting(db, "seerr", next);
  return next;
}

export function getPlexSettingsView(db: Database.Database): PlexSettingsView | null {
  const settings = getPlexSettings(db);
  if (!settings) return null;
  const url = new URL(settings.serverUrl);
  return {
    serverUrl: settings.serverUrl,
    machineIdentifier: settings.machineIdentifier,
    tokenConfigured: Boolean(settings.token),
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? "443" : "80")),
    useSsl: url.protocol === "https:"
  };
}
