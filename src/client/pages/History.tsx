import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, XCircle } from "lucide-react";
import { apiGet } from "../lib/api";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { formatDateTime, formatRelativeTime } from "../lib/utils";
import type { HistoryPageResponse, SearchCandidate, SyncRun, SyncRunDetail, SyncRunItem } from "../../shared/types";

type KindFilter = "all" | "full" | "rss" | "user" | "publish";
type StatusFilter = "all" | "success" | "error" | "running";

const KIND_LABELS: Record<string, string> = {
  full: "GraphQL",
  rss: "RSS",
  user: "Manual",
  publish: "Collection"
};

// Strip the leading "RSS sync:" / "Full sync:" / "Manual sync" prefix from a summary
// string since the row header already shows the sync type.
function stripKindPrefix(summary: string): string {
  return summary.replace(/^(RSS sync|Full sync|Manual sync|Collection publish|Collection sync)[:\s]*/i, "").trim();
}

const ACTION_LABELS: Record<string, string> = {
  "watchlist.fetch": "Watchlist fetch",
  "watchlist.rss": "RSS item",
  "watchlist.rss.self": "RSS item (self)",
  "watchlist.match.failed": "Match failed",
  "watchlist.date_unresolved": "Date unresolved",
  "collection.publish": "Collection publish",
  "isolation.filters": "Isolation filters",
  "sync.user": "User sync"
};

const VALID_KINDS: KindFilter[] = ["all", "full", "rss", "user", "publish"];
const VALID_STATUSES: StatusFilter[] = ["all", "success", "error", "running"];
const VALID_PAGE_SIZES = [10, 25, 50, 100];
const HISTORY_FAST_REFRESH_MS = 2_500;
const HISTORY_IDLE_REFRESH_MS = 15_000;

export default function History() {
  const [searchParams, setSearchParams] = useSearchParams();

  const kind = (VALID_KINDS.includes(searchParams.get("type") as KindFilter) ? searchParams.get("type") : "all") as KindFilter;
  const status = (VALID_STATUSES.includes(searchParams.get("status") as StatusFilter) ? searchParams.get("status") : "all") as StatusFilter;
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = VALID_PAGE_SIZES.includes(Number(searchParams.get("pageSize"))) ? Number(searchParams.get("pageSize")) : 10;

  function setParam(key: string, value: string, resetPage = false) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, value);
      if (resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }

  const [data, setData] = useState<HistoryPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    setLoading((current) => current || !background);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), kind, status });
      const result = await apiGet<HistoryPageResponse>(`/api/history?${params.toString()}`);
      setData(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, kind, status]);

  const runs = data?.results ?? [];
  const pageInfo = data?.pageInfo;
  const hasRunningSync = runs.some((run) => run.status === "running");

  useLiveRefresh(
    async () => {
      await load(true);
    },
    {
      getIntervalMs: () => (hasRunningSync ? HISTORY_FAST_REFRESH_MS : HISTORY_IDLE_REFRESH_MS)
    }
  );

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">History</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {/* Kind filter */}
        <div className="flex rounded-lg overflow-hidden border border-outline-variant/30">
          {(["all", "full", "rss", "user", "publish"] as KindFilter[]).map((k) => (
            <button
              key={k}
              onClick={() => setParam("type", k, true)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                kind === k
                  ? "bg-primary/15 text-primary"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {k === "all" ? "All types" : KIND_LABELS[k] ?? k}
            </button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex rounded-lg overflow-hidden border border-outline-variant/30">
          {(["all", "success", "error", "running"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setParam("status", s, true)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                status === s
                  ? "bg-primary/15 text-primary"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {s === "all" ? "All status" : s}
            </button>
          ))}
        </div>

        {/* Page size */}
        <select
          value={pageSize}
          onChange={(e) => setParam("pageSize", e.target.value, true)}
          className="ml-auto px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:outline-none"
        >
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-on-surface-variant text-sm">Loading history...</div>
        </div>
      ) : runs.length > 0 ? (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      ) : (
        <div className="bg-surface-container rounded-2xl border border-outline-variant/20 flex items-center justify-center py-16 text-center">
          <p className="text-on-surface-variant text-sm max-w-xs">
            No sync history matches the current filter.
          </p>
        </div>
      )}

      {/* Pagination */}
      {pageInfo && pageInfo.total > 0 && (
        <div className="flex items-center justify-between mt-4 text-xs text-on-surface-variant">
          <span>
            {`${(pageInfo.page - 1) * pageInfo.pageSize + 1}–${Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of ${pageInfo.total}`}
          </span>
          <div className="flex gap-1 items-center">
            <button
              disabled={page <= 1}
              onClick={() => setParam("page", String(page - 1))}
              className="p-1.5 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2">Page {page} / {pageInfo.pages}</span>
            <button
              disabled={page >= pageInfo.pages}
              onClick={() => setParam("page", String(page + 1))}
              className="p-1.5 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: SyncRun }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SyncRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function loadDetail() {
    if (detail) return;
    setDetailLoading(true);
    try {
      const result = await apiGet<SyncRunDetail>(`/api/history/${run.id}`);
      setDetail(result);
    } finally {
      setDetailLoading(false);
    }
  }

  function handleExpand() {
    if (!expanded) void loadDetail();
    setExpanded((v) => !v);
  }

  const statusConfig = {
    success: {
      icon: <CheckCircle size={18} className="text-success" />,
      badge: "text-success bg-success/10 border-success/20"
    },
    error: {
      icon: <XCircle size={18} className="text-error" />,
      badge: "text-error bg-error/10 border-error/20"
    },
    running: {
      icon: <Clock size={18} className="text-warning animate-pulse" />,
      badge: "text-warning bg-warning/10 border-warning/20"
    },
    idle: {
      icon: <AlertCircle size={18} className="text-on-surface-variant" />,
      badge: "text-on-surface-variant bg-surface-container-high border-outline-variant/20"
    }
  };

  const config = statusConfig[run.status];

  const durationMs =
    run.completedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  const durationText = durationMs !== null
    ? durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/20 overflow-hidden">
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-surface-container-high/50 transition-colors"
      >
        {config.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-on-surface text-sm">
              {KIND_LABELS[run.kind] ?? run.kind} Sync
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${config.badge}`}>
              {run.status}
            </span>
          </div>
          <div className="text-on-surface-variant text-xs mt-0.5 truncate">{stripKindPrefix(run.summary)}</div>
        </div>
        <div className="flex-shrink-0 text-right mr-2">
          <div className="text-on-surface-variant text-xs">{formatRelativeTime(run.startedAt)}</div>
          {durationText && (
            <div className="text-on-surface-variant text-xs mt-0.5">{durationText}</div>
          )}
        </div>
        {expanded ? <ChevronUp size={16} className="text-on-surface-variant flex-shrink-0" /> : <ChevronDown size={16} className="text-on-surface-variant flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-outline-variant/20 bg-surface-container-low">
          {/* Run metadata */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs px-4 py-3">
            <div>
              <span className="text-on-surface-variant">Started</span>
              <div className="text-on-surface mt-0.5">{formatDateTime(run.startedAt)}</div>
            </div>
            {run.completedAt && (
              <div>
                <span className="text-on-surface-variant">Completed</span>
                <div className="text-on-surface mt-0.5">{formatDateTime(run.completedAt)}</div>
              </div>
            )}
            {run.error && (
              <div className="col-span-2">
                <span className="text-error">Error</span>
                <div className="text-error/80 mt-0.5 font-mono break-all">{run.error}</div>
              </div>
            )}
          </div>

          {/* Run items */}
          <div className="px-4 pb-3">
            {detailLoading ? (
              <div className="text-xs text-on-surface-variant py-2">Loading details...</div>
            ) : detail ? (
              <RunItems items={detail.items} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function RunItems({ items }: { items: SyncRunItem[] }) {
  if (items.length === 0) {
    return <div className="text-xs text-on-surface-variant py-2">No step details recorded.</div>;
  }

  const failures = items.filter((i) => i.action === "watchlist.match.failed");
  const unresolved = items.filter((i) => i.action === "watchlist.date_unresolved");
  const errors = items.filter(
    (i) => i.status === "error" && i.action !== "watchlist.match.failed" && i.action !== "watchlist.date_unresolved"
  );
  const other = items.filter(
    (i) => i.status === "success" && i.action !== "watchlist.match.failed" && i.action !== "watchlist.date_unresolved"
  );

  return (
    <div className="space-y-3">
      {/* Summary counts */}
      <div className="flex flex-wrap gap-3 text-xs">
        {other.length > 0 && (
          <span className="text-success bg-success/10 px-2 py-0.5 rounded-full">
            {other.length} step{other.length !== 1 ? "s" : ""} OK
          </span>
        )}
        {failures.length > 0 && (
          <span className="text-warning bg-warning/10 px-2 py-0.5 rounded-full">
            {failures.length} unmatched
          </span>
        )}
        {unresolved.length > 0 && (
          <span className="text-warning bg-warning/10 px-2 py-0.5 rounded-full">
            {unresolved.length} date{unresolved.length !== 1 ? "s" : ""} unresolved
          </span>
        )}
        {errors.length > 0 && (
          <span className="text-error bg-error/10 px-2 py-0.5 rounded-full">
            {errors.length} error{errors.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Errors */}
      {errors.map((item) => (
        <RunItemRow key={item.id} item={item} />
      ))}

      {/* Match failures */}
      {failures.length > 0 && (
        <div>
          <div className="text-xs text-warning font-medium mb-1.5">Unmatched items ({failures.length})</div>
          <div className="space-y-1">
            {failures.map((item) => (
              <MatchFailureRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Watchlisted at date unresolved */}
      {unresolved.length > 0 && (
        <div>
          <div className="text-xs text-warning font-medium mb-1.5">Watchlisted At Date Unresolved ({unresolved.length})</div>
          <div className="space-y-1">
            {unresolved.map((item) => (
              <DateUnresolvedRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Successful steps (collapsed by default) */}
      {other.length > 0 && <StepsCollapsible items={other} />}
    </div>
  );
}

function RunItemRow({ item }: { item: SyncRunItem }) {
  return (
    <div className="bg-error/5 border border-error/20 rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-error font-medium">{ACTION_LABELS[item.action] ?? item.action}</span>
      </div>
      {item.details !== undefined && item.details !== null && (
        <pre className="mt-1 text-error/70 font-mono whitespace-pre-wrap break-all max-h-24 overflow-auto">
          {JSON.stringify(item.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface MatchFailureDetails {
  plexItemId?: string;
  title?: string;
  type?: string;
  year?: number | null;
  thumb?: string | null;
  guids?: string[];
  discoverKey?: string | null;
  source?: string;
  addedAt?: string;
  libraryId?: string;
  searchCandidates?: SearchCandidate[];
}

function MatchFailureRow({ item }: { item: SyncRunItem }) {
  const [open, setOpen] = useState(false);
  const d = item.details as MatchFailureDetails | null;
  const candidates = d?.searchCandidates ?? [];

  return (
    <div className="bg-warning/5 border border-warning/20 rounded-lg px-3 py-2 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <div>
          <span className="text-on-surface font-medium">{d?.title ?? "Unknown"}</span>
          <span className="text-on-surface-variant ml-2">{d?.type} {d?.year ? `(${d.year})` : ""}</span>
          <span className="text-on-surface-variant/50 ml-2">({candidates.length} candidate{candidates.length !== 1 ? "s" : ""} from Plex)</span>
        </div>
        {open ? <ChevronUp size={12} className="text-on-surface-variant mt-0.5 flex-shrink-0" /> : <ChevronDown size={12} className="text-on-surface-variant mt-0.5 flex-shrink-0" />}
      </button>
      {open && (
        <div className="mt-2 space-y-3 text-on-surface-variant">
          {/* Watchlist item fields */}
          <div className="space-y-1">
            <div className="text-on-surface-variant/60 font-medium uppercase tracking-wide text-[10px]">Watchlist item</div>
            {d?.plexItemId && <div><span className="text-on-surface-variant/60">Plex ID:</span> <span className="font-mono break-all">{d.plexItemId}</span></div>}
            <div><span className="text-on-surface-variant/60">Library ID:</span> {d?.libraryId ?? "—"}</div>
            <div><span className="text-on-surface-variant/60">Source:</span> {d?.source ?? "—"}</div>
            {d?.addedAt && <div><span className="text-on-surface-variant/60">Added at:</span> {d.addedAt}</div>}
            {d?.discoverKey && <div><span className="text-on-surface-variant/60">Discover key:</span> <span className="font-mono break-all">{d.discoverKey}</span></div>}
            {d?.guids && d.guids.length > 0 ? (
              <div>
                <span className="text-on-surface-variant/60">GUIDs:</span>
                <div className="font-mono mt-0.5 space-y-0.5">
                  {d.guids.map((g, i) => <div key={i} className="break-all">{g}</div>)}
                </div>
              </div>
            ) : (
              <div className="text-warning/70">No GUIDs — GUID matching not possible</div>
            )}
          </div>

          {/* Plex search candidates */}
          <div>
            <div className="text-on-surface-variant/60 font-medium uppercase tracking-wide text-[10px] mb-1">
              Plex library candidates ({candidates.length})
            </div>
            {candidates.length === 0 ? (
              <div className="text-warning/70">Plex returned no candidates for this title</div>
            ) : (
              <div className="space-y-1">
                {candidates.map((c, i) => (
                  <div key={i} className="bg-surface-container rounded px-2 py-1 space-y-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="text-on-surface font-medium">{c.title}</span>
                      {c.year && <span className="text-on-surface-variant/60">({c.year})</span>}
                      <span className="text-on-surface-variant/50 font-mono ml-auto">{c.ratingKey}</span>
                    </div>
                    {c.guids.length > 0 && (
                      <div className="font-mono text-[10px] text-on-surface-variant/50 space-y-0.5">
                        {c.guids.map((g, j) => <div key={j} className="break-all">{g}</div>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface DateUnresolvedDetails {
  title?: string;
  type?: string;
}

function DateUnresolvedRow({ item }: { item: SyncRunItem }) {
  const d = item.details as DateUnresolvedDetails | null;
  return (
    <div className="bg-warning/5 border border-warning/20 rounded-lg px-3 py-2 text-xs">
      <span className="text-on-surface font-medium">{d?.title ?? "Unknown"}</span>
      <span className="text-on-surface-variant ml-2">{d?.type}</span>
    </div>
  );
}

function StepsCollapsible({ items }: { items: SyncRunItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface transition-colors"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {open ? "Hide" : "Show"} {items.length} completed step{items.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded-lg bg-surface-container/50">
              <CheckCircle size={12} className="text-success flex-shrink-0" />
              <span className="text-on-surface-variant">{ACTION_LABELS[item.action] ?? item.action}</span>
              {item.details !== null && typeof item.details === "object" && "itemCount" in (item.details as object) && (
                <span className="text-on-surface-variant/60 ml-auto">{String((item.details as Record<string, unknown>)["itemCount"])} items</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
