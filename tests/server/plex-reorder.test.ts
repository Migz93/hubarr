import assert from "node:assert/strict";
import test from "node:test";
import { PlexIntegration } from "../../src/server/integrations/plex.js";
import type { Logger } from "../../src/server/logger.js";

type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; meta?: unknown };

function createCapturingLogger() {
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

function moveItem(order: string[], itemKey: string, afterKey: string | null): string[] {
  const withoutItem = order.filter((key) => key !== itemKey);
  if (afterKey === null) {
    return [itemKey, ...withoutItem];
  }

  const afterIndex = withoutItem.indexOf(afterKey);
  if (afterIndex === -1) {
    throw new Error(`afterKey not found in test order: ${afterKey} for item ${itemKey}`);
  }

  return [
    ...withoutItem.slice(0, afterIndex + 1),
    itemKey,
    ...withoutItem.slice(afterIndex + 1)
  ];
}

test("reorderCollectionItems retries progressively until Plex reports the desired order", async () => {
  const { logger, entries } = createCapturingLogger();
  const plex = new PlexIntegration({
    serverUrl: "http://plex.example",
    token: "token",
    machineIdentifier: "machine",
    movieLibraryId: "1",
    showLibraryId: "2"
  }, logger);

  let order = ["a", "c", "b"];
  let moveCalls = 0;

  plex.getCollectionItems = async () => [...order];
  (plex as unknown as { requestServer: (path: string, options?: unknown) => Promise<unknown> }).requestServer = async (path: string) => {
    moveCalls += 1;
    const match = path.match(/\/items\/([^/]+)\/move(?:\?after=(.+))?$/);
    assert.ok(match);

    const itemKey = decodeURIComponent(match[1]);
    const afterKey = match[2] ? decodeURIComponent(match[2]) : null;
    if (moveCalls > 1) {
      order = moveItem(order, itemKey, afterKey);
    }
    return {};
  };

  const result = await plex.reorderCollectionItems("collection-1", ["a", "b", "c"]);

  assert.equal(result.staleKeys.size, 0);
  assert.equal(result.converged, true);
  assert.deepEqual(result.finalOrder, ["a", "b", "c"]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(moveCalls, 2);
  assert.ok(entries.some((entry) => entry.message === "Collection order still mismatched after item move"));
});

test("reorderCollectionItems moves only the first misplaced item when that converges the order", async () => {
  const { logger } = createCapturingLogger();
  const plex = new PlexIntegration({
    serverUrl: "http://plex.example",
    token: "token",
    machineIdentifier: "machine",
    movieLibraryId: "1",
    showLibraryId: "2"
  }, logger);

  let order = ["a", "c", "b"];
  const moved: Array<{ itemKey: string; afterKey: string | null }> = [];

  plex.getCollectionItems = async () => [...order];
  (plex as unknown as { requestServer: (path: string, options?: unknown) => Promise<unknown> }).requestServer = async (path: string) => {
    const match = path.match(/\/items\/([^/]+)\/move(?:\?after=(.+))?$/);
    assert.ok(match);

    const itemKey = decodeURIComponent(match[1]);
    const afterKey = match[2] ? decodeURIComponent(match[2]) : null;
    moved.push({ itemKey, afterKey });
    order = moveItem(order, itemKey, afterKey);
    return {};
  };

  const result = await plex.reorderCollectionItems("collection-1", ["a", "b", "c"]);

  assert.equal(result.staleKeys.size, 0);
  assert.equal(result.converged, true);
  assert.deepEqual(result.finalOrder, ["a", "b", "c"]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(moved, [{ itemKey: "b", afterKey: "a" }]);
});
