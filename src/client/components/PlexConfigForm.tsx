import { useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "../lib/api";
import type { PlexConfigPayload, PlexConnectionOption, PlexLibrary, PlexSettingsView } from "../../shared/types";
import { Field, SaveBar, SectionCard, SelectInput, TextInput, ToggleField } from "./FormControls";

interface PlexConfigResponse {
  plex: PlexSettingsView | null;
  libraries: PlexLibrary[];
}

export default function PlexConfigForm({
  initialConfig,
  initialTrackAllUsers = false,
  saveUrl,
  onSaved,
  saveLabel = "Save Plex"
}: {
  initialConfig: PlexSettingsView | null;
  initialTrackAllUsers?: boolean;
  saveUrl: string;
  onSaved?: (result: PlexConfigResponse) => void | Promise<void>;
  saveLabel?: string;
}) {
  const [availableServers, setAvailableServers] = useState<PlexConnectionOption[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [selectedServerUri, setSelectedServerUri] = useState<string>(initialConfig?.serverUrl ?? "");
  const [selectedMachineIdentifier, setSelectedMachineIdentifier] = useState<string>(
    initialConfig?.machineIdentifier ?? ""
  );
  const [hostname, setHostname] = useState(initialConfig?.hostname ?? "");
  const [port, setPort] = useState(String(initialConfig?.port ?? 32400));
  const [useSsl, setUseSsl] = useState(initialConfig?.useSsl ?? false);
  const [trackAllUsers, setTrackAllUsers] = useState(initialTrackAllUsers);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupedServers = useMemo(() => {
    return availableServers.map((option) => ({
      value: option.uri,
      label: `${option.name} · ${option.uri}`,
      option
    }));
  }, [availableServers]);

  function switchToManual() {
    setSelectedServerUri("");
    setSelectedMachineIdentifier("");
  }

  async function loadServers() {
    setLoadingServers(true);
    setError(null);
    try {
      const result = await apiGet<PlexConnectionOption[]>("/api/setup/plex/servers");
      setAvailableServers(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingServers(false);
    }
  }

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      const payload: PlexConfigPayload =
        selectedServerUri && selectedMachineIdentifier
          ? {
              mode: "preset",
              serverUrl: selectedServerUri,
              machineIdentifier: selectedMachineIdentifier
            }
          : {
              mode: "manual",
              hostname,
              port: Number(port),
              useSsl,
              trackAllUsers
            };

      if (payload.mode === "preset") {
        payload.trackAllUsers = trackAllUsers;
      }

      const result = await apiPost<PlexConfigResponse>(saveUrl, payload);
      setSuccess(true);
      await onSaved?.(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Plex Settings"
      description="Connect Hubarr to your Plex server. Once linked, Hubarr will build and maintain watchlist Collections and publish them as Hub rows."
      wide
    >
      <Field label="Server" hint="Press the button to load available servers">
        <div className="grid grid-cols-[1fr_auto] gap-2 items-stretch">
          <SelectInput
            value={selectedServerUri}
            onChange={(value) => {
              const match = groupedServers.find((entry) => entry.value === value)?.option;
              if (!match) {
                switchToManual();
                return;
              }
              setSelectedMachineIdentifier(match.machineIdentifier);
              setSelectedServerUri(match.uri);
              setHostname(match.address);
              setPort(String(match.port));
              setUseSsl(match.protocol === "https");
            }}
          >
            <option value="">Press the button to load available servers</option>
            {groupedServers.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </SelectInput>
          <button
            type="button"
            disabled={loadingServers}
            onClick={() => void loadServers()}
            className="flex items-center justify-center gap-2 bg-surface-container-high hover:bg-surface-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2.5 transition-colors border border-outline-variant/20"
            aria-label="Load available servers"
          >
            <RefreshCw size={15} className={loadingServers ? "animate-spin" : ""} />
          </button>
        </div>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-4">
        <Field label="Hostname or IP Address*">
          <div className="flex rounded-lg border border-outline-variant/30 overflow-hidden bg-surface-container-low">
            <div className="px-3 py-2 text-sm text-on-surface-variant bg-surface-container-high border-r border-outline-variant/20">
              {useSsl ? "https://" : "http://"}
            </div>
            <input
              value={hostname}
              onChange={(event) => {
                switchToManual();
                setHostname(event.target.value);
              }}
              placeholder="192.168.1.10"
              className="flex-1 bg-transparent px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none"
            />
          </div>
        </Field>
        <Field label="Port*">
          <TextInput
            value={port}
            onChange={(value) => {
              switchToManual();
              setPort(value);
            }}
            type="number"
            placeholder="32400"
          />
        </Field>
      </div>

      <ToggleField label="Use SSL" checked={useSsl} onChange={(value) => {
        switchToManual();
        setUseSsl(value);
      }} />

      <ToggleField
        label="Track All Users"
        hint="Keep background watchlist tracking running for disabled users too. Disabled users still will not publish collections or appear in normal dashboard/watchlist views."
        checked={trackAllUsers}
        onChange={setTrackAllUsers}
      />

      <SaveBar
        saving={saving}
        success={success}
        error={error}
        onSave={() => void save()}
        label={saveLabel}
      />

      {success && onSaved && (
        <div className="text-xs text-on-surface-variant flex items-center gap-1">
          <ChevronRight size={12} />
          Plex configuration saved successfully.
        </div>
      )}
    </SectionCard>
  );
}
