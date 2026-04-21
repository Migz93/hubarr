import { useEffect, useState } from "react";
import { apiGet } from "./api";
import type { SettingsResponse } from "../../shared/types";

export function useSettings() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    apiGet<SettingsResponse>("/api/settings")
      .then((result) => {
        if (!cancelled) {
          setSettings(result);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, loading };
}
