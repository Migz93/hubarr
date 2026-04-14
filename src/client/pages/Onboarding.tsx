import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import PlexOAuth from "../lib/plexOAuth";
import PlexConfigForm from "../components/PlexConfigForm";
import CollectionsConfigForm from "../components/CollectionsConfigForm";
import { SaveBar, SectionCard, ToggleField } from "../components/FormControls";
import type {
  OnboardingStep,
  PreloadPhase,
  PreloadProgressEvent,
  SetupStatusResponse,
  SettingsResponse
} from "../../shared/types";

interface OnboardingProps {
  authenticated?: boolean;
  onComplete: () => Promise<void>;
}

export default function Onboarding({ authenticated = false, onComplete }: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("auth");
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  async function loadSetupState() {
    try {
      const [status, currentSettings] = await Promise.all([
        apiGet<SetupStatusResponse>("/api/setup/status"),
        apiGet<SettingsResponse>("/api/settings")
      ]);
      setSetupStatus(status);
      setSettings(currentSettings);
      setStep(status.currentStep);
    } catch {
      // Fresh install before auth — stay on auth step
      setStep("auth");
    }
  }

  useEffect(() => {
    if (!authenticated) {
      setStep("auth");
      return;
    }
    void loadSetupState();
  }, [authenticated]);

  async function handlePlexAuth() {
    setAuthError(null);
    setAuthBusy(true);
    const oauth = new PlexOAuth();
    oauth.preparePopup();
    try {
      const token = await oauth.login();
      await apiPost("/api/auth/plex", { authToken: token });
      await loadSetupState();
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAuthBusy(false);
    }
  }

  const stepState = useMemo(() => {
    if (step === "auth") {
      return { authDone: false, plexDone: false, generalDone: false, collectionsDone: false, preloadDone: false };
    }
    if (step === "plex") {
      return { authDone: true, plexDone: false, generalDone: false, collectionsDone: false, preloadDone: false };
    }
    if (step === "general") {
      return { authDone: true, plexDone: true, generalDone: false, collectionsDone: false, preloadDone: false };
    }
    if (step === "collections") {
      return {
        authDone: true,
        plexDone: true,
        generalDone: true,
        collectionsDone: Boolean(setupStatus?.collectionsConfigured),
        preloadDone: false
      };
    }
    // preload
    return { authDone: true, plexDone: true, generalDone: true, collectionsDone: true, preloadDone: false };
  }, [setupStatus?.collectionsConfigured, step]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        <div className="flex flex-col items-center mb-8">
          <img src="/logo.png" alt="Hubarr" className="w-16 h-16 mb-4" />
          <h1 className="font-headline font-bold text-2xl text-on-surface">Welcome to Hubarr</h1>
          <p className="text-on-surface-variant text-sm mt-1">Let&apos;s get your server set up</p>
        </div>

        <div className="flex items-center justify-center gap-3 mb-6">
          <StepDot number={1} active={step === "auth"} done={stepState.authDone} label="Sign in" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={2} active={step === "plex"} done={stepState.plexDone} label="Configure Plex" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={3} active={step === "general"} done={stepState.generalDone ?? false} label="General" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={4} active={step === "collections"} done={stepState.collectionsDone ?? false} label="Collections" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={5} active={step === "preload"} done={stepState.preloadDone} label="Preloading" />
        </div>

        {step === "auth" && (
          <div className="bg-surface-container rounded-2xl p-6 border border-outline-variant/20 max-w-xl mx-auto">
            <h2 className="font-headline font-semibold text-lg text-on-surface mb-1">
              Sign in with Plex
            </h2>
            <p className="text-on-surface-variant text-sm mb-6">
              Authenticate with your Plex account to make this Hubarr instance yours.
            </p>

            {authError && (
              <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
                {authError}
              </div>
            )}

            <button
              disabled={authBusy}
              onClick={() => void handlePlexAuth()}
              className="w-full flex items-center justify-center gap-3 bg-primary hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed text-on-primary font-semibold rounded-xl px-4 py-3 transition-colors"
            >
              {authBusy ? "Waiting for Plex..." : "Sign in with Plex"}
              {!authBusy && <ChevronRight size={18} />}
            </button>
          </div>
        )}

        {step === "plex" && (
          <PlexConfigForm
            initialConfig={setupStatus?.plex ?? null}
            saveUrl="/api/setup/plex/save"
            saveLabel="Continue to General"
            onSaved={async () => {
              await loadSetupState();
              setStep("general");
            }}
          />
        )}

        {step === "general" && settings && (
          <GeneralOnboardingStep
            settings={settings}
            onSaved={async () => {
              await loadSetupState();
              setStep("collections");
            }}
          />
        )}

        {step === "collections" && settings && (
          <CollectionsConfigForm
            initialValue={settings.collections}
            librariesUrl="/api/setup/plex/libraries"
            saveLabel="Finish Setup"
            onSaved={async () => {
              setStep("preload");
            }}
          />
        )}

        {step === "preload" && (
          <PreloadStep onComplete={onComplete} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preload step
// ---------------------------------------------------------------------------

interface PhaseState {
  status: "idle" | "running" | "done" | "error";
  message: string;
  progress?: number;
  total?: number;
}

const INITIAL_PHASES: Record<PreloadPhase, PhaseState> = {
  "discover-users": { status: "idle", message: "" },
  "activity-cache": { status: "idle", message: "" },
  "graphql-sync": { status: "idle", message: "" },
  "complete": { status: "idle", message: "" }
};

const PHASE_LABELS: Record<Exclude<PreloadPhase, "complete">, string> = {
  "discover-users": "Fetch Plex users & avatars",
  "activity-cache": "Sync activity feed",
  "graphql-sync": "Sync watchlists"
};

function PreloadStep({ onComplete }: { onComplete: () => Promise<void> }) {
  const [phases, setPhases] = useState<Record<PreloadPhase, PhaseState>>(INITIAL_PHASES);
  const [done, setDone] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Prevent double-entering the app if the EventSource fires multiple complete events
  const enteringRef = useRef(false);

  useEffect(() => {
    const es = new EventSource("/api/setup/preload");

    es.onmessage = (e: MessageEvent<string>) => {
      let event: PreloadProgressEvent;
      try {
        event = JSON.parse(e.data) as PreloadProgressEvent;
      } catch {
        return;
      }

      if (event.phase === "complete") {
        es.close();
        setDone(true);
        // Enter the app automatically after a short pause so the user can see
        // the completed state before navigating away.
        if (!enteringRef.current) {
          enteringRef.current = true;
          window.setTimeout(() => void onComplete(), 1500);
        }
        return;
      }

      setPhases((prev) => ({
        ...prev,
        [event.phase]: {
          status: event.status,
          message: event.message,
          progress: event.progress,
          total: event.total
        }
      }));
    };

    es.onerror = () => {
      es.close();
      setFatalError("Connection to server lost. Please refresh and try again.");
    };

    return () => {
      es.close();
    };
    // onComplete is stable (passed from App level), so the empty dep array is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-surface-container rounded-2xl p-6 border border-outline-variant/20 max-w-xl mx-auto">
      <h2 className="font-headline font-semibold text-lg text-on-surface mb-1">
        Getting Hubarr Ready
      </h2>
      <p className="text-on-surface-variant text-sm mb-6">
        Loading your data in the background — this only happens once.
      </p>

      <div className="space-y-3">
        {(["discover-users", "activity-cache", "graphql-sync"] as const).map((phase) => (
          <PreloadPhaseRow
            key={phase}
            label={PHASE_LABELS[phase]}
            state={phases[phase]}
          />
        ))}
      </div>

      {done && (
        <div className="mt-6 pt-5 border-t border-outline-variant/20 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-success text-sm font-medium">
            <Check size={16} />
            Hubarr is ready — entering now…
          </div>
        </div>
      )}

      {fatalError && (
        <div className="mt-4 bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm">
          {fatalError}
        </div>
      )}
    </div>
  );
}

function PreloadPhaseRow({ label, state }: { label: string; state: PhaseState }) {
  const isIdle = state.status === "idle";
  const isRunning = state.status === "running";
  const isDone = state.status === "done";
  const isError = state.status === "error";

  return (
    <div className="flex items-start gap-3">
      {/* Status icon */}
      <div className="mt-0.5 w-5 h-5 flex items-center justify-center shrink-0">
        {isIdle && (
          <div className="w-4 h-4 rounded-full border-2 border-outline-variant/40" />
        )}
        {isRunning && (
          <Loader2 size={16} className="animate-spin text-primary" />
        )}
        {isDone && (
          <div className="w-4 h-4 rounded-full bg-success flex items-center justify-center">
            <Check size={10} className="text-white" />
          </div>
        )}
        {isError && (
          <div className="w-4 h-4 rounded-full bg-error/20 flex items-center justify-center">
            <X size={10} className="text-error" />
          </div>
        )}
      </div>

      {/* Label and message */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium leading-tight ${isIdle ? "text-on-surface-variant" : "text-on-surface"}`}>
          {label}
        </p>
        {state.message && (
          <p className={`text-xs mt-0.5 ${isError ? "text-error" : "text-on-surface-variant"}`}>
            {state.message}
            {/* Inline progress counter for the graphql-sync phase */}
            {isRunning && state.total !== undefined && state.total > 0 && state.progress !== undefined && (
              <span className="ml-1 text-on-surface-variant/60">
                ({state.progress}/{state.total})
              </span>
            )}
          </p>
        )}
        {/* Progress bar for graphql-sync */}
        {isRunning && state.total !== undefined && state.total > 0 && (
          <div className="mt-1.5 h-1 rounded-full bg-surface-container-high overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${Math.round(((state.progress ?? 0) / state.total) * 100)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General step
// ---------------------------------------------------------------------------

function GeneralOnboardingStep({
  settings,
  onSaved
}: {
  settings: SettingsResponse;
  onSaved: () => Promise<void>;
}) {
  const [trackAllUsers, setTrackAllUsers] = useState(settings.general.trackAllUsers);
  const [fullSyncOnStartup, setFullSyncOnStartup] = useState(settings.general.fullSyncOnStartup);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTrackAllUsers(settings.general.trackAllUsers);
    setFullSyncOnStartup(settings.general.fullSyncOnStartup);
  }, [settings.general.fullSyncOnStartup, settings.general.trackAllUsers]);

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await apiPatch("/api/settings", {
        general: {
          trackAllUsers,
          fullSyncOnStartup
        }
      });
      setSuccess(true);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="General Settings"
      description="Choose how Hubarr should behave after Plex is connected. You can change these again later in Settings."
      wide
    >
      <div className="space-y-4">
        <ToggleField
          label="Track All Users"
          hint="Keep background watchlist tracking running for disabled users too. Turning this off deletes cached watchlist data for disabled users."
          checked={trackAllUsers}
          onChange={setTrackAllUsers}
        />
        <ToggleField
          label="Startup Sync"
          hint="When Hubarr starts, run a Plex full library scan, then a watchlist GraphQL sync, then a collection sync."
          checked={fullSyncOnStartup}
          onChange={setFullSyncOnStartup}
        />
      </div>
      <SaveBar
        saving={saving}
        success={success}
        error={error}
        onSave={() => void save()}
        label="Continue to Collections"
      />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Step indicator dot
// ---------------------------------------------------------------------------

function StepDot({
  number,
  active,
  done,
  label
}: {
  number: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
          done
            ? "bg-success text-white"
            : active
            ? "bg-primary text-on-primary"
            : "bg-surface-container-high text-on-surface-variant"
        }`}
      >
        {done ? <Check size={14} /> : number}
      </div>
      <span className={`text-xs ${active ? "text-on-surface" : "text-on-surface-variant"}`}>
        {label}
      </span>
    </div>
  );
}
