import assert from "node:assert/strict";
import test from "node:test";
import { resolveLogLevel } from "../../src/server/config.js";

test("resolveLogLevel accepts supported levels and defaults when unset", () => {
  assert.equal(resolveLogLevel(undefined), "info");

  for (const level of ["debug", "info", "warn", "error"]) {
    assert.equal(resolveLogLevel(level), level);
  }
});

test("resolveLogLevel falls back to info for an invalid value", () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);

  try {
    assert.equal(resolveLogLevel("warning"), "info");
    assert.deepEqual(warnings, ['Invalid LOG_LEVEL "warning"; falling back to "info".']);
  } finally {
    console.warn = originalWarn;
  }
});
