import { useEffect, useState } from "react";
import { Film, Tv, X, Star, Clock, Tag } from "lucide-react";
import { formatWatchlistDate } from "../lib/utils";
import { apiGet, apiPost } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import type { RichItemMetadata, SeerrRequestState, SeerrSettingsView, UserRecord, WatchlistUser } from "../../shared/types";

interface ModalItem {
  plexItemId: string;
  title: string;
  year: number | null;
  type: "movie" | "show";
  posterUrl: string | null;
  users: WatchlistUser[];
  plexAvailable: boolean;
}

function formatRuntime(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// Outcomes that mean the item is definitively handled in Seerr — suppress Request buttons for all other users.
const TERMINAL_POSITIVE = new Set(["created", "already_requested", "already_available", "added_directly"]);

// Priority order for picking the single "best" state that represents the item across all users.
const OUTCOME_PRIORITY = ["created", "already_requested", "already_available", "added_directly", "failed", "skipped_unlinked_user", "skipped_missing_ids"];

function getBestSeerrState(states: SeerrRequestState[]): SeerrRequestState | null {
  for (const outcome of OUTCOME_PRIORITY) {
    const found = states.find(s => s.outcome === outcome);
    if (found) return found;
  }
  return null;
}

function buildSeerrUrl(baseUrl: string, type: "movie" | "show", tmdbId: number): string {
  return `${baseUrl.replace(/\/$/, "")}/${type === "movie" ? "movie" : "tv"}/${tmdbId}`;
}

function SeerrIcon({ className = "w-3 h-3" }: { className?: string }) {
  return <img src="/seerr-icon.svg" alt="" aria-hidden="true" className={className} />;
}

interface SeerrBadgeProps {
  outcome: string;
  url?: string | null;
  isRequesting?: boolean;
  onAction?: () => void;
}

function SeerrBadge({ outcome, url, isRequesting, onAction }: SeerrBadgeProps) {
  const base = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap";

  if (outcome === "added_directly") {
    if (url) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" title="View in Seerr" className={`${base} bg-success/10 text-success hover:bg-success/20`}>
          <SeerrIcon />
          In Seerr
        </a>
      );
    }
    return <span className={`${base} bg-success/10 text-success`}><SeerrIcon />In Seerr</span>;
  }

  if (outcome === "created" || outcome === "already_requested" || outcome === "already_available") {
    if (url) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" title="View in Seerr" className={`${base} bg-success/10 text-success hover:bg-success/20`}>
          <SeerrIcon />
          Requested
        </a>
      );
    }
    return <span className={`${base} bg-success/10 text-success`}><SeerrIcon />Requested</span>;
  }

  if (outcome === "failed") {
    return (
      <button onClick={onAction} disabled={isRequesting} className={`${base} bg-error/10 text-error hover:bg-error/20 disabled:opacity-40`}>
        <SeerrIcon />
        {isRequesting ? "Retrying…" : "Retry"}
      </button>
    );
  }

  if (outcome === "__request__") {
    return (
      <button onClick={onAction} disabled={isRequesting} className={`${base} bg-error/10 text-error hover:bg-error/20 disabled:opacity-40`}>
        <SeerrIcon />
        {isRequesting ? "Requesting…" : "Request"}
      </button>
    );
  }

  return null;
}

export function WatchlistItemModal({
  item,
  onClose,
  seerrSettings
}: {
  item: ModalItem;
  onClose: () => void;
  seerrSettings?: SeerrSettingsView | null;
}) {
  const [rich, setRich] = useState<RichItemMetadata | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(true);
  const [seerrStates, setSeerrStates] = useState<SeerrRequestState[]>([]);
  const [seerrStateLoaded, setSeerrStateLoaded] = useState(false);
  const [allUsers, setAllUsers] = useState<UserRecord[]>([]);
  const [requestingFor, setRequestingFor] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    setEnrichLoading(true);
    apiGet<RichItemMetadata | null>(`/api/watchlists/enrich?plexItemId=${encodeURIComponent(item.plexItemId)}`)
      .then((data) => setRich(data))
      .catch(() => setRich(null))
      .finally(() => setEnrichLoading(false));
  }, [item.plexItemId]);

  useEffect(() => {
    let cancelled = false;

    setSeerrStates([]);
    setSeerrStateLoaded(false);
    setRequestError(null);

    if (!seerrSettings?.enabled || item.plexAvailable) {
      setSeerrStateLoaded(true);
      return;
    }

    apiGet<SeerrRequestState[]>(`/api/watchlists/seerr-state?plexItemId=${encodeURIComponent(item.plexItemId)}`)
      .then((states) => {
        if (!cancelled) {
          setSeerrStates(states);
          setSeerrStateLoaded(true);
        }
      })
      .catch((err) => {
        console.error("Failed to load Seerr request state", err);
        if (!cancelled) {
          setRequestError("Unable to load Seerr request state.");
          setSeerrStates([]);
          setSeerrStateLoaded(true);
        }
      });
    // Fetch all users so we can identify non-watchlist requesters
    apiGet<UserRecord[]>("/api/users")
      .then((users) => {
        if (!cancelled) {
          setAllUsers(users);
        }
      })
      .catch((err) => {
        console.error("Failed to load users for Seerr request state", err);
      });

    return () => {
      cancelled = true;
    };
  }, [item.plexItemId, seerrSettings?.enabled, item.plexAvailable]);

  async function requestForUser(userId: number) {
    setRequestingFor(userId);
    setRequestError(null);
    try {
      await apiPost("/api/watchlists/request", { userId, plexItemId: item.plexItemId });
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Request failed.");
      setRequestingFor(null);
      return;
    }
    // Best-effort refresh — if this fails the request already succeeded, so don't surface an error.
    try {
      const updated = await apiGet<SeerrRequestState[]>(`/api/watchlists/seerr-state?plexItemId=${encodeURIComponent(item.plexItemId)}`);
      setSeerrStates(updated);
    } catch (err) {
      console.error("Failed to refresh Seerr state after request", err);
    }
    setRequestingFor(null);
  }

  const posterSrc = getPlexImageSrc(item.posterUrl);

  // --- Seerr dedup logic ---
  const canRequest = Boolean(seerrSettings?.enabled && !item.plexAvailable);
  const seerrActionsReady = canRequest && seerrStateLoaded;
  const bestState = seerrActionsReady ? getBestSeerrState(seerrStates) : null;
  const hasGlobalTerminal = bestState !== null && TERMINAL_POSITIVE.has(bestState.outcome ?? "");

  // URL to open the item in Seerr (only valid when we have a terminal positive state + tmdbId)
  const itemSeerrUrl =
    hasGlobalTerminal && seerrSettings?.baseUrl && bestState?.tmdbId
      ? buildSeerrUrl(seerrSettings.baseUrl, item.type, bestState.tmdbId)
      : null;

  // Item is in Seerr/Radarr but was never requested by any specific user — show Unknown ghost row.
  const isUnknownRequester = canRequest && hasGlobalTerminal && bestState !== null && bestState.seerrRequestId === null;

  // If the "best" state belongs to a user not on this item's watchlist, find their info for a ghost row
  const bestStateIsWatchlistUser = item.users.some(u => u.userId === bestState?.userId);
  const externalRequester =
    canRequest && hasGlobalTerminal && !isUnknownRequester && !bestStateIsWatchlistUser && bestState
      ? (allUsers.find(u => u.id === bestState.userId) ?? null)
      : null;

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-container rounded-2xl w-full max-w-2xl border border-outline-variant/20 shadow-xl overflow-hidden flex max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: poster */}
        <div className="w-44 flex-shrink-0 self-stretch bg-surface-container-high">
          {posterSrc ? (
            <img
              src={posterSrc}
              alt={item.title}
              className="w-full h-full object-cover object-top"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/poster-fallback.svg"; }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              {item.type === "movie" ? (
                <Film size={40} className="text-on-surface-variant" />
              ) : (
                <Tv size={40} className="text-on-surface-variant" />
              )}
            </div>
          )}
        </div>

        {/* Right: scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Close button */}
          <div className="flex justify-end p-3 pb-0">
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="px-5 pb-5 pt-2">
            {/* Title */}
            <h3 className="font-headline font-bold text-xl text-on-surface leading-tight mb-1">
              {item.title}
            </h3>

            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-on-surface-variant text-sm mb-3">
              {item.year && <span>{item.year}</span>}
              <span>·</span>
              <span className="capitalize">{item.type}</span>
              {rich?.contentRating && (
                <>
                  <span>·</span>
                  <span className="px-1.5 py-0.5 rounded border border-outline-variant/40 text-xs font-medium">
                    {rich.contentRating}
                  </span>
                </>
              )}
              {rich?.duration && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {formatRuntime(rich.duration)}
                  </span>
                </>
              )}
              {rich?.audienceRating && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1 text-warning">
                    <Star size={12} fill="currentColor" />
                    {rich.audienceRating.toFixed(1)}
                  </span>
                </>
              )}
              <>
                <span>·</span>
                {item.plexAvailable ? (
                  <span className="text-success text-xs font-medium">In Library</span>
                ) : (
                  <span className="text-error text-xs font-medium">Not In Library</span>
                )}
              </>
            </div>

            {/* Genres */}
            {enrichLoading ? (
              <div className="flex gap-1.5 mb-3">
                {[60, 72, 50].map((w) => (
                  <div key={w} className="h-5 rounded-full bg-surface-container-high animate-pulse" style={{ width: w }} />
                ))}
              </div>
            ) : rich?.genres && rich.genres.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {rich.genres.map((genre) => (
                  <span
                    key={genre}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant text-xs"
                  >
                    <Tag size={10} />
                    {genre}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Tagline */}
            {rich?.tagline && (
              <p className="text-on-surface-variant text-sm italic mb-2">"{rich.tagline}"</p>
            )}

            {/* Summary */}
            {enrichLoading ? (
              <div className="space-y-1.5 mb-4">
                <div className="h-3 rounded bg-surface-container-high animate-pulse w-full" />
                <div className="h-3 rounded bg-surface-container-high animate-pulse w-5/6" />
                <div className="h-3 rounded bg-surface-container-high animate-pulse w-4/6" />
              </div>
            ) : rich?.summary ? (
              <p className="text-on-surface-variant text-sm leading-relaxed mb-4">
                {rich.summary}
              </p>
            ) : null}

            {/* Divider + Users */}
            <div className="border-t border-outline-variant/20 pt-3">
              <div className="text-xs text-on-surface-variant mb-2">
                On watchlist of {item.users.length} user{item.users.length !== 1 ? "s" : ""}
              </div>
              {requestError && (
                <div className="mb-2 px-3 py-2 rounded-lg bg-error/10 text-error text-xs">
                  {requestError}
                </div>
              )}
              <div className="space-y-2.5">
                {item.users.map((user) => {
                  const userState = seerrStates.find(s => s.userId === user.userId);
                  const isTheBestOwner = user.userId === bestState?.userId;
                  const isRequesting = requestingFor === user.userId;

                  // Determine which badge (if any) this user row shows
                  let badgeOutcome: string | null = null;
                  if (seerrActionsReady) {
                    if (!isUnknownRequester && isTheBestOwner && bestState?.outcome) {
                      // This user owns the canonical item state (and a specific person requested it)
                      badgeOutcome = bestState.outcome;
                    } else if (!hasGlobalTerminal) {
                      // No globally-terminal state — show per-user actionable badges
                      if (userState?.outcome === "failed") {
                        badgeOutcome = "failed";
                      } else if (!userState || userState.outcome === null) {
                        badgeOutcome = "__request__";
                      }
                      // skipped_* → no badge (nothing the user can do)
                    }
                  }

                  // Only the owner of a terminal-positive state gets the Seerr link
                  const badgeUrl = isTheBestOwner && hasGlobalTerminal ? itemSeerrUrl : null;

                  return (
                    <div key={user.userId} className="flex items-center gap-2.5">
                      {getPlexImageSrc(user.avatarUrl) ? (
                        <img
                          src={getPlexImageSrc(user.avatarUrl)!}
                          alt={user.displayName}
                          className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0">
                          <span className="text-on-surface-variant text-xs">
                            {user.displayName.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                      <span className="text-on-surface text-sm flex-1 min-w-0 truncate">{user.displayName}</span>
                      {badgeOutcome && (
                        <SeerrBadge
                          outcome={badgeOutcome}
                          url={badgeUrl}
                          isRequesting={isRequesting}
                          onAction={() => void requestForUser(user.userId)}
                        />
                      )}
                      <span className="text-on-surface-variant text-xs flex-shrink-0">{formatWatchlistDate(user.addedAt)}</span>
                    </div>
                  );
                })}

                {/* Ghost row: the terminal state belongs to someone not on this item's watchlist */}
                {externalRequester && (
                  <div className="flex items-center gap-2.5 border-t border-outline-variant/10 pt-2 mt-0.5">
                    {getPlexImageSrc(externalRequester.avatarUrl) ? (
                      <img
                        src={getPlexImageSrc(externalRequester.avatarUrl)!}
                        alt={externalRequester.displayName}
                        className="w-6 h-6 rounded-full object-cover flex-shrink-0 opacity-70"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 opacity-70">
                        <span className="text-on-surface-variant text-xs">
                          {externalRequester.displayName.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <span className="text-on-surface-variant text-sm flex-1 min-w-0 truncate">{externalRequester.displayName}</span>
                    <SeerrBadge outcome={bestState!.outcome!} url={itemSeerrUrl} />
                    <span className="text-on-surface-variant text-xs flex-shrink-0 italic">not on watchlist</span>
                  </div>
                )}

                {/* Ghost row: item is in Seerr/Radarr but was not requested by any specific user */}
                {isUnknownRequester && (
                  <div className="flex items-center gap-2.5 border-t border-outline-variant/10 pt-2 mt-0.5">
                    <div className="w-6 h-6 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 opacity-70">
                      <span className="text-on-surface-variant text-xs">?</span>
                    </div>
                    <span className="text-on-surface-variant text-sm flex-1 min-w-0 truncate italic">Unknown</span>
                    <SeerrBadge outcome={bestState!.outcome!} url={itemSeerrUrl} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
