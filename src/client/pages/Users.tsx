import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Edit2, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { Field, SelectInput, ToggleField } from "../components/FormControls";
import type { CollectionSortOrder, UserRecord, ManagedUserRecord, JobInfo, SettingsResponse, VisibilityConfig } from "../../shared/types";

/** Human-readable labels for each CollectionSortOrder value, matching the
 *  dropdown text used in CollectionsConfigForm and the EditModal. */
const SORT_ORDER_LABELS: Record<string, string> = {
  "date-desc": "Release Date (New to Old)",
  "date-asc": "Release Date (Old to New)",
  "title": "Title (A\u2013Z)",
  "watchlist-date-desc": "Watchlisted Date (New to Old)",
  "watchlist-date-asc": "Watchlisted Date (Old to New)"
};

const USERS_FAST_REFRESH_MS = 3_000;
const USERS_IDLE_REFRESH_MS = 30_000;
const USERS_DISCOVER_JOB_ID = "users-discover";

export default function Users() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [managedUsers, setManagedUsers] = useState<ManagedUserRecord[]>([]);
  const [usersDiscoverJob, setUsersDiscoverJob] = useState<JobInfo | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggeringRefresh, setTriggeringRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [managedOpen, setManagedOpen] = useState(false);
  const [watchlistInfoUser, setWatchlistInfoUser] = useState<UserRecord | null>(null);

  async function load(background = false) {
    setLoading((current) => current || !background);
    try {
      const [usersResult, managedResult, settingsResult, jobsResult] = await Promise.all([
        apiGet<UserRecord[]>("/api/users"),
        apiGet<ManagedUserRecord[]>("/api/users/managed"),
        apiGet<SettingsResponse>("/api/settings"),
        apiGet<JobInfo[]>("/api/settings/jobs")
      ]);
      setUsers(usersResult);
      setManagedUsers(managedResult);
      setSettings(settingsResult);
      setUsersDiscoverJob(jobsResult.find((job) => job.id === USERS_DISCOVER_JOB_ID) ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  const refreshInProgress = triggeringRefresh || (usersDiscoverJob?.isRunning ?? false);
  const getIntervalMs = useCallback(
    () => (refreshInProgress ? USERS_FAST_REFRESH_MS : USERS_IDLE_REFRESH_MS),
    [refreshInProgress]
  );
  const { refreshNow } = useLiveRefresh(
    async () => {
      await load(true);
    },
    {
      getIntervalMs
    }
  );

  async function refreshUsers() {
    setTriggeringRefresh(true);
    setError(null);
    try {
      await apiPost("/api/settings/jobs/users-discover/run");
      await refreshNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTriggeringRefresh(false);
    }
  }

  async function bulkSetEnabled(enabled: boolean) {
    if (selectedIds.length === 0) return;
    try {
      await apiPost("/api/users/bulk", { ids: selectedIds, enabled });
      setSelectedIds([]);
      await refreshNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function syncUser(userId: number) {
    setSyncingId(userId);
    try {
      await apiPost(`/api/users/${userId}/sync`);
      await refreshNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncingId(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const activeUsers = useMemo(() => users.filter((user) => user.enabled), [users]);
  const disabledUsers = useMemo(() => users.filter((user) => !user.enabled), [users]);

  function toggleSelected(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  }

  if (loading && users.length === 0 && settings === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-on-surface-variant text-sm">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Users</h1>
        <button
          onClick={() => void refreshUsers()}
          className="flex items-center gap-2 bg-surface-container-high hover:bg-surface-bright text-on-surface text-sm font-medium rounded-xl px-3 py-2.5 transition-colors border border-outline-variant/20"
        >
          <RefreshCw size={15} className={refreshInProgress ? "animate-spin" : ""} />
          {refreshInProgress ? "Refreshing..." : "Refresh Users"}
        </button>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
          {error}
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => void bulkSetEnabled(true)}
            className="bg-primary hover:bg-primary-dim text-on-primary text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
          >
            Enable Selected
          </button>
          <button
            onClick={() => void bulkSetEnabled(false)}
            className="bg-surface-container-high hover:bg-surface-bright text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
          >
            Disable Selected
          </button>
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-sm font-medium text-on-surface-variant uppercase tracking-wide mb-3">
          Active ({activeUsers.length})
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {activeUsers.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              selected={selectedIds.includes(user.id)}
              syncing={syncingId === user.id}
              onToggleSelected={() => toggleSelected(user.id)}
              onEdit={() => setEditingId(user.id)}
              onSync={() => void syncUser(user.id)}
              onOpenWatchlist={() => navigate(`/watchlists?user=${user.id}`)}
              onShowNoData={() => setWatchlistInfoUser(user)}
            />
          ))}
        </div>
      </div>

      <div className="mb-6">
        <button
          onClick={() => setDisabledOpen((open) => !open)}
          className="flex items-center gap-2 text-sm font-medium text-on-surface-variant mb-3"
        >
          {disabledOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Disabled ({disabledUsers.length})
        </button>
        {disabledOpen && (
          disabledUsers.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {disabledUsers.map((user) => (
                <UserCard
                  key={user.id}
                  user={user}
                  selected={selectedIds.includes(user.id)}
                  syncing={syncingId === user.id}
                  onToggleSelected={() => toggleSelected(user.id)}
                  onEdit={() => setEditingId(user.id)}
                  onSync={() => void syncUser(user.id)}
                  onOpenWatchlist={() => navigate(`/watchlists?user=${user.id}`)}
                  onShowNoData={() => setWatchlistInfoUser(user)}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">No disabled users</p>
          )
        )}
      </div>

      {managedUsers.length > 0 && (
        <div>
          <button
            onClick={() => setManagedOpen((open) => !open)}
            className="flex items-center gap-2 text-sm font-medium text-on-surface-variant mb-3"
          >
            {managedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            Managed Users ({managedUsers.length})
          </button>
          {managedOpen && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {managedUsers.map((user) => (
                <ManagedUserCard key={user.plexUserId} user={user} />
              ))}
            </div>
          )}
        </div>
      )}

      {editingId !== null && settings && (
        <EditModal
          user={users.find((user) => user.id === editingId)!}
          settings={settings}
          onClose={() => setEditingId(null)}
          onSave={async (patch) => {
            await apiPatch(`/api/users/${editingId}`, patch);
            setEditingId(null);
            await refreshNow();
          }}
        />
      )}

      {watchlistInfoUser && (
        <WatchlistInfoModal
          user={watchlistInfoUser}
          trackAllUsersEnabled={Boolean(settings?.general.trackAllUsers)}
          onClose={() => setWatchlistInfoUser(null)}
        />
      )}
    </div>
  );
}

function Avatar({ avatarUrl, displayName, size }: { avatarUrl: string | null; displayName: string; size: string }) {
  const src = getPlexImageSrc(avatarUrl);
  if (src) {
    return (
      <img
        src={src}
        alt={displayName}
        className={`${size} rounded-full object-cover`}
      />
    );
  }
  return (
    <div className={`${size} rounded-full bg-surface-container-highest flex items-center justify-center`}>
      <span className="text-on-surface-variant text-lg font-medium">
        {displayName.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

function UserCard({
  user,
  selected,
  syncing,
  onToggleSelected,
  onEdit,
  onSync,
  onOpenWatchlist,
  onShowNoData
}: {
  user: UserRecord;
  selected: boolean;
  syncing: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onSync: () => void;
  onOpenWatchlist: () => void;
  onShowNoData: () => void;
}) {
  const displayName = user.displayNameOverride?.trim() ? user.displayName : user.username;
  const showUsernameHint = Boolean(user.displayNameOverride?.trim());

  return (
    <div
      className={`relative bg-surface-container rounded-2xl border flex flex-col items-center p-4 gap-2 transition-colors ${
        selected ? "border-primary/50 bg-surface-container-high" : "border-outline-variant/20"
      } ${!user.enabled ? "opacity-60" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelected}
        className="absolute top-3 left-3 accent-primary w-4 h-4 cursor-pointer"
      />

      <button
        onClick={onEdit}
        className="absolute top-3 right-3 p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors border border-outline-variant/20"
        title="Edit user"
      >
        <Edit2 size={14} />
      </button>

      <Avatar avatarUrl={user.avatarUrl} displayName={displayName} size="w-16 h-16" />

      <div className="w-full text-center px-1">
        <div className="flex items-center justify-center gap-1.5 min-w-0">
          <p
            className="font-medium text-on-surface text-sm truncate min-w-0"
            title={showUsernameHint ? `${displayName} (${user.username})` : displayName}
          >
            {displayName}
          </p>
          {user.isSelf && (
            <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium flex-shrink-0">
              You
            </span>
          )}
        </div>
        {showUsernameHint && (
          <p className="text-xs text-on-surface-variant truncate">{user.username}</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 mt-auto pt-2 w-full justify-center flex-wrap">
        {user.watchlistItemCount > 0 ? (
          <button
            onClick={onOpenWatchlist}
            className="flex items-center gap-1 bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium rounded-lg px-2.5 py-1.5 transition-colors border border-outline-variant/20"
          >
            {user.watchlistItemCount} Watchlist {user.watchlistItemCount === 1 ? "Item" : "Items"}
          </button>
        ) : (
          <button
            onClick={onShowNoData}
            className="flex items-center gap-1 bg-surface-container-high hover:bg-surface-bright text-on-surface-variant text-xs font-medium rounded-lg px-2.5 py-1.5 transition-colors border border-outline-variant/20"
          >
            No Watchlist Data
          </button>
        )}
        {user.enabled && (
          <button
            disabled={syncing}
            onClick={onSync}
            className="flex items-center gap-1 bg-surface-container-high hover:bg-surface-bright disabled:opacity-50 text-on-surface text-xs font-medium rounded-lg px-2.5 py-1.5 transition-colors border border-outline-variant/20"
          >
            <Play size={11} className={syncing ? "animate-pulse" : ""} />
            {syncing ? "Syncing…" : "Sync Watchlist"}
          </button>
        )}
      </div>
    </div>
  );
}

function WatchlistInfoModal({
  user,
  trackAllUsersEnabled,
  onClose
}: {
  user: UserRecord;
  trackAllUsersEnabled: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [onClose]);

  const detail = !user.enabled && !trackAllUsersEnabled
    ? "No watchlist data is available for this user right now. They are currently disabled in Hubarr and Track All Users is turned off."
    : "No watchlist data can be found for this user. This usually means their watchlist privacy is set to private or they currently have no items in their watchlist.";

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-container rounded-2xl p-6 w-full max-w-md border border-outline-variant/20 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-headline font-semibold text-lg text-on-surface">
            {user.displayName}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
          >
            <X size={18} />
          </button>
        </div>

        <p className="text-sm text-on-surface-variant leading-6">
          {detail}
        </p>

        <div className="mt-6">
          <button
            onClick={onClose}
            className="w-full bg-primary hover:bg-primary-dim text-on-primary text-sm font-semibold rounded-xl py-2.5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoBadge({ label, message, className }: { label: string; message: string; className: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`text-xs px-1.5 py-0.5 rounded font-medium cursor-pointer ${className}`}
      >
        {label}
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 w-48 bg-surface-container-highest border border-outline-variant/30 rounded-lg px-3 py-2 text-xs text-on-surface shadow-lg z-10 text-center">
          {message}
        </div>
      )}
    </div>
  );
}

function ManagedUserCard({ user }: { user: ManagedUserRecord }) {
  return (
    <div className="relative bg-surface-container rounded-2xl border border-outline-variant/20 flex flex-col items-center p-4 gap-2 opacity-80">
      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="w-16 h-16" />

      <div className="w-full text-center px-1">
        <p className="font-medium text-on-surface text-sm truncate" title={user.displayName}>
          {user.displayName}
        </p>
      </div>

      <div className="flex flex-wrap gap-1 justify-center">
        <InfoBadge
          label="Managed User"
          message="Watchlists are not available for managed users"
          className="bg-amber-500/10 text-amber-400 border border-amber-500/20"
        />
        {user.hasRestrictionProfile && (
          <InfoBadge
            label="Restriction Profile"
            message="Label exclusion cannot be applied to user with Restriction Profile"
            className="bg-orange-500/10 text-orange-400 border border-orange-500/20"
          />
        )}
      </div>
    </div>
  );
}

function EditModal({
  user,
  settings,
  onSave,
  onClose
}: {
  user: UserRecord;
  settings: SettingsResponse;
  onSave: (patch: Partial<UserRecord>) => Promise<void>;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(user.enabled);
  const [displayNameOverride, setDisplayNameOverride] = useState(user.displayNameOverride ?? "");
  const [collectionNameOverride, setCollectionNameOverride] = useState(user.collectionNameOverride ?? "");
  const [visibilityOverride, setVisibilityOverride] = useState<VisibilityConfig | null>(
    user.visibilityOverride ?? null
  );
  const [collectionSortOrderOverride, setCollectionSortOrderOverride] = useState<CollectionSortOrder | null>(
    user.collectionSortOrderOverride ?? null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultName = settings.collections.collectionNamePattern.replace(
    "{user}",
    displayNameOverride.trim() || user.username
  );
  const effectiveVisibility = visibilityOverride ?? settings.collections.visibilityDefaults;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        enabled,
        displayNameOverride: displayNameOverride.trim() || null,
        collectionNameOverride: collectionNameOverride.trim() || null,
        visibilityOverride,
        collectionSortOrderOverride
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-container rounded-2xl p-6 w-full max-w-lg border border-outline-variant/20 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-headline font-semibold text-lg text-on-surface">
            Edit {user.displayName}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <ToggleField label="Enabled" checked={enabled} onChange={setEnabled} />

          <Field label="Display name override" hint={`Plex Username: ${user.username}`}>
            <input
              value={displayNameOverride}
              onChange={(event) => setDisplayNameOverride(event.target.value)}
              placeholder="Leave blank to use Plex Username"
              className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
            />
          </Field>

          <Field label="Collection name" hint={`Default name is ${defaultName}`}>
            <input
              value={collectionNameOverride}
              onChange={(event) => setCollectionNameOverride(event.target.value)}
              placeholder="Leave blank to use the default naming pattern"
              className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
            />
          </Field>

          <div className="border-t border-outline-variant/10 pt-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-on-surface">Hub Visibility</div>
              {visibilityOverride && (
                <button
                  onClick={() => setVisibilityOverride(null)}
                  className="text-xs text-primary hover:text-primary-dim"
                >
                  Restore to global default
                </button>
              )}
            </div>
            <div className="space-y-3">
              <ToggleField
                label="Library Recommended"
                checked={effectiveVisibility.recommended}
                onChange={(value) =>
                  setVisibilityOverride((current) => ({
                    ...(current ?? settings.collections.visibilityDefaults),
                    recommended: value
                  }))
                }
              />
              <ToggleField
                label="Home"
                checked={effectiveVisibility.home}
                onChange={(value) =>
                  setVisibilityOverride((current) => ({
                    ...(current ?? settings.collections.visibilityDefaults),
                    home: value
                  }))
                }
              />
              <ToggleField
                label="Friends Home"
                checked={effectiveVisibility.shared}
                onChange={(value) =>
                  setVisibilityOverride((current) => ({
                    ...(current ?? settings.collections.visibilityDefaults),
                    shared: value
                  }))
                }
              />
            </div>
          </div>

          <div className="border-t border-outline-variant/10 pt-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-on-surface">Collection Ordering</div>
              {collectionSortOrderOverride && (
                <button
                  onClick={() => setCollectionSortOrderOverride(null)}
                  className="text-xs text-primary hover:text-primary-dim"
                >
                  Restore to global default
                </button>
              )}
            </div>
            <div className="text-xs text-on-surface-variant mb-1.5">
              {`Global default: ${SORT_ORDER_LABELS[settings.collections.collectionSortOrder] ?? settings.collections.collectionSortOrder}`}
            </div>
            <div>
              <SelectInput
                value={collectionSortOrderOverride ?? ""}
                onChange={(value) =>
                  setCollectionSortOrderOverride((value as CollectionSortOrder) || null)
                }
              >
                <option value="">Use global default</option>
                <option value="date-desc">Release Date (New to Old)</option>
                <option value="date-asc">Release Date (Old to New)</option>
                <option value="title">Title (A–Z)</option>
                <option value="watchlist-date-desc">Watchlisted Date (New to Old)</option>
                <option value="watchlist-date-asc">Watchlisted Date (Old to New)</option>
              </SelectInput>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mt-4">
            {error}
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 bg-surface-container-high hover:bg-surface-bright text-on-surface text-sm font-medium rounded-xl py-2.5 transition-colors border border-outline-variant/20"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={() => void save()}
            className="flex-1 bg-primary hover:bg-primary-dim disabled:opacity-50 text-on-primary text-sm font-semibold rounded-xl py-2.5 transition-colors"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
