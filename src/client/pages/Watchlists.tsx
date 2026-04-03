import { useEffect, useState } from "react";
import { Film, Tv, ChevronLeft, ChevronRight, CheckCircle, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { WatchlistItemModal } from "../components/WatchlistItemModal";
import type {
  MediaType,
  WatchlistPageResponse,
  WatchlistGroupedItem,
  WatchlistSortBy
} from "../../shared/types";

const PAGE_SIZE = 24;

type AvailabilityFilter = "all" | "available" | "missing";

const SORT_OPTIONS: { value: WatchlistSortBy; label: string }[] = [
  { value: "added-desc", label: "Watchlisted (Newest)" },
  { value: "added-asc",  label: "Watchlisted (Oldest)" },
  { value: "title-asc",  label: "Title (A–Z)" },
  { value: "title-desc", label: "Title (Z–A)" }
];

const VALID_SORT_VALUES = ["added-desc", "added-asc", "title-asc", "title-desc"];
const VALID_AVAILABILITY = ["all", "available", "missing"];
const VALID_MEDIA_TYPES = ["all", "movie", "show"];

export default function Watchlists() {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawType = searchParams.get("type") ?? "all";
  const selectedMediaType = (VALID_MEDIA_TYPES.includes(rawType) ? rawType : "all") as "all" | MediaType;
  const rawUser = searchParams.get("user");
  const selectedUserId = rawUser !== null && !isNaN(Number(rawUser)) ? Number(rawUser) : null;
  const availability = (VALID_AVAILABILITY.includes(searchParams.get("availability") ?? "") ? searchParams.get("availability") : "all") as AvailabilityFilter;
  const sortBy = (VALID_SORT_VALUES.includes(searchParams.get("sort") ?? "") ? searchParams.get("sort") : "added-desc") as WatchlistSortBy;
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));

  function setParam(updates: Record<string, string | null>, resetPage = false) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      if (resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }

  function selectUser(id: number | null) { setParam({ user: id !== null ? String(id) : null }, true); }
  function selectMediaType(mt: "all" | MediaType) { setParam({ type: mt === "all" ? null : mt }, true); }
  function selectAvailability(a: AvailabilityFilter) { setParam({ availability: a === "all" ? null : a }, true); }
  function selectSort(s: WatchlistSortBy) { setParam({ sort: s === "added-desc" ? null : s }, true); }

  const [data, setData] = useState<WatchlistPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<WatchlistGroupedItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sortBy });
    if (selectedUserId !== null) params.set("userId", String(selectedUserId));
    if (selectedMediaType !== "all") params.set("mediaType", selectedMediaType);
    if (availability !== "all") params.set("availability", availability);
    apiGet<WatchlistPageResponse>(`/api/watchlists?${params.toString()}`)
      .then((result) => { setData(result); setError(null); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [selectedUserId, selectedMediaType, availability, sortBy, page]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Watchlists</h1>
      </div>

      {/* Filters section */}
      <div className="mb-2">
        <span className="text-[11px] font-medium text-on-surface-variant/60 uppercase tracking-wide">Filters</span>
      </div>

      {/* Row 1: Type + divider + Availability */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <FilterChip label="All"    active={selectedMediaType === "all"}   count={data?.facets.media.all}   onClick={() => selectMediaType("all")} />
        <FilterChip label="Movies" active={selectedMediaType === "movie"} count={data?.facets.media.movie} onClick={() => selectMediaType("movie")} />
        <FilterChip label="Shows"  active={selectedMediaType === "show"}  count={data?.facets.media.show}  onClick={() => selectMediaType("show")} />

        <div className="w-px h-5 bg-outline-variant/40 mx-1 flex-shrink-0" />

        <FilterChip label="In Library" active={availability === "available"} onClick={() => selectAvailability(availability === "available" ? "all" : "available")} />
        <FilterChip label="Missing"    active={availability === "missing"}   onClick={() => selectAvailability(availability === "missing"   ? "all" : "missing")} />
      </div>

      {/* Row 2: Users */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <FilterChip
          label="All Users"
          active={selectedUserId === null}
          count={data?.facets.allUsersCount}
          onClick={() => selectUser(null)}
        />
        {data?.facets.users.map((friend) => (
          <FilterChip
            key={friend.userId}
            label={friend.displayName}
            active={selectedUserId === friend.userId}
            avatarUrl={friend.avatarUrl}
            count={friend.count}
            onClick={() => selectUser(friend.userId)}
          />
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-outline-variant/20 mb-4" />

      {/* Sorting section */}
      <div className="mb-2">
        <span className="text-[11px] font-medium text-on-surface-variant/60 uppercase tracking-wide">Sort</span>
      </div>

      {/* Row 3: Sort */}
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        {SORT_OPTIONS.map((opt) => (
          <FilterChip
            key={opt.value}
            label={opt.label}
            active={sortBy === opt.value}
            onClick={() => selectSort(opt.value)}
          />
        ))}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
          {error}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-on-surface-variant text-sm">Loading watchlists...</div>
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 mb-6">
            {data.items.map((item) => (
              <WatchlistPoster
                key={item.plexItemId}
                item={item}
                selectedUserId={selectedUserId}
                onClick={() => setSelectedItem(item)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button
                disabled={page <= 1}
                onClick={() => setParam({ page: String(page - 1) })}
                className="p-2 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-40 transition-colors"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-on-surface-variant text-sm">
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setParam({ page: String(page + 1) })}
                className="p-2 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-40 transition-colors"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="bg-surface-container rounded-2xl border border-outline-variant/20 flex items-center justify-center py-16 text-center">
          <p className="text-on-surface-variant text-sm max-w-xs">
            No watchlist items found. Run a sync to populate watchlists.
          </p>
        </div>
      )}

      {/* Item detail modal */}
      {selectedItem && (
        <WatchlistItemModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  count,
  avatarUrl,
  onClick
}: {
  label: string;
  active: boolean;
  count?: number;
  avatarUrl?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors border ${
        active
          ? "bg-primary/10 text-primary border-primary/30"
          : "bg-surface-container border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:border-outline-variant/40"
      }`}
    >
      {avatarUrl && (
        <img
          src={`/api/plex/image?path=${encodeURIComponent(avatarUrl)}`}
          alt=""
          className="w-5 h-5 rounded-full object-cover"
        />
      )}
      {label}
      {count !== undefined && (
        <span className={`text-xs ${active ? "text-primary/70" : "text-on-surface-variant/60"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function WatchlistPoster({
  item,
  selectedUserId,
  onClick
}: {
  item: WatchlistGroupedItem;
  selectedUserId: number | null;
  onClick: () => void;
}) {
  const posterSrc = item.posterUrl
    ? `/api/plex/image?path=${encodeURIComponent(item.posterUrl)}`
    : null;
  // When filtering by a specific user, show that user's watchlist date.
  // In "All users" mode, show the most recent date across all users.
  const displayAddedAt =
    selectedUserId !== null
      ? (item.users.find((u) => u.userId === selectedUserId)?.addedAt ?? item.addedAt)
      : item.addedAt;
  const addedDate = new Date(displayAddedAt).toLocaleDateString("en-GB");

  return (
    <button onClick={onClick} className="group text-left w-full">
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-container-high transition-transform duration-300 group-hover:scale-105">
        {posterSrc ? (
          <img
            src={posterSrc}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center">
            {item.type === "movie" ? (
              <Film size={24} className="text-on-surface-variant mb-2" />
            ) : (
              <Tv size={24} className="text-on-surface-variant mb-2" />
            )}
            <span className="text-on-surface-variant text-xs leading-tight">{item.title}</span>
          </div>
        )}
        {/* Gradient overlay — fades in on hover */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          style={{ background: "linear-gradient(180deg, rgba(45,55,72,0.2) 0%, rgba(45,55,72,0.95) 100%)" }} />
        {/* Availability icon — always visible, top-right */}
        <div className="absolute top-1.5 right-1.5">
          {item.plexAvailable ? (
            <div className="relative">
              <div className="absolute inset-[3px] rounded-full bg-[#0a3d1f]" />
              <CheckCircle size={18} className="relative text-success drop-shadow-[0_0_4px_rgba(0,0,0,1)]" />
            </div>
          ) : (
            <div className="relative">
              <div className="absolute inset-[3px] rounded-full bg-[#3d0a0a]" />
              <XCircle size={18} className="relative text-error drop-shadow-[0_0_4px_rgba(0,0,0,1)]" />
            </div>
          )}
        </div>
        {/* Hover text — left-aligned at bottom, matches seerr sizing */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-start px-2 pb-2 opacity-0 translate-y-1 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
          {item.year && (
            <span className="text-white/80 text-sm font-medium leading-tight">{item.year}</span>
          )}
          <span className="text-white text-xl font-bold leading-tight line-clamp-3 mt-0.5" style={{ wordBreak: "break-word" }}>{item.title}</span>
          <span className="text-white/70 text-xs mt-1">Watchlisted on {addedDate}</span>
        </div>
      </div>
    </button>
  );
}
