import type Database from "better-sqlite3";
import type { SeerrMappingStatus, SeerrRequestOutcome, SeerrRequestState, SeerrUserLink } from "../../shared/types.js";
import { getSeerrSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// User links
// ---------------------------------------------------------------------------

interface SeerrUserLinkRow {
  user_id: number;
  manual_seerr_user_id: number | null;
  auto_matched_seerr_user_id: number | null;
  effective_seerr_user_id: number | null;
  mapping_status: string;
  auto_request_enabled: number | null;
  updated_at: string;
}

const NO_SEERR_USER_SELECTED = -1;

function rowToLink(row: SeerrUserLinkRow, globalAutoRequestEnabled: boolean): SeerrUserLink {
  const override = row.auto_request_enabled === null ? null : Boolean(row.auto_request_enabled);
  return {
    userId: row.user_id,
    manualSeerrUserId: row.manual_seerr_user_id,
    autoMatchedSeerrUserId: row.auto_matched_seerr_user_id,
    effectiveSeerrUserId: row.effective_seerr_user_id,
    mappingStatus: row.mapping_status as SeerrMappingStatus,
    autoRequestEnabledOverride: override,
    autoRequestEnabled: override ?? globalAutoRequestEnabled
  };
}

export function getSeerrUserLink(db: Database.Database, userId: number): SeerrUserLink | null {
  const row = db
    .prepare("SELECT * FROM seerr_user_links WHERE user_id = ?")
    .get(userId) as SeerrUserLinkRow | undefined;
  if (!row) return null;
  const { autoRequestEnabled: globalAutoRequestEnabled } = getSeerrSettings(db);
  return rowToLink(row, globalAutoRequestEnabled);
}

export function listSeerrUserLinks(db: Database.Database): SeerrUserLink[] {
  const rows = db
    .prepare("SELECT * FROM seerr_user_links")
    .all() as SeerrUserLinkRow[];
  const { autoRequestEnabled: globalAutoRequestEnabled } = getSeerrSettings(db);
  return rows.map((row) => rowToLink(row, globalAutoRequestEnabled));
}

export interface UpsertSeerrUserLinkInput {
  userId: number;
  manualSeerrUserId?: number | null;
  autoMatchedSeerrUserId?: number | null;
  autoRequestEnabledOverride?: boolean | null;
}

function computeEffectiveAndStatus(
  manual: number | null,
  autoMatched: number | null
): { effectiveSeerrUserId: number | null; mappingStatus: SeerrMappingStatus } {
  if (manual === NO_SEERR_USER_SELECTED) {
    return { effectiveSeerrUserId: null, mappingStatus: "manual" };
  }
  if (manual !== null) {
    return { effectiveSeerrUserId: manual, mappingStatus: "manual" };
  }
  if (autoMatched !== null) {
    return { effectiveSeerrUserId: autoMatched, mappingStatus: "auto" };
  }
  return { effectiveSeerrUserId: null, mappingStatus: "unlinked" };
}

export function upsertSeerrUserLink(db: Database.Database, input: UpsertSeerrUserLinkInput): SeerrUserLink {
  const existing = getSeerrUserLink(db, input.userId);
  const manual = "manualSeerrUserId" in input ? (input.manualSeerrUserId ?? null) : (existing?.manualSeerrUserId ?? null);
  const autoMatched = "autoMatchedSeerrUserId" in input ? (input.autoMatchedSeerrUserId ?? null) : (existing?.autoMatchedSeerrUserId ?? null);
  const autoRequestEnabledOverride =
    "autoRequestEnabledOverride" in input
      ? (input.autoRequestEnabledOverride ?? null)
      : (existing?.autoRequestEnabledOverride ?? null);

  const { effectiveSeerrUserId, mappingStatus } = computeEffectiveAndStatus(manual, autoMatched);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO seerr_user_links
      (user_id, manual_seerr_user_id, auto_matched_seerr_user_id, effective_seerr_user_id,
       mapping_status, auto_request_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      manual_seerr_user_id = excluded.manual_seerr_user_id,
      auto_matched_seerr_user_id = excluded.auto_matched_seerr_user_id,
      effective_seerr_user_id = excluded.effective_seerr_user_id,
      mapping_status = excluded.mapping_status,
      auto_request_enabled = excluded.auto_request_enabled,
      updated_at = excluded.updated_at
  `).run(
    input.userId,
    manual,
    autoMatched,
    effectiveSeerrUserId,
    mappingStatus,
    autoRequestEnabledOverride === null ? null : (autoRequestEnabledOverride ? 1 : 0),
    now
  );

  const { autoRequestEnabled: globalAutoRequestEnabled } = getSeerrSettings(db);
  return {
    userId: input.userId,
    manualSeerrUserId: manual,
    autoMatchedSeerrUserId: autoMatched,
    effectiveSeerrUserId,
    mappingStatus,
    autoRequestEnabledOverride,
    autoRequestEnabled: autoRequestEnabledOverride ?? globalAutoRequestEnabled
  };
}

export function deleteSeerrUserLink(db: Database.Database, userId: number): void {
  db.prepare("DELETE FROM seerr_user_links WHERE user_id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Request state
// ---------------------------------------------------------------------------

const SEERR_PRESENT_OUTCOMES = ["created", "already_requested", "already_available", "added_directly"];

interface SeerrRequestStateRow {
  id: number;
  user_id: number;
  plex_item_id: string;
  seerr_request_id: number | null;
  seerr_media_id: number | null;
  tmdb_id: number | null;
  last_attempted_at: string | null;
  outcome: string | null;
  last_error: string | null;
  effective_seerr_user_id: number | null;
  execution_seerr_user_id: number | null;
  updated_at: string;
}

function rowToRequestState(row: SeerrRequestStateRow): SeerrRequestState {
  return {
    id: row.id,
    userId: row.user_id,
    plexItemId: row.plex_item_id,
    seerrRequestId: row.seerr_request_id,
    seerrMediaId: row.seerr_media_id,
    tmdbId: row.tmdb_id,
    lastAttemptedAt: row.last_attempted_at,
    outcome: row.outcome as SeerrRequestOutcome | null,
    lastError: row.last_error,
    effectiveSeerrUserId: row.effective_seerr_user_id,
    executionSeerrUserId: row.execution_seerr_user_id,
    updatedAt: row.updated_at
  };
}

function normalizeIdentifierValue(value: string): string {
  return value.trim().toLowerCase();
}

function findEquivalentSeerrRequestStateId(
  db: Database.Database,
  userId: number,
  plexItemId: string,
  tmdbId?: number | null
): number | null {
  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  const tmdbIdentifier = tmdbId ? `tmdb://${tmdbId}` : null;
  const row = db.prepare(`
    WITH target_media AS (
      SELECT id
      FROM media_items
      WHERE canonical_plex_item_id = ?
      UNION
      SELECT media_item_id
      FROM media_item_identifiers
      WHERE identifier_value = ?
      UNION
      SELECT media_item_id
      FROM media_item_identifiers
      WHERE identifier_value = ?
    ),
    target_identifiers AS (
      SELECT canonical_plex_item_id AS identifier_value
      FROM media_items
      WHERE id IN (SELECT id FROM target_media)
      UNION
      SELECT identifier_value
      FROM media_item_identifiers
      WHERE media_item_id IN (SELECT id FROM target_media)
    )
    SELECT s.id
    FROM seerr_request_state s
    WHERE s.user_id = ?
      AND (
        lower(s.plex_item_id) = ?
        OR lower(s.plex_item_id) IN (SELECT identifier_value FROM target_identifiers)
        OR (? IS NOT NULL AND s.tmdb_id = ?)
        OR EXISTS (
          SELECT 1
          FROM target_identifiers ti
          WHERE ti.identifier_value = 'tmdb://' || s.tmdb_id
        )
      )
    ORDER BY
      CASE WHEN lower(s.plex_item_id) = ? THEN 0 ELSE 1 END,
      s.updated_at DESC,
      s.id DESC
    LIMIT 1
  `).get(
    normalizedPlexItemId,
    normalizedPlexItemId,
    tmdbIdentifier,
    userId,
    normalizedPlexItemId,
    tmdbId ?? null,
    tmdbId ?? null,
    normalizedPlexItemId
  ) as { id: number } | undefined;

  return row?.id ?? null;
}

function addTmdbIdentifierForKnownMedia(
  db: Database.Database,
  plexItemId: string,
  tmdbId?: number | null
): void {
  if (!tmdbId) return;

  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  db.prepare(`
    INSERT INTO media_item_identifiers (media_item_id, identifier_type, identifier_value)
    SELECT id, 'tmdb', ?
    FROM media_items
    WHERE canonical_plex_item_id = ?
    UNION
    SELECT media_item_id, 'tmdb', ?
    FROM media_item_identifiers
    WHERE identifier_value = ?
    ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
      media_item_id = excluded.media_item_id
  `).run(
    `tmdb://${tmdbId}`,
    normalizedPlexItemId,
    `tmdb://${tmdbId}`,
    normalizedPlexItemId
  );
}

export function getSeerrRequestState(
  db: Database.Database,
  userId: number,
  plexItemId: string
): SeerrRequestState | null {
  const existingId = findEquivalentSeerrRequestStateId(db, userId, plexItemId);
  if (existingId === null) return null;

  const row = db.prepare("SELECT * FROM seerr_request_state WHERE id = ?").get(existingId) as SeerrRequestStateRow | undefined;
  return row ? rowToRequestState(row) : null;
}

export function listSeerrRequestStatesForItem(
  db: Database.Database,
  plexItemId: string
): SeerrRequestState[] {
  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  const rows = db
    .prepare(`
      WITH target_media AS (
        SELECT id
        FROM media_items
        WHERE canonical_plex_item_id = ?
        UNION
        SELECT media_item_id
        FROM media_item_identifiers
        WHERE identifier_value = ?
      ),
      target_identifiers AS (
        SELECT canonical_plex_item_id AS identifier_value
        FROM media_items
        WHERE id IN (SELECT id FROM target_media)
        UNION
        SELECT identifier_value
        FROM media_item_identifiers
        WHERE media_item_id IN (SELECT id FROM target_media)
      )
      SELECT DISTINCT s.*
      FROM seerr_request_state s
      WHERE lower(s.plex_item_id) = ?
         OR lower(s.plex_item_id) IN (SELECT identifier_value FROM target_identifiers)
         OR EXISTS (
           SELECT 1
           FROM target_identifiers ti
           WHERE ti.identifier_value = 'tmdb://' || s.tmdb_id
         )
      ORDER BY s.updated_at DESC, s.id DESC
    `)
    .all(normalizedPlexItemId, normalizedPlexItemId, normalizedPlexItemId) as SeerrRequestStateRow[];

  const latestByUser = new Map<number, SeerrRequestStateRow>();
  for (const row of rows) {
    if (!latestByUser.has(row.user_id)) {
      latestByUser.set(row.user_id, row);
    }
  }

  return Array.from(latestByUser.values()).map(rowToRequestState);
}

export function listSeerrRequestStatesForUser(
  db: Database.Database,
  userId: number
): SeerrRequestState[] {
  const rows = db
    .prepare("SELECT * FROM seerr_request_state WHERE user_id = ?")
    .all(userId) as SeerrRequestStateRow[];
  return rows.map(rowToRequestState);
}

export function deleteSkippedUnlinkedRequestStatesForUser(
  db: Database.Database,
  userId: number
): number {
  const result = db
    .prepare("DELETE FROM seerr_request_state WHERE user_id = ? AND outcome = 'skipped_unlinked_user'")
    .run(userId);
  return Number(result.changes);
}

export function listSeerrRequestedPlexItemIds(
  db: Database.Database,
  plexItemIds: string[]
): Set<string> {
  const normalizedPlexItemIds = Array.from(new Set(
    plexItemIds.map(normalizeIdentifierValue).filter(Boolean)
  ));
  if (normalizedPlexItemIds.length === 0) return new Set();

  const valuesSql = normalizedPlexItemIds.map(() => "(?)").join(", ");
  const outcomeSql = SEERR_PRESENT_OUTCOMES.map(() => "?").join(", ");
  const rows = db.prepare(`
    WITH input_items(plex_item_id) AS (
      VALUES ${valuesSql}
    ),
    target_media AS (
      SELECT ii.plex_item_id, mi.id AS media_item_id
      FROM input_items ii
      JOIN media_items mi ON mi.canonical_plex_item_id = ii.plex_item_id
      UNION
      SELECT ii.plex_item_id, mii.media_item_id
      FROM input_items ii
      JOIN media_item_identifiers mii ON mii.identifier_value = ii.plex_item_id
    ),
    target_identifiers AS (
      SELECT tm.plex_item_id, mi.canonical_plex_item_id AS identifier_value
      FROM target_media tm
      JOIN media_items mi ON mi.id = tm.media_item_id
      UNION
      SELECT tm.plex_item_id, mii.identifier_value
      FROM target_media tm
      JOIN media_item_identifiers mii ON mii.media_item_id = tm.media_item_id
    )
    SELECT DISTINCT ii.plex_item_id AS plexItemId
    FROM input_items ii
    WHERE EXISTS (
      SELECT 1
      FROM seerr_request_state s
      WHERE s.outcome IN (${outcomeSql})
        AND (
          lower(s.plex_item_id) = ii.plex_item_id
          OR lower(s.plex_item_id) IN (
            SELECT ti.identifier_value
            FROM target_identifiers ti
            WHERE ti.plex_item_id = ii.plex_item_id
          )
          OR EXISTS (
            SELECT 1
            FROM target_identifiers ti
            WHERE ti.plex_item_id = ii.plex_item_id
              AND ti.identifier_value = 'tmdb://' || s.tmdb_id
          )
        )
    )
  `).all(...normalizedPlexItemIds, ...SEERR_PRESENT_OUTCOMES) as Array<{ plexItemId: string }>;

  return new Set(rows.map((row) => row.plexItemId));
}

export interface UpsertSeerrRequestStateInput {
  userId: number;
  plexItemId: string;
  seerrRequestId?: number | null;
  seerrMediaId?: number | null;
  tmdbId?: number | null;
  outcome: SeerrRequestOutcome;
  lastError?: string | null;
  effectiveSeerrUserId?: number | null;
  executionSeerrUserId?: number | null;
}

export function upsertSeerrRequestState(
  db: Database.Database,
  input: UpsertSeerrRequestStateInput
): SeerrRequestState {
  const now = new Date().toISOString();
  const existingId = findEquivalentSeerrRequestStateId(db, input.userId, input.plexItemId, input.tmdbId);

  addTmdbIdentifierForKnownMedia(db, input.plexItemId, input.tmdbId);

  if (existingId !== null) {
    db.prepare(`
      UPDATE seerr_request_state
      SET plex_item_id = ?,
          seerr_request_id = ?,
          seerr_media_id = ?,
          tmdb_id = ?,
          last_attempted_at = ?,
          outcome = ?,
          last_error = ?,
          effective_seerr_user_id = ?,
          execution_seerr_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.plexItemId,
      input.seerrRequestId ?? null,
      input.seerrMediaId ?? null,
      input.tmdbId ?? null,
      now,
      input.outcome,
      input.lastError ?? null,
      input.effectiveSeerrUserId ?? null,
      input.executionSeerrUserId ?? null,
      now,
      existingId
    );

    const saved = db.prepare("SELECT * FROM seerr_request_state WHERE id = ?").get(existingId) as SeerrRequestStateRow | undefined;
    if (!saved) throw new Error("Failed to update seerr request state");
    return rowToRequestState(saved);
  }

  db.prepare(`
    INSERT INTO seerr_request_state
      (user_id, plex_item_id, seerr_request_id, seerr_media_id, tmdb_id,
       last_attempted_at, outcome, last_error,
       effective_seerr_user_id, execution_seerr_user_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId,
    input.plexItemId,
    input.seerrRequestId ?? null,
    input.seerrMediaId ?? null,
    input.tmdbId ?? null,
    now,
    input.outcome,
    input.lastError ?? null,
    input.effectiveSeerrUserId ?? null,
    input.executionSeerrUserId ?? null,
    now
  );

  const saved = getSeerrRequestState(db, input.userId, input.plexItemId);
  if (!saved) throw new Error("Failed to upsert seerr request state");
  return saved;
}

export function deleteSeerrRequestState(
  db: Database.Database,
  userId: number,
  plexItemId: string
): void {
  const normalizedPlexItemId = normalizeIdentifierValue(plexItemId);
  db.prepare(`
    WITH target_media AS (
      SELECT id
      FROM media_items
      WHERE canonical_plex_item_id = ?
      UNION
      SELECT media_item_id
      FROM media_item_identifiers
      WHERE identifier_value = ?
    ),
    target_identifiers AS (
      SELECT canonical_plex_item_id AS identifier_value
      FROM media_items
      WHERE id IN (SELECT id FROM target_media)
      UNION
      SELECT identifier_value
      FROM media_item_identifiers
      WHERE media_item_id IN (SELECT id FROM target_media)
    )
    DELETE FROM seerr_request_state
    WHERE user_id = ?
      AND (
        lower(plex_item_id) = ?
        OR lower(plex_item_id) IN (SELECT identifier_value FROM target_identifiers)
        OR EXISTS (
          SELECT 1
          FROM target_identifiers ti
          WHERE ti.identifier_value = 'tmdb://' || seerr_request_state.tmdb_id
        )
      )
  `).run(normalizedPlexItemId, normalizedPlexItemId, userId, normalizedPlexItemId);
}
