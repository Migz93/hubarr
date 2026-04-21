import { useEffect, useState } from "react";
import { apiGet } from "./api";
import type { SettingsResponse } from "../../shared/types";

export function useSettings() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGet<SettingsResponse>("/api/settings")
      .then((result) => {
        if (!cancelled) {
          setSettings(result);
          setError(null);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch settings", { error: err, endpoint: "/api/settings" });
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load settings.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, loading, error };
}
