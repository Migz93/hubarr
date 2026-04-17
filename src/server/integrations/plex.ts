import crypto from "node:crypto";
import { parseStringPromise } from "xml2js";
import pLimit from "p-limit";
import type { RssFeedItem } from "../rss-cache.js";
import type { Logger } from "../logger.js";
import { PLEX_USER_AGENT } from "../version.js";
import type { CollectionSortOrder, UserRecord, MediaType, PlexSettingsInput, RichItemMetadata, SearchCandidate, WatchlistItem } from "../../shared/types.js";

export interface ResolvedWatchlistItem extends WatchlistItem {
  searchCandidates?: SearchCandidate[];
}

// Use one shared limiter so concurrent full-sync users do not each get their
// own 10-request budget for discover enrichment and library matching.
const resolveWatchlistItemLimit = pLimit(10);

// ---------------------------------------------------------------------------
// Filter string helpers for per-user Plex content isolation
// ---------------------------------------------------------------------------

/**
 * Remove all `hubarr:*` label exclusions from a Plex filter string.
 * Preserves all other filter components (contentRating, etc.).
 * Cleans up any empty label!= groups that result.
 */
function removeHubarrLabelsFromFilter(filter: string): string {
  if (!filter) return filter;

  const groups = filter.split("&").map((group) => {
    const parts = group.split("|").map((part) => {
      if (!part.startsWith("label!=")) return part;
      const remaining = part
        .slice("label!=".length)
        .split(",")
        .filter((l) => !l.startsWith("hubarr:"));
      return remaining.length > 0 ? `label!=${remaining.join(",")}` : null;
    }).filter((p): p is string => p !== null);
    return parts.join("|") || null;
  }).filter((g): g is string => g !== null);

  return groups.join("&");
}

/**
 * Append Hubarr label exclusions to a (already-cleaned) filter string.
 * Returns `label!=a,b` if the base is empty, otherwise `base&label!=a,b`.
 */
function addHubarrLabelExclusions(base: string, labels: string[]): string {
  if (labels.length === 0) return base;
  const exclusion = `label!=${labels.join(",")}`;
  return base ? `${base}&${exclusion}` : exclusion;
}

interface PlexGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface PlexFriendNode {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
  };
}

interface PlexWatchlistNode {
  id: string;
  title: string;
  type: "MOVIE" | "SHOW";
  guid?: string;
  key?: string;
  year?: number;
}

type PlexFriendWatchlistResponse = {
  userV2: {
    watchlist: {
      nodes: PlexWatchlistNode[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
};

interface PlexActivityFeedNode {
  date: string;
  userV2: {
    id: string;
    username: string;
    displayName: string;
  };
  metadataItem: {
    id: string;
    title: string;
    type: string;
    key: string | null;
    guid: string | null;
  } | null;
}

type PlexActivityFeedResponse = {
  activityFeed: {
    nodes: PlexActivityFeedNode[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
};

export interface PlexLibrary {
  key: string;
  title: string;
  type: "movie" | "show";
}

export interface PlexLibraryItemMatch {
  ratingKey: string;
  addedAt: string | null;
  guids: string[];
}

const COMMUNITY_API_URL = "https://community.plex.tv/api";
const DISCOVER_ORIGIN = "https://discover.provider.plex.tv";
const DISCOVER_RSS_PATH = "/rss";
const RSS_PLEX_ORIGIN = "https://rss.plex.tv";
const PLEX_TV_ACCOUNT_URL = "https://plex.tv/users/account.json";
const PLEX_TV_USERS_URL = "https://plex.tv/api/users";
const PLEX_TV_PING_URL = "https://plex.tv/api/v2/ping";
const PLEX_TV_RESOURCES_URL = "https://plex.tv/api/v2/resources";

const RSS_PLEX_UUID_PATH = /^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Sentinel value used when no real watchlist date can be determined.
// Stored in the DB so it can be overwritten later if a real date is found.
export const WATCHLIST_DATE_UNKNOWN_SENTINEL = "2001-01-01T00:00:00.000Z";

export class PlexIntegration {
  private resolvedMachineIdentifier: string | null = null;

  constructor(
    private readonly settings: PlexSettingsInput,
    private readonly logger: Logger
  ) {}

  private async getMachineIdentifier() {
    if (this.resolvedMachineIdentifier) {
      return this.resolvedMachineIdentifier;
    }

    const identity = await this.requestServer<{ MediaContainer?: { machineIdentifier?: string } }>("/identity");
    const machineIdentifier =
      identity.MediaContainer?.machineIdentifier || this.settings.machineIdentifier;

    if (!machineIdentifier) {
      throw new Error("Unable to determine Plex machine identifier from server identity.");
    }

    this.resolvedMachineIdentifier = machineIdentifier;
    return machineIdentifier;
  }

  private buildServerUrl(pathname: string) {
    return new URL(
      pathname,
      this.settings.serverUrl.endsWith("/") ? this.settings.serverUrl : `${this.settings.serverUrl}/`
    );
  }

  private normalizeMetadataId(rawId: string) {
    const trimmed = rawId.trim();
    if (!/^[a-f0-9]{24}$/.test(trimmed)) {
      throw new Error(`Invalid Plex metadata ID: ${rawId}`);
    }
    return trimmed;
  }

  private buildDiscoverMetadataUrl(rawEndpoint: string) {
    const match = rawEndpoint.trim().match(/^\/?library\/metadata\/(.+)$/);
    if (!match) {
      throw new Error(`Unsupported discover metadata endpoint: ${rawEndpoint}`);
    }

    const url = new URL(DISCOVER_ORIGIN);
    url.pathname = `/library/metadata/${this.normalizeMetadataId(match[1])}`;
    url.searchParams.set("format", "json");
    return url;
  }

  private buildDiscoverRssRequestUrl(rawUrl: string) {
    const parsed = new URL(rawUrl);

    // Plex returns RSS feed URLs as https://rss.plex.tv/{uuid}
    if (parsed.origin === RSS_PLEX_ORIGIN) {
      if (!RSS_PLEX_UUID_PATH.test(parsed.pathname)) {
        throw new Error(`Unsupported rss.plex.tv path: ${rawUrl}`);
      }
      return new URL(rawUrl);
    }

    // Legacy discover.provider.plex.tv/rss format
    if (parsed.origin === DISCOVER_ORIGIN && parsed.pathname === DISCOVER_RSS_PATH) {
      const url = new URL(`${DISCOVER_ORIGIN}${DISCOVER_RSS_PATH}`);
      for (const [key, value] of parsed.searchParams) {
        if (key.toLowerCase() === "x-plex-token") {
          continue;
        }
        url.searchParams.set(key, value);
      }
      url.searchParams.set("format", "json");
      return url;
    }

    throw new Error(`Unsupported RSS URL: ${rawUrl}`);
  }

  private async requestServer<T>(pathname: string, init?: RequestInit): Promise<T> {
    const url = this.buildServerUrl(pathname);
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "X-Plex-Token": this.settings.token,
        ...(init?.headers || {})
      }
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `Plex server request failed: ${response.status} ${response.statusText} at ${url.toString()}. Response: ${responseText}`
      );
    }

    const contentLength = response.headers.get("content-length");
    const contentType = response.headers.get("content-type") || "";

    if (response.status === 204 || contentLength === "0") {
      return undefined as T;
    }

    const rawText = await response.text();
    if (!rawText.trim()) {
      return undefined as T;
    }

    if (!contentType.includes("json")) {
      return rawText as T;
    }

    return JSON.parse(rawText) as T;
  }

  private async requestCommunity<T>(query: string, variables?: Record<string, unknown>) {
    const response = await fetch(COMMUNITY_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": this.settings.token
      },
      body: JSON.stringify({ query, variables })
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Plex community request failed: ${response.status} ${response.statusText}. Response: ${rawText}`
      );
    }

    let payload: PlexGraphQLResponse<T>;
    try {
      payload = JSON.parse(rawText) as PlexGraphQLResponse<T>;
    } catch {
      throw new Error(`Plex community request returned non-JSON data: ${rawText}`);
    }

    if (payload.errors?.length) {
      throw new Error(`Plex GraphQL errors: ${payload.errors.map((entry) => entry.message).join(", ")}`);
    }
    if (!payload.data) {
      throw new Error("Plex community request returned no data.");
    }
    return payload.data;
  }

  private parseYear(value?: string | null) {
    if (!value) return null;
    const year = Number.parseInt(value.slice(0, 4), 10);
    return Number.isNaN(year) ? null : year;
  }

  private normalizeRssTitle(title: string): { title: string; year: number | null } {
    const match = title.match(/^(.*)\s+\((\d{4})\)$/);
    if (!match) {
      return { title: title.trim(), year: null };
    }

    const parsedYear = Number.parseInt(match[2], 10);
    return {
      title: match[1].trim(),
      year: Number.isNaN(parsedYear) ? null : parsedYear
    };
  }

  private normalizePosterUrl(url: string | null | undefined): string | null {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      if (parsed.hostname === "images.plex.tv" && parsed.pathname === "/photo") {
        const nested = parsed.searchParams.get("url");
        if (nested) {
          return nested;
        }
      }
    } catch {
      return url;
    }

    return url;
  }

  private normalizeGuids(guids: unknown): string[] {
    if (!Array.isArray(guids)) {
      return [];
    }

    return guids
      .map((guid) => {
        if (typeof guid === "string") {
          return guid;
        }
        if (guid && typeof guid === "object" && "id" in guid && typeof guid.id === "string") {
          return guid.id;
        }
        return null;
      })
      .filter((guid): guid is string => Boolean(guid))
      .map((guid) => guid.toLowerCase().trim())
      .filter(Boolean);
  }

  private normalizeAddedAt(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }

      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
      }
    }

    return WATCHLIST_DATE_UNKNOWN_SENTINEL;
  }

  private buildPlexItemId(fallbackId: string, guids?: string[]): string {
    const plexGuid = guids?.find((guid) => guid.startsWith("plex://"));
    return plexGuid ?? fallbackId;
  }

  /**
   * Hit the Plex discover API to retrieve poster, year, release date, and
   * cross-database GUIDs for a watchlist item.
   *
   * `originallyAvailableAt` is the authoritative release-date source. When it
   * is a full YYYY-MM-DD string we use it directly; when only a year is available
   * we synthesise `YYYY-01-01` as a sortable fallback. Both cases populate
   * `releaseDate` so collection ordering is always deterministic.
   *
   * Best-effort: returns null when all endpoint attempts fail.
   */
  private async fetchDiscoverMetadata(item: WatchlistItem): Promise<{ posterUrl: string | null; year: number | null; releaseDate: string | null; guids: string[] } | null> {
    const endpoints = Array.from(new Set([
      item.discoverKey ? item.discoverKey.replace(/^\//, "") : null,
      `library/metadata/${encodeURIComponent(item.plexItemId)}`,
      `library/metadata/${item.plexItemId}`
    ].filter((endpoint): endpoint is string => Boolean(endpoint))));

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(this.buildDiscoverMetadataUrl(endpoint), {
          headers: {
            "User-Agent": PLEX_USER_AGENT,
            "X-Plex-Token": this.settings.token,
            Accept: "application/json"
          }
        });

        if (!response.ok) {
          continue;
        }

        const json = (await response.json()) as {
          MediaContainer?: {
            Metadata?: Array<{
              thumb?: string;
              year?: number;
              originallyAvailableAt?: string;
              Guid?: Array<{ id?: string }>;
            }>;
          };
        };

        const metadata = json.MediaContainer?.Metadata?.[0];
        if (metadata) {
          const guids = (metadata.Guid ?? [])
            .map((g) => g.id)
            .filter((id): id is string => Boolean(id));

          // Derive a full release date from originallyAvailableAt when available,
          // otherwise synthesize YYYY-01-01 from year as a sortable fallback.
          const oaa = metadata.originallyAvailableAt;
          let releaseDate: string | null = null;
          if (oaa && /^\d{4}-\d{2}-\d{2}$/.test(oaa)) {
            releaseDate = oaa;
          } else if (metadata.year) {
            releaseDate = `${metadata.year}-01-01`;
          }

          return {
            posterUrl: metadata.thumb ?? null,
            year: metadata.year ?? this.parseYear(oaa) ?? null,
            releaseDate,
            guids
          };
        }
      } catch {
        // Best-effort discover metadata lookup only.
      }
    }

    return null;
  }

  async fetchRichMetadata(plexItemId: string, discoverKey: string | null): Promise<RichItemMetadata | null> {
    const endpoints = Array.from(new Set([
      discoverKey ? discoverKey.replace(/^\//, "") : null,
      `library/metadata/${encodeURIComponent(plexItemId)}`,
      `library/metadata/${plexItemId}`
    ].filter((ep): ep is string => Boolean(ep))));

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(this.buildDiscoverMetadataUrl(endpoint), {
          headers: {
            "User-Agent": PLEX_USER_AGENT,
            "X-Plex-Token": this.settings.token,
            Accept: "application/json"
          }
        });
        if (!response.ok) continue;

        const json = (await response.json()) as {
          MediaContainer?: {
            Metadata?: Array<{
              summary?: string;
              tagline?: string;
              contentRating?: string;
              audienceRating?: number;
              duration?: number;
              studio?: string;
              Genre?: Array<{ tag?: string }>;
            }>;
          };
        };

        const meta = json.MediaContainer?.Metadata?.[0];
        if (meta) {
          return {
            summary: meta.summary ?? null,
            tagline: meta.tagline ?? null,
            contentRating: meta.contentRating ?? null,
            audienceRating: meta.audienceRating ?? null,
            duration: meta.duration ?? null,
            studio: meta.studio ?? null,
            genres: (meta.Genre ?? []).map((g) => g.tag).filter((t): t is string => Boolean(t))
          };
        }
      } catch {
        // best-effort
      }
    }
    return null;
  }

  /**
   * Enrich a watchlist item with poster, year, release date, and GUIDs from
   * Plex discover metadata.
   *
   * Short-circuit rule: skip the discover lookup only when BOTH thumb AND
   * releaseDate are already known. Having thumb+year alone is not enough —
   * RSS items typically arrive with a thumbnail and year extracted from the
   * feed title, but they have never been through a discover lookup so they
   * will not yet have a proper releaseDate.
   */
  private async enrichWatchlistMetadata(item: WatchlistItem) {
    // Only skip the discover lookup when we already have everything we need.
    // Requiring releaseDate (not just year) prevents RSS-ingested items from
    // permanently bypassing the discover call.
    if (item.thumb && item.releaseDate) {
      return {
        thumb: item.thumb,
        year: item.year,
        releaseDate: item.releaseDate,
        guids: item.guids ?? []
      };
    }

    const discover = await this.fetchDiscoverMetadata(item);
    // Merge discover GUIDs with any existing GUIDs from the watchlist item,
    // deduplicating. This gives us tmdb://, tvdb://, imdb:// IDs alongside
    // the plex:// GUID from the GraphQL watchlist.
    const mergedGuids = Array.from(new Set([
      ...(item.guids ?? []),
      ...(discover?.guids ?? [])
    ]));

    // Derive releaseDate: prefer discover metadata, then synthesize from year.
    let releaseDate = discover?.releaseDate ?? item.releaseDate ?? null;
    if (!releaseDate) {
      const year = discover?.year ?? item.year;
      if (year) {
        releaseDate = `${year}-01-01`;
      }
    }

    return {
      thumb: discover?.posterUrl ?? item.thumb,
      year: discover?.year ?? item.year,
      releaseDate,
      guids: mergedGuids
    };
  }

  async validate() {
    const identity = await this.requestServer<{ MediaContainer?: { machineIdentifier?: string } }>("/identity");
    const libraries = await this.getLibraries();
    const machineIdentifier =
      identity.MediaContainer?.machineIdentifier || this.settings.machineIdentifier;

    this.resolvedMachineIdentifier = machineIdentifier || null;

    return {
      machineIdentifier,
      libraries
    };
  }

  async getLibraries(): Promise<PlexLibrary[]> {
    const response = await this.requestServer<{
      MediaContainer?: { Directory?: Array<{ key: string; title: string; type: "movie" | "show" }> };
    }>("/library/sections");

    return (response.MediaContainer?.Directory || []).filter(
      (library) => library.type === "movie" || library.type === "show"
    );
  }

  async getRecentlyAddedLibraryItems(
    libraryId: string,
    mediaType: MediaType,
    addedSince: Date
  ): Promise<PlexLibraryItemMatch[]> {
    const params = new URLSearchParams({
      includeGuids: "1",
      sort: "addedAt:desc",
      "addedAt>>=": String(Math.floor(addedSince.getTime() / 1000))
    });

    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{
          ratingKey: string;
          addedAt?: number;
          Guid?: Array<{ id?: string }>;
        }>;
      };
    }>(`/library/sections/${libraryId}/all?${params.toString()}`, {
      headers: {
        "X-Plex-Container-Start": "0",
        "X-Plex-Container-Size": mediaType === "movie" ? "500" : "200"
      }
    });

    return (response.MediaContainer?.Metadata || []).map((item) => ({
      ratingKey: item.ratingKey,
      addedAt: typeof item.addedAt === "number" ? new Date(item.addedAt * 1000).toISOString() : null,
      guids: (item.Guid || [])
        .map((guid) => guid.id)
        .filter((id): id is string => Boolean(id))
        .map((id) => id.toLowerCase())
    }));
  }

  async getAllLibraryItems(libraryId: string, mediaType: MediaType): Promise<PlexLibraryItemMatch[]> {
    const pageSize = mediaType === "movie" ? 500 : 200;
    const items: PlexLibraryItemMatch[] = [];
    let start = 0;

    while (true) {
      const response = await this.requestServer<{
        MediaContainer?: {
          Metadata?: Array<{
            ratingKey: string;
            addedAt?: number;
            Guid?: Array<{ id?: string }>;
          }>;
        };
      }>(`/library/sections/${libraryId}/all?includeGuids=1`, {
        headers: {
          "X-Plex-Container-Start": String(start),
          "X-Plex-Container-Size": String(pageSize)
        }
      });

      const page = (response.MediaContainer?.Metadata || []).map((item) => ({
        ratingKey: item.ratingKey,
        addedAt: typeof item.addedAt === "number" ? new Date(item.addedAt * 1000).toISOString() : null,
        guids: (item.Guid || [])
          .map((guid) => guid.id)
          .filter((id): id is string => Boolean(id))
          .map((id) => id.toLowerCase())
      }));

      items.push(...page);

      if (page.length < pageSize) {
        break;
      }

      start += pageSize;
    }

    return items;
  }

  async discoverUsers() {
    const data = await this.requestCommunity<{ allFriendsV2: PlexFriendNode[] }>(`
      query GetAllFriends {
        allFriendsV2 {
          user {
            id
            username
            displayName
            avatar
          }
        }
      }
    `);

    return data.allFriendsV2.map((friend) => ({
      plexUserId: friend.user.id,
      username: friend.user.username,
      displayName: friend.user.displayName || friend.user.username,
      avatarUrl: friend.user.avatar
    }));
  }

  private async fetchGraphqlWatchlist(userId: string): Promise<WatchlistItem[]> {
    const items: WatchlistItem[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data: PlexFriendWatchlistResponse = await this.requestCommunity<PlexFriendWatchlistResponse>(
        `
          query GetFriendWatchlist($user: UserInput!, $first: PaginationInt!, $after: String) {
            userV2(user: $user) {
              ... on User {
                watchlist(first: $first, after: $after) {
                  nodes {
                    id
                    guid
                    key
                    title
                    type
                    year
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        { user: { id: userId }, first: 100, after }
      );

      for (const item of data.userV2.watchlist.nodes) {
        const guid = item.guid?.toLowerCase().trim();
        const guids = guid ? [guid] : undefined;
        items.push({
          plexItemId: this.buildPlexItemId(item.key ?? item.id, guids),
          title: item.title,
          type: item.type === "SHOW" ? "show" : "movie",
          year: item.year ?? null,
          releaseDate: null,
          thumb: null,
          guids,
          discoverKey: item.key,
          source: "graphql",
          addedAt: WATCHLIST_DATE_UNKNOWN_SENTINEL,
          matchedRatingKey: null
        });
      }

      hasNextPage = data.userV2.watchlist.pageInfo.hasNextPage;
      after = data.userV2.watchlist.pageInfo.endCursor;
    }

    return items;
  }

  async fetchUserWatchlist(userId: string): Promise<WatchlistItem[]> {
    return this.fetchGraphqlWatchlist(userId);
  }

  /**
   * Fetch WATCHLIST activity feed entries from the Plex Community GraphQL API.
   *
   * On the initial call (since = null) paginates the full history.
   * On incremental calls, pass the ISO timestamp from the previous run —
   * pagination stops when entries older than that timestamp are reached.
   * Plex returns entries newest-first so this is safe to short-circuit.
   *
   * Returns one tuple per event. The caller is responsible for upserting into
   * watchlist_activity_cache, keeping only the most recent date per user+item.
   */
  async fetchWatchlistActivityFeed(
    since: string | null
  ): Promise<Array<{ plexItemId: string; plexUserId: string; watchlistedAt: string }>> {
    const results: Array<{ plexItemId: string; plexUserId: string; watchlistedAt: string }> = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data: PlexActivityFeedResponse = await this.requestCommunity<PlexActivityFeedResponse>(
        `query GetWatchlistActivity($first: PaginationInt!, $after: String) {
           activityFeed(first: $first, after: $after, types: [WATCHLIST]) {
             nodes {
               date
               userV2 { id username displayName }
               metadataItem { id title type key guid }
             }
             pageInfo { endCursor hasNextPage }
           }
         }`,
        { first: 100, after }
      );

      let reachedSince = false;
      for (const node of data.activityFeed.nodes) {
        // Incremental mode: stop once we pass entries older than last fetch
        if (since && node.date <= since) {
          reachedSince = true;
          break;
        }
        if (!node.metadataItem) continue;
        const guids = node.metadataItem.guid ? [node.metadataItem.guid] : undefined;
        const plexItemId = this.buildPlexItemId(node.metadataItem.key ?? node.metadataItem.id, guids);
        results.push({
          plexItemId,
          plexUserId: node.userV2.id,
          watchlistedAt: node.date
        });
      }

      hasNextPage = !reachedSince && data.activityFeed.pageInfo.hasNextPage;
      after = data.activityFeed.pageInfo.endCursor;
    }

    return results;
  }

  async enrichWatchlistItem(item: WatchlistItem): Promise<WatchlistItem> {
    const enriched = await this.enrichWatchlistMetadata(item);
    return {
      ...item,
      thumb: enriched.thumb,
      year: enriched.year,
      releaseDate: enriched.releaseDate,
      guids: enriched.guids
    };
  }

  async resolveWatchlistItems(items: WatchlistItem[], mediaType: MediaType, libraryId: string): Promise<ResolvedWatchlistItem[]> {
    const filteredItems = items.filter((entry) => entry.type === mediaType);

    const results = await Promise.all(filteredItems.map((item) =>
      resolveWatchlistItemLimit(async (): Promise<ResolvedWatchlistItem> => {
        this.logger.debug("Watchlist item raw data", { item });

        // Enrich first so we have tmdb/tvdb/imdb GUIDs from discover.provider.plex.tv
        // before attempting the library match.
        const enriched = await this.enrichWatchlistMetadata(item);
        const enrichedGuids = enriched.guids;

        this.logger.debug("Watchlist item enriched GUIDs", {
          title: item.title,
          originalGuids: item.guids ?? [],
          enrichedGuids
        });

        const match = await this.searchLibraryItem(
          item.title,
          mediaType,
          libraryId,
          enriched.year || undefined,
          enrichedGuids
        );
        const matchedRatingKey = match.ratingKey || null;

        if (matchedRatingKey) {
          this.logger.debug("Watchlist item resolved to library", {
            title: item.title,
            type: mediaType,
            ratingKey: matchedRatingKey
          });
          return {
            ...item,
            thumb: enriched.thumb,
            year: enriched.year,
            releaseDate: enriched.releaseDate,
            guids: enrichedGuids,
            matchedRatingKey
          };
        } else {
          this.logger.warn("Watchlist item not matched in library", {
            title: item.title,
            type: mediaType,
            year: enriched.year ?? null,
            guids: enrichedGuids,
            libraryId,
            candidateCount: match.candidates.length,
            candidates: match.candidates
          });
          return {
            ...item,
            thumb: enriched.thumb,
            year: enriched.year,
            releaseDate: enriched.releaseDate,
            guids: enrichedGuids,
            matchedRatingKey: null,
            searchCandidates: match.candidates
          };
        }
      })
    ));

    return results;
  }

  async searchLibraryItem(
    title: string,
    mediaType: MediaType,
    libraryId: string,
    year?: number,
    guids?: string[]
  ): Promise<{ ratingKey: string | null; matchedBy: "guid" | "title" | "none"; candidates: SearchCandidate[] }> {
    const typeParam = mediaType === "movie" ? 1 : 2;
    // Note: year is intentionally omitted from the query — it's too strict
    // and Plex sometimes stores a different year than the watchlist metadata.
    // GUID matching handles precision; title matching uses year only for disambiguation.
    const params = new URLSearchParams({
      type: String(typeParam),
      title,
      includeGuids: "1"
    });

    this.logger.debug("Library match attempt", {
      mediaType,
      title,
      year: year ?? null,
      guids: guids ?? [],
      libraryId,
      query: params.toString()
    });

    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{
          ratingKey: string;
          title: string;
          year?: number;
          Guid?: Array<{ id?: string }>;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
    }>(`/library/sections/${libraryId}/all?${params.toString()}`);

    this.logger.debug("Library search raw response", { response });

    const entries = response.MediaContainer?.Metadata || [];
    const normalizedGuids = new Set((guids || []).map((guid) => guid.toLowerCase().trim()).filter(Boolean));

    const candidates = entries.map((e) => ({
      title: e.title,
      year: e.year ?? null,
      ratingKey: e.ratingKey,
      guids: (e.Guid || []).map((g) => g.id).filter((id): id is string => Boolean(id))
    }));

    this.logger.debug("Library search results", {
      title,
      candidateCount: entries.length,
      candidates
    });

    const guidMatch =
      normalizedGuids.size > 0
        ? entries.find((entry) =>
            (entry.Guid || [])
              .map((guid) => guid.id?.toLowerCase().trim())
              .filter((guid): guid is string => Boolean(guid))
              .some((guid) => normalizedGuids.has(guid))
          )
        : null;

    if (guidMatch) {
      this.logger.debug("Library match result", {
        title,
        matchedBy: "guid",
        ratingKey: guidMatch.ratingKey
      });
      return { ratingKey: guidMatch.ratingKey, matchedBy: "guid", candidates };
    }

    this.logger.debug("Library match result", {
      title,
      matchedBy: "none",
      ratingKey: null
    });
    return { ratingKey: null, matchedBy: "none", candidates };
  }

  async getCollections(libraryId: string) {
    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{ ratingKey: string; title: string }>;
      };
    }>(`/library/sections/${libraryId}/collections`);

    return response.MediaContainer?.Metadata || [];
  }

  async createCollection(title: string, mediaType: MediaType, libraryId: string) {
    const type = mediaType === "movie" ? 1 : 2;
    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{ ratingKey: string }>;
      };
    }>(
      `/library/collections?type=${type}&title=${encodeURIComponent(title)}&smart=0&sectionId=${libraryId}`,
      { method: "POST" }
    );

    const ratingKey = response.MediaContainer?.Metadata?.[0]?.ratingKey;
    if (!ratingKey) {
      throw new Error("Plex did not return a collection rating key.");
    }
    return ratingKey;
  }

  async getCollectionItems(collectionRatingKey: string) {
    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{ ratingKey: string }>;
      };
    }>(`/library/collections/${collectionRatingKey}/children`);

    return (response.MediaContainer?.Metadata || []).map((item) => item.ratingKey);
  }

  async syncCollectionItems(collectionRatingKey: string, ratingKeys: string[]) {
    const machineIdentifier = await this.getMachineIdentifier();
    const currentItems = await this.getCollectionItems(collectionRatingKey);
    const currentSet = new Set(currentItems);
    const desiredSet = new Set(ratingKeys);

    const toAdd = ratingKeys.filter((key) => !currentSet.has(key));
    const toRemove = currentItems.filter((key) => !desiredSet.has(key));

    this.logger.debug("Collection item sync", {
      collectionRatingKey,
      current: currentItems.length,
      desired: ratingKeys.length,
      toAdd: toAdd.length,
      toRemove: toRemove.length
    });

    if (toAdd.length) {
      const uri = `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${toAdd.join(",")}`;
      await this.requestServer(
        `/library/collections/${collectionRatingKey}/items?uri=${encodeURIComponent(uri)}`,
        { method: "PUT" }
      );
    }

    for (const key of toRemove) {
      await this.requestServer(
        `/library/collections/${collectionRatingKey}/items/${key}`,
        { method: "DELETE" }
      );
    }
  }

  async ensureCollection(title: string, mediaType: MediaType, libraryId: string) {
    const existing = (await this.getCollections(libraryId)).find((collection) => collection.title === title);
    if (existing) {
      return existing.ratingKey;
    }
    return this.createCollection(title, mediaType, libraryId);
  }

  async deleteCollection(collectionRatingKey: string): Promise<void> {
    await this.requestServer(`/library/metadata/${collectionRatingKey}`, { method: "DELETE" });
  }

  async updateCollectionVisibility(
    collectionRatingKey: string,
    libraryId: string,
    visibility: { recommended: boolean; home: boolean; shared: boolean }
  ) {
    await this.requestServer(
      `/hubs/sections/${libraryId}/manage?metadataItemId=${collectionRatingKey}`,
      { method: "POST" }
    );

    const hubIdentifier = `custom.collection.${libraryId}.${collectionRatingKey}`;
    const params = new URLSearchParams({
      promotedToRecommended: visibility.recommended ? "1" : "0",
      promotedToOwnHome: visibility.home ? "1" : "0",
      promotedToSharedHome: visibility.shared ? "1" : "0"
    });

    await this.requestServer(
      `/hubs/sections/${libraryId}/manage/${hubIdentifier}?${params.toString()}`,
      { method: "PUT" }
    );

    return hubIdentifier;
  }

  /**
   * Set the sort title on a collection so it sorts after user-managed content.
   * Uses type=18 (collection) and locked so Plex won't override it.
   */
  async updateCollectionSortTitle(ratingKey: string, sortTitle: string): Promise<void> {
    const params = new URLSearchParams({
      type: "18",
      id: ratingKey,
      "titleSort.value": sortTitle,
      "titleSort.locked": "1"
    });
    await this.requestServer(`/library/metadata/${ratingKey}?${params.toString()}`, { method: "PUT" });
  }

  /**
   * Set the Plex collection sort mode.
   *   date-desc → collectionSort=2 (custom order, items positioned via reorderCollectionItems)
   *   date-asc  → collectionSort=2 (custom order, items positioned via reorderCollectionItems)
   *   title     → collectionSort=1 (Plex native alphabetical)
   *
   * Both date directions use Hubarr-managed custom ordering so the sort behaviour
   * is consistent and deterministic regardless of direction.
   */
  async updateCollectionContentSort(ratingKey: string, sortOrder: CollectionSortOrder): Promise<void> {
    const plexSort: Record<CollectionSortOrder, number> = {
      "date-desc": 2,
      "date-asc": 2,
      "title": 1,
      // Watchlist date sorts use Plex's custom order mode (2) so item positions
      // can be pushed explicitly via reorderCollectionItems.
      "watchlist-date-desc": 2,
      "watchlist-date-asc": 2
    };
    await this.requestServer(
      `/library/collections/${ratingKey}/prefs?collectionSort=${plexSort[sortOrder]}`,
      { method: "PUT" }
    );
  }

  /**
   * Enforce a specific item order in a custom-sorted collection.
   * Moves every item into position sequentially — simple and guaranteed correct.
   * Skips the whole operation if the collection is already in the desired order.
   */
  async reorderCollectionItems(collectionRatingKey: string, orderedRatingKeys: string[]): Promise<void> {
    if (orderedRatingKeys.length <= 1) return;

    const currentOrder = await this.getCollectionItems(collectionRatingKey);

    if (
      currentOrder.length === orderedRatingKeys.length &&
      currentOrder.every((key, i) => key === orderedRatingKeys[i])
    ) {
      return; // already in correct order
    }

    for (let i = 0; i < orderedRatingKeys.length; i++) {
      const itemKey = orderedRatingKeys[i];
      if (i === 0) {
        await this.requestServer(
          `/library/collections/${collectionRatingKey}/items/${itemKey}/move`,
          { method: "PUT" }
        );
      } else {
        const afterKey = orderedRatingKeys[i - 1];
        await this.requestServer(
          `/library/collections/${collectionRatingKey}/items/${itemKey}/move?after=${afterKey}`,
          { method: "PUT" }
        );
      }
    }
  }

  /**
   * Fetch the account info for the admin (the owner of the configured token).
   * Used to upsert the self user record when Plex settings are saved.
   */
  private async fetchSelfAccountData(): Promise<{
    plexUserId: string;
    plexUuid: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  }> {
    const response = await fetch(PLEX_TV_ACCOUNT_URL, {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": this.settings.token,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Plex account info: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as {
      user?: {
        id?: number | string;
        uuid?: string;
        username?: string;
        title?: string;
        thumb?: string;
      };
    };

    const user = json.user;
    if (!user?.id) {
      throw new Error("Plex account response did not include a user ID.");
    }

    return {
      plexUserId: String(user.id),
      plexUuid: user.uuid ?? String(user.id),
      username: user.username ?? String(user.id),
      displayName: user.title ?? user.username ?? String(user.id),
      avatarUrl: user.thumb ?? null
    };
  }

  async fetchSelfAccount(): Promise<{
    plexUserId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  }> {
    const account = await this.fetchSelfAccountData();
    return {
      plexUserId: account.plexUserId,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl
    };
  }

  /**
   * Fetch the admin's own watchlist via the Plex discover REST API.
   * Paginates automatically. Returns WatchlistItem[] with source "graphql"
   * (a direct Plex API call, same trust level as the GraphQL friend path).
   */
  async fetchSelfWatchlist(): Promise<WatchlistItem[]> {
    const account = await this.fetchSelfAccountData();
    return this.fetchGraphqlWatchlist(account.plexUuid);
  }

  /**
   * Return the UUID of the authenticated admin account.
   * Plex internally uses two ID formats for the same account: a legacy numeric
   * ID (stored in the `users` table as plexUserId) and a hex UUID (used by the
   * GraphQL API and the activityFeed). This method returns the UUID form so
   * callers can look up the activity cache using the correct identifier.
   */
  async fetchSelfPlexUuid(): Promise<string> {
    const account = await this.fetchSelfAccountData();
    return account.plexUuid;
  }

  /**
   * Fetch a Plex watchlist RSS feed URL.
   * feedType "watchlist" = admin's own feed; "friendsWatchlist" = combined friends feed.
   * Requires Plex Pass. Must be called with the admin's personal Plex OAuth token
   * (PlexOwnerRecord.plexToken), NOT the Plex server token — discover.provider.plex.tv
   * is a cloud endpoint that requires the personal account token.
   */
  async fetchRssUrl(feedType: "watchlist" | "friendsWatchlist", ownerToken: string): Promise<string | null> {
    const url = new URL(`${DISCOVER_ORIGIN}${DISCOVER_RSS_PATH}`);
    url.searchParams.set("X-Plex-Client-Identifier", "hubarr");
    url.searchParams.set("format", "json");

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "User-Agent": PLEX_USER_AGENT,
          "Content-Type": "application/json",
          "X-Plex-Token": ownerToken
        },
        body: JSON.stringify({ feedType })
      });

      if (!response.ok) {
        return null;
      }

      const json = (await response.json()) as { RSSInfo?: Array<{ url: string }> };
      return json.RSSInfo?.[0]?.url ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch and parse items from a Plex RSS feed URL.
   * Returns a tagged result so callers can distinguish auth failures
   * (Plex Pass not active / token lacks RSS access) from transient errors.
   */
  async fetchRssFeedItems(
    url: string
  ): Promise<{ ok: true; items: RssFeedItem[] } | { ok: false; authError: boolean; message: string }> {
    const urlObj = this.buildDiscoverRssRequestUrl(url);

    try {
      const response = await fetch(urlObj.toString(), {
        headers: {
          "User-Agent": PLEX_USER_AGENT,
          "X-Plex-Token": this.settings.token,
          Accept: "application/json"
        }
      });

      if (response.status === 401 || response.status === 403) {
        return { ok: false, authError: true, message: `HTTP ${response.status}: RSS token lacks Plex Pass or RSS access` };
      }

      if (!response.ok) {
        return { ok: false, authError: false, message: `HTTP ${response.status}: ${response.statusText}` };
      }

      const json = (await response.json()) as {
        items?: Array<{
          title?: string;
          category?: string;
          guids?: unknown[];
          author?: string;
          pubDate?: string;
          thumbnail?: { url?: string };
        }>;
      };

      const items: RssFeedItem[] = [];

      for (const raw of json.items ?? []) {
        if (!raw.title || !raw.category || !Array.isArray(raw.guids) || raw.guids.length === 0) {
          continue;
        }

        const type = this.parseRssCategory(raw.category);
        if (!type) {
          continue;
        }

        const guids = raw.guids
          .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
          .map((g) => g.toLowerCase().trim());

        if (guids.length === 0) {
          continue;
        }

        const normalizedTitle = this.normalizeRssTitle(raw.title);

        items.push({
          title: normalizedTitle.title,
          type,
          guids,
          author: raw.author ?? "",
          thumb: this.normalizePosterUrl(raw.thumbnail?.url ?? null),
          year: normalizedTitle.year,
          pubDate: typeof raw.pubDate === "string" ? raw.pubDate : null
        });
      }

      return { ok: true, items };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, authError: false, message };
    }
  }

  private parseRssCategory(category: string): "movie" | "show" | null {
    const normalized = category.toLowerCase().trim();
    if (normalized === "movie" || normalized === "movies") return "movie";
    if (normalized === "show" || normalized === "shows" || normalized === "tv") return "show";
    return null;
  }

  createCollectionLabel(userName: string) {
    return `hubarr:${userName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-watchlist`;
  }

  async getCollectionLabels(ratingKey: string): Promise<string[]> {
    const response = await this.requestServer<{
      MediaContainer?: {
        Metadata?: Array<{
          Label?: Array<{ tag: string }>;
        }>;
      };
    }>(`/library/metadata/${ratingKey}`);

    return (response.MediaContainer?.Metadata?.[0]?.Label ?? []).map((l) => l.tag);
  }

  /**
   * Apply a Hubarr label to a Plex collection (not to media items inside it).
   * Strips any existing hubarr:* labels first so old formats don't accumulate,
   * then adds the new label. No-ops if the label is already the only hubarr label present.
   */
  async applyLabelToCollection(ratingKey: string, labelName: string): Promise<void> {
    const existingLabels = await this.getCollectionLabels(ratingKey);

    // Strip old hubarr labels, keep everything else
    const nonHubarrLabels = existingLabels.filter((l) => !l.toLowerCase().startsWith("hubarr:"));
    const hubarrLabels = existingLabels.filter((l) => l.toLowerCase().startsWith("hubarr:"));
    if (hubarrLabels.length === 1 && hubarrLabels[0].toLowerCase() === labelName.toLowerCase()) {
      return; // already correct, nothing to change
    }

    const allLabels = [...nonHubarrLabels, labelName];
    // Keys are NOT encoded — Plex expects literal bracket syntax e.g. label[0].tag.tag
    // Values are encoded.
    const parts: string[] = ["label.locked=1"];
    allLabels.forEach((label, index) => {
      parts.push(`label[${index}].tag.tag=${encodeURIComponent(label)}`);
    });

    await this.requestServer(`/library/metadata/${ratingKey}?${parts.join("&")}`, { method: "PUT" });
  }

  hashRatingKeys(keys: string[]) {
    return crypto.createHash("sha256").update(keys.join(",")).digest("hex");
  }

  /**
   * Fetch all Plex managed users who have access to this server.
   * Uses the Plex.tv v2 shared_servers API (returns XML).
   * Filters to only users on this server by machineIdentifier.
   */
  private async getSharedUsers(): Promise<Array<{
    plexUserId: string;
    invitedEmail: string;
    filterMovies: string;
    filterTelevision: string;
    filterMusic: string;
    filterPhotos: string;
    filterAll: string;
    allowSync: boolean;
    allowChannels: boolean;
    allowCameraUpload: boolean;
    allowSubtitleAdmin: boolean;
    allowTuners: number;
  }>> {
    const machineIdentifier = await this.getMachineIdentifier();

    const url = new URL("https://clients.plex.tv/api/v2/shared_servers/owned/accepted");
    url.searchParams.set("X-Plex-Product", "Hubarr");
    url.searchParams.set("X-Plex-Client-Identifier", "hubarr");
    url.searchParams.set("X-Plex-Token", this.settings.token);

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/xml" }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch shared servers: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = await parseStringPromise(xml) as {
      sharedServers?: {
        sharedServer?: Array<{
          $: { invitedId: string; invitedEmail: string; machineIdentifier: string };
          invited?: Array<{
            $: { username?: string; email?: string };
            sharingSettings?: Array<{
              $: {
                filterMovies?: string;
                filterTelevision?: string;
                filterMusic?: string;
                filterPhotos?: string;
                filterAll?: string;
                allowSync?: string;
                allowChannels?: string;
                allowCameraUpload?: string;
                allowSubtitleAdmin?: string;
                allowTuners?: string;
              };
            }>;
          }>;
        }>;
      };
    };

    const servers = parsed.sharedServers?.sharedServer ?? [];

    return servers
      .filter((s) => s.$.machineIdentifier === machineIdentifier)
      .flatMap((s) => {
        const invited = s.invited?.[0];
        if (!invited) return [];
        // sharing may be absent for users with no restrictions set — use empty defaults
        const sharing = invited.sharingSettings?.[0]?.$;
        return [{
          plexUserId: s.$.invitedId,
          invitedEmail: invited.$.username || invited.$.email || s.$.invitedEmail,
          filterMovies: decodeURIComponent(sharing?.filterMovies ?? ""),
          filterTelevision: decodeURIComponent(sharing?.filterTelevision ?? ""),
          filterMusic: sharing?.filterMusic ?? "",
          filterPhotos: sharing?.filterPhotos ?? "",
          filterAll: sharing?.filterAll ?? "",
          allowSync: sharing?.allowSync === "1",
          allowChannels: sharing?.allowChannels === "1",
          allowCameraUpload: sharing?.allowCameraUpload === "1",
          allowSubtitleAdmin: sharing?.allowSubtitleAdmin === "1",
          allowTuners: parseInt(sharing?.allowTuners ?? "0", 10)
        }];
      });
  }

  /**
   * Fetch Plex Home managed users who have no independent Plex account.
   * Uses the plex.tv/api/users endpoint and filters for home-only managed
   * accounts (home="1", no username/email), scoped to this server.
   */
  private async getHomeOnlyManagedUsers(): Promise<Array<{
    plexUserId: string;
    displayName: string;
    avatarUrl: string | null;
    filterMovies: string;
    filterTelevision: string;
    filterMusic: string;
    filterPhotos: string;
    filterAll: string;
    allowSync: boolean;
    allowChannels: boolean;
    allowCameraUpload: boolean;
    allowSubtitleAdmin: boolean;
    allowTuners: number;
    hasRestrictionProfile: boolean;
  }>> {
    const machineIdentifier = await this.getMachineIdentifier();

    const url = new URL(PLEX_TV_USERS_URL);
    url.searchParams.set("X-Plex-Token", this.settings.token);

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/xml", "User-Agent": PLEX_USER_AGENT }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Plex users list: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = await parseStringPromise(xml) as {
      MediaContainer?: {
        User?: Array<{
          $: {
            id: string;
            title?: string;
            thumb?: string;
            home?: string;
            username?: string;
            email?: string;
            filterMovies?: string;
            filterTelevision?: string;
            filterMusic?: string;
            filterPhotos?: string;
            filterAll?: string;
            allowSync?: string;
            allowChannels?: string;
            allowCameraUpload?: string;
            allowSubtitleAdmin?: string;
            allowTuners?: string;
          };
          Server?: Array<{ $: { machineIdentifier: string } }>;
        }>;
      };
    };

    const users = parsed.MediaContainer?.User ?? [];

    return users
      .filter((u) =>
        u.$.home === "1" &&
        !u.$.username &&
        !u.$.email &&
        (u.Server ?? []).some((s) => s.$.machineIdentifier === machineIdentifier)
      )
      .map((u) => {
        const filterMovies = decodeURIComponent(u.$.filterMovies ?? "");
        const filterTelevision = decodeURIComponent(u.$.filterTelevision ?? "");
        return {
          plexUserId: u.$.id,
          displayName: u.$.title ?? u.$.id,
          avatarUrl: u.$.thumb ?? null,
          filterMovies,
          filterTelevision,
          filterMusic: u.$.filterMusic ?? "",
          filterPhotos: u.$.filterPhotos ?? "",
          filterAll: u.$.filterAll ?? "",
          allowSync: u.$.allowSync === "1",
          allowChannels: u.$.allowChannels === "1",
          allowCameraUpload: u.$.allowCameraUpload === "1",
          allowSubtitleAdmin: u.$.allowSubtitleAdmin === "1",
          allowTuners: parseInt(u.$.allowTuners ?? "0", 10),
          hasRestrictionProfile: filterMovies.includes("contentRating=") || filterTelevision.includes("contentRating=")
        };
      });
  }

  async fetchManagedUsers(): Promise<Array<{
    plexUserId: string;
    displayName: string;
    avatarUrl: string | null;
    hasRestrictionProfile: boolean;
  }>> {
    const users = await this.getHomeOnlyManagedUsers();
    return users.map(({ plexUserId, displayName, avatarUrl, hasRestrictionProfile }) => ({
      plexUserId,
      displayName,
      avatarUrl,
      hasRestrictionProfile
    }));
  }

  /**
   * Apply per-user label exclusion filters so each Plex managed user only
   * sees their own watchlist hub row, not other users' rows.
   *
   * For each Plex managed user on this server:
   * - If they match an enabled Hubarr friend: exclude all other enabled friends' labels
   * - If they are not a tracked Hubarr friend: exclude all enabled friends' labels
   *
   * The admin (server owner) is not a shared user and is unaffected — they see all collections.
   * Existing non-Hubarr filters (contentRating etc.) are always preserved.
   */
  async syncIsolationFilters(enabledUsers: UserRecord[]): Promise<{ updated: number; skipped: number }> {
    const sharedUsers = await this.getSharedUsers();

    // Build one label per user (same label applies to both movie and TV collections)
    const allLabels = enabledUsers.map((u) => this.createCollectionLabel(u.displayName));

    // Index enabled users by their Plex username for matching with shared users.
    // The XML invitedId and GraphQL plexUserId are different ID formats, but
    // the Plex username is consistent across both APIs (matches user.invitedEmail).
    const userByUsername = new Map(enabledUsers.map((u) => [u.username, u]));

    const updateUrl = new URL("https://clients.plex.tv/api/v2/sharing_settings");
    updateUrl.searchParams.set("X-Plex-Product", "Hubarr");
    updateUrl.searchParams.set("X-Plex-Client-Identifier", "hubarr");
    updateUrl.searchParams.set("X-Plex-Token", this.settings.token);

    let updated = 0;
    let skipped = 0;

    for (const user of sharedUsers) {
      if (!user.invitedEmail) {
        // Plex Home managed users with no Plex account (no username or email) cannot be
        // updated via the sharing_settings API — skip gracefully.
        skipped++;
        continue;
      }
      const matchedUser = userByUsername.get(user.invitedEmail);

      // Labels to exclude: all labels EXCEPT this user's own
      const excludedLabels = matchedUser
        ? allLabels.filter((l) => l !== this.createCollectionLabel(matchedUser.displayName))
        : allLabels;

      // Strip old Hubarr labels then re-apply the current set
      const cleanedMovieFilter = removeHubarrLabelsFromFilter(user.filterMovies);
      const cleanedShowFilter = removeHubarrLabelsFromFilter(user.filterTelevision);
      const finalMovieFilter = addHubarrLabelExclusions(cleanedMovieFilter, excludedLabels);
      const finalShowFilter = addHubarrLabelExclusions(cleanedShowFilter, excludedLabels);

      // Skip if nothing changed
      if (finalMovieFilter === user.filterMovies && finalShowFilter === user.filterTelevision) {
        skipped++;
        continue;
      }

      const payload = {
        invitedEmail: user.invitedEmail,
        settings: {
          filterMovies: finalMovieFilter,
          filterTelevision: finalShowFilter,
          filterMusic: user.filterMusic,
          filterPhotos: user.filterPhotos,
          filterAll: user.filterAll || null,
          allowSync: user.allowSync,
          allowChannels: user.allowChannels,
          allowCameraUpload: user.allowCameraUpload,
          allowSubtitleAdmin: user.allowSubtitleAdmin,
          allowTuners: user.allowTuners
        }
      };

      const response = await fetch(updateUrl.toString(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to update sharing filters for ${user.invitedEmail}: ${response.status} ${text}`);
      }

      updated++;
    }

    // Also apply to Plex Home managed users who have no independent Plex account.
    // These can't be reached via the email-based sharing_settings path, but the
    // same endpoint accepts invitedId (numeric user ID) as an alternative.
    const homeUsers = await this.getHomeOnlyManagedUsers();
    for (const user of homeUsers) {
      // Skip users with a restriction profile — Plex prevents label filter changes for them
      if (user.hasRestrictionProfile) {
        skipped++;
        continue;
      }

      // Managed users are never Hubarr-enabled, so always exclude all labels
      const cleanedMovieFilter = removeHubarrLabelsFromFilter(user.filterMovies);
      const cleanedShowFilter = removeHubarrLabelsFromFilter(user.filterTelevision);
      const finalMovieFilter = addHubarrLabelExclusions(cleanedMovieFilter, allLabels);
      const finalShowFilter = addHubarrLabelExclusions(cleanedShowFilter, allLabels);

      if (finalMovieFilter === user.filterMovies && finalShowFilter === user.filterTelevision) {
        skipped++;
        continue;
      }

      const payload = {
        invitedId: user.plexUserId,
        settings: {
          filterMovies: finalMovieFilter,
          filterTelevision: finalShowFilter,
          filterMusic: user.filterMusic,
          filterPhotos: user.filterPhotos,
          filterAll: user.filterAll || null,
          allowSync: user.allowSync,
          allowChannels: user.allowChannels,
          allowCameraUpload: user.allowCameraUpload,
          allowSubtitleAdmin: user.allowSubtitleAdmin,
          allowTuners: user.allowTuners
        }
      };

      const response = await fetch(updateUrl.toString(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to update sharing filters for managed user ${user.displayName} (${user.plexUserId}): ${response.status} ${text}`);
      }

      updated++;
    }

    return { updated, skipped };
  }

  async clearHubarrIsolationFilters(): Promise<{ updated: number; skipped: number }> {
    const sharedUsers = await this.getSharedUsers();

    const updateUrl = new URL("https://clients.plex.tv/api/v2/sharing_settings");
    updateUrl.searchParams.set("X-Plex-Product", "Hubarr");
    updateUrl.searchParams.set("X-Plex-Client-Identifier", "hubarr");
    updateUrl.searchParams.set("X-Plex-Token", this.settings.token);

    let updated = 0;
    let skipped = 0;

    for (const user of sharedUsers) {
      if (!user.invitedEmail) {
        skipped++;
        continue;
      }

      const finalMovieFilter = removeHubarrLabelsFromFilter(user.filterMovies);
      const finalShowFilter = removeHubarrLabelsFromFilter(user.filterTelevision);

      if (finalMovieFilter === user.filterMovies && finalShowFilter === user.filterTelevision) {
        skipped++;
        continue;
      }

      const payload = {
        invitedEmail: user.invitedEmail,
        settings: {
          filterMovies: finalMovieFilter,
          filterTelevision: finalShowFilter,
          filterMusic: user.filterMusic,
          filterPhotos: user.filterPhotos,
          filterAll: user.filterAll || null,
          allowSync: user.allowSync,
          allowChannels: user.allowChannels,
          allowCameraUpload: user.allowCameraUpload,
          allowSubtitleAdmin: user.allowSubtitleAdmin,
          allowTuners: user.allowTuners
        }
      };

      const response = await fetch(updateUrl.toString(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to clear sharing filters for ${user.invitedEmail}: ${response.status} ${text}`);
      }

      updated++;
    }

    // Also clear from Plex Home managed users
    const homeUsers = await this.getHomeOnlyManagedUsers();
    for (const user of homeUsers) {
      // Restriction profile users are skipped in sync — don't attempt to clear them either
      if (user.hasRestrictionProfile) {
        skipped++;
        continue;
      }

      const finalMovieFilter = removeHubarrLabelsFromFilter(user.filterMovies);
      const finalShowFilter = removeHubarrLabelsFromFilter(user.filterTelevision);

      if (finalMovieFilter === user.filterMovies && finalShowFilter === user.filterTelevision) {
        skipped++;
        continue;
      }

      const payload = {
        invitedId: user.plexUserId,
        settings: {
          filterMovies: finalMovieFilter,
          filterTelevision: finalShowFilter,
          filterMusic: user.filterMusic,
          filterPhotos: user.filterPhotos,
          filterAll: user.filterAll || null,
          allowSync: user.allowSync,
          allowChannels: user.allowChannels,
          allowCameraUpload: user.allowCameraUpload,
          allowSubtitleAdmin: user.allowSubtitleAdmin,
          allowTuners: user.allowTuners
        }
      };

      const response = await fetch(updateUrl.toString(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to clear sharing filters for managed user ${user.displayName} (${user.plexUserId}): ${response.status} ${text}`);
      }

      updated++;
    }

    return { updated, skipped };
  }

  // ---------------------------------------------------------------------------
  // Static helpers for auth flows (no PlexSettingsInput required)
  // ---------------------------------------------------------------------------

  /**
   * Fetch Plex account info for any token without needing a full settings object.
   * Used during Plex OAuth onboarding to identify the signing-in user.
   */
  static async fetchAccountByToken(token: string): Promise<{
    plexId: string;
    plexToken: string;
    username: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
  }> {
    const response = await fetch(PLEX_TV_ACCOUNT_URL, {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": token,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Plex account fetch failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as {
      user?: {
        id?: number | string;
        username?: string;
        email?: string;
        title?: string;
        thumb?: string;
      };
    };

    const user = json.user;
    if (!user?.id) {
      throw new Error("Plex account response did not include a user ID.");
    }

    return {
      plexId: String(user.id),
      plexToken: token,
      username: user.username ?? String(user.id),
      displayName: user.title ?? user.username ?? String(user.id),
      email: user.email ?? null,
      avatarUrl: user.thumb ?? null
    };
  }

  static async pingToken(token: string): Promise<void> {
    const response = await fetch(PLEX_TV_PING_URL, {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": token,
        Accept: "application/json",
        "X-Plex-Client-Identifier": crypto.randomUUID(),
        "X-Plex-Product": "Hubarr"
      }
    });

    if (!response.ok) {
      throw new Error(`Plex token ping failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { pong?: boolean };
    if (!json.pong) {
      throw new Error("Plex token ping returned no pong response.");
    }
  }

  /**
   * Discover Plex servers owned by the given token.
   * Used during onboarding step 2 (server selection).
   */
  static async discoverServers(token: string): Promise<
    Array<{
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
    }>
  > {
    const url = new URL(PLEX_TV_RESOURCES_URL);
    url.searchParams.set("includeHttps", "1");
    url.searchParams.set("includeRelay", "1");
    url.searchParams.set("includeIPv6", "1");

    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": token,
        Accept: "application/json",
        "X-Plex-Client-Identifier": "hubarr-server",
        "X-Plex-Product": "Hubarr"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to discover Plex servers: ${response.status} ${response.statusText}`);
    }

    type PlexResource = {
      name: string;
      clientIdentifier: string;
      provides: string;
      owned: boolean;
      connections: Array<{
        uri: string;
        address: string;
        port: number;
        protocol: string;
        local: boolean;
      }>;
    };

    const resources = (await response.json()) as PlexResource[];
    const servers = resources.filter((r) => r.provides.includes("server") && r.owned);

    return servers.map((server) => ({
      name: server.name,
      machineIdentifier: server.clientIdentifier,
      connections: server.connections.map((conn) => ({
        uri: conn.uri,
        address: conn.address,
        port: conn.port,
        protocol: conn.protocol,
        local: conn.local,
        status: null,
        message: null
      }))
    }));
  }
}
