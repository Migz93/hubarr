import type Database from "better-sqlite3";
import type { DashboardResponse, RecentlyAddedItem, SyncRun } from "../../shared/types.js";
import { calculateHistoryRetentionEvents, getAppSettings } from "./settings.js";

// -------------------------------------------------------------------------
// Job Run State
// -------------------------------------------------------------------------

export function getJobRunState(
  db: Database.Database,
  jobId: string
): { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | null {
  const row = db
    .prepare("SELECT last_run_at AS lastRunAt, last_run_status AS lastRunStatus FROM job_run_state WHERE job_id = ?")
    .get(jobId) as { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | undefined;

  return row ?? null;
}

export function saveJobRunState(
  db: Database.Database,
  jobId: string,
  state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }
): void {
  db.prepare(`
    INSERT INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_run_status = excluded.last_run_status,
      updated_at = excluded.updated_at
  `).run(jobId, state.lastRunAt, state.lastRunStatus, new Date().toISOString());
}

// -------------------------------------------------------------------------
// Sync Runs
// -------------------------------------------------------------------------

export function pruneSyncRuns(db: Database.Database, maxEvents: number): void {
  const retention = Math.max(1, Math.floor(maxEvents));
  db.prepare(`
    DELETE FROM sync_runs
    WHERE id IN (
      SELECT id
      FROM sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `).run(retention);
}

export function createSyncRun(db: Database.Database, kind: SyncRun["kind"], summary: string): number {
  const result = db
    .prepare("INSERT INTO sync_runs (kind, status, started_at, summary) VALUES (?, 'running', ?, ?)")
    .run(kind, new Date().toISOString(), summary);
  pruneSyncRuns(db, calculateHistoryRetentionEvents(getAppSettings(db)));
  return Number(result.lastInsertRowid);
}

export function completeSyncRun(
  db: Database.Database,
  id: number,
  status: SyncRun["status"],
  summary: string,
  error: string | null
): void {
  db.prepare("UPDATE sync_runs SET status = ?, completed_at = ?, summary = ?, error = ? WHERE id = ?")
    .run(status, new Date().toISOString(), summary, error, id);
}

export function addSyncRunItem(
  db: Database.Database,
  runId: number,
  action: string,
  status: SyncRun["status"],
  details: unknown,
  userId?: number
): void {
  db.prepare(
    "INSERT INTO sync_run_items (run_id, user_id, action, status, details, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(runId, userId || null, action, status, JSON.stringify(details), new Date().toISOString());
}

export function listSyncRuns(db: Database.Database, limit = 10): SyncRun[] {
  return db
    .prepare(
      "SELECT id, kind, status, started_at AS startedAt, completed_at AS completedAt, summary, error FROM sync_runs ORDER BY started_at DESC LIMIT ?"
    )
    .all(limit) as SyncRun[];
}

export function listSyncRunsPaginated(
  db: Database.Database,
  options: {
    page: number;
    pageSize: number;
    kind?: string;
    status?: string;
  }
): { results: SyncRun[]; total: number } {
  const { page, pageSize, kind, status } = options;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (kind && kind !== "all") {
    conditions.push("kind = ?");
    params.push(kind);
  }
  if (status && status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

  const total = (db.prepare(`SELECT COUNT(*) AS count FROM sync_runs ${where}`).get(...params) as { count: number }).count;
  const results = db
    .prepare(`SELECT id, kind, status, started_at AS startedAt, completed_at AS completedAt, summary, error FROM sync_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as SyncRun[];

  return { results, total };
}

export function getSyncRunWithItems(
  db: Database.Database,
  runId: number
): (SyncRun & { items: Array<{ id: number; runId: number; userId: number | null; action: string; status: string; details: unknown; createdAt: string }> }) | null {
  const run = db
    .prepare("SELECT id, kind, status, started_at AS startedAt, completed_at AS completedAt, summary, error FROM sync_runs WHERE id = ?")
    .get(runId) as SyncRun | undefined;

  if (!run) return null;

  const rawItems = db
    .prepare("SELECT id, run_id AS runId, user_id AS userId, action, status, details, created_at AS createdAt FROM sync_run_items WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as Array<{ id: number; runId: number; userId: number | null; action: string; status: string; details: string; createdAt: string }>;

  const items = rawItems.map((item) => ({
    ...item,
    details: (() => { try { return JSON.parse(item.details); } catch { return item.details; } })()
  }));

  return { ...run, items };
}

// -------------------------------------------------------------------------
// Dashboard
// -------------------------------------------------------------------------

export function buildDashboard(db: Database.Database): DashboardResponse {
  type RecentRow = {
    plexItemId: string;
    title: string;
    year: number | null;
    type: string;
    posterUrl: string | null;
    addedAt: string;
    matchedRatingKey: string | null;
    userId: number;
    userDisplayName: string;
    userAvatarUrl: string | null;
  };

  const recentRows = db
    .prepare(`
      SELECT w.plex_item_id AS plexItemId, w.title, w.year, w.type, w.thumb AS posterUrl, w.added_at AS addedAt,
             w.matched_rating_key AS matchedRatingKey,
             f.id AS userId,
             COALESCE(f.display_name_override, f.username) AS userDisplayName,
             f.avatar_url AS userAvatarUrl
      FROM watchlist_cache w
      JOIN users f ON f.id = w.user_id
      WHERE f.enabled = 1
      ORDER BY w.added_at DESC
    `)
    .all() as RecentRow[];

  // Group by plexItemId so the same movie watchlisted by multiple users
  // appears once, showing all users and the most recent watchlist date.
  const grouped = new Map<string, RecentlyAddedItem>();
  for (const row of recentRows) {
    const userEntry = {
      userId: row.userId,
      displayName: row.userDisplayName,
      avatarUrl: row.userAvatarUrl,
      addedAt: row.addedAt
    };
    const existing = grouped.get(row.plexItemId);
    if (existing) {
      existing.users.push(userEntry);
      if (row.addedAt > existing.addedAt) existing.addedAt = row.addedAt;
      existing.plexAvailable = existing.plexAvailable || Boolean(row.matchedRatingKey);
    } else {
      grouped.set(row.plexItemId, {
        plexItemId: row.plexItemId,
        title: row.title,
        year: row.year,
        type: row.type as "movie" | "show",
        posterUrl: row.posterUrl,
        addedAt: row.addedAt,
        users: [userEntry],
        plexAvailable: Boolean(row.matchedRatingKey)
      });
    }
  }

  const recentlyAdded: RecentlyAddedItem[] = Array.from(grouped.values())
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 12);

  const enabledCount = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE enabled = 1").get() as { count: number }).count;

  const movieCount = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT w.plex_item_id) AS count FROM watchlist_cache w JOIN users f ON f.id = w.user_id WHERE f.enabled = 1 AND w.type = 'movie'"
      )
      .get() as { count: number }
  ).count;

  const showCount = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT w.plex_item_id) AS count FROM watchlist_cache w JOIN users f ON f.id = w.user_id WHERE f.enabled = 1 AND w.type = 'show'"
      )
      .get() as { count: number }
  ).count;

  return {
    recentlyAdded,
    stats: { enabledUsers: enabledCount, trackedMovies: movieCount, trackedShows: showCount },
    syncActivity: listSyncRuns(db, 8)
  };
}
