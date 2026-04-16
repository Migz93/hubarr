import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

export type SettingKey = "admin" | "plex" | "app" | "session_secret";

export const defaultAppSettings: AppSettings = {
  reconciliationIntervalMinutes: 60,
  activityCacheFetchIntervalMinutes: 60,
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

/**
 * Normalize legacy collection sort order values to the current date-based names.
 * Existing installs may have "year-desc" or "year-asc" stored in settings.
 */
function normalizeSortOrder(value: string): AppSettings["collectionSortOrder"] {
  if (value === "year-desc") return "date-desc";
  if (value === "year-asc") return "date-asc";
  if (value === "date-desc" || value === "date-asc" || value === "title" || value === "watchlist-date-desc" || value === "watchlist-date-asc") return value;
  return "date-desc";
}

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

/**
 * Resolve the session signing secret from the database.
 *
 * On the first run after migrating from the file-based approach, any existing
 * .session_secret file is read into the database and then deleted so that
 * existing sessions remain valid. If no secret exists anywhere a new one is
 * generated and persisted.
 */
export function resolveSessionSecret(db: Database.Database, dataDir: string): string {
  const stored = getSetting<string>(db, "session_secret");
  if (stored) {
    return stored;
  }

  // One-time migration: pull the value out of the legacy file if it exists.
  const legacyFile = path.join(dataDir, ".session_secret");
  let secret: string;
  try {
    secret = fs.readFileSync(legacyFile, "utf8").trim();
    fs.unlinkSync(legacyFile);
  } catch {
    // File didn't exist — generate a fresh secret.
    secret = crypto.randomBytes(48).toString("hex");
  }

  setSetting(db, "session_secret", secret);
  return secret;
}

// -------------------------------------------------------------------------
// Bootstrap / Auth
// -------------------------------------------------------------------------

export function getBootstrapStatus(db: Database.Database, hasActiveSession: boolean): BootstrapStatus {
  const plexSettings = getSetting<PlexSettingsInput>(db, "plex");
  const appSettings = getAppSettings(db);
  const setupComplete = Boolean(
    plexSettings?.serverUrl &&
      appSettings.defaultMovieLibraryId &&
      appSettings.defaultShowLibraryId
  );

  // Backwards-compat: existing installs that were fully configured before the
  // onboardingComplete flag was introduced won't have the field in stored
  // settings. For these we derive onboardingComplete from setupComplete so
  // they aren't forced through the wizard again.
  const stored = getSetting<AppSettings>(db, "app");
  const hasFlag = stored !== null && "onboardingComplete" in stored;
  const onboardingComplete = hasFlag ? appSettings.onboardingComplete : setupComplete;

  return {
    hasOwner: Boolean(getSetting<PlexOwnerRecord>(db, "admin")),
    setupComplete,
    onboardingComplete,
    hasActiveSession
  };
}

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
  const merged = { ...defaultAppSettings, ...stored };
  // Normalize on every read so existing installs that stored the old "year-desc" /
  // "year-asc" values automatically upgrade to "date-desc" / "date-asc" without
  // requiring a schema migration or a manual settings save.
  merged.collectionSortOrder = normalizeSortOrder(merged.collectionSortOrder);
  return merged;
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
  const totalSyncsPerDay = fullSyncsPerDay + rssSyncsPerDay + publishSyncsPerDay;
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
