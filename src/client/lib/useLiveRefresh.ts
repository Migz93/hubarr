import { useCallback, useEffect, useRef } from "react";

interface LiveRefreshOptions {
  enabled?: boolean;
  getIntervalMs: () => number | null;
}

export function useLiveRefresh(
  load: () => Promise<void>,
  { enabled = true, getIntervalMs }: LiveRefreshOptions
) {
  const mountedRef = useRef(true);
  const loadRef = useRef(load);
  const getIntervalMsRef = useRef(getIntervalMs);
  const enabledRef = useRef(enabled);
  const inFlightRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRefreshRef = useRef<() => Promise<void>>(async () => {});

  const clearScheduledRefresh = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const scheduleNextRefresh = useCallback(() => {
    clearScheduledRefresh();
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }

    const intervalMs = getIntervalMsRef.current();
    if (intervalMs === null || intervalMs <= 0) {
      return;
    }

    timeoutRef.current = setTimeout(() => {
      void runRefreshRef.current();
    }, intervalMs);
  }, [clearScheduledRefresh]);

  const runRefresh = useCallback(async () => {
    clearScheduledRefresh();
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    try {
      await loadRef.current();
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        scheduleNextRefresh();
      }
    }
  }, [clearScheduledRefresh]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    getIntervalMsRef.current = getIntervalMs;
    enabledRef.current = enabled;
    scheduleNextRefresh();
  }, [enabled, getIntervalMs, scheduleNextRefresh]);

  useEffect(() => {
    runRefreshRef.current = runRefresh;
  }, [runRefresh]);

  useEffect(() => {
    // Hubarr uses polling-first UI refresh because background state changes on
    // the server, but the app does not yet have a push channel for the client.
    mountedRef.current = true;

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void runRefreshRef.current();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearScheduledRefresh();
    };
  }, [clearScheduledRefresh, scheduleNextRefresh]);

  return {
    refreshNow: runRefresh
  };
}
