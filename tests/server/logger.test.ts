import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../../src/server/logger.js";

test("entries below the configured level don't push kept entries out of the in-memory logs", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hubarr-logger-test-"));
  // A file where the data directory should be stops the logs/ directory from
  // being created, so the logger runs console-only and the in-memory entries
  // are the only record, as when the log file is unavailable.
  const dataDir = path.join(tempDir, "not-a-directory");
  writeFileSync(dataDir, "");

  try {
    const logger = new Logger(dataDir, "warn");
    logger.warn("warn entry");
    logger.error("error entry");
    for (let i = 0; i < 600; i++) {
      logger.debug(`debug entry ${i}`);
      logger.info(`info entry ${i}`);
    }

    assert.deepEqual(
      logger.getRecentLogs(500).map((entry) => entry.message),
      ["warn entry", "error entry"]
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
