import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../../src/server/app.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { LogsPageResponse } from "../../src/shared/types.js";

test("logs fallback honors the configured level and UI filter", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hubarr-logs-endpoint-test-"));
  const config: RuntimeConfig = {
    port: 9301,
    dataDir,
    sessionCookieName: "hubarr_session",
    sessionTtlMs: 1000 * 60 * 60,
    logLevel: "warn"
  };
  const { app, db, logger } = createApp(config);
  const owner = {
    plexId: "owner-id",
    plexToken: "owner-token",
    username: "owner",
    displayName: "Owner",
    email: null,
    avatarUrl: null
  };
  const sessionId = "test-session";
  const signature = createHmac("sha256", db.getSessionSecret()).update(sessionId).digest("hex");
  const server = app.listen(0, "127.0.0.1");

  try {
    db.savePlexOwner(owner);
    db.createSession(sessionId, owner.plexId, new Date(Date.now() + config.sessionTtlMs).toISOString());
    logger.debug("debug entry");
    logger.info("info entry");
    logger.warn("warn entry");
    logger.error("error entry");

    const logFile = path.join(dataDir, "logs", ".machinelogs.json");
    rmSync(logFile, { force: true });
    mkdirSync(logFile);

    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}/api/settings/logs`;
    const headers = { cookie: `${config.sessionCookieName}=${sessionId}.${signature}` };
    const response = await fetch(`${baseUrl}?filter=debug`, {
      headers
    });

    assert.equal(response.status, 200);
    const body = await response.json() as LogsPageResponse;
    assert.deepEqual(body.results.map((entry) => entry.level), ["error", "warn"]);

    const errorOnlyResponse = await fetch(`${baseUrl}?filter=error`, {
      headers
    });

    assert.equal(errorOnlyResponse.status, 200);
    const errorOnlyBody = await errorOnlyResponse.json() as LogsPageResponse;
    assert.deepEqual(errorOnlyBody.results.map((entry) => entry.level), ["error"]);
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
