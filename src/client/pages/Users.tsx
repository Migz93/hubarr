import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Edit2, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import { Field, ToggleField } from "../components/FormControls";
import type { UserRecord, ManagedUserRecord, SettingsResponse, VisibilityConfig } from "../../shared/types";

export default function Users() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [managedUsers, setManagedUsers] = useState<ManagedUserRecord[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [managedOpen, setManagedOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [usersResult, managedResult, settingsResult] = await Promise.all([
        apiGet<UserRecord[]>("/api/users"),
        apiGet<ManagedUserRecord[]>("/api/users/managed"),
        apiGet<SettingsResponse>("/api/settings")
      ]);
      setUsers(usersResult);
      setManagedUsers(managedResult);
      setSettings(settingsResult);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function refreshUsers() {
    setRefreshing(true);
    setError(null);
    try {
      await apiPost("/api/users/discover");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  }

  async function bulkSetEnabled(enabled: boolean) {
    if (selectedIds.length === 0) return;
    try {
      await apiPost("/api/users/bulk", { ids: selectedIds, enabled });
      setSelectedIds([]);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function syncUser(userId: number) {
    setSyncingId(userId);
    try {
      await apiPost(`/api/users/${userId}/sync`);
      await load();
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

  if (loading) {
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
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          Refresh Users
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
            await load();
          }}
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
  onSync
}: {
  user: UserRecord;
  selected: boolean;
  syncing: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onSync: () => void;
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

      <div className="flex items-center gap-1.5 mt-auto pt-1 w-full justify-center flex-wrap">
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
        <button
          onClick={onEdit}
          className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors border border-outline-variant/20"
          title="Edit user"
        >
          <Edit2 size={14} />
        </button>
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
        visibilityOverride
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
