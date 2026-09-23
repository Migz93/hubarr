import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "./lib/api";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import Dashboard from "./pages/Dashboard";
import Users from "./pages/Users";
import Watchlists from "./pages/Watchlists";
import History from "./pages/History";
import Settings from "./pages/Settings";
import type { BootstrapStatus, SessionUser } from "../shared/types";

interface AppState {
  bootstrap: BootstrapStatus | null;
  user: SessionUser | null;
  loading: boolean;
  loadFailed: boolean;
}

export default function App() {
  const location = useLocation();

  // Keep the Plex popup on a lightweight same-origin page so mobile browsers
  // treat the auth window as a user-opened tab before it navigates to plex.tv.
  if (location.pathname === "/login/plex/loading") {
    return <PlexPopupLoading />;
  }

  if (location.pathname === "/login/plex/done") {
    return <PlexPopupDone />;
  }

  return <MainApp />;
}

function MainApp() {
  const navigate = useNavigate();
  const [state, setState] = useState<AppState>({
    bootstrap: null,
    user: null,
    loading: true,
    loadFailed: false
  });

  // Both endpoints answer 200 for a signed-out user, so a rejection here is a
  // 429, 5xx or network failure — not a logout. Flag it so the startup check
  // shows a retryable error instead of the login screen.
  async function loadState() {
    try {
      const [bootstrap, session] = await Promise.all([
        apiGet<BootstrapStatus>("/api/bootstrap/status"),
        apiGet<{ authenticated: boolean; user: SessionUser | null }>("/api/auth/session")
      ]);

      setState({
        bootstrap,
        user: session.authenticated ? session.user : null,
        loading: false,
        loadFailed: false
      });

      return {
        bootstrap,
        session
      };
    } catch {
      setState((s) => ({ ...s, loading: false, loadFailed: true }));
      return null;
    }
  }

  function retryLoad() {
    setState((s) => ({ ...s, loading: true, loadFailed: false }));
    void loadState();
  }

  useEffect(() => {
    void loadState();
  }, []);

  async function onAuthenticated() {
    const nextState = await loadState();
    if (!nextState) {
      return;
    }

    if (!nextState.bootstrap.onboardingComplete) {
      navigate("/onboarding");
    } else {
      navigate("/dashboard");
    }
  }

  async function onSetupComplete() {
    await loadState();
    navigate("/dashboard");
  }

  async function handleLogout() {
    await apiPost<void>("/api/auth/logout");
    setState((s) => ({ ...s, user: null }));
    navigate("/login");
  }

  const { bootstrap, user, loading, loadFailed } = state;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-on-surface font-headline font-bold">H</span>
          </div>
          <div className="text-on-surface-variant text-sm">Loading Hubarr...</div>
        </div>
      </div>
    );
  }

  if (!bootstrap && loadFailed) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="text-sm text-error">Unable to load Hubarr. Please try again.</div>
        <button
          type="button"
          onClick={retryLoad}
          className="rounded-xl bg-primary-dim px-4 py-2 text-sm font-bold text-on-surface transition-colors hover:bg-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  // Fresh install — go straight to onboarding
  if (bootstrap && !bootstrap.hasOwner) {
    return (
      <Routes>
        <Route
          path="/onboarding"
          element={<Onboarding authenticated={false} onComplete={onSetupComplete} />}
        />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }

  // Not logged in on an already-owned instance — show login
  if (!user) {
    return (
      <Routes>
        <Route
          path="/login"
          element={<Login onAuthenticated={onAuthenticated} />}
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Logged in but onboarding not complete — show onboarding
  if (bootstrap && !bootstrap.onboardingComplete) {
    return (
      <Routes>
        <Route
          path="/onboarding"
          element={<Onboarding authenticated onComplete={onSetupComplete} />}
        />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }

  // Fully authenticated and set up
  return (
    <Routes>
      <Route element={<Layout user={user} onLogout={() => void handleLogout()} />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/watchlists" element={<Watchlists />} />
        <Route path="/users" element={<Users />} />
        <Route path="/history" element={<History />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

function PlexPopupLoading() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <RefreshCw size={28} className="animate-spin text-primary" aria-label="Loading" />
    </div>
  );
}

function PlexPopupDone() {
  useEffect(() => {
    window.close();

    const retryId = window.setTimeout(() => {
      window.close();
    }, 250);

    return () => {
      window.clearTimeout(retryId);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <p className="text-on-surface-variant text-sm">Authentication complete. You can close this tab.</p>
    </div>
  );
}
