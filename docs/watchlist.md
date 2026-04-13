# Watchlist System

This document explains how Hubarr fetches, stores, and maintains watchlist data
for the admin user and their friends — including how watchlist-added dates are
resolved and what happens when a date cannot be determined.

---

## Overview

Hubarr maintains watchlists through three complementary mechanisms that run at
different frequencies and serve different purposes:

| Mechanism | Frequency | Purpose |
|---|---|---|
| GraphQL full sync | Configurable (default 1h) | Authoritative list of what is currently on each watchlist |
| RSS polling | Configurable (default 30s) | Fast detection of new additions |
| Activity feed cache | Configurable (default 1h), independently scheduled | Historical `addedAt` dates for watchlist items |

The GraphQL sync is the source of truth for what is on a watchlist right now.
The RSS feeds catch new items quickly between full syncs. The activity feed
cache fills in when items were added, which GraphQL alone cannot answer.

---

## GraphQL Full Sync

**Endpoint:** `https://community.plex.tv/api` (POST)  
**Schedule:** Every `reconciliationIntervalMinutes` (default 60 minutes), and
optionally on startup if `fullSyncOnStartup` is enabled.  
**Code:** `src/server/integrations/plex.ts` → `fetchGraphqlWatchlist()`,
`src/server/services.ts` → `syncUser()`

### What it does

For each enabled user (self and friends), Hubarr queries the Plex Community
GraphQL API for their full watchlist. The query paginates in batches of 100
until all items are retrieved:

```graphql
query GetFriendWatchlist($user: UserInput!, $first: PaginationInt!, $after: String) {
  userV2(user: $user) {
    ... on User {
      watchlist(first: $first, after: $after) {
        nodes { id guid key title type year }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

Each item is then enriched via `discover.provider.plex.tv` to resolve GUIDs
(TMDB, TVDB, IMDB), poster URLs, release dates, and year. The enriched list is
matched against the configured Plex server libraries to find the local
`ratingKey` for each item.

### Why GraphQL

The GraphQL API is the only endpoint that returns a complete, paginated watchlist
for both the admin and their friends using a single token. It is used as the
definitive record of what is on a watchlist at any given moment.

**Limitation:** The GraphQL watchlist response contains no date fields. It cannot
tell Hubarr when an item was added to the watchlist. The `addedAt` date is
resolved separately (see [Date Resolution](#date-resolution)).

### Merge behaviour

After fetching, the new list is merged against the existing stored items using
`mergeFetchedWatchlistItems()`. This preserves:
- `addedAt` — never overwritten by a later sync if it already holds a real date
- `matchedRatingKey` — preserved if already resolved, updated if changed
- `guids` — union of new and existing GUIDs
- `discoverKey` — preserved if the new fetch doesn't provide one

Items that disappear from the GraphQL response are removed from the stored
watchlist for that user.

### Ad-hoc sync (button press)

When a sync is triggered manually — either the dashboard "Run Sync" button
(all users) or the per-user sync button — the flow is extended beyond a plain
GraphQL fetch:

1. **Activity cache refresh** — the activity feed is fetched incrementally
   before the GraphQL pass, so date resolution uses the freshest available data.
2. **RSS date snapshot** — both RSS feeds are fetched once and a per-user date
   map is built. This covers items watchlisted very recently that may not yet
   appear in the activity feed.
3. **GraphQL sync** — runs as normal for each user, with both the activity cache
   and the RSS date map available for `addedAt` resolution.
4. **Collection publish** — runs immediately after the sync so Plex collections
   are updated without waiting for the next scheduled publish job.

The per-user sync button fetches the activity cache for all users (the feed is
global) but scopes the RSS date map to that specific user's author entries.

---

## RSS Feeds

**Endpoint:** `https://rss.plex.tv/<uuid>` and `https://discover.provider.plex.tv/rss`  
**Schedule:** Every `rssPollIntervalSeconds` (default 30 seconds)  
**Requires:** Plex Pass  
**Code:** `src/server/integrations/plex.ts` → `fetchRssFeedItems()`,
`src/server/services.ts` → `pollRss()`, `processSelfRssNewItems()`,
`processRssNewItems()`

### What it does

Hubarr maintains two RSS feeds:

| Feed | Covers | `feedType` |
|---|---|---|
| Self watchlist | Admin's own additions only | `watchlist` |
| Friends watchlist | All enabled friends combined | `friendsWatchlist` |

On startup both caches are primed with the current feed state. On each poll,
the feed is diffed against the in-memory cache — only new items (those not seen
in the last fetch) are processed. This diff-based approach means the RSS path
only triggers work when something actually changed.

### Why RSS feeds

RSS feeds update faster than the GraphQL sync interval. A new item added to a
watchlist typically appears in the RSS feed within seconds. This gives Hubarr
near-real-time awareness of new additions without running a full GraphQL sync
every few seconds.

### Date attribution

Each RSS item includes:
- `pubDate` — when the item appeared in the feed, used directly as `addedAt`
- `author` — the Plex UUID of the user who added the item

The `author` field is used to attribute friends-feed items to the correct
enabled user. Items whose `author` does not match any enabled user are skipped
by the RSS path — if that user is disabled in Hubarr, they will also not appear
in the GraphQL sync, so their items are intentionally ignored across both paths.

### Limitation

RSS feeds have a finite window — they do not contain the full history of a
watchlist, only recent additions. Items that were on a watchlist before Hubarr
was set up will not appear in the RSS feed and must rely on the activity feed
cache or fall back to the sentinel value.

### Deduplication

The in-memory RSS cache keys each entry by the combination of the item's GUIDs
and the `author` field. This means if two friends watchlist the same item within
the same polling window, both entries are treated as distinct and both are
processed — one does not silently shadow the other.

### Collection publish on new items

When the background RSS poll detects new items and processes them, a collection
publish is triggered immediately afterwards. Plex collections are updated as
soon as the RSS item is ingested rather than waiting for the next scheduled
publish job.

---

## Activity Feed Cache

**Endpoint:** `https://community.plex.tv/api` (POST)  
**Schedule:** Runs once on startup, then every `activityCacheFetchIntervalMinutes`
(default 60 minutes) — configurable independently from the full sync via Settings > Jobs  
**Code:** `src/server/integrations/plex.ts` → `fetchWatchlistActivityFeed()`,
`src/server/services.ts` → `syncActivityCache()`  
**Database:** `watchlist_activity_cache` table (migration v5)

### What it does

The Plex Community GraphQL `activityFeed` query, filtered to `types: [WATCHLIST]`,
returns a history of watchlist events — each entry records who watchlisted
something, what they watchlisted, and when:

```graphql
query GetWatchlistActivity($first: PaginationInt!, $after: String) {
  activityFeed(first: $first, after: $after, types: [WATCHLIST]) {
    nodes {
      date
      userV2 { id username displayName }
      metadataItem { id title type key }
    }
    pageInfo { endCursor hasNextPage }
  }
}
```

Results are stored locally in `watchlist_activity_cache`:

```sql
CREATE TABLE watchlist_activity_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plex_item_id TEXT NOT NULL,
  plex_user_id TEXT NOT NULL,
  watchlisted_at TEXT NOT NULL,
  UNIQUE(plex_item_id, plex_user_id)
);
```

One row per user+item pair, keeping only the most recent `watchlisted_at` date.
If the same item is watchlisted, removed, and re-watchlisted, only the most
recent event is retained.

### Initial population

On the very first run (`job_run_state.last_run_at` is `NULL` for
`activity-cache-fetch`), the full feed history is paginated from newest to
oldest. The feed has been confirmed to retain history going back several years.

### Incremental updates

On subsequent runs, only events newer than `last_run_at` are fetched.
Since Plex returns events newest-first, the fetch stops as soon as an entry
older than the last run timestamp is encountered — keeping the incremental cost
low regardless of total feed size.

### How it is used

During `syncUser()`, after the GraphQL fetch and merge, any item whose `addedAt`
is still the sentinel value is looked up in the activity cache. If a matching
`(plex_item_id, plex_user_id)` row exists, its `watchlisted_at` is used as the
real `addedAt`. Items that remain unresolved after this lookup are recorded in
the sync run as `watchlist.date_unresolved` and appear in the History page
(see [Unresolved Dates in History](#unresolved-dates-in-history)).

As of migration `v8`, Hubarr resolves this through explicit identifier tables
rather than ad hoc service-layer fallbacks:

- `user_identifier_aliases` stores known Plex user IDs for the same local user
  record, including the self user's numeric Plex ID and GraphQL UUID
- `media_items` stores one canonical `plex://...` item identity per media item
- `media_item_identifiers` stores additional aliases for the same media item,
  such as `/library/metadata/...` discover keys and external GUIDs

That means the activity-cache lookup can match the same conceptual item and the
same conceptual user across multiple Plex identifier formats without manually
trying permutations in `services.ts`.

### Limitation

The activity feed does not retain infinite history. Items watchlisted before the
feed's earliest record cannot be resolved this way and will permanently carry the
sentinel value unless added again (creating a new activity event) or resolved via
the RSS fast path.

---

## Date Resolution

When determining `addedAt` for a watchlist item, sources are checked in priority
order:

| Priority | Source | Covers |
|---|---|---|
| 1 | Already-stored real date | Preserved from any previous resolution |
| 2 | Activity feed cache | Self and friends — where history exists |
| 3 | RSS date snapshot | Self and friends — recent items, ad-hoc syncs only |
| 4 | Sentinel value | No date available from any source |

A stored date is never overwritten unless it is the sentinel. Once a real date
is written it is permanent.

The activity cache is tried before the RSS snapshot because it covers a much
longer history. The RSS snapshot is available only during ad-hoc syncs (button
presses) — during background scheduled GraphQL syncs no RSS snapshot is
fetched, so only priorities 1, 2, and 4 apply. Background RSS polling resolves
dates directly at ingest time via `pubDate`, which is stored immediately and
preserved by all subsequent syncs under priority 1.

### Sentinel value

When no real date can be determined, Hubarr stores:

```
2001-01-01T00:00:00.000Z
```

This is an intentionally implausible date that signals "date unknown" rather
than pretending the item was watchlisted today. The sentinel is treated as
overwriteable — if a real date arrives later via RSS or an activity cache update,
it replaces the sentinel.

In the UI, the sentinel is displayed as **Unknown** rather than the raw date.

---

## Unresolved Dates in History

After each GraphQL sync, any items that still carry the sentinel are recorded
against that sync run as `watchlist.date_unresolved` items. These appear in the
History page under **Watchlisted At Date Unresolved (N)**, only shown when N > 0.

As the activity feed cache accumulates history over time, this count will
naturally trend towards zero for most users.

---

## Files

| File | Purpose |
|---|---|
| `src/server/integrations/plex.ts` | `fetchGraphqlWatchlist()`, `fetchWatchlistActivityFeed()`, `fetchRssFeedItems()`, `fetchRssUrl()` |
| `src/server/services.ts` | `syncUser()`, `runFullSync()`, `runUserSync()`, `syncActivityCache()`, `buildAllRssDateMaps()`, `pollRss()`, `processSelfRssNewItems()`, `processRssNewItems()`, `runPublishPass()` |
| `src/server/db/watchlist.ts` | Watchlist and activity cache DB helpers |
| `src/server/db/identifiers.ts` | Explicit media/user identifier catalog and alias-based lookup helpers |
| `src/server/db/migrations.ts` | Schema — `watchlist_cache` (v1), `watchlist_activity_cache` (v5) |
| `src/server/rss-cache.ts` | In-memory RSS diff cache — author-keyed deduplication, `prime()`, `diff()` |
| `src/server/index.ts` | Job registrations for all three sync mechanisms |
| `src/client/lib/utils.ts` | `formatWatchlistDate()`, `formatWatchlistDateShort()` — sentinel-aware display helpers |

---
