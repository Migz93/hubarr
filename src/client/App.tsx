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
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<AppState>({
    bootstrap: null,
    user: null,
    loading: true
  });

  // Keep the Plex popup on a lightweight same-origin page so mobile browsers
  // treat the auth window as a user-opened tab before it navigates to plex.tv.
  if (location.pathname === "/login/plex/loading") {
    return <PlexPopupLoading />;
  }

  if (location.pathname === "/login/plex/done") {
    return <PlexPopupDone />;
  }

  async function loadState() {
    try {
      const [bootstrap, session] = await Promise.all([
        apiGet<BootstrapStatus>("/api/bootstrap/status"),
        apiGet<{ authenticated: boolean; user: SessionUser | null }>("/api/auth/session")
      ]);

      setState({
        bootstrap,
        user: session.authenticated ? session.user : null,
        loading: false
      });

      return {
        bootstrap,
        session
      };
    } catch {
      setState((s) => ({ ...s, loading: false }));
      return null;
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  async function onAuthenticated() {
    const nextState = await loadState();
    if (!nextState) {
      return;
    }

    if (!nextState.bootstrap.setupComplete) {
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

  const { bootstrap, user, loading } = state;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-on-primary font-headline font-bold">H</span>
          </div>
          <div className="text-on-surface-variant text-sm">Loading Hubarr...</div>
        </div>
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

  // Logged in but setup not complete — show onboarding
  if (bootstrap && !bootstrap.setupComplete) {
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
      <RefreshCw size={28} className="animate-spin text-primary" aria-label="Loading" />
    </div>
  );
}
