import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Logger } from "./logger.js";
import { buildTrustedPlexImageRequest, sanitizeAvatarUrl } from "./plex-image-utils.js";

const FETCH_TIMEOUT_MS = 15_000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class ImageCacheService {
  private readonly cacheDir: string;

  constructor(dataDir: string, private readonly logger: Logger) {
    this.cacheDir = path.join(dataDir, "image-cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Download, resize, and cache a Plex library poster image.
   * Returns the web-accessible path ("/images/<hash>.jpg") or null on failure.
   * Skips re-download if a fresh cached file already exists.
   */
  async cachePosterImage(thumbPath: string, serverUrl: string, token: string): Promise<string | null> {
    const key = this.cacheKey(thumbPath);
    const filePath = this.cacheFilePath(key);

    if (this.isFresh(filePath)) {
      return `/images/${key}.jpg`;
    }

    try {
      const imageUrl = buildTrustedPlexImageRequest(serverUrl, thumbPath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await fetch(imageUrl, {
          headers: { "X-Plex-Token": token },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        this.logger.warn("ImageCache: upstream fetch failed for poster", {
          thumbPath,
          status: upstream.status
        });
        return null;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      const resized = await sharp(buf)
        .resize(300, 450, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      fs.writeFileSync(filePath, resized);
      return `/images/${key}.jpg`;
    } catch (err) {
      this.logger.warn("ImageCache: failed to cache poster", {
        thumbPath,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Download, resize, and cache a poster image from an absolute public URL
   * (e.g. metadata-static.plex.tv or image.tmdb.org CDN URLs).
   * Returns the web-accessible path ("/images/<hash>.jpg") or null on failure.
   * Skips re-download if a fresh cached file already exists.
   */
  async cachePosterImageFromUrl(imageUrl: string): Promise<string | null> {
    const safe = sanitizeAvatarUrl(imageUrl);
    if (!safe) {
      this.logger.warn("ImageCache: invalid poster URL, skipping", { imageUrl });
      return null;
    }

    const key = this.cacheKey(imageUrl);
    const filePath = this.cacheFilePath(key);

    if (this.isFresh(filePath)) {
      return `/images/${key}.jpg`;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await fetch(safe, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        this.logger.warn("ImageCache: upstream fetch failed for poster URL", {
          imageUrl,
          status: upstream.status
        });
        return null;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      const resized = await sharp(buf)
        .resize(300, 450, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      fs.writeFileSync(filePath, resized);
      return `/images/${key}.jpg`;
    } catch (err) {
      this.logger.warn("ImageCache: failed to cache poster from URL", {
        imageUrl,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Download and cache a user avatar image (no resizing — avatars are small).
   * Returns the web-accessible path ("/images/<hash>.jpg") or null on failure.
   * Skips re-download if a fresh cached file already exists.
   */
  async cacheAvatarImage(avatarUrl: string): Promise<string | null> {
    const safe = sanitizeAvatarUrl(avatarUrl);
    if (!safe) {
      this.logger.warn("ImageCache: invalid avatar URL, skipping", { avatarUrl });
      return null;
    }

    const key = this.cacheKey(avatarUrl);
    const filePath = this.cacheFilePath(key);

    if (this.isFresh(filePath)) {
      return `/images/${key}.jpg`;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await fetch(safe, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        this.logger.warn("ImageCache: upstream fetch failed for avatar", {
          avatarUrl,
          status: upstream.status
        });
        return null;
      }

      const contentType = upstream.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        this.logger.warn("ImageCache: avatar response is not an image", { avatarUrl, contentType });
        return null;
      }

      const contentLength = Number(upstream.headers.get("content-length") ?? 0);
      if (contentLength > AVATAR_MAX_BYTES) {
        this.logger.warn("ImageCache: avatar too large", { avatarUrl, contentLength });
        return null;
      }

      // Read with hard byte cap regardless of Content-Length
      const reader = upstream.body?.getReader();
      if (!reader) return null;

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > AVATAR_MAX_BYTES) {
          await reader.cancel();
          this.logger.warn("ImageCache: avatar exceeded byte cap mid-stream", { avatarUrl });
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      const buf = Buffer.concat(chunks);

      // Convert to JPEG for a consistent extension regardless of source format
      const jpeg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
      fs.writeFileSync(filePath, jpeg);
      return `/images/${key}.jpg`;
    } catch (err) {
      this.logger.warn("ImageCache: failed to cache avatar", {
        avatarUrl,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Delete all files in the cache directory.
   * Returns the number of files removed.
   */
  clearCache(): number {
    let removed = 0;
    try {
      for (const file of fs.readdirSync(this.cacheDir)) {
        fs.unlinkSync(path.join(this.cacheDir, file));
        removed++;
      }
    } catch (err) {
      this.logger.warn("ImageCache: error during clearCache", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return removed;
  }

  private isFresh(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      return Date.now() - stat.mtimeMs < MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private cacheKey(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  private cacheFilePath(key: string): string {
    return path.join(this.cacheDir, `${key}.jpg`);
  }
}
