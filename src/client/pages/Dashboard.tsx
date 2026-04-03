import { useEffect, useState } from "react";
import { RefreshCw, Film, Tv, Users, Library, CheckCircle, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import { formatRelativeTime } from "../lib/utils";
import { WatchlistItemModal } from "../components/WatchlistItemModal";
import type { DashboardResponse, RecentlyAddedItem, SyncRun } from "../../shared/types";

export default function Dashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<RecentlyAddedItem | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await apiGet<DashboardResponse>("/api/dashboard");
      setData(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function runFullSync() {
    setSyncing(true);
    try {
      await apiPost("/api/watchlists/refresh");
      await load();
    } catch {
      // non-critical
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-on-surface-variant text-sm">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm">
          {error}
        </div>
      </div>
    );
  }

  const totalMedia = (data?.stats.trackedMovies ?? 0) + (data?.stats.trackedShows ?? 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Dashboard</h1>
        <button
          disabled={syncing}
          onClick={() => void runFullSync()}
          className="flex items-center gap-2 bg-surface-container-high hover:bg-surface-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
        >
          <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing..." : "Run Sync"}
        </button>
      </div>

      <div className="flex flex-col gap-5">
      {/* Stats + Sync Activity row */}
      {data && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          {/* Compact stat chips */}
          <div className="flex gap-2 flex-1">
            <StatChip icon={<Users size={14} />} label="Users" value={data.stats.enabledUsers} to="/users" />
            <StatChip icon={<Library size={14} />} label="Media" value={totalMedia} to="/watchlists" />
            <StatChip icon={<Film size={14} />} label="Movies" value={data.stats.trackedMovies} to="/watchlists?type=movie" />
            <StatChip icon={<Tv size={14} />} label="Shows" value={data.stats.trackedShows} to="/watchlists?type=show" />
          </div>

          {/* Recent sync activity */}
          <Link
            to="/history"
            className="sm:w-80 flex-shrink-0 bg-surface-container rounded-xl border border-outline-variant/20 px-4 py-2.5 hover:bg-surface-container-high transition-colors group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-on-surface-variant uppercase tracking-wide">Recent Syncs</span>
              <span className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">View all →</span>
            </div>
            {data.syncActivity.length > 0 ? (
              <div className="space-y-1.5">
                {data.syncActivity.slice(0, 3).map((run) => (
                  <CompactSyncRow key={run.id} run={run} />
                ))}
              </div>
            ) : (
              <p className="text-on-surface-variant text-xs">No sync activity yet.</p>
            )}
          </Link>
        </div>
      )}

      {/* Recently Added — single row */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-headline font-semibold text-base text-on-surface">Recently Added</h2>
          <Link to="/watchlists" className="text-sm text-primary hover:text-primary-dim">View All</Link>
        </div>
        {data && data.recentlyAdded.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {data.recentlyAdded.map((item) => (
              <PosterCard
                key={item.plexItemId}
                item={item}
                onClick={() => setSelectedItem(item)}
              />
            ))}
          </div>
        ) : (
          <div className="bg-surface-container rounded-2xl border border-outline-variant/20 flex items-center justify-center py-10">
            <p className="text-on-surface-variant text-sm">No items recently added. Run a sync to populate watchlists.</p>
          </div>
        )}
      </div>
      {selectedItem && (
        <WatchlistItemModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
      </div>
    </div>
  );
}

function StatChip({
  icon,
  label,
  value,
  to
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="flex-1 flex flex-col items-center justify-center gap-0.5 bg-surface-container hover:bg-surface-container-high rounded-xl px-4 py-2.5 border border-outline-variant/20 transition-colors text-center"
    >
      <div className="flex items-center gap-1.5 text-primary">
        {icon}
        <span className="font-headline font-bold text-on-surface text-lg leading-none">{value}</span>
      </div>
      <span className="text-on-surface-variant text-xs">{label}</span>
    </Link>
  );
}

const KIND_LABELS: Record<string, string> = {
  full: "Full",
  rss: "RSS",
  user: "Manual",
  publish: "Publish"
};

function formatCompactSummary(run: SyncRun): string {
  const s = run.summary;
  if (run.kind === "rss") {
    const match = s.match(/(\d+) new item/i);
    const count = match ? parseInt(match[1], 10) : 0;
    return `${count} New Item${count !== 1 ? "s" : ""}`;
  }
  if (run.kind === "full") {
    const partial = s.match(/(\d+\/\d+) users? succeeded/i);
    if (partial) return `${partial[1]} Users`;
    const full = s.match(/for (\d+) users?/i);
    if (full) return `${full[1]} Users`;
    return "Running\u2026";
  }
  if (run.kind === "user") {
    const match = s.match(/(?:finished|failed) for (.+?)\.?\s*$/i);
    return match ? match[1] : "Running\u2026";
  }
  if (run.kind === "publish") {
    const partial = s.match(/(\d+\/\d+) users? succeeded/i);
    if (partial) return `${partial[1]} Users`;
    const full = s.match(/for (\d+) users?/i);
    if (full) return `${full[1]} Users`;
    return "Running\u2026";
  }
  return s;
}

function CompactSyncRow({ run }: { run: SyncRun }) {
  const statusColor = {
    success: "text-success",
    error: "text-error",
    running: "text-warning",
    idle: "text-on-surface-variant"
  }[run.status];

  const dot = {
    success: "bg-success",
    error: "bg-error",
    running: "bg-warning animate-pulse",
    idle: "bg-on-surface-variant"
  }[run.status];

  const typeLabel = KIND_LABELS[run.kind] ?? run.kind;

  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      <span className="text-on-surface truncate flex-1">
        {typeLabel}: {formatCompactSummary(run)}
      </span>
      <span className={`flex-shrink-0 ${statusColor}`}>
        {formatRelativeTime(run.startedAt)} · {run.status}
      </span>
    </div>
  );
}

function PosterCard({
  item,
  onClick
}: {
  item: RecentlyAddedItem;
  onClick: () => void;
}) {
  const posterSrc = getPlexImageSrc(item.posterUrl);

  const addedDate = new Date(item.addedAt).toLocaleDateString("en-GB");

  return (
    <button onClick={onClick} className="group text-left w-full">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-surface-container-high transition-transform duration-300 group-hover:scale-105">
        {posterSrc ? (
          <img
            src={posterSrc}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
            {item.type === "movie" ? (
              <Film size={20} className="text-on-surface-variant mb-1" />
            ) : (
              <Tv size={20} className="text-on-surface-variant mb-1" />
            )}
            <span className="text-on-surface-variant text-xs leading-tight line-clamp-2">{item.title}</span>
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
