import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "../lib/api";
import type { PlexConfigPayload, PlexConnectionOption, PlexLibrary, PlexSettingsView } from "../../shared/types";
import { Field, SectionCard, SelectInput, TextInput, ToggleField } from "./FormControls";

interface PlexConfigResponse {
  plex: PlexSettingsView | null;
  libraries: PlexLibrary[];
}

export default function PlexConfigForm({
  initialConfig,
  saveUrl,
  testUrl,
  onSaved,
  onBack,
  saveLabel = "Save Plex"
}: {
  initialConfig: PlexSettingsView | null;
  saveUrl: string;
  testUrl: string;
  onSaved?: (result: PlexConfigResponse) => void | Promise<void>;
  onBack?: () => void;
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
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const groupedServers = useMemo(() => {
    return availableServers.map((option) => ({
      value: option.uri,
      label: `${option.name} · ${option.uri}`,
      option
    }));
  }, [availableServers]);

  const trimmedHostname = hostname.trim();
  const parsedPort = parseInt(port, 10);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const manualConfigValid = trimmedHostname.length > 0 && portValid;

  function buildPayload(): PlexConfigPayload {
    return selectedServerUri && selectedMachineIdentifier
      ? { mode: "preset", serverUrl: selectedServerUri, machineIdentifier: selectedMachineIdentifier }
      : { mode: "manual", hostname: trimmedHostname, port: parsedPort, useSsl };
  }

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

  async function testConnection() {
    const payload = buildPayload();
    console.debug("Plex connection test started", { testUrl, payload });
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; serverUrl?: string; libraryCount?: number; error?: string }>(
        testUrl,
        payload
      );
      if (result.ok) {
        console.debug("Plex connection test succeeded", { ok: true, serverUrl: result.serverUrl, libraryCount: result.libraryCount });
        const count = result.libraryCount ?? 0;
        setTestResult({ ok: true, message: `Test Succeeded — ${count} ${count === 1 ? "library" : "libraries"} found` });
      } else {
        console.warn("Plex connection test returned non-ok", { ok: false, error: result.error });
        setTestResult({ ok: false, message: result.error ?? "Connection failed" });
      }
    } catch (caught) {
      console.warn("Plex connection test threw", { error: caught instanceof Error ? caught.message : String(caught) });
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      const result = await apiPost<PlexConfigResponse>(saveUrl, buildPayload());
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
      description="Connect Hubarr to your Plex server to start building and publishing watchlist collections."
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
            className="flex items-center justify-center gap-2 bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2.5 transition-colors border border-outline-variant/20"
            aria-label="Load available servers"
          >
            <RefreshCw size={15} className={loadingServers ? "animate-spin" : ""} />
          </button>
        </div>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-4">
        <Field label="Hostname or IP Address*">
          <div className="flex rounded-lg border border-outline-variant/30 overflow-hidden bg-background-container-low">
            <div className="px-3 py-2 text-sm text-on-surface-variant bg-background-container-high border-r border-outline-variant/20">
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

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-outline-variant/15">
        <div className="flex items-center gap-3 flex-wrap">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 bg-background-container-high hover:bg-background-bright text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
            >
              <ChevronLeft size={15} />
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing || (!selectedServerUri && !manualConfigValid)}
            className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {testResult && (
            <span className={`text-xs font-medium ${testResult.ok ? "text-success" : "text-error"}`}>
              {testResult.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {success && <span className="text-success text-sm">Saved</span>}
          {error && <span className="text-error text-sm">{error}</span>}
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="flex items-center gap-2 bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
          >
            {saving ? "Saving..." : saveLabel}
            {!saving && <ChevronRight size={15} />}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
