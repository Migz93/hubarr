import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RuntimeConfig {
  port: number;
  dataDir: string;
  sessionSecret: string;
  sessionCookieName: string;
  sessionTtlMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function resolveSessionSecret(dataDir: string): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(dataDir, ".session_secret");
  const generated = crypto.randomBytes(48).toString("hex");

  try {
    const handle = fs.openSync(secretFile, "wx", 0o600);
    try {
      fs.writeFileSync(handle, generated, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    return generated;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") {
      throw error;
    }
    return fs.readFileSync(secretFile, "utf8").trim();
  }
}

export function loadRuntimeConfig(): RuntimeConfig {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : "/config";

  fs.mkdirSync(dataDir, { recursive: true });

  return {
    port: Number(process.env.PORT || 9301),
    dataDir,
    sessionSecret: resolveSessionSecret(dataDir),
    sessionCookieName: "hubarr_session",
    sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
    logLevel:
      (process.env.LOG_LEVEL as RuntimeConfig["logLevel"] | undefined) || "info",
  };
}
