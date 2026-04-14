import { useCallback, useEffect, useRef } from "react";

interface LiveRefreshOptions {
  enabled?: boolean;
  getIntervalMs: () => number | null;
  pauseWhenHidden?: boolean;
}

export function useLiveRefresh(
  load: () => Promise<void>,
  { enabled = true, getIntervalMs, pauseWhenHidden = true }: LiveRefreshOptions
) {
  const mountedRef = useRef(true);
  const loadRef = useRef(load);
  const getIntervalMsRef = useRef(getIntervalMs);
  const enabledRef = useRef(enabled);
  const pauseWhenHiddenRef = useRef(pauseWhenHidden);
  const visibleRef = useRef(typeof document === "undefined" ? true : document.visibilityState === "visible");
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

    if (pauseWhenHiddenRef.current && !visibleRef.current) {
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
    pauseWhenHiddenRef.current = pauseWhenHidden;
    scheduleNextRefresh();
  }, [enabled, getIntervalMs, pauseWhenHidden, scheduleNextRefresh]);

  useEffect(() => {
    runRefreshRef.current = runRefresh;
  }, [runRefresh]);

  useEffect(() => {
    // Hubarr uses polling-first UI refresh because background state changes on
    // the server, but the app does not yet have a push channel for the client.
    mountedRef.current = true;

    function handleVisibilityChange() {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) {
        void runRefreshRef.current();
      } else if (pauseWhenHiddenRef.current) {
        clearScheduledRefresh();
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
