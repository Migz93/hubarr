import { useEffect, useState } from "react";
import { Film, Tv, X, Star, Clock, Tag } from "lucide-react";
import { formatRelativeTime } from "../lib/utils";
import { apiGet } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import type { RichItemMetadata, WatchlistUser } from "../../shared/types";

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

export function WatchlistItemModal({
  item,
  onClose
}: {
  item: ModalItem;
  onClose: () => void;
}) {
  const [rich, setRich] = useState<RichItemMetadata | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(true);

  useEffect(() => {
    setEnrichLoading(true);
    apiGet<RichItemMetadata | null>(`/api/watchlists/enrich?plexItemId=${encodeURIComponent(item.plexItemId)}`)
      .then((data) => setRich(data))
      .catch(() => setRich(null))
      .finally(() => setEnrichLoading(false));
  }, [item.plexItemId]);

  const posterSrc = getPlexImageSrc(item.posterUrl);

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
              <div className="space-y-2">
                {item.users.map((user) => (
                  <div key={user.userId} className="flex items-center gap-2.5">
                    {user.avatarUrl ? (
                      <img
                        src={getPlexImageSrc(user.avatarUrl) ?? undefined}
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
                    <span className="text-on-surface text-sm flex-1">{user.displayName}</span>
                    <span className="text-on-surface-variant text-xs">{formatRelativeTime(user.addedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
