import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubarrDatabase } from "../../src/server/db/index.js";
import type { RuntimeConfig } from "../../src/server/config.js";

export function createTestDatabase(): { db: HubarrDatabase; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hubarr-db-test-"));
  const config: RuntimeConfig = {
    port: 9301,
    dataDir,
    sessionCookieName: "hubarr_session",
    sessionTtlMs: 1000 * 60 * 60,
    logLevel: "error"
  };

  return {
    db: new HubarrDatabase(config),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true })
  };
}
