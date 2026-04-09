import type Database from "better-sqlite3";
import type { ManagedUserRecord, UserRecord } from "../../shared/types.js";
import { getAppSettings } from "./settings.js";

function buildCollectionName(
  effectiveDisplayName: string,
  pattern: string,
  collectionNameOverride: string | null
): string {
  return (collectionNameOverride && collectionNameOverride.trim()) || pattern.replace("{user}", effectiveDisplayName);
}

export function upsertUsers(
  db: Database.Database,
  users: Array<{
    plexUserId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  }>
): UserRecord[] {
  const appSettings = getAppSettings(db);
  const stmt = db.prepare(`
    INSERT INTO users (
      plex_user_id, username, display_name, avatar_url, enabled, visibility_mode, collection_name
    )
    VALUES (@plexUserId, @username, @displayName, @avatarUrl, 0, 'shared-home', @collectionName)
    ON CONFLICT(plex_user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url
  `);

  db.transaction(() => {
    for (const user of users) {
      stmt.run({ ...user, collectionName: buildCollectionName(user.username, appSettings.collectionNamePattern, null) });
    }
  })();

  return listUsers(db);
}

export function upsertSelfUser(
  db: Database.Database,
  account: {
    plexUserId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  }
): void {
  const appSettings = getAppSettings(db);
  const collectionName = buildCollectionName(account.username, appSettings.collectionNamePattern, null);
  db.prepare(`
    INSERT INTO users (
      plex_user_id, username, display_name, avatar_url, is_self, enabled, visibility_mode, collection_name
    )
    VALUES (@plexUserId, @username, @displayName, @avatarUrl, 1, 0, 'shared-home', @collectionName)
    ON CONFLICT(plex_user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      is_self = 1
  `).run({ ...account, collectionName });
}

export function listUsers(db: Database.Database): UserRecord[] {
  return db
    .prepare(`
      SELECT
        id,
        plex_user_id AS plexUserId,
        username,
        display_name_override AS displayNameOverride,
        COALESCE(display_name_override, username) AS displayName,
        avatar_url AS avatarUrl,
        is_self AS isSelf,
        enabled,
        movie_library_id AS movieLibraryId,
        show_library_id AS showLibraryId,
        visibility_mode AS visibilityMode,
        visibility_override AS visibilityOverride,
        collection_name_override AS collectionNameOverride,
        collection_name AS collectionName,
        last_synced_at AS lastSyncedAt,
        last_sync_error AS lastSyncError
      FROM users
      ORDER BY is_self DESC, enabled DESC, LOWER(display_name) ASC
    `)
    .all()
    .map((row) => {
      const r = row as Omit<UserRecord, "enabled" | "isSelf" | "visibilityOverride"> & {
        enabled: number;
        isSelf: number;
        visibilityOverride: string | null;
      };
      return {
        ...r,
        isSelf: Boolean(r.isSelf),
        enabled: Boolean(r.enabled),
        visibilityOverride: r.visibilityOverride
          ? (JSON.parse(r.visibilityOverride) as UserRecord["visibilityOverride"])
          : null
      };
    }) as UserRecord[];
}

export function getUser(db: Database.Database, id: number): UserRecord | null {
  return listUsers(db).find((u) => u.id === id) || null;
}

export function updateUser(
  db: Database.Database,
  id: number,
  patch: Partial<
    Pick<
      UserRecord,
      "enabled" | "movieLibraryId" | "showLibraryId" | "visibilityOverride" | "displayNameOverride" | "collectionNameOverride"
    >
  >
): UserRecord | null {
  const current = getUser(db, id);
  if (!current) throw new Error("User not found.");

  const next = { ...current, ...patch };
  const effectiveName = next.displayNameOverride || current.username;
  const appSettings = getAppSettings(db);
  const collectionName = buildCollectionName(
    effectiveName,
    appSettings.collectionNamePattern,
    next.collectionNameOverride ?? null
  );

  db.prepare(`
    UPDATE users
    SET enabled = ?, movie_library_id = ?, show_library_id = ?,
        visibility_override = ?, display_name_override = ?, collection_name_override = ?, collection_name = ?
    WHERE id = ?
  `).run(
    next.enabled ? 1 : 0,
    next.movieLibraryId ?? null,
    next.showLibraryId ?? null,
    next.visibilityOverride !== undefined ? JSON.stringify(next.visibilityOverride) : null,
    next.displayNameOverride ?? null,
    next.collectionNameOverride ?? null,
    collectionName,
    id
  );

  return getUser(db, id);
}

export function bulkUpdateUsers(db: Database.Database, ids: number[], enabled: boolean): number[] {
  const stmt = db.prepare("UPDATE users SET enabled = ? WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) {
      stmt.run(enabled ? 1 : 0, id);
    }
  })();
  return ids;
}

export function refreshDerivedCollectionNames(db: Database.Database): void {
  const appSettings = getAppSettings(db);
  const rows = db
    .prepare(`
      SELECT id, username, display_name_override AS displayNameOverride, collection_name_override AS collectionNameOverride
      FROM users
    `)
    .all() as Array<{
      id: number;
      username: string;
      displayNameOverride: string | null;
      collectionNameOverride: string | null;
    }>;

  const stmt = db.prepare("UPDATE users SET collection_name = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      const effectiveName = row.displayNameOverride || row.username;
      const collectionName = buildCollectionName(
        effectiveName,
        appSettings.collectionNamePattern,
        row.collectionNameOverride
      );
      stmt.run(collectionName, row.id);
    }
  })();
}

export function markUserSyncResult(db: Database.Database, userId: number, error: string | null): void {
  db.prepare("UPDATE users SET last_synced_at = ?, last_sync_error = ? WHERE id = ?")
    .run(new Date().toISOString(), error, userId);
}

export function upsertManagedUsers(
  db: Database.Database,
  users: Array<{
    plexUserId: string;
    displayName: string;
    avatarUrl: string | null;
    hasRestrictionProfile: boolean;
  }>
): ManagedUserRecord[] {
  const stmt = db.prepare(`
    INSERT INTO managed_users (plex_user_id, display_name, avatar_url, has_restriction_profile)
    VALUES (@plexUserId, @displayName, @avatarUrl, @hasRestrictionProfile)
    ON CONFLICT(plex_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      has_restriction_profile = excluded.has_restriction_profile
  `);

  db.transaction(() => {
    for (const user of users) {
      stmt.run({ ...user, hasRestrictionProfile: user.hasRestrictionProfile ? 1 : 0 });
    }
  })();

  return listManagedUsers(db);
}

export function listManagedUsers(db: Database.Database): ManagedUserRecord[] {
  return (db
    .prepare(`
      SELECT
        plex_user_id AS plexUserId,
        display_name AS displayName,
        avatar_url AS avatarUrl,
        has_restriction_profile AS hasRestrictionProfile
      FROM managed_users
      ORDER BY LOWER(display_name) ASC
    `)
    .all() as Array<Omit<ManagedUserRecord, "hasRestrictionProfile"> & { hasRestrictionProfile: number }>)
    .map((row) => ({ ...row, hasRestrictionProfile: Boolean(row.hasRestrictionProfile) }));
}
