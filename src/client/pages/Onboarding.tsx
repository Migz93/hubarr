import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import PlexOAuth from "../lib/plexOAuth";
import PlexConfigForm from "../components/PlexConfigForm";
import CollectionsConfigForm from "../components/CollectionsConfigForm";
import { SaveBar, SectionCard, ToggleField } from "../components/FormControls";
import type {
  OnboardingStep,
  PreloadPhase,
  PreloadProgressEvent,
  SetupStatusResponse,
  SettingsResponse,
  UserRecord
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

  // Step order: auth(1) → general(2) → plex(3) → collections(4) → users(5) → preload(hidden)
  const stepState = useMemo(() => {
    const authDone = step !== "auth";
    const generalDone = authDone && step !== "general";
    const plexDone = generalDone && step !== "plex";
    const collectionsDone = plexDone && (step !== "collections" || Boolean(setupStatus?.collectionsConfigured));
    const usersDone = collectionsDone && step !== "users";
    return { authDone, generalDone, plexDone, collectionsDone, usersDone };
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
          <StepDot number={2} active={step === "general"} done={stepState.generalDone} label="General" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={3} active={step === "plex"} done={stepState.plexDone} label="Plex" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={4} active={step === "collections"} done={stepState.collectionsDone} label="Collections" />
          <div className="w-6 h-px bg-outline-variant/40" />
          <StepDot number={5} active={step === "users"} done={stepState.usersDone} label="Users" />
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

        {step === "general" && settings && (
          <GeneralOnboardingStep
            settings={settings}
            onSaved={async () => {
              await loadSetupState();
              setStep("plex");
            }}
          />
        )}

        {step === "plex" && (
          <PlexConfigForm
            initialConfig={setupStatus?.plex ?? null}
            saveUrl="/api/setup/plex/save"
            saveLabel="Continue to Collections"
            onBack={() => setStep("general")}
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
            saveLabel="Continue to Users"
            onBack={() => setStep("plex")}
            onSaved={async () => {
              setStep("users");
            }}
          />
        )}

        {step === "users" && (
          <UsersOnboardingStep
            onBack={() => setStep("collections")}
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
// Users step
// ---------------------------------------------------------------------------

// How many times to re-fetch users to pick up avatars that are still being
// cached in the background after the Plex step completes.
const AVATAR_POLL_MAX = 6;

/**
 * Lets the admin choose which Plex users should have watchlist collections
 * enabled before the one-time preload runs.
 */
function UsersOnboardingStep({ onBack, onSaved }: { onBack: () => void; onSaved: () => Promise<void> }) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatarPollCount, setAvatarPollCount] = useState(0);
  const initialSelectionDone = useRef(false);
  const knownUserIds = useRef<Set<number>>(new Set());

  // Merge newly fetched users into local state without undoing manual
  // selection changes for users the admin has already seen on the page.
  function applyFetchedUsers(list: UserRecord[]) {
    const nextKnownIds = new Set(list.map((user) => user.id));
    const autoSelectedIds = list.filter((user) => user.isSelf || user.enabled).map((user) => user.id);

    setUsers(list);
    setSelectedIds((prev) => {
      if (!initialSelectionDone.current) {
        initialSelectionDone.current = true;
        knownUserIds.current = nextKnownIds;
        return new Set(autoSelectedIds);
      }

      const next = new Set(prev);
      for (const id of autoSelectedIds) {
        if (!knownUserIds.current.has(id)) {
          next.add(id);
        }
      }
      knownUserIds.current = nextKnownIds;
      return next;
    });
  }

  // Initial load
  useEffect(() => {
    apiGet<UserRecord[]>("/api/users")
      .then((list) => {
        applyFetchedUsers(list);
      })
      .catch(() => {
        /* empty state shown, user can proceed */
      })
      .finally(() => setLoading(false));
  }, []);

  // Keep re-fetching avatars that are still being cached in the background.
  // Stops once all users have avatars or after AVATAR_POLL_MAX attempts.
  useEffect(() => {
    if (users.length === 0 || avatarPollCount >= AVATAR_POLL_MAX) return;
    const hasMissing = users.some((u) => u.avatarUrl === null);
    if (!hasMissing) return;

    const timer = setTimeout(async () => {
      try {
        const list = await apiGet<UserRecord[]>("/api/users");
        applyFetchedUsers(list);
      } catch {
        /* ignore — we'll try again next cycle */
      }
      setAvatarPollCount((c) => c + 1);
    }, 2000);

    return () => clearTimeout(timer);
  }, [users, avatarPollCount]);

  function toggle(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === users.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(users.map((u) => u.id)));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const selectedUserIds = users.filter((user) => selectedIds.has(user.id)).map((user) => user.id);
      const deselectedUserIds = users.filter((user) => !selectedIds.has(user.id)).map((user) => user.id);

      if (selectedUserIds.length > 0) {
        await apiPost("/api/users/bulk", {
          ids: selectedUserIds,
          enabled: true
        });
      }

      if (deselectedUserIds.length > 0) {
        await apiPost("/api/users/bulk", {
          ids: deselectedUserIds,
          enabled: false
        });
      }

      await apiPost("/api/setup/users/complete", {});
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  const allSelected = users.length > 0 && selectedIds.size === users.length;
  const noneSelected = selectedIds.size === 0;

  return (
    <div className="bg-surface-container rounded-2xl p-6 border border-outline-variant/20 max-w-2xl mx-auto">
      <h2 className="font-headline font-semibold text-lg text-on-surface mb-1">
        Choose Your Users
      </h2>
      <p className="text-on-surface-variant text-sm mb-6">
        Select which Plex users to create watchlist collections for.<br />
        Collections will be synced to Plex as part of setup.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-10 gap-2 text-on-surface-variant text-sm">
          <Loader2 size={18} className="animate-spin" />
          Loading users...
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-10 text-on-surface-variant text-sm">
          No users found yet. You can add them from the Users page after setup.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 mb-5 justify-center">
            {users.map((user) => (
              <UserSelectCard
                key={user.id}
                user={user}
                selected={selectedIds.has(user.id)}
                onToggle={() => toggle(user.id)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-outline-variant/20">
            <button
              onClick={toggleAll}
              className="text-sm text-primary hover:text-primary-dim transition-colors"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
            <span className="text-xs text-on-surface-variant">
              {selectedIds.size} of {users.length} selected
            </span>
          </div>
        </>
      )}

      {error && (
        <div className="mt-4 bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 bg-surface-container-high hover:bg-surface-bright text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
        >
          <ChevronLeft size={15} />
          Back
        </button>
        <button
          disabled={saving}
          onClick={() => void save()}
          className="flex items-center gap-2 bg-primary hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed text-on-primary font-semibold rounded-xl px-5 py-2.5 text-sm transition-colors"
        >
          {saving ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Saving...
            </>
          ) : noneSelected ? (
            "Skip"
          ) : (
            <>
              Continue
              <ChevronRight size={15} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function UserSelectCard({
  user,
  selected,
  onToggle
}: {
  user: UserRecord;
  selected: boolean;
  onToggle: () => void;
}) {
  const avatarSrc = getPlexImageSrc(user.avatarUrl);

  return (
    <button
      onClick={onToggle}
      className={`flex flex-col items-center gap-2 p-3 rounded-xl w-24 transition-all ${
        selected
          ? "bg-primary/10 ring-1 ring-primary/40"
          : "hover:bg-surface-container-high ring-1 ring-transparent"
      }`}
    >
      <div className="relative w-14 h-14 shrink-0">
        <div
          className={`w-full h-full rounded-full overflow-hidden transition-opacity ${
            selected ? "opacity-100" : "opacity-50"
          }`}
        >
          {avatarSrc ? (
            <img src={avatarSrc} alt={user.displayName} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-semibold text-xl">
                {user.displayName[0]?.toUpperCase() ?? "?"}
              </span>
            </div>
          )}
        </div>

        {selected && (
          <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
            <Check size={11} className="text-on-primary" />
          </div>
        )}
      </div>

      <div className="w-full text-center">
        <p
          className={`text-xs font-medium leading-tight truncate ${
            selected ? "text-on-surface" : "text-on-surface-variant"
          }`}
        >
          {user.displayName}
        </p>
        {user.isSelf && (
          <p className="text-[10px] text-primary leading-tight mt-0.5">You</p>
        )}
      </div>
    </button>
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

type VisiblePreloadPhase = Exclude<PreloadPhase, "complete">;

const VISIBLE_PRELOAD_PHASES: VisiblePreloadPhase[] = [
  "discover-users",
  "activity-cache",
  "graphql-sync",
  "publish-collections"
];

const INITIAL_PHASES: Record<VisiblePreloadPhase, PhaseState> = {
  "discover-users": { status: "idle", message: "" },
  "activity-cache": { status: "idle", message: "" },
  "graphql-sync": { status: "idle", message: "" },
  "publish-collections": { status: "idle", message: "" }
};

const PHASE_LABELS: Record<VisiblePreloadPhase, string> = {
  "discover-users": "Fetch Plex users & avatars",
  "activity-cache": "Sync activity feed",
  "graphql-sync": "Sync watchlists",
  "publish-collections": "Publish collections"
};

/**
 * Streams the one-time preload progress, then marks onboarding complete before
 * handing control back to the main app shell.
 */
function PreloadStep({ onComplete }: { onComplete: () => Promise<void> }) {
  const [phases, setPhases] = useState<Record<VisiblePreloadPhase, PhaseState>>(INITIAL_PHASES);
  const [done, setDone] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [retryCompletionOnly, setRetryCompletionOnly] = useState(false);
  const enteringRef = useRef(false);
  const onCompleteRef = useRef(onComplete);

  onCompleteRef.current = onComplete;

  async function finishOnboarding() {
    setFatalError(null);
    try {
      await apiPost("/api/setup/complete", {});
      setRetryCompletionOnly(false);
      await onCompleteRef.current();
    } catch (caught) {
      setDone(false);
      setRetryCompletionOnly(true);
      enteringRef.current = false;
      setFatalError(
        caught instanceof Error
          ? caught.message
          : "Could not finish setup. Retry to enter Hubarr."
      );
    }
  }

  useEffect(() => {
    let closed = false;
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
        if (closed) {
          return;
        }
        setDone(true);
        setFatalError(null);
        setRetryCompletionOnly(false);
        if (!enteringRef.current) {
          enteringRef.current = true;
          window.setTimeout(async () => {
            await finishOnboarding();
          }, 1500);
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
      if (closed) {
        return;
      }
      setFatalError("Connection to server lost. Retry to continue the preload.");
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [retryToken]);

  function retry() {
    if (retryCompletionOnly) {
      enteringRef.current = true;
      void finishOnboarding();
      return;
    }

    enteringRef.current = false;
    setDone(false);
    setFatalError(null);
    setRetryCompletionOnly(false);
    setPhases(INITIAL_PHASES);
    setRetryToken((current) => current + 1);
  }

  return (
    <div className="bg-surface-container rounded-2xl p-6 border border-outline-variant/20 max-w-xl mx-auto">
      <h2 className="font-headline font-semibold text-lg text-on-surface mb-1">
        Getting Hubarr Ready
      </h2>
      <p className="text-on-surface-variant text-sm mb-6">
        Running your first full sync to get everything ready.<br />
        This only happens once — future syncs will be much faster.
      </p>

      <div className="space-y-3">
        {VISIBLE_PRELOAD_PHASES.map((phase) => (
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
          <p>{fatalError}</p>
          <button
            onClick={retry}
            className="mt-3 inline-flex items-center gap-2 bg-error text-white font-semibold rounded-lg px-3 py-2 text-sm transition-colors hover:opacity-90"
          >
            Retry preload
          </button>
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
  const showProgress = isRunning && state.total !== undefined && state.total > 0;

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 w-5 h-5 flex items-center justify-center shrink-0">
        {isIdle && <div className="w-4 h-4 rounded-full border-2 border-outline-variant/40" />}
        {isRunning && <Loader2 size={16} className="animate-spin text-primary" />}
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

      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium leading-tight ${isIdle ? "text-on-surface-variant" : "text-on-surface"}`}>
          {label}
        </p>
        {state.message && (
          <p className={`text-xs mt-0.5 ${isError ? "text-error" : "text-on-surface-variant"}`}>
            {state.message}
            {showProgress && state.progress !== undefined && (
              <span className="ml-1 text-on-surface-variant/60">({state.progress}/{state.total})</span>
            )}
          </p>
        )}
        {showProgress && (
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
        general: { trackAllUsers, fullSyncOnStartup }
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
      description="Configure the global settings for your Hubarr instance. You can change these again later in Settings."
      wide
    >
      <div className="space-y-4">
        <ToggleField
          label="Track All Users"
          hint="This allows you to view watchlist data for all your Plex users regardless of their enabled status. This will not publish collections."
          checked={trackAllUsers}
          onChange={setTrackAllUsers}
        />
        <ToggleField
          label="Startup Sync"
          hint="When Hubarr starts, run a full scan of your libraries and watchlists, then publish collections."
          checked={fullSyncOnStartup}
          onChange={setFullSyncOnStartup}
        />
      </div>
      <SaveBar
        saving={saving}
        success={success}
        error={error}
        onSave={() => void save()}
        label="Continue to Plex"
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
