export function getPlexImageSrc(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }

  return path.startsWith("/")
    ? `/api/plex/image?path=${encodeURIComponent(path)}`
    : path;
}
