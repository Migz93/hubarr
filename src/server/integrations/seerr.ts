import type { SeerrRequestOutcome, SeerrUser } from "../../shared/types.js";
import type { Logger } from "../logger.js";

export interface SeerrSettingsInput {
  baseUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Seerr API permission bitmask for the Hubarr service account.
// Includes: MANAGE_USERS | MANAGE_REQUESTS | REQUEST | REQUEST_ADVANCED |
//           REQUEST_VIEW | REQUEST_MOVIE | REQUEST_TV | RECENT_VIEW | WATCHLIST_VIEW
// ---------------------------------------------------------------------------
const HUBARR_SERVICE_ACCOUNT_PERMISSIONS = 202_137_656;

const SEERR_SERVICE_ACCOUNT_EMAIL = "hubarr@hubarr.local";
const SEERR_SERVICE_ACCOUNT_USERNAME = "Hubarr";

interface SeerrUserResponse {
  id: number;
  email: string;
  username?: string | null;
  displayName?: string | null;
  plexUsername?: string | null;
  avatar?: string | null;
}

interface SeerrUsersListResponse {
  results: SeerrUserResponse[];
  pageInfo?: { pages: number; page: number; count: number; results: number };
}

interface SeerrMediaInfo {
  id: number;
  tmdbId?: number;
  status: number;  // 1=UNKNOWN 2=PENDING 3=PROCESSING 4=PARTIALLY_AVAILABLE 5=AVAILABLE 6=DELETED
  requests?: Array<{ id: number; requestedBy?: { id: number } }>;
}

// Statuses that mean the item is actively in-flight or available — do not re-request.
// We whitelist rather than blacklist so that undocumented future status codes (e.g. 7)
// fall through to requestable rather than silently blocking a request.
const SEERR_SKIP_STATUSES = new Set([2, 3, 4, 5]); // PENDING, PROCESSING, PARTIALLY_AVAILABLE, AVAILABLE

interface SeerrMediaResponse {
  mediaInfo?: SeerrMediaInfo;
}


export interface SeerrCheckResult {
  outcome: Extract<SeerrRequestOutcome, "already_requested" | "already_available" | "created" | "failed">;
  seerrRequestId: number | null;
  seerrMediaId: number | null;
  tmdbId: number | null;
  error?: string;
}

export class SeerrIntegration {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(settings: SeerrSettingsInput, private readonly logger: Logger) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "accept": "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": settings.apiKey
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.url(path), { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Seerr GET ${path} failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { ...this.headers, ...extraHeaders },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Seerr POST ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Seerr PUT ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return res.json() as Promise<T>;
  }

  private async delete(path: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: "DELETE",
      headers: this.headers
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Seerr DELETE ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Connectivity
  // ---------------------------------------------------------------------------

  async validate(): Promise<{ version: string; userCount: number }> {
    const status = await this.get<{ version: string }>("/status");
    const users = await this.getUsers(1, 0);
    return { version: status.version ?? "unknown", userCount: users.length };
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async getUsers(take = 100, skip = 0): Promise<SeerrUser[]> {
    const data = await this.get<SeerrUsersListResponse>(`/user?take=${take}&skip=${skip}`);
    const results = data.results ?? [];

    const users: SeerrUser[] = results.map((u) => ({
      id: u.id,
      email: u.email ?? "",
      username: u.username ?? null,
      displayName: u.displayName ?? null,
      plexUsername: u.plexUsername ?? null
    }));

    // Paginate if there are more users
    const pages = data.pageInfo?.pages ?? 1;
    if (pages > 1) {
      for (let page = 2; page <= pages; page++) {
        const nextData = await this.get<SeerrUsersListResponse>(`/user?take=${take}&skip=${(page - 1) * take}`);
        for (const u of nextData.results ?? []) {
          users.push({
            id: u.id,
            email: u.email ?? "",
            username: u.username ?? null,
            displayName: u.displayName ?? null,
            plexUsername: u.plexUsername ?? null
          });
        }
      }
    }

    return users;
  }

  /**
   * Find a Seerr user by exact plexUsername match (case-insensitive),
   * then by exact local username match.
   */
  autoMatchUser(seerrUsers: SeerrUser[], plexUsername: string): SeerrUser | null {
    const normalized = plexUsername.trim().toLowerCase();

    // Priority 1: plexUsername exact match
    const byPlexUsername = seerrUsers.find(
      (u) => u.plexUsername?.trim().toLowerCase() === normalized
    );
    if (byPlexUsername) return byPlexUsername;

    // Priority 2: local username exact match
    const byUsername = seerrUsers.find(
      (u) => u.username?.trim().toLowerCase() === normalized
    );
    return byUsername ?? null;
  }

  // ---------------------------------------------------------------------------
  // Service account management
  // ---------------------------------------------------------------------------

  /**
   * Create or reconcile the Hubarr service account in Seerr.
   * Returns the Seerr user ID of the service account.
   */
  async createOrReconcileServiceAccount(avatarUrl?: string | null): Promise<number> {
    const users = await this.getUsers();

    const existing = users.find(
      (u) => u.email.toLowerCase() === SEERR_SERVICE_ACCOUNT_EMAIL.toLowerCase()
    );

    let userId: number;

    if (existing) {
      userId = existing.id;
      this.logger.info("Seerr service account exists — reconciling permissions", { seerrUserId: userId });
    } else {
      // Seerr's POST /user ignores the `permissions` field and always applies
      // defaultPermissions. We create the account first, then set permissions via PUT.
      const created = await this.post<SeerrUserResponse>("/user", {
        email: SEERR_SERVICE_ACCOUNT_EMAIL,
        username: SEERR_SERVICE_ACCOUNT_USERNAME,
        ...(avatarUrl ? { avatar: avatarUrl } : {}),
        userType: 3  // LOCAL user type
      });
      userId = created.id;
      this.logger.info("Seerr service account created", {
        seerrUserId: userId,
        avatarApplied: Boolean(avatarUrl)
      });
    }

    // Always enforce the correct permissions — the only reliable way is PUT /user/{id}.
    await this.put(`/user/${userId}`, {
      username: SEERR_SERVICE_ACCOUNT_USERNAME,
      permissions: HUBARR_SERVICE_ACCOUNT_PERMISSIONS
    });
    this.logger.info("Seerr service account permissions applied", {
      seerrUserId: userId,
      permissions: HUBARR_SERVICE_ACCOUNT_PERMISSIONS
    });

    return userId;
  }

  /**
   * Delete the Hubarr service account from Seerr if it exists.
   * This is used when service account mode is disabled in Hubarr settings.
   */
  async deleteServiceAccount(): Promise<void> {
    const users = await this.getUsers();
    const existing = users.find(
      (u) => u.email.toLowerCase() === SEERR_SERVICE_ACCOUNT_EMAIL.toLowerCase()
    );

    if (!existing) {
      this.logger.info("Seerr service account delete skipped — account not found");
      return;
    }

    await this.delete(`/user/${existing.id}`);
    this.logger.info("Seerr service account deleted", { seerrUserId: existing.id });
  }

  // ---------------------------------------------------------------------------
  // Media status inspection
  // ---------------------------------------------------------------------------

  /** Check movie status in Seerr. Returns null when the movie is not known to Seerr. */
  async getMovieStatus(tmdbId: number): Promise<SeerrMediaInfo | null> {
    try {
      const data = await this.get<SeerrMediaResponse>(`/movie/${tmdbId}`);
      return data.mediaInfo ?? null;
    } catch {
      return null;
    }
  }

  /** Check TV show status in Seerr. Returns null when the show is not known to Seerr. */
  async getTvStatus(tmdbId: number): Promise<SeerrMediaInfo | null> {
    try {
      const data = await this.get<SeerrMediaResponse>(`/tv/${tmdbId}`);
      return data.mediaInfo ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Inspect existing Seerr state and return whether the item should be requested
   * or skipped. Returns null when the item is not yet known to Seerr (requestable).
   *
   * Mirrors plexlistarr's _skip_reason logic:
   *   - status <= 1 (UNKNOWN) → requestable
   *   - status >= 5 (AVAILABLE) → already_available
   *   - status 2-4 with requests → already_requested
   *   - status 2-4 with no requests → already_available (added via Radarr/Sonarr directly,
   *     or requests not visible to this caller)
   */
  evaluateMediaInfo(
    mediaInfo: SeerrMediaInfo | null,
    requesterSeerrUserId: number
  ): { skip: true; outcome: "already_available" | "already_requested"; seerrRequestId: number | null; seerrMediaId: number | null } | null {
    if (!mediaInfo || !SEERR_SKIP_STATUSES.has(mediaInfo.status)) {
      // Only statuses 2-5 are known "in-flight or available" — everything else is requestable
      // (includes 1=UNKNOWN, 6=DELETED, and any undocumented future codes)
      return null;
    }

    if (mediaInfo.status === 5) {
      return { skip: true, outcome: "already_available", seerrRequestId: null, seerrMediaId: mediaInfo.id };
    }

    // Status 2-4: item is known to Seerr and being processed.
    const requests = mediaInfo.requests ?? [];
    if (requests.length === 0) {
      // Added via Radarr/Sonarr directly (no Seerr request) — still in-flight, don't re-request.
      return { skip: true, outcome: "already_requested", seerrRequestId: null, seerrMediaId: mediaInfo.id };
    }

    const ownRequest = requests.find((r) => r.requestedBy?.id === requesterSeerrUserId);
    const anyRequestId = (ownRequest ?? requests[0]).id;
    return { skip: true, outcome: "already_requested", seerrRequestId: anyRequestId, seerrMediaId: mediaInfo.id };
  }

  // ---------------------------------------------------------------------------
  // Request creation
  // ---------------------------------------------------------------------------

  async createRequest(
    tmdbId: number,
    mediaType: "movie" | "show",
    requesterSeerrUserId: number,
    executionSeerrUserId?: number | null
  ): Promise<{ id: number; media?: { id: number } }> {
    const payload = mediaType === "movie"
      ? { mediaType: "movie", mediaId: tmdbId, userId: requesterSeerrUserId }
      : { mediaType: "tv", mediaId: tmdbId, userId: requesterSeerrUserId, seasons: "all" };
    // X-API-User tells Seerr to act as the execution user, so "modified by" shows as
    // the service account (or the requester themselves) rather than the admin API key owner.
    const extraHeaders = executionSeerrUserId ? { "X-API-User": String(executionSeerrUserId) } : undefined;
    return this.post<{ id: number; media?: { id: number } }>("/request", payload, extraHeaders);
  }

  /**
   * Check Seerr state and, if the item is requestable, create a request.
   *
   * @param tmdbId - TMDB identifier for the media item
   * @param mediaType - "movie" or "show"
   * @param requesterSeerrUserId - Seerr user ID of the watchlist owner
   * @param executionSeerrUserId - Seerr user ID of the account performing the request
   *   (recorded for audit; the admin API key is always used for execution)
   */
  async checkAndRequest(
    tmdbId: number,
    mediaType: "movie" | "show",
    requesterSeerrUserId: number,
    executionSeerrUserId: number
  ): Promise<SeerrCheckResult> {
    const mediaInfo = mediaType === "movie"
      ? await this.getMovieStatus(tmdbId)
      : await this.getTvStatus(tmdbId);

    const skipResult = this.evaluateMediaInfo(mediaInfo, requesterSeerrUserId);
    if (skipResult) {
      this.logger.info("Seerr request skipped — item already known", {
        tmdbId,
        mediaType,
        outcome: skipResult.outcome,
        seerrMediaId: skipResult.seerrMediaId
      });
      return {
        outcome: skipResult.outcome,
        seerrRequestId: skipResult.seerrRequestId,
        seerrMediaId: skipResult.seerrMediaId,
        tmdbId
      };
    }

    // Item is requestable — create the request
    try {
      const response = await this.createRequest(tmdbId, mediaType, requesterSeerrUserId, executionSeerrUserId);

      this.logger.info("Seerr request created", {
        tmdbId,
        mediaType,
        seerrRequestId: response.id,
        seerrMediaId: response.media?.id ?? null,
        requesterSeerrUserId,
        executionSeerrUserId
      });

      return {
        outcome: "created",
        seerrRequestId: response.id,
        seerrMediaId: response.media?.id ?? null,
        tmdbId
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error("Seerr request creation failed", { tmdbId, mediaType, error });
      return {
        outcome: "failed",
        seerrRequestId: null,
        seerrMediaId: null,
        tmdbId,
        error
      };
    }
  }
}

// ---------------------------------------------------------------------------
// TMDB ID extraction from Plex GUIDs
// ---------------------------------------------------------------------------

/**
 * Extract a TMDB numeric ID from a list of Plex GUIDs.
 * Returns null if no tmdb:// GUID is found.
 */
export function extractTmdbId(guids: string[]): number | null {
  for (const guid of guids) {
    // Matches "tmdb://12345" or "com.plexapp.agents.themoviedb://12345?..."
    const match = guid.match(/^tmdb:\/\/(\d+)/i) ?? guid.match(/themoviedb:\/\/(\d+)/i);
    if (match?.[1]) {
      const id = parseInt(match[1], 10);
      if (!isNaN(id) && id > 0) return id;
    }
  }
  return null;
}
