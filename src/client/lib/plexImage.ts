export function getPlexImageSrc(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }

  if (path.startsWith("/")) {
    return `/api/plex/image?path=${encodeURIComponent(path)}`;
  }
  return `/api/avatar?url=${encodeURIComponent(path)}`;
}
