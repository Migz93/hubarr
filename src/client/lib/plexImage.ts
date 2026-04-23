export function getPlexImageSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  // Only serve locally cached images. Non-cached paths return null so the
  // caller can show its own placeholder UI until the next sync populates the cache.
  if (path.startsWith("/images/")) return path;
  return null;
}
