// Shared Plex image URL validation utilities used by both the image cache
// service and (previously) the image proxy endpoints in app.ts.

export const PLEX_LIBRARY_IMAGE_PATH = /^\/library\/metadata\/([A-Za-z0-9:-]+)\/(thumb|art|clearLogo|squareArt|theme)(?:\/(\d+))?$/;
export const PLEX_RESOURCE_IMAGE_PATH = /^\/:\/resources\/([A-Za-z0-9._-]+)$/;
export const ALLOWED_PLEX_IMAGE_QUERY_PARAMS = new Set(["width", "height", "minSize", "upscale", "format"]);

// Matches private/loopback addresses in both bare and bracket-wrapped forms.
// Node's WHATWG URL parser returns IPv6 hostnames with brackets, e.g. [::1].
// Covers: IPv4 private ranges, IPv4 link-local, IPv6 loopback, IPv4-mapped IPv6
// (::ffff:... normalized by URL parser to [::ffff:7f00:1] etc.), IPv6 ULA
// (fc00::/7 = fc and fd prefixes), IPv6 link-local (fe80::/10).
export const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|\[::1\]|::ffff:|\[::ffff:|f[cd][0-9a-f]{2}:|\[f[cd][0-9a-f]{2}|fe80:|\[fe80:|localhost)/i;

// Validates and sanitizes an avatar URL (or a redirect location resolved against
// a base URL). Returns url.href reconstructed from the parsed URL object —
// never the raw input string — so that static analysis sees a clean value
// rather than a tainted user-supplied string flowing into fetch().
export function sanitizeAvatarUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    PRIVATE_IP_RE.test(url.hostname)
  ) {
    return null;
  }
  return url.href;
}

export function sanitizePlexImageQuery(search: string) {
  const parsed = new URLSearchParams(search);
  const sanitized = new URLSearchParams();

  for (const [key, value] of parsed) {
    if (key.toLowerCase() === "x-plex-token") {
      continue;
    }
    if (!ALLOWED_PLEX_IMAGE_QUERY_PARAMS.has(key)) {
      throw new Error(`Unsupported Plex image query parameter: ${key}`);
    }
    if (key === "format") {
      if (!/^[a-z0-9-]+$/i.test(value)) {
        throw new Error("Invalid Plex image format parameter.");
      }
      sanitized.set(key, value.toLowerCase());
      continue;
    }
    if (!/^\d{1,4}$/.test(value)) {
      throw new Error(`Invalid Plex image query parameter value for ${key}.`);
    }
    sanitized.set(key, value);
  }

  return sanitized;
}

export function buildTrustedPlexImageRequest(serverUrl: string, rawPath: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Absolute Plex image URLs are not allowed.");
  }

  const [pathname, search = ""] = rawPath.split("?", 2);
  if (!pathname.startsWith("/")) {
    throw new Error("Plex image path must start with '/'.");
  }

  const serverOrigin = new URL(serverUrl).origin;
  const upstream = new URL(serverOrigin);
  const libraryMatch = pathname.match(PLEX_LIBRARY_IMAGE_PATH);
  const resourceMatch = pathname.match(PLEX_RESOURCE_IMAGE_PATH);

  if (libraryMatch) {
    const [, ratingKey, assetKind, version] = libraryMatch;
    upstream.pathname = version
      ? `/library/metadata/${ratingKey}/${assetKind}/${version}`
      : `/library/metadata/${ratingKey}/${assetKind}`;
  } else if (resourceMatch) {
    upstream.pathname = `/:/resources/${resourceMatch[1]}`;
  } else {
    throw new Error("Unsupported Plex image path.");
  }

  upstream.search = sanitizePlexImageQuery(search).toString();
  return upstream.toString();
}
