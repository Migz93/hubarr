import fs from "node:fs";
import path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface RuntimeConfig {
  port: number;
  dataDir: string;
  sessionCookieName: string;
  sessionTtlMs: number;
  logLevel: LogLevel;
}

export function resolveLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) {
    return "info";
  }

  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }

  console.warn(`Invalid LOG_LEVEL "${value}"; falling back to "info".`);
  return "info";
}

export function loadRuntimeConfig(): RuntimeConfig {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : "/config";

  fs.mkdirSync(dataDir, { recursive: true });

  return {
    port: Number(process.env.PORT || 9301),
    dataDir,
    sessionCookieName: "hubarr_session",
    sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
    logLevel: resolveLogLevel(process.env["LOG_LEVEL"]),
  };
}
