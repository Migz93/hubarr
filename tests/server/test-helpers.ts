import type { Logger } from "../../src/server/logger.js";

export type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; meta?: unknown };

export function createCapturingLogger() {
  const entries: LogEntry[] = [];
  const logger = {
    debug: (message: string, meta?: unknown) => entries.push({ level: "debug", message, meta }),
    info: (message: string, meta?: unknown) => entries.push({ level: "info", message, meta }),
    warn: (message: string, meta?: unknown) => entries.push({ level: "warn", message, meta }),
    error: (message: string, meta?: unknown) => entries.push({ level: "error", message, meta }),
    getRecentLogs: () => entries
  } as unknown as Logger;

  return { logger, entries };
}
