import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import PlexOAuth from "../lib/plexOAuth";
import PlexConfigForm from "../components/PlexConfigForm";
import CollectionsConfigForm from "../components/CollectionsConfigForm";
import { SaveBar, SectionCard, ToggleField } from "../components/FormControls";
import type { OnboardingStep, SetupStatusResponse, SettingsResponse } from "../../shared/types";

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
      return { authDone: false, plexDone: false, generalDone: false };
    }
    if (step === "plex") {
      return { authDone: true, plexDone: false, generalDone: false };
    }
    if (step === "general") {
      return { authDone: true, plexDone: true, generalDone: false };
    }
    return {
      authDone: true,
      plexDone: true,
      generalDone: true,
      collectionsDone: Boolean(setupStatus?.collectionsConfigured)
    };
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
          <StepDot number={1} active={step === "auth"} done={stepState.authDone} label="Sign in with Plex" />
          <div className="w-8 h-px bg-outline-variant/40" />
          <StepDot number={2} active={step === "plex"} done={stepState.plexDone} label="Configure Plex" />
          <div className="w-8 h-px bg-outline-variant/40" />
          <StepDot number={3} active={step === "general"} done={stepState.generalDone ?? false} label="General" />
          <div className="w-8 h-px bg-outline-variant/40" />
          <StepDot number={4} active={step === "collections"} done={stepState.collectionsDone ?? false} label="Collections" />
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
              await onComplete();
            }}
          />
        )}
      </div>
    </div>
  );
}

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
