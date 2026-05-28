export function ratingKeyOrderMatches(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

export function buildOrderMismatchMeta(actual: string[], expected: string[]) {
  const mismatchIndex = expected.findIndex((key, i) => actual[i] !== key);
  const firstMismatchIndex = mismatchIndex === -1 && actual.length !== expected.length
    ? Math.min(actual.length, expected.length)
    : mismatchIndex;

  return {
    expectedCount: expected.length,
    actualCount: actual.length,
    firstMismatchIndex,
    expectedSample: expected.slice(0, 8),
    actualSample: actual.slice(0, 8)
  };
}
