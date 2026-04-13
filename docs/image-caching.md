# Image Caching

This document describes the image caching system in Hubarr — how posters and
avatars are fetched, stored, served, and refreshed.

## Overview

Hubarr caches all images locally at sync time. The browser never talks to Plex
or any external CDN for images. Every poster and avatar served to the UI comes
from a file on disk under `/config/image-cache/`, served through the
authenticated `/images/` static route.

The system has three operating modes for any given image:

| Situation | Behaviour |
|---|---|
| No cached entry exists | Fetch from upstream inline, write to disk, record metadata |
| Cached entry exists, file is fresh | Return local path immediately, do nothing |
| Cached entry exists, file is stale | Return existing local path immediately, start a background refresh |

A failed background refresh never removes the existing file. The stale image
stays visible until a future refresh succeeds.

### Freshness policy

When an image is fetched or refreshed, the freshness window is derived from the
upstream HTTP response:

- If the response includes a `Cache-Control: max-age=<seconds>` directive, that
  value is used as the freshness duration.
- If the response has no usable `Cache-Control` max-age (header absent,
  malformed, or `max-age=0`), the freshness window falls back to **30 days**.

This applies identically to both posters and avatars.

The chosen freshness source and resulting stale-after timestamp are recorded in
the `image_cache` metadata row and logged at `info` level on every
cache/refresh so the decision is visible in the log page.

> **`max-age=0` policy:** If the upstream sends `Cache-Control: max-age=0`
> (immediately stale), Hubarr treats this as "no usable max-age" and applies
> the 30-day fallback instead. Media artwork CDNs occasionally send this on
> transient responses; treating it as a 30-day window avoids churn for content
> that is functionally static.

---

## Files

| File | Purpose |
|---|---|
| `src/server/image-cache.ts` | `ImageCacheService` — all fetch, write, and refresh logic |
| `src/server/db/image-cache.ts` | SQLite repository layer for the `image_cache` table |
| `src/server/db/migrations.ts` | Migration v4 creates the table and drops legacy columns |
| `src/server/plex-image-utils.ts` | URL validation helpers (unchanged) |

---

## Database: `image_cache` table

Introduced in migration v4. Replaces the old `cached_thumb` column on
`watchlist_cache` and `cached_avatar_url` on `users` / `managed_users`.

```sql
CREATE TABLE image_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,           -- 'poster:<plexItemId>' or 'avatar:<plexUserId>'
  kind TEXT NOT NULL,                        -- 'poster' or 'avatar'
  entity_id TEXT NOT NULL,                   -- plexItemId or plexUserId
  source_type TEXT,                          -- 'plex-path' or 'public-url'
  source_value TEXT,                         -- the Plex relative path or CDN URL
  local_file_path TEXT,                      -- absolute path on disk
  local_web_path TEXT,                       -- '/images/<uuid>.jpg'
  cached_at TEXT,                            -- ISO timestamp of first cache
  last_refresh_at TEXT,                      -- ISO timestamp of last successful refresh
  refresh_after TEXT,                        -- ISO timestamp — treat as stale after this
  last_attempted_at TEXT,                    -- ISO timestamp of last refresh attempt
  last_error TEXT                            -- last refresh error message, or NULL
);

CREATE INDEX idx_image_cache_kind_entity ON image_cache(kind, entity_id);
```

### Cache key design

Keys are based on the **Hubarr entity identity**, not the upstream URL:

- Posters: `poster:<plexItemId>` — stable across URL changes (CDN rotations,
  Plex metadata updates, etc.)
- Avatars: `avatar:<plexUserId>` — stable Plex user identity

This means re-caching the same movie under a new URL doesn't create a new file;
it just updates the `source_value` on the existing row and uses the same key.

---

## `ImageCacheService`

Constructed once in `app.ts` and passed to `HubarrServices`:

```ts
const imageCache = new ImageCacheService(config.dataDir, db, logger);
```

### `ensurePosterCached(plexItemId, source)`

```ts
type ImageSource =
  | { type: "plex-path"; value: string; serverUrl: string; token: string }
  | { type: "public-url"; value: string };

ensurePosterCached(plexItemId: string, source: ImageSource): Promise<string | null>
```

Called from `services.ts` whenever a watchlist item has a `thumb`. The source
type is derived from the thumb value:

- Starts with `/` → `plex-path` (authenticated Plex library path)
- Starts with `https://` → `public-url` (TMDB/Plex metadata CDN)

Returns the local web path (`/images/<uuid>.jpg`) or `null` if the image could
not be fetched.

**Transform spec:** resize to fit within `1000×1000` (preserves aspect ratio,
allows upscaling), JPEG quality 100.

### `ensureAvatarCached(plexUserId, avatarUrl)`

```ts
ensureAvatarCached(plexUserId: string, avatarUrl: string): Promise<string | null>
```

Always treats the source as `public-url` (Plex avatar URLs are external HTTPS).

**Transform spec:** resize to exactly `256×256` with `cover` fit (crops to
square), JPEG quality 100.

### `clearAll()`

Deletes every file under `/config/image-cache/` and clears all rows from
`image_cache`. Used by the "Clear Image Cache" button in Settings.

### `pruneOrphaned()`

Scans the cache directory and deletes any `.jpg` file whose web path is not
present in `image_cache.local_web_path`. Safe to call at any time — only
removes files with no matching metadata row.

### `runMaintenanceTasks()`

Performs image-cache housekeeping used by the daily `Maintenance Tasks` job:

1. delete orphaned watchlist poster rows from `image_cache`
2. prune any local files no longer referenced by metadata

This cleanup is intentionally scoped to watchlist-owned poster cache entries.
Avatar cache rows are left alone.

---

## Stale-while-refresh detail

When `ensurePosterCached` or `ensureAvatarCached` finds a stale entry with a
valid file on disk:

1. The existing `local_web_path` is returned immediately so the UI has
   something to show.
2. A background refresh is started as a fire-and-forget `Promise`:
   - A new UUID filename is chosen (`<uuid>.jpg`)
   - The image is fetched and transformed into memory
   - Written atomically: `tmpfile → rename` into the cache dir
   - `image_cache` row is updated with the new file path and a new
     `refresh_after` timestamp
   - **The old file is deleted only after the new file is committed**
3. If the refresh fails at any point:
   - `last_error` and `last_attempted_at` are updated in the DB row
   - The old file is left in place untouched
   - The next `ensurePosterCached` call for this item will serve the old
     file and try another background refresh

The result is that a running UI will never show a broken image due to a
cache refresh attempt.

---

## Atomic writes

All file writes follow the same pattern:

```
1. write data → /tmp/hubarr-img-<uuid>.tmp
2. fs.renameSync(tmpPath, finalPath)
3. on any error: unlink tmpPath and re-throw
```

`rename` is atomic on Linux when both paths are on the same filesystem. The
cache directory is always inside `/config/image-cache/` and the tmp file is in
the OS temp directory. If those happen to be on different filesystems, `rename`
falls back to a copy-and-delete — still safe because the final file is never
partially written.

---

## Where images are triggered

### Full / manual sync

`services.ts → syncUser()` — after `replaceWatchlistItems`, iterates every item
in the merged list and calls `ensurePosterCached` for any item with a `thumb`.

### RSS ingestion

`services.ts → processSelfRssNewItems()` and `processRssNewItems()` — both call
`ensurePosterCached` immediately after `upsertWatchlistItem`, so RSS items get
posters without waiting for the next full sync.

### Self-user avatar

`services.ts → upsertSelfUser()` — called on Plex settings save and on every
full sync. Calls `ensureAvatarCached` with the account's `avatarUrl`.

### Friend avatars

`services.ts → discoverUsers()` — after upserting friends and managed users,
calls `ensureAvatarCached` for each with a non-null `avatarUrl`.

---

## DB read paths

All read queries that return image paths use `LEFT JOIN image_cache` rather than
column fallbacks. External URLs are never returned to the client.

| Query | Join |
|---|---|
| `buildDashboard` (`db/sync.ts`) | `LEFT JOIN image_cache ip ON ip.cache_key = 'poster:' \|\| w.plex_item_id` |
| `buildDashboard` user avatars | `LEFT JOIN image_cache ia ON ia.cache_key = 'avatar:' \|\| f.plex_user_id` |
| `getWatchlistGrouped` (`db/watchlist.ts`) | Same poster + avatar joins |
| `listUsers` (`db/users.ts`) | `LEFT JOIN image_cache ic ON ic.cache_key = 'avatar:' \|\| u.plex_user_id` |
| `listManagedUsers` (`db/users.ts`) | Same |
| `getSession` (`db/settings.ts`) | Direct query: `SELECT ic.local_web_path FROM image_cache ic WHERE ic.cache_key = 'avatar:' \|\| ?` |

If no matching `image_cache` row exists, the JOIN produces `NULL` — the client
receives `null` for that field and renders initials / poster fallback SVG.

---

## Client-side rendering

`src/client/lib/plexImage.ts` exports a single helper:

```ts
function getPlexImageSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/images/")) return path;
  return null;
}
```

All avatar and poster render sites branch on the result of this function, never
on raw field truthiness. An external URL accidentally in the field returns `null`
and the fallback UI is shown cleanly instead of a broken `<img>`.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/images/:file` | Authenticated static file serving from `/config/image-cache/` |
| `POST` | `/api/settings/image-cache/clear` | Delete all files + clear `image_cache` table |
| `POST` | `/api/settings/image-cache/prune` | Delete files not referenced by any metadata row |

---

## Logging

All image service log entries include structured fields for observability:

| Field | Values |
|---|---|
| `action` | `lookup`, `cache`, `refresh`, `prune`, `clear` |
| `result` | `fresh`, `stale`, `miss`, `cached`, `refreshed`, `failed`, `removed`, `kept` |
| `kind` | `poster`, `avatar` |
| `cacheKey` | e.g. `poster:abc123` |
| `entityId` | `plexItemId` or `plexUserId` |
| `sourceType` | `plex-path`, `public-url` |
| `freshnessSource` | `upstream-cache-control`, `fallback-30d` |
| `maxAgeSeconds` | the freshness window in seconds |
| `staleAfter` | ISO timestamp after which the entry is considered stale |

Log levels follow these rules:

- `debug` — cache hits, freshness decisions, stale-while-refresh trigger, prune skips
- `info` — new image cached, stale image refreshed, prune removed files, cache cleared
- `warn` — fetch failures (old image kept), file missing on disk, invalid URL
- `error` — disk write failure with no usable fallback, clear/prune scan failure

---

## Migration notes

Migration v4 is a clean break:

- The old `cached_thumb` and `cached_avatar_url` columns are dropped.
- No data migration from old columns to the new table.
- After upgrading, images will be absent until the next sync populates
  `image_cache`. A single full sync restores all posters and avatars.
