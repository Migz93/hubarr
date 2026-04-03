import { useState } from "react";
import PlexOAuth from "../lib/plexOAuth";
import { apiPost } from "../lib/api";

interface LoginProps {
  onAuthenticated: () => Promise<void>;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlexLogin() {
    setError(null);
    setBusy(true);
    const oauth = new PlexOAuth();
    oauth.preparePopup();
    try {
      const token = await oauth.login();
      await apiPost("/api/auth/plex", { authToken: token });
      await onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/logo.png" alt="Hubarr" className="w-48 h-48 mb-6" />
          <h1 className="font-headline font-bold text-5xl text-on-surface">Hubarr</h1>
        </div>

        {/* Card */}
        <div className="bg-surface-container rounded-2xl p-6 border border-outline-variant/20">
          <h2 className="font-headline font-semibold text-lg text-on-surface mb-6 text-center">Sign in to continue</h2>

          {error && (
            <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">
              {error}
            </div>
          )}

          <button
            disabled={busy}
            onClick={() => void handlePlexLogin()}
            className="w-full flex items-center justify-center gap-3 bg-primary hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed text-on-primary font-semibold rounded-xl px-4 py-3 transition-colors"
          >
            {busy ? (
              <span>Waiting for Plex...</span>
            ) : (
              <>
                <span>Login with</span>
                <PlexLogo />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlexLogo() {
  return (
    <svg height="20" viewBox="0 0 361 157" aria-label="Plex" xmlns="http://www.w3.org/2000/svg">
      <path fill="#fff" d="M59.3,28.2c-14.3,0-23.5,3.9-31.3,13v-10H.4v123.7s.5.2,1.9.5c1.9.5,12.1,2.5,19.6-3.4,6.5-5.3,8-11.4,8-18.3v-17.8c8,8,17,11.4,29.6,11.4,27.2,0,48-20.8,48-48.4s-20.1-50.7-48.3-50.7h0ZM54,103.8c-15.3,0-27.4-11.9-27.4-26.3s14.3-25.6,27.4-25.6,27.4,11.2,27.4,25.8-12.1,26-27.4,26Z" />
      <path fill="#fff" d="M146.9,75.9c0,10.7,1.2,23.7,12.4,37.9.2.2.7.9.7.9-4.6,7.3-10.2,12.3-17.7,12.3s-11.6-3-16.5-8c-5.1-5.5-7.5-12.6-7.5-20.1V.4h28.4l.2,75.6Z" />
      <polygon fill="#eaaf20" points="286.4 77.8 252.9 31.2 287.3 31.2 320.6 77.8 287.3 124.1 252.9 124.1 286.4 77.8" />
      <polygon fill="#fff" points="329.5 72.5 359.4 31.2 324.9 31.2 312.6 48.3 329.5 72.5" />
      <path fill="#fff" d="M312.6,107.2l5.8,7.5c5.6,8.2,12.9,12.3,21.3,12.3,9-.2,15.3-7.5,17.7-10.3,0,0-4.4-3.7-9.9-9.8-7.5-8.2-17.5-23.3-17.7-24l-17.2,24.2Z" />
      <path fill="#fff" d="M227.4,97.4c-5.8,5-9.7,7.8-17.7,7.8-14.3,0-22.6-9.6-23.8-20.1h75.9c.5-1.4.7-3.2.7-6.2,0-29-22.6-50.7-52.2-50.7s-51.2,22.1-51.2,49.8,23,49.1,51.9,49.1,37.6-10.7,47.1-29.7h-30.8ZM210.7,50.1c12.6,0,22.1,7.8,24.3,18h-48c2.4-10.7,11.4-18,23.8-18h0Z" />
    </svg>
  );
}
