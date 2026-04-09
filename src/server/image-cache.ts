import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { HubarrDatabase } from "./db/index.js";
import type { Logger } from "./logger.js";
import { buildTrustedPlexImageRequest, sanitizeAvatarUrl } from "./plex-image-utils.js";

const FETCH_TIMEOUT_MS = 15_000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const POSTER_MAX_BYTES = 20 * 1024 * 1024;
const FALLBACK_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface FetchResult {
  data: Buffer;
  maxAgeSeconds: number | null;
}

export type ImageSource =
  | { type: "plex-path"; value: string; serverUrl: string; token: string }
  | { type: "public-url"; value: string };

export class ImageCacheService {
  private readonly cacheDir: string;

  constructor(
    dataDir: string,
    private readonly db: HubarrDatabase,
    private readonly logger: Logger
  ) {
    this.cacheDir = path.join(dataDir, "image-cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Ensure a poster is cached for the given watchlist item.
   * Returns the local web path or null if unavailable.
   *
   * - Fresh hit  → return immediately, no fetch.
   * - Stale hit  → return existing path immediately, refresh async.
   * - Miss       → fetch inline and return path, or null on failure.
   */
  async ensurePosterCached(plexItemId: string, source: ImageSource): Promise<string | null> {
    const cacheKey = `poster:${plexItemId}`;

    this.logger.debug("ImageCache: poster lookup", {
      action: "lookup", kind: "poster", cacheKey, entityId: plexItemId
    });

    const entry = this.db.getImageCacheEntry(cacheKey);

    if (entry?.localWebPath) {
      const fileExists = fs.existsSync(entry.localFilePath ?? "");

      if (!fileExists) {
        this.logger.warn("ImageCache: cached poster file missing, re-fetching", {
          action: "lookup", kind: "poster", cacheKey, filePath: entry.localFilePath
        });
      } else if (this.isFresh(entry.refreshAfter)) {
        this.logger.debug("ImageCache: poster is fresh", {
          action: "lookup", result: "fresh", kind: "poster", cacheKey
        });
        // Update source in case it changed, but don't re-download
        this.updateSourceIfChanged(entry, source);
        return entry.localWebPath;
      } else {
        this.logger.debug("ImageCache: poster is stale, serving existing while refreshing", {
          action: "lookup", result: "stale", kind: "poster", cacheKey
        });
        this.updateSourceIfChanged(entry, source);
        // Fire-and-forget background refresh
        this.refreshPoster(cacheKey, plexItemId, source).catch(() => {
          // Already logged inside refreshPoster
        });
        return entry.localWebPath;
      }
    }

    // No valid cached entry — fetch inline
    this.logger.debug("ImageCache: poster cache miss, fetching inline", {
      action: "cache", result: "miss", kind: "poster", cacheKey
    });
    return this.fetchAndCachePoster(cacheKey, plexItemId, source);
  }

  /**
   * Ensure an avatar is cached for the given Plex user.
   * Returns the local web path or null if unavailable.
   */
  async ensureAvatarCached(plexUserId: string, avatarUrl: string): Promise<string | null> {
    const cacheKey = `avatar:${plexUserId}`;

    this.logger.debug("ImageCache: avatar lookup", {
      action: "lookup", kind: "avatar", cacheKey, entityId: plexUserId
    });

    const source: ImageSource = { type: "public-url", value: avatarUrl };
    const entry = this.db.getImageCacheEntry(cacheKey);

    if (entry?.localWebPath) {
      const fileExists = fs.existsSync(entry.localFilePath ?? "");

      if (!fileExists) {
        this.logger.warn("ImageCache: cached avatar file missing, re-fetching", {
          action: "lookup", kind: "avatar", cacheKey, filePath: entry.localFilePath
        });
      } else if (this.isFresh(entry.refreshAfter)) {
        this.logger.debug("ImageCache: avatar is fresh", {
          action: "lookup", result: "fresh", kind: "avatar", cacheKey
        });
        this.updateSourceIfChanged(entry, source);
        return entry.localWebPath;
      } else {
        this.logger.debug("ImageCache: avatar is stale, serving existing while refreshing", {
          action: "lookup", result: "stale", kind: "avatar", cacheKey
        });
        this.updateSourceIfChanged(entry, source);
        this.refreshAvatar(cacheKey, plexUserId, avatarUrl).catch(() => {
          // Already logged inside refreshAvatar
        });
        return entry.localWebPath;
      }
    }

    // No valid cached entry — fetch inline
    this.logger.debug("ImageCache: avatar cache miss, fetching inline", {
      action: "cache", result: "miss", kind: "avatar", cacheKey
    });
    return this.fetchAndCacheAvatar(cacheKey, plexUserId, avatarUrl);
  }

  /**
   * Delete files in the cache directory that are not referenced by any
   * image_cache metadata row. Returns the number of files removed.
   */
  pruneOrphaned(): number {
    const referencedPaths = new Set(this.db.listAllImageCacheWebPaths());
    let removed = 0;

    try {
      for (const file of fs.readdirSync(this.cacheDir)) {
        const webPath = `/images/${file}`;
        if (!referencedPaths.has(webPath)) {
          try {
            fs.unlinkSync(path.join(this.cacheDir, file));
            removed++;
            this.logger.info("ImageCache: pruned orphaned file", {
              action: "prune", result: "removed", filePath: webPath
            });
          } catch (err) {
            this.logger.warn("ImageCache: failed to prune file", {
              action: "prune", filePath: webPath,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        } else {
          this.logger.debug("ImageCache: prune skipped — file still referenced", {
            action: "prune", result: "kept", filePath: webPath
          });
        }
      }
    } catch (err) {
      this.logger.error("ImageCache: prune scan failed", {
        action: "prune",
        error: err instanceof Error ? err.message : String(err)
      });
    }

    if (removed > 0) {
      this.logger.info("ImageCache: prune complete", { action: "prune", removed });
    }

    return removed;
  }

  /**
   * Delete all files and clear all image_cache metadata rows.
   * Returns the number of files removed.
   */
  clearAll(): number {
    let removed = 0;
    try {
      for (const file of fs.readdirSync(this.cacheDir)) {
        try {
          fs.unlinkSync(path.join(this.cacheDir, file));
          removed++;
        } catch (err) {
          this.logger.warn("ImageCache: failed to delete file during clear", {
            action: "clear",
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      this.db.clearImageCacheTable();
      this.logger.info("ImageCache: clear image cache completed", { action: "clear", removed });
    } catch (err) {
      this.logger.error("ImageCache: clear failed", {
        action: "clear",
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Inline fetch helpers
  // ---------------------------------------------------------------------------

  private async fetchAndCachePoster(
    cacheKey: string,
    plexItemId: string,
    source: ImageSource
  ): Promise<string | null> {
    const filename = `${crypto.randomUUID()}.jpg`;
    const filePath = path.join(this.cacheDir, filename);
    const webPath = `/images/${filename}`;

    try {
      const result = await this.fetchImageBuffer(source);
      if (!result) return null;

      const resized = await sharp(result.data)
        .resize(1000, 1000, { fit: "inside", withoutEnlargement: false })
        .jpeg({ quality: 100 })
        .toBuffer();

      await this.atomicWrite(filePath, resized);

      const now = new Date().toISOString();
      const { refreshAfter, freshnessSource, maxAgeSeconds } = this.computeRefreshAfter(result.maxAgeSeconds);
      this.db.upsertImageCacheEntry({
        cacheKey,
        kind: "poster",
        entityId: plexItemId,
        sourceType: source.type,
        sourceValue: source.value,
        localFilePath: filePath,
        localWebPath: webPath,
        cachedAt: now,
        lastRefreshAt: now,
        refreshAfter
      });

      this.logger.info("ImageCache: new poster cached", {
        action: "cache", result: "cached", kind: "poster", cacheKey,
        entityId: plexItemId, sourceType: source.type, filePath: webPath,
        freshnessSource, maxAgeSeconds, staleAfter: refreshAfter
      });
      return webPath;
    } catch (err) {
      this.logger.warn("ImageCache: failed to cache poster", {
        action: "cache", result: "failed", kind: "poster", cacheKey,
        entityId: plexItemId, sourceType: source.type, sourceValue: source.value,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  private async fetchAndCacheAvatar(
    cacheKey: string,
    plexUserId: string,
    avatarUrl: string
  ): Promise<string | null> {
    const filename = `${crypto.randomUUID()}.jpg`;
    const filePath = path.join(this.cacheDir, filename);
    const webPath = `/images/${filename}`;

    try {
      const result = await this.fetchAvatarBuffer(avatarUrl);
      if (!result) return null;

      const resized = await sharp(result.data)
        .resize(256, 256, { fit: "cover", position: "center" })
        .jpeg({ quality: 100 })
        .toBuffer();

      await this.atomicWrite(filePath, resized);

      const now = new Date().toISOString();
      const { refreshAfter, freshnessSource, maxAgeSeconds } = this.computeRefreshAfter(result.maxAgeSeconds);
      this.db.upsertImageCacheEntry({
        cacheKey,
        kind: "avatar",
        entityId: plexUserId,
        sourceType: "public-url",
        sourceValue: avatarUrl,
        localFilePath: filePath,
        localWebPath: webPath,
        cachedAt: now,
        lastRefreshAt: now,
        refreshAfter
      });

      this.logger.info("ImageCache: new avatar cached", {
        action: "cache", result: "cached", kind: "avatar", cacheKey,
        entityId: plexUserId, filePath: webPath,
        freshnessSource, maxAgeSeconds, staleAfter: refreshAfter
      });
      return webPath;
    } catch (err) {
      this.logger.warn("ImageCache: failed to cache avatar", {
        action: "cache", result: "failed", kind: "avatar", cacheKey,
        entityId: plexUserId, sourceValue: avatarUrl,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Stale-while-refresh
  // ---------------------------------------------------------------------------

  private async refreshPoster(
    cacheKey: string,
    plexItemId: string,
    source: ImageSource
  ): Promise<void> {
    const attemptedAt = new Date().toISOString();
    this.db.markImageCacheRefreshAttempt(cacheKey, attemptedAt);

    const entry = this.db.getImageCacheEntry(cacheKey);
    if (!entry) return;

    const filename = `${crypto.randomUUID()}.jpg`;
    const newFilePath = path.join(this.cacheDir, filename);
    const newWebPath = `/images/${filename}`;

    try {
      const result = await this.fetchImageBuffer(source);
      if (!result) throw new Error("Empty response from upstream");

      const resized = await sharp(result.data)
        .resize(1000, 1000, { fit: "inside", withoutEnlargement: false })
        .jpeg({ quality: 100 })
        .toBuffer();

      await this.atomicWrite(newFilePath, resized);

      // Delete old file only after successful write
      if (entry.localFilePath && entry.localFilePath !== newFilePath) {
        try { fs.unlinkSync(entry.localFilePath); } catch { /* best-effort */ }
      }

      const now = new Date().toISOString();
      const { refreshAfter, freshnessSource, maxAgeSeconds } = this.computeRefreshAfter(result.maxAgeSeconds);
      this.db.markImageCacheRefreshSuccess(cacheKey, {
        localFilePath: newFilePath,
        localWebPath: newWebPath,
        sourceType: source.type,
        sourceValue: source.value,
        lastRefreshAt: now,
        refreshAfter
      });

      this.logger.info("ImageCache: stale poster refreshed", {
        action: "refresh", result: "refreshed", kind: "poster", cacheKey,
        entityId: plexItemId, filePath: newWebPath,
        freshnessSource, maxAgeSeconds, staleAfter: refreshAfter
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.db.markImageCacheRefreshFailure(cacheKey, { attemptedAt, error });
      this.logger.warn("ImageCache: poster refresh failed, keeping existing image", {
        action: "refresh", result: "failed", kind: "poster", cacheKey,
        entityId: plexItemId, error
      });
      // Clean up the temp file if it was written before the error
      try { fs.unlinkSync(newFilePath); } catch { /* doesn't exist */ }
    }
  }

  private async refreshAvatar(
    cacheKey: string,
    plexUserId: string,
    avatarUrl: string
  ): Promise<void> {
    const attemptedAt = new Date().toISOString();
    this.db.markImageCacheRefreshAttempt(cacheKey, attemptedAt);

    const entry = this.db.getImageCacheEntry(cacheKey);
    if (!entry) return;

    const filename = `${crypto.randomUUID()}.jpg`;
    const newFilePath = path.join(this.cacheDir, filename);
    const newWebPath = `/images/${filename}`;

    try {
      const result = await this.fetchAvatarBuffer(avatarUrl);
      if (!result) throw new Error("Empty response from upstream");

      const resized = await sharp(result.data)
        .resize(256, 256, { fit: "cover", position: "center" })
        .jpeg({ quality: 100 })
        .toBuffer();

      await this.atomicWrite(newFilePath, resized);

      if (entry.localFilePath && entry.localFilePath !== newFilePath) {
        try { fs.unlinkSync(entry.localFilePath); } catch { /* best-effort */ }
      }

      const now = new Date().toISOString();
      const { refreshAfter, freshnessSource, maxAgeSeconds } = this.computeRefreshAfter(result.maxAgeSeconds);
      this.db.markImageCacheRefreshSuccess(cacheKey, {
        localFilePath: newFilePath,
        localWebPath: newWebPath,
        sourceType: "public-url",
        sourceValue: avatarUrl,
        lastRefreshAt: now,
        refreshAfter
      });

      this.logger.info("ImageCache: stale avatar refreshed", {
        action: "refresh", result: "refreshed", kind: "avatar", cacheKey,
        entityId: plexUserId, filePath: newWebPath,
        freshnessSource, maxAgeSeconds, staleAfter: refreshAfter
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.db.markImageCacheRefreshFailure(cacheKey, { attemptedAt, error });
      this.logger.warn("ImageCache: avatar refresh failed, keeping existing image", {
        action: "refresh", result: "failed", kind: "avatar", cacheKey,
        entityId: plexUserId, error
      });
      try { fs.unlinkSync(newFilePath); } catch { /* doesn't exist */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch helpers
  // ---------------------------------------------------------------------------

  private async fetchImageBuffer(source: ImageSource): Promise<FetchResult | null> {
    if (source.type === "plex-path") {
      return this.fetchPlexPathBuffer(source.value, source.serverUrl, source.token);
    }
    return this.fetchPublicUrlBuffer(source.value);
  }

  private async fetchPlexPathBuffer(
    thumbPath: string,
    serverUrl: string,
    token: string
  ): Promise<FetchResult | null> {
    let imageUrl: string;
    try {
      imageUrl = buildTrustedPlexImageRequest(serverUrl, thumbPath);
    } catch (err) {
      this.logger.warn("ImageCache: invalid Plex image path", {
        action: "lookup", sourceType: "plex-path", sourceValue: thumbPath,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }

    // Plex is a user-configured trusted source — follow its redirects natively.
    // Per-hop SSRF validation is reserved for untrusted external URLs.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const upstream = await fetch(imageUrl, {
        headers: { "X-Plex-Token": token },
        signal: controller.signal
      });
      if (!upstream.ok) {
        this.logger.warn("ImageCache: Plex fetch failed", {
          sourceValue: thumbPath, status: upstream.status
        });
        return null;
      }
      const maxAgeSeconds = this.parseCacheControlMaxAge(upstream.headers.get("cache-control"));
      const data = await this.streamBodyWithCap(upstream, POSTER_MAX_BYTES, thumbPath);
      if (!data) return null;
      return { data, maxAgeSeconds };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchPublicUrlBuffer(imageUrl: string): Promise<FetchResult | null> {
    const safe = sanitizeAvatarUrl(imageUrl);
    if (!safe) {
      this.logger.warn("ImageCache: invalid or unsafe public URL", {
        action: "lookup", sourceType: "public-url", sourceValue: imageUrl
      });
      return null;
    }

    const upstream = await this.fetchFollowingRedirects(safe);
    if (!upstream) return null; // redirect issue already logged
    if (!upstream.ok) {
      this.logger.warn("ImageCache: public URL fetch failed", {
        sourceValue: imageUrl, status: upstream.status
      });
      return null;
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      this.logger.warn("ImageCache: poster response is not an image", {
        action: "lookup", sourceType: "public-url", sourceValue: imageUrl, contentType
      });
      return null;
    }
    const maxAgeSeconds = this.parseCacheControlMaxAge(upstream.headers.get("cache-control"));
    const data = await this.streamBodyWithCap(upstream, POSTER_MAX_BYTES, imageUrl);
    if (!data) return null;
    return { data, maxAgeSeconds };
  }

  private async fetchAvatarBuffer(avatarUrl: string): Promise<FetchResult | null> {
    const safe = sanitizeAvatarUrl(avatarUrl);
    if (!safe) {
      this.logger.warn("ImageCache: invalid avatar URL", {
        action: "lookup", sourceType: "public-url", sourceValue: avatarUrl
      });
      return null;
    }

    const upstream = await this.fetchFollowingRedirects(safe);
    if (!upstream) return null; // redirect issue already logged
    if (!upstream.ok) {
      this.logger.warn("ImageCache: avatar fetch failed", {
        sourceValue: avatarUrl, status: upstream.status
      });
      return null;
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      this.logger.warn("ImageCache: avatar response is not an image", {
        sourceValue: avatarUrl, contentType
      });
      return null;
    }
    const maxAgeSeconds = this.parseCacheControlMaxAge(upstream.headers.get("cache-control"));
    const data = await this.streamBodyWithCap(upstream, AVATAR_MAX_BYTES, avatarUrl);
    if (!data) return null;
    return { data: data, maxAgeSeconds };
  }

  /**
   * Fetch a URL following redirects manually, re-validating each Location
   * header through sanitizeAvatarUrl to prevent SSRF via redirect hops.
   * Returns the final non-redirect Response, or null if a hop fails validation
   * or the redirect limit is exceeded.
   */
  private async fetchFollowingRedirects(
    initialUrl: string,
    headers?: Record<string, string>
  ): Promise<Response | null> {
    const MAX_REDIRECTS = 5;
    let url = initialUrl;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          ...(headers ? { headers } : {})
        });

        if (response.status < 300 || response.status >= 400) {
          return response;
        }

        if (hop === MAX_REDIRECTS) {
          this.logger.warn("ImageCache: too many redirects", { url: initialUrl });
          return null;
        }

        const location = response.headers.get("location");
        if (!location) {
          this.logger.warn("ImageCache: redirect with no Location header", { url });
          return null;
        }

        const next = sanitizeAvatarUrl(location, url);
        if (!next) {
          this.logger.warn("ImageCache: redirect to disallowed URL blocked", {
            action: "lookup", from: url, location
          });
          return null;
        }

        url = next;
      }
    } finally {
      clearTimeout(timeout);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private async streamBodyWithCap(
    response: Response,
    maxBytes: number,
    sourceValue: string
  ): Promise<Buffer | null> {
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      this.logger.warn("ImageCache: response too large", { sourceValue, contentLength, maxBytes });
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        this.logger.warn("ImageCache: response exceeded byte cap mid-stream", { sourceValue, maxBytes });
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  private async atomicWrite(filePath: string, data: Buffer): Promise<void> {
    // Temp file must be in the same directory as the destination so that
    // rename() is always within the same filesystem (avoids EXDEV errors).
    const tmpPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  private isFresh(refreshAfter: string | null): boolean {
    if (!refreshAfter) return false;
    return Date.now() < new Date(refreshAfter).getTime();
  }

  private parseCacheControlMaxAge(header: string | null): number | null {
    if (!header) return null;
    const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header);
    if (!match) return null;
    const seconds = parseInt(match[1], 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  private computeRefreshAfter(maxAgeSeconds: number | null): {
    refreshAfter: string;
    freshnessSource: "upstream-cache-control" | "fallback-30d";
    maxAgeSeconds: number;
  } {
    if (maxAgeSeconds != null) {
      this.logger.debug("ImageCache: using upstream Cache-Control for freshness", {
        action: "lookup", freshnessSource: "upstream-cache-control", maxAgeSeconds
      });
      return {
        refreshAfter: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
        freshnessSource: "upstream-cache-control",
        maxAgeSeconds
      };
    }
    const fallbackSeconds = FALLBACK_FRESHNESS_MS / 1000;
    this.logger.debug("ImageCache: no upstream Cache-Control, using 30-day fallback", {
      action: "lookup", freshnessSource: "fallback-30d", maxAgeSeconds: fallbackSeconds
    });
    return {
      refreshAfter: new Date(Date.now() + FALLBACK_FRESHNESS_MS).toISOString(),
      freshnessSource: "fallback-30d",
      maxAgeSeconds: fallbackSeconds
    };
  }

  private updateSourceIfChanged(
    entry: { cacheKey: string; sourceType: string | null; sourceValue: string | null },
    source: ImageSource
  ): void {
    if (entry.sourceType !== source.type || entry.sourceValue !== source.value) {
      // The source URL changed (e.g. CDN path rotated). Update metadata so
      // the next refresh uses the current source. Non-blocking best-effort.
      const existing = this.db.getImageCacheEntry(entry.cacheKey);
      if (existing?.localFilePath && existing.localWebPath) {
        this.db.markImageCacheRefreshSuccess(entry.cacheKey, {
          localFilePath: existing.localFilePath,
          localWebPath: existing.localWebPath,
          sourceType: source.type,
          sourceValue: source.value,
          lastRefreshAt: existing.lastRefreshAt ?? new Date().toISOString(),
          refreshAfter: existing.refreshAfter ?? this.computeRefreshAfter(null).refreshAfter
        });
      }
    }
  }
}
