import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, Pause, Pencil, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import PlexConfigForm from "../components/PlexConfigForm";
import CollectionsConfigForm from "../components/CollectionsConfigForm";
import { SaveBar, SectionCard, ToggleField } from "../components/FormControls";
import type { AboutInfo, JobInfo, LogEntry, LogsPageResponse, SettingsResponse } from "../../shared/types";

type Tab = "general" | "plex" | "collections" | "logs" | "jobs" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "plex", label: "Plex" },
  { id: "collections", label: "Collections" },
  { id: "logs", label: "Logs" },
  { id: "jobs", label: "Jobs" },
  { id: "about", label: "About" }
];

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (TABS.some((t) => t.id === searchParams.get("tab")) ? searchParams.get("tab") : "general") as Tab;
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setTab(tab: Tab) {
    setSearchParams({ tab }, { replace: true });
  }

  async function loadSettings() {
    setLoading(true);
    try {
      const result = await apiGet<SettingsResponse>("/api/settings");
      setSettings(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Settings</h1>
      </div>

      <div className="flex gap-0.5 border-b border-outline-variant/20 mb-6 overflow-x-auto no-scrollbar pb-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px whitespace-nowrap ${
              activeTab === tab.id
                ? "text-primary border-primary"
                : "text-on-surface-variant border-transparent hover:text-on-surface"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="text-on-surface-variant text-sm">Loading settings...</div>
        </div>
      ) : (
        <>
          {activeTab === "general" && settings && (
            <GeneralTab settings={settings} onSave={loadSettings} />
          )}
          {activeTab === "plex" && settings && (
            <PlexConfigForm
              initialConfig={settings.plex}
              saveUrl="/api/settings/plex/save"
              saveLabel="Save Plex"
              onSaved={async () => {
                await loadSettings();
              }}
            />
          )}
          {activeTab === "collections" && settings && (
            <CollectionsConfigForm
              initialValue={settings.collections}
              librariesUrl="/api/settings/plex/libraries"
              saveLabel="Save Collections"
              onSaved={async () => {
                await loadSettings();
              }}
            />
          )}
          {activeTab === "logs" && <LogsTab />}
          {activeTab === "jobs" && <JobsTab />}
          {activeTab === "about" && <AboutTab />}
        </>
      )}
    </div>
  );
}

function GeneralTab({
  settings,
  onSave
}: {
  settings: SettingsResponse;
  onSave: () => Promise<void>;
}) {
  const [form, setForm] = useState({ ...settings.general });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    setForm({ ...settings.general });
  }, [settings.general]);

  async function save() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await apiPatch("/api/settings", { general: form });
      setSuccess(true);
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function resetCollections() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setResetting(true);
    setResetMessage(null);
    try {
      const result = await apiPost<{
        deleted: number;
        skipped: number;
        isolationUpdated: number;
      }>("/api/settings/reset-collections");
      setResetMessage(
        `Deleted ${result.deleted} collection${result.deleted !== 1 ? "s" : ""} and cleared exclusion labels from ${result.isolationUpdated} user${result.isolationUpdated !== 1 ? "s" : ""}.`
      );
    } catch (caught) {
      setResetMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard title="General Settings">
        <ToggleField
          label="Startup Sync"
          hint="When Hubarr starts, run a Plex full library scan, then a watchlist GraphQL sync, then a collection sync."
          checked={form.fullSyncOnStartup}
          onChange={(value) => setForm((current) => ({ ...current, fullSyncOnStartup: value }))}
        />
        <div className="mt-5">
          <label className="block text-sm font-medium text-on-surface mb-2">
            History Retention
          </label>
          <p className="text-xs text-on-surface-variant mb-3">
            Choose how many days of scheduled sync history Hubarr should keep before trimming older entries.
          </p>
          <input
            type="number"
            min={1}
            step={1}
            value={form.historyRetentionDays}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                historyRetentionDays: Math.max(1, Math.floor(Number(e.target.value) || 1))
              }))
            }
            className="w-full max-w-xs bg-surface-container-low border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
          />
        </div>
        <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} />

        <div className="border-t border-outline-variant/10 pt-4">
          <div className="text-sm font-medium text-on-surface mb-2">Reset</div>
          <p className="text-xs text-on-surface-variant mb-3">
            Delete Hubarr managed collections and remove Hubarr exclusion labels from all users.
          </p>
          {confirmReset && !resetting && (
            <div className="fixed inset-0 z-10" onClick={() => setConfirmReset(false)} />
          )}
          <button
            disabled={resetting}
            onClick={() => void resetCollections()}
            className={`relative z-20 text-sm font-semibold rounded-xl px-4 py-2 min-w-[160px] transition-colors disabled:opacity-50 ${
              confirmReset
                ? "bg-error text-white animate-pulse hover:bg-error/90"
                : "bg-surface-container-high hover:bg-surface-bright border border-error/40 text-error"
            }`}
          >
            {resetting ? "Resetting…" : confirmReset ? "Are you sure?" : "Reset Collections"}
          </button>
          {resetMessage && <div className="text-xs text-on-surface-variant mt-3">{resetMessage}</div>}
        </div>
      </SectionCard>
    </div>
  );
}

type LogFilter = "debug" | "info" | "warn" | "error";

const LEVEL_BADGE: Record<LogFilter, string> = {
  debug: "text-on-surface-variant bg-surface-container",
  info:  "text-primary bg-primary/10",
  warn:  "text-warning bg-warning/10",
  error: "text-error bg-error/10"
};

function LogsTab() {
  const [data, setData] = useState<LogsPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LogFilter>("debug");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeLog, setActiveLog] = useState<LogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        filter,
        page: String(page),
        pageSize: String(pageSize),
        ...(debouncedSearch ? { search: debouncedSearch } : {})
      });
      const result = await apiGet<LogsPageResponse>(`/api/settings/logs?${params.toString()}`);
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize, debouncedSearch]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { void load(); }, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, load]);

  // Reset page when filter/search/pageSize changes
  useEffect(() => { setPage(1); }, [filter, pageSize]);

  function copyLog(entry: LogEntry) {
    const text = `${entry.timestamp} [${entry.level.toUpperCase()}]: ${entry.message}${entry.meta !== undefined ? " " + JSON.stringify(entry.meta) : ""}`;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const results = data?.results ?? [];
  const pageInfo = data?.pageInfo;

  return (
    <>
      {/* Detail modal */}
      {activeLog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => setActiveLog(null)}
        >
          <div
            className="bg-surface-container-high rounded-2xl border border-outline-variant/30 w-full max-w-2xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-on-surface">Log Details</h3>
              <button onClick={() => setActiveLog(null)} className="text-on-surface-variant hover:text-on-surface">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Timestamp</span>
                <span className="text-on-surface font-mono">{activeLog.timestamp}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Level</span>
                <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${LEVEL_BADGE[activeLog.level]}`}>{activeLog.level}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Message</span>
                <span className="text-on-surface break-all">{activeLog.message}</span>
              </div>
              {activeLog.meta !== undefined && (
                <div className="flex gap-2">
                  <span className="text-on-surface-variant w-24 flex-shrink-0">Meta</span>
                  <pre className="text-on-surface font-mono text-xs bg-surface-container rounded-lg p-3 overflow-auto max-h-64 flex-1 whitespace-pre-wrap break-all">
                    {JSON.stringify(activeLog.meta, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => copyLog(activeLog)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-sm hover:bg-primary/20 transition-colors"
              >
                <ClipboardCopy size={14} />
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                onClick={() => setActiveLog(null)}
                className="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface text-sm hover:bg-surface-container-high transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Logs" description="Logs are also written to /config/logs on the host.">
        {/* Controls */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Search */}
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
          />
          {/* Level filter */}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as LogFilter)}
            className="px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-sm text-on-surface focus:outline-none focus:border-primary/50"
          >
            <option value="debug">Debug (all)</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error only</option>
          </select>
          {/* Page size */}
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-sm text-on-surface focus:outline-none focus:border-primary/50"
          >
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
              autoRefresh
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-surface-container border-outline-variant/30 text-on-surface-variant"
            }`}
          >
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
            {autoRefresh ? "Pause" : "Resume"}
          </button>
          {/* Manual refresh */}
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Table */}
        <div className="bg-surface-container-low rounded-xl border border-outline-variant/20 overflow-hidden">
          {loading && !data ? (
            <div className="flex items-center justify-center h-48 text-on-surface-variant text-sm">Loading logs...</div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-on-surface-variant text-sm">
              No log entries match the current filter.
              {filter !== "debug" && (
                <button onClick={() => setFilter("debug")} className="text-primary text-xs hover:underline">Show all logs</button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-outline-variant/10">
              {results.map((entry, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2 text-xs font-mono hover:bg-surface-container/50 group">
                  <span className="text-on-surface-variant/60 flex-shrink-0 w-[7.5rem] truncate pt-0.5">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className={`flex-shrink-0 w-12 text-center px-1 py-0.5 rounded text-[10px] font-bold uppercase ${LEVEL_BADGE[entry.level]}`}>
                    {entry.level}
                  </span>
                  <span className="text-on-surface flex-1 break-all leading-relaxed">{entry.message}</span>
                  <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {entry.meta !== undefined && (
                      <button
                        onClick={() => setActiveLog(entry)}
                        className="p-1 text-on-surface-variant hover:text-primary transition-colors"
                        title="View details"
                      >
                        <Eye size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => copyLog(entry)}
                      className="p-1 text-on-surface-variant hover:text-primary transition-colors"
                      title="Copy"
                    >
                      <ClipboardCopy size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {pageInfo && pageInfo.total > 0 && (
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>
              {pageInfo.total === 0 ? "No results" : `${(pageInfo.page - 1) * pageInfo.pageSize + 1}–${Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of ${pageInfo.total}`}
            </span>
            <div className="flex gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="p-1.5 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-2 py-1">Page {page} / {pageInfo.pages}</span>
              <button
                disabled={page >= pageInfo.pages}
                onClick={() => setPage((p) => p + 1)}
                className="p-1.5 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </SectionCard>
    </>
  );
}

const JOB_PRESETS: Record<string, { unit: "minutes" | "hours"; values: number[] }> = {
  "collection-publish": { unit: "minutes", values: [5, 10, 15, 20, 30, 60] },
  "plex-recently-added-scan": { unit: "minutes", values: [5, 10, 15, 20, 30, 60] },
  "plex-full-library-scan": { unit: "hours", values: [60, 120, 240, 360, 720, 1440] },
  "full-sync": { unit: "minutes", values: [5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440] },
  "rss-sync":  { unit: "minutes", values: [1, 2, 5, 10, 15, 30] },
};

function formatPresetLabel(value: number, unit: "minutes" | "hours"): string {
  if (unit === "hours") {
    const h = value / 60;
    return `Every ${h} hour${h !== 1 ? "s" : ""}`;
  }
  if (value < 60) return `Every ${value} minute${value !== 1 ? "s" : ""}`;
  const h = value / 60;
  return `Every ${h} hour${h !== 1 ? "s" : ""}`;
}

function parseCurrentIntervalValue(job: JobInfo): string {
  const preset = JOB_PRESETS[job.id];
  if (!preset) {
    return "";
  }

  const match = job.intervalDescription.match(/Every (\d+)/i);
  const current = Number(match?.[1] ?? preset.values[0]);

  if (preset.unit === "hours") {
    return String(current * 60);
  }

  return String(current);
}

function JobsTab() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<JobInfo | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await apiGet<JobInfo[]>("/api/settings/jobs");
      setJobs(result);
    } finally {
      setLoading(false);
    }
  }

  async function runJob(id: string) {
    setRunningId(id);
    try {
      await apiPost(`/api/settings/jobs/${id}/run`);
      await load();
    } finally {
      setRunningId(null);
    }
  }

  function openEdit(job: JobInfo) {
    if (!JOB_PRESETS[job.id]) return;
    setEditValue(parseCurrentIntervalValue(job));
    setEditingJob(job);
  }

  async function saveSchedule() {
    if (!editingJob) return;
    setSaving(true);
    try {
      const body = { intervalMinutes: Number(editValue) };
      await apiPatch(`/api/settings/jobs/${editingJob.id}`, body);
      setEditingJob(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      {/* Edit schedule modal */}
      {editingJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-surface-container rounded-2xl border border-outline-variant/20 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20">
              <h2 className="font-headline font-semibold text-on-surface">Edit Schedule</h2>
              <button onClick={() => setEditingJob(null)} className="text-on-surface-variant hover:text-on-surface transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <div className="text-sm font-medium text-on-surface mb-1">{editingJob.name}</div>
                <div className="text-xs text-on-surface-variant">Current: {editingJob.intervalDescription}</div>
              </div>
              <div>
                <label className="text-sm font-medium text-on-surface block mb-2">New Frequency</label>
                <select
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
                >
                  {(JOB_PRESETS[editingJob.id]?.values ?? []).map((v) => (
                    <option key={v} value={String(v)}>
                      {formatPresetLabel(v, JOB_PRESETS[editingJob.id]?.unit ?? "minutes")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-outline-variant/20">
              <button
                onClick={() => setEditingJob(null)}
                className="text-sm font-medium text-on-surface-variant hover:text-on-surface px-4 py-2 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={saving}
                onClick={() => void saveSchedule()}
                className="bg-primary hover:bg-primary-dim disabled:opacity-50 text-on-primary text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Jobs" description="Background jobs and their next scheduled execution.">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-on-surface-variant text-sm">Loading jobs...</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant/20">
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Job Name</th>
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Next Execution</th>
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Last Run</th>
                  <th className="pb-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-on-surface">{job.name}</span>
                        {runningId === job.id && (
                          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                        )}
                      </div>
                      <div className="text-xs text-on-surface-variant mt-0.5">{job.intervalDescription}</div>
                    </td>
                    <td className="py-3 pr-4 text-on-surface-variant">
                      {job.nextRunAt ? formatRelativeTime(job.nextRunAt) : "—"}
                    </td>
                    <td className="py-3 pr-4">
                      {job.lastRunAt ? (
                        <div>
                          <span className="text-on-surface-variant">{formatRelativeTime(job.lastRunAt)}</span>
                          {job.lastRunStatus && (
                            <span className={`ml-2 text-xs font-medium ${job.lastRunStatus === "success" ? "text-success" : "text-error"}`}>
                              {job.lastRunStatus}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-on-surface-variant">—</span>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-2">
                        {JOB_PRESETS[job.id] && (
                          <button
                            onClick={() => openEdit(job)}
                            className="flex items-center gap-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high text-xs font-medium rounded-lg px-3 py-1.5 transition-colors border border-outline-variant/20"
                          >
                            <Pencil size={13} />
                            Edit
                          </button>
                        )}
                        <button
                          disabled={runningId === job.id}
                          onClick={() => void runJob(job.id)}
                          className="flex items-center gap-1.5 bg-primary/10 hover:bg-primary/20 disabled:opacity-50 text-primary text-xs font-medium rounded-lg px-3 py-1.5 transition-colors border border-primary/20"
                        >
                          <Play size={13} />
                          {runningId === job.id ? "Running..." : "Run Now"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  body: string;
}

function AboutTab() {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [releases, setReleases] = useState<GitHubRelease[] | null>(null);
  const [releasesError, setReleasesError] = useState(false);
  const [changelogRelease, setChangelogRelease] = useState<GitHubRelease | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await apiGet<AboutInfo>("/api/settings/about");
        setInfo(result);
      } catch {
        // non-critical
      }
    };
    void load();

    fetch("https://api.github.com/repos/migz93/hubarr/releases?per_page=20")
      .then((r) => r.json())
      .then((data: GitHubRelease[]) => setReleases(data))
      .catch(() => setReleasesError(true));
  }, []);

  return (
    <div className="flex flex-col gap-5">
      {/* About Hubarr */}
      <SectionCard title="About Hubarr">
        <InfoRow label="Version">
          <a
            href="https://github.com/migz93/hubarr/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline font-mono text-sm"
          >
            {info?.version ?? "..."}
          </a>
        </InfoRow>
        <InfoRow label="Data Directory">
          <code className="text-sm text-on-surface bg-surface-container-high px-2 py-0.5 rounded">{info?.dataDir ?? "..."}</code>
        </InfoRow>
        <InfoRow label="Timezone">
          <code className="text-sm text-on-surface bg-surface-container-high px-2 py-0.5 rounded">{info?.tz ?? "..."}</code>
        </InfoRow>
      </SectionCard>

      {/* Getting Support */}
      <SectionCard title="Getting Support">
        <InfoRow label="Documentation">
          <span className="text-sm text-on-surface-variant">TBC</span>
        </InfoRow>
        <InfoRow label="GitHub Discussions">
          <a
            href="https://github.com/migz93/hubarr/discussions"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline text-sm"
          >
            github.com/migz93/hubarr/discussions
          </a>
        </InfoRow>
        <InfoRow label="Discord">
          <span className="text-sm text-on-surface-variant">TBC</span>
        </InfoRow>
      </SectionCard>

      {/* Support Hubarr */}
      <SectionCard title="Support Hubarr">
        <InfoRow label="Help Pay for Coffee ☕">
          <a
            href="https://www.buymeacoffee.com/Migz93"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline text-sm"
          >
            buymeacoffee.com/Migz93
          </a>
        </InfoRow>
      </SectionCard>

      {/* Releases */}
      <SectionCard title="Releases">
        {releasesError && (
          <p className="text-on-surface-variant text-sm">Release data is currently unavailable.</p>
        )}
        {!releases && !releasesError && (
          <p className="text-on-surface-variant text-sm">Loading releases...</p>
        )}
        {releases && releases.length === 0 && (
          <p className="text-on-surface-variant text-sm">No releases found.</p>
        )}
        {releases && releases.map((release, index) => (
          <div
            key={release.id}
            className="flex items-center justify-between gap-4 bg-surface-container-high rounded-xl px-4 py-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-semibold text-on-surface truncate">{release.name || release.tag_name}</span>
              {index === 0 && (
                <span className="flex-shrink-0 text-xs font-medium text-success bg-success/10 px-2 py-0.5 rounded-full border border-success/20">Latest</span>
              )}
              {info?.version && (release.name === info.version || release.tag_name === `v${info.version}` || release.tag_name === info.version) && (
                <span className="flex-shrink-0 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">Current</span>
              )}
              <span className="flex-shrink-0 text-xs text-on-surface-variant">
                {new Date(release.published_at).toLocaleDateString()}
              </span>
            </div>
            <button
              onClick={() => setChangelogRelease(release)}
              className="flex-shrink-0 flex items-center gap-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-bright text-xs font-medium rounded-lg px-3 py-1.5 transition-colors border border-outline-variant/20"
            >
              View Changelog
            </button>
          </div>
        ))}
      </SectionCard>

      {/* Changelog modal */}
      {changelogRelease && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-outline-variant/20">
              <h3 className="font-headline font-semibold text-on-surface">{changelogRelease.name || changelogRelease.tag_name} Changelog</h3>
              <button
                onClick={() => setChangelogRelease(null)}
                className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              {changelogRelease.body ? (
                <pre className="text-sm text-on-surface-variant font-mono whitespace-pre-wrap break-words">{changelogRelease.body}</pre>
              ) : (
                <p className="text-on-surface-variant text-sm">No changelog available.</p>
              )}
            </div>
            <div className="flex justify-end gap-3 p-4 border-t border-outline-variant/20">
              <button
                onClick={() => setChangelogRelease(null)}
                className="px-4 py-2 text-sm rounded-xl bg-surface-container-high hover:bg-surface-bright text-on-surface border border-outline-variant/20 transition-colors"
              >
                Close
              </button>
              <a
                href={changelogRelease.html_url.startsWith("https://github.com/") ? changelogRelease.html_url : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-sm rounded-xl bg-primary hover:bg-primary-dim text-on-primary font-medium transition-colors"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-on-surface-variant">{label}</dt>
      <dd className="text-sm text-on-surface sm:col-span-2 mt-1 sm:mt-0">{children}</dd>
    </div>
  );
}
