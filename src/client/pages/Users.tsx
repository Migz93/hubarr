import { useEffect, useMemo, useState } from "react";
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
        <div className="space-y-2">
          {activeUsers.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              compact={false}
              selected={selectedIds.includes(user.id)}
              syncing={syncingId === user.id}
              onToggleSelected={() => toggleSelected(user.id)}
              onEdit={() => setEditingId(user.id)}
              onSync={() => void syncUser(user.id)}
            />
          ))}
        </div>
      </div>

      <div>
        <button
          onClick={() => setDisabledOpen((open) => !open)}
          className="flex items-center gap-2 text-sm font-medium text-on-surface-variant mb-3"
        >
          {disabledOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Disabled ({disabledUsers.length})
        </button>
        {disabledOpen && (
          <div className="space-y-2">
            {disabledUsers.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                compact
                selected={selectedIds.includes(user.id)}
                syncing={syncingId === user.id}
                onToggleSelected={() => toggleSelected(user.id)}
                onEdit={() => setEditingId(user.id)}
                onSync={() => void syncUser(user.id)}
              />
            ))}
          </div>
        )}
      </div>

      {managedUsers.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setManagedOpen((open) => !open)}
            className="flex items-center gap-2 text-sm font-medium text-on-surface-variant mb-3"
          >
            {managedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            Managed Home Users ({managedUsers.length})
          </button>
          {managedOpen && (
            <div className="space-y-2">
              {managedUsers.map((user) => (
                <ManagedUserRow key={user.plexUserId} user={user} />
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

function UserRow({
  user,
  compact,
  selected,
  syncing,
  onToggleSelected,
  onEdit,
  onSync
}: {
  user: UserRecord;
  compact: boolean;
  selected: boolean;
  syncing: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onSync: () => void;
}) {
  const hasNameOverride = Boolean(user.displayNameOverride?.trim());
  const primaryName = hasNameOverride ? `${user.displayName} (${user.username})` : user.username;

  return (
    <div
      className={`bg-surface-container rounded-xl border border-outline-variant/20 flex items-center gap-4 ${
        compact ? "px-4 py-3" : "px-4 py-4"
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelected}
        className="accent-primary w-4 h-4"
      />

      {user.avatarUrl ? (
        <img
          src={getPlexImageSrc(user.avatarUrl) ?? undefined}
          alt={user.displayName}
          className={`${compact ? "w-8 h-8" : "w-10 h-10"} rounded-full object-cover`}
        />
      ) : (
        <div className={`${compact ? "w-8 h-8" : "w-10 h-10"} rounded-full bg-surface-container-highest flex items-center justify-center`}>
          <span className="text-on-surface-variant text-xs font-medium">
            {user.displayName.charAt(0).toUpperCase()}
          </span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-on-surface text-sm truncate">{primaryName}</span>
          {user.isSelf && (
            <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">
              You
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {user.enabled && (
          <button
            disabled={syncing}
            onClick={onSync}
            className="flex items-center gap-1.5 bg-surface-container-high hover:bg-surface-bright disabled:opacity-50 text-on-surface text-xs font-medium rounded-lg px-3 py-2 transition-colors border border-outline-variant/20"
          >
            <Play size={13} className={syncing ? "animate-pulse" : ""} />
            {syncing ? "Syncing..." : "Sync Watchlist"}
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-2 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          title="Edit"
        >
          <Edit2 size={15} />
        </button>
      </div>
    </div>
  );
}

function ManagedUserRow({ user }: { user: ManagedUserRecord }) {
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/20 flex items-center gap-4 px-4 py-3 opacity-80">
      {user.avatarUrl ? (
        <img
          src={getPlexImageSrc(user.avatarUrl) ?? undefined}
          alt={user.displayName}
          className="w-8 h-8 rounded-full object-cover"
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center">
          <span className="text-on-surface-variant text-xs font-medium">
            {user.displayName.charAt(0).toUpperCase()}
          </span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <span className="font-medium text-on-surface text-sm truncate">{user.displayName}</span>
        <p className="text-xs text-on-surface-variant mt-0.5">
          {"Watchlists not available for managed users \u2014 "}
          {user.hasRestrictionProfile
            ? "Label exclusion cannot be applied to user with Restriction Profile"
            : "Label exclusion filter applied"}
        </p>
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
