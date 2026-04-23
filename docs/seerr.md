# Seerr Integration

This document describes how Hubarr integrates with Seerr — how it is
configured, how users are matched, how requests are created and attributed, how
the service account works, and what failure modes look like.

---

## Overview

When Seerr integration is enabled, Hubarr can turn missing watchlist items into
Seerr requests automatically after each sync, and also accept manual one-off
requests from the Watchlists UI.

Requests are attributed to the watchlist owner via Seerr's `userId` field in
the request payload, so Seerr shows the correct "Requested By" user. An
optional Hubarr service account can be used to execute requests so that
"Modified By" shows as Hubarr rather than the admin API key holder.

---

## Configuration

Settings live at `Settings → Seerr`.

### Seerr Integration card

| Field | Description |
|---|---|
| Base URL | Full URL of the Seerr instance, e.g. `http://seerr.local:5055` |
| API Key | Seerr admin API key — stored server-side, never returned to the client |
| Test Connection | Hits `/api/v1/status` and `/api/v1/user` to verify connectivity |

### Request Behaviour card

| Field | Description |
|---|---|
| Auto-Request | Global toggle — whether Hubarr submits requests during sync |
| Use Service Account | Create a dedicated Hubarr LOCAL user in Seerr to execute requests |

Saving settings with **Use Service Account** enabled creates (or reconciles) the
Hubarr service account immediately. Saving with it disabled deletes the account
from Seerr and clears the stored ID from Hubarr settings.

Auto-matching also runs on every settings save — any enabled users not yet
mapped will be automatically linked if a matching Seerr user is found.

---

## User Mapping

Each Hubarr user can be linked to a Seerr user. The link is stored in
`seerr_user_links` and has one of these statuses:

| Status | Meaning |
|---|---|
| `auto` | Matched automatically by username |
| `manual` | Manually overridden in the Users edit modal |
| `unlinked` | No match found and no manual override |

### Auto-matching priority

1. Exact `plexUsername` match (case-insensitive)
2. Exact local `username` match (case-insensitive)

No fuzzy matching. If more than one Seerr user has the same matching
`plexUsername` or `username`, the first exact match returned by Seerr is used.

### Manual override

In the Users edit modal, when Seerr is enabled a **Seerr** tab appears with:

- a dropdown to select a manual override from all Seerr users
- a per-user **Auto-Request Enabled** toggle

The modal uses the normal **Save Changes** button to persist both user settings
and Seerr mapping changes.

The `effective_seerr_user_id` stored in the DB is always the manual override if
one is set, otherwise the auto-matched user.

When a saved mapping becomes linked, Hubarr clears stale
`skipped_unlinked_user` request states for that Hubarr user. This lets the
Watchlists and Dashboard modals show the manual **Request** action immediately
instead of waiting for the next Seerr request sync to refresh the cached state.

### Per-user auto-request

Each user can either follow the global auto-request setting or set an explicit
override. The effective value is:

```typescript
userOverride ?? globalAutoRequest
```

That means a user override of `true` enables automatic Seerr requests for that
user even when the global setting is off, and an override of `false` blocks
automatic requests for that user even when the global setting is on.

---

## Request Flow

### Automatic (sync-time)

Seerr request processing runs as its own **Seerr Request Sync** job. When Seerr
is enabled, the job is listed on `Settings → Jobs` with **Next Execution** set to
**Manual**. It has a **Run Now** button but no editable schedule.

The job can run with three scopes:

| Scope | Trigger | Behaviour |
|---|---|---|
| `all` | Manual job run or full GraphQL sync | Checks all tracked users and all missing watchlist items |
| `user` | Manual user sync | Checks the synced user only |
| `items` | RSS sync | Checks only newly processed missing RSS items for the affected user |

RSS and user-scoped runs require the effective auto-request value to be true
before they contact Seerr. Full/manual all-user runs can still refresh cached
Seerr state for linked users even when auto-request is off.

`processSeerrRequestsForUser(friend, missingItems, runId)` is called by the
Seerr job after the watchlist/RSS source has persisted the missing items. Seerr
job failures are recorded on the Seerr run and do not fail the parent RSS,
GraphQL, or user sync.

```text
for each missing item:
  ├── skip if user has no seerr_user_links row at all
  ├── if no effectiveSeerrUserId AND autoRequest enabled → record skipped_unlinked_user
  ├── if no TMDB ID AND autoRequest enabled → record skipped_missing_ids
  ├── fetch live Seerr mediaInfo (getMovieStatus / getTvStatus)
  ├── evaluateMediaInfo → skip result or null
  ├── if skip result → upsertSeerrRequestState (already_available / already_requested / added_directly)
  ├── if requestable → deleteSeerrRequestState (clear stale cache)
  └── if requestable + autoRequest enabled → createRequest → upsertSeerrRequestState (created / failed)
```

**State refresh runs regardless of the auto-request gate for all-user Seerr
runs.** Any linked user with missing items can have their Seerr state updated by
the manual Seerr job or by a full GraphQL sync, so the Watchlists UI can stay
accurate even when automatic request creation is disabled.

### Manual (UI-triggered)

The Watchlists and Dashboard item modals show per-user Seerr badges. A **Request**
or **Retry** button calls `POST /api/watchlists/request`, which invokes
`checkAndRequest()` directly and updates the stored state for that user+item.

---

## Seerr Status Handling

The implementation uses a **whitelist** of skip statuses rather than a
blacklist, so any undocumented future status codes fall through to requestable:

```typescript
const SEERR_SKIP_STATUSES = new Set([2, 3, 4, 5]);
// PENDING | PROCESSING | PARTIALLY_AVAILABLE | AVAILABLE
```

| Status | Name | Treatment |
|---|---|---|
| 1 | UNKNOWN | Requestable |
| 2 | PENDING | Skip → `already_requested`, or `added_directly` when Seerr has no request record |
| 3 | PROCESSING | Skip → `already_requested`, or `added_directly` when Seerr has no request record |
| 4 | PARTIALLY_AVAILABLE | Skip → `already_requested`, or `added_directly` when Seerr has no request record |
| 5 | AVAILABLE | Skip → `already_available` |
| 6 | DELETED | Requestable |
| 7+ | Undocumented | Requestable (whitelist approach) |

For statuses 2–4 with no visible requests, the item is treated as
`added_directly`. This covers items that are in Seerr via another path, such as
being added directly through Radarr/Sonarr, where there is no specific Seerr
requester to attribute.

---

## Outcome States

All outcomes are stored in `seerr_request_state.outcome`:

| Outcome | Meaning |
|---|---|
| `created` | Hubarr successfully submitted a new Seerr request |
| `already_requested` | Seerr already has a request for this item |
| `already_available` | Seerr reports the item as available |
| `added_directly` | Seerr has the item in progress without a visible request record |
| `skipped_unlinked_user` | User has no effective Seerr mapping |
| `skipped_missing_ids` | No TMDB ID could be extracted from Plex GUIDs |
| `failed` | Seerr API call succeeded but the request POST failed |

When a previously-cached `already_available` item becomes requestable again
(e.g. Seerr marks it DELETED), the stale DB record is deleted and the UI
correctly shows "Request in Seerr" again.

---

## Request Attribution

Seerr uses a single master API key for all programmatic access. Two headers
work together to control attribution:

- **`X-Api-Key`** — always the master key, authenticates the call
- **`X-API-User`** — when set, tells Seerr to act as that user for "Modified By"

The `userId` field in the `POST /request` body controls "Requested By" and is
always set to the watchlist owner's Seerr user ID.

| Mode | X-API-User | Requested By | Modified By |
|---|---|---|---|
| No service account | watchlist owner | watchlist owner | watchlist owner |
| Service account | Hubarr service account | watchlist owner | Hubarr |

---

## Service Account

Hubarr can create and manage a dedicated LOCAL Seerr user for executing
requests. This makes it easy to identify Hubarr-originated requests in the Seerr
audit log.

| Field | Value |
|---|---|
| Email | `hubarr@hubarr.local` |
| Username | `Hubarr` |
| User type | `3` (LOCAL) |
| Avatar | `https://raw.githubusercontent.com/Migz93/hubarr/refs/heads/main/public/logo.png` |
| Permissions bitmask | `202_137_656` |
| Disabled notification types | Request Pending Approval, Request Automatically Approved, Request Processing Failed, Request Available |

The permissions bitmask includes:
`MANAGE_USERS | MANAGE_REQUESTS | REQUEST | REQUEST_ADVANCED | REQUEST_VIEW | REQUEST_MOVIE | REQUEST_TV | RECENT_VIEW | WATCHLIST_VIEW`

### Lifecycle

1. **Enable service account** — `createOrReconcileServiceAccount()` finds or
   creates the account, then always calls `PUT /user/{id}` to enforce the
   correct permissions. It then calls
   `POST /user/{id}/settings/notifications` to untick the request lifecycle
   notifications that would otherwise fire for Hubarr's automated request flow.
   This means re-saving settings acts as a manual repair trigger if the
   account's permissions or notification preferences were changed in Seerr.
2. **Disable service account** — `deleteServiceAccount()` deletes the account
   from Seerr and clears `serviceAccountSeerrUserId` from Hubarr settings.

### Critical: POST /user ignores permissions

Seerr's `POST /user` endpoint ignores the `permissions` field in the request
body and always applies `settings.main.defaultPermissions`. Permissions must be
set via a follow-up `PUT /user/{id}`. `createOrReconcileServiceAccount()` always
runs this PUT, even for an account that already exists.

---

## Watchlists UI — Badges And Filters

Dashboard and Watchlists poster cards use three status indicators:

| Indicator | Meaning |
|---|---|
| Green tick | Item is available in Plex |
| Seerr logo | Item is missing from Plex but is already requested/known in Seerr |
| Red cross | Item is missing from Plex and not requested in Seerr |

Plex availability takes priority over Seerr state: if an item is in Plex and
also has Seerr state, the poster shows the green tick.

When Seerr is enabled, the Watchlists page also shows a **Requested** filter
chip. It uses `availability=requested` and returns watchlist items with a
terminal positive Seerr outcome (`created`, `already_requested`,
`already_available`, or `added_directly`).

The watchlist item modal shows Seerr badges on user rows and, when needed,
additional ghost rows. The "best" state across all users is selected using this
priority:

```text
created > already_requested > already_available > added_directly > failed > skipped_*
```

| Badge | Colour | Action |
|---|---|---|
| Requested | Green | Opens item page in Seerr |
| In Seerr | Green | Opens item page in Seerr |
| Request | Red | Submits a new Seerr request |
| Retry | Red | Retries a failed request |

If the canonical state belongs to a user not on this item's watchlist, a ghost
row shows their avatar and name with the badge.

If the item is already requested/known in Seerr but has no specific requester
(`seerr_request_id IS NULL`), the modal suppresses per-user request badges and
shows an **Unknown** ghost row with a green **Requested** badge.

The same badge logic applies to the Dashboard item modal — both pages use the
same `WatchlistItemModal` component and receive the same `seerrSettings` prop.

---

## History Labels

The Seerr job creates `sync_runs.kind = "seerr"` rows. Dashboard and History show
these as **Seerr** runs.

Seerr-related sync steps appear in History with these labels:

| Action key | Label |
|---|---|
| `seerr.request.created` | Seerr request created |
| `seerr.request.existing` | Already in Seerr |
| `seerr.request.skipped` | Seerr request skipped |
| `seerr.request.failed` | Seerr request failed |

---

## Data Model

### `seerr_user_links`

One row per Hubarr user. Tracks the mapping between a Hubarr user and their
Seerr counterpart.

```sql
CREATE TABLE seerr_user_links (
  user_id INTEGER PRIMARY KEY,
  manual_seerr_user_id INTEGER,
  auto_matched_seerr_user_id INTEGER,
  effective_seerr_user_id INTEGER,
  mapping_status TEXT NOT NULL DEFAULT 'unlinked',
  auto_request_enabled INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### `seerr_request_state`

One row per user+item pair. Tracks what happened when Hubarr last processed
that item for that user.

```sql
CREATE TABLE seerr_request_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plex_item_id TEXT NOT NULL,
  seerr_request_id INTEGER,
  seerr_media_id INTEGER,
  tmdb_id INTEGER,
  last_attempted_at TEXT,
  outcome TEXT,
  last_error TEXT,
  effective_seerr_user_id INTEGER,
  execution_seerr_user_id INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, plex_item_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

Both tables are introduced in migration v10.

`plex_item_id` stores the Hubarr/Plex item key that was active when the state
was written. Reads, updates, and deletes resolve equivalent media identities via
`media_items` and `media_item_identifiers`, including `plex://`, discover keys,
and `tmdb://` identifiers. This prevents duplicate or stale Seerr state when the
same media appears under different Plex/watchlist ID formats.

`seerr_request_id` and `seerr_media_id` are stored as Seerr-specific state, not
as Hubarr media identity aliases. Hubarr uses TMDB/Plex identifiers for
cross-system media matching.

---

## API Routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/settings` | Extended to include `seerr: SeerrSettingsView` (apiKey redacted) |
| `PATCH` | `/api/settings/seerr` | Save Seerr settings; reconciles or deletes service account; kicks off auto-match sync |
| `POST` | `/api/settings/seerr/test` | Test connectivity against provided or stored credentials |
| `GET` | `/api/settings/seerr/users` | List Seerr users for the mapping UI dropdown |
| `GET` | `/api/users/:id/seerr` | Get the Seerr link record for a user |
| `PATCH` | `/api/users/:id/seerr` | Update manual override and per-user autoRequestEnabled |
| `GET` | `/api/watchlists?availability=requested` | Filter Watchlists to items with terminal positive Seerr state |
| `GET` | `/api/watchlists/seerr-state?plexItemId=` | DB-only read of request states for an item (no live Seerr calls); resolves equivalent item IDs |
| `POST` | `/api/watchlists/request` | Manually trigger a Seerr request for a user+item |
| `POST` | `/api/settings/jobs/seerr-request-sync/run` | Trigger the manual all-user Seerr Request Sync job |

---

## Files

| File | Purpose |
|---|---|
| `src/server/integrations/seerr.ts` | `SeerrIntegration` class — all Seerr API calls, `evaluateMediaInfo`, `extractTmdbId` |
| `src/server/db/seerr.ts` | DB repo — user links, equivalent-ID Seerr state lookup, request state CRUD, requested-item facets |
| `src/server/services.ts` → `runSeerrRequestSync()` | Scoped Seerr Request Sync job; called manually, after full sync, after user sync, and for missing RSS items |
| `src/server/services.ts` → `processSeerrRequestsForUser()` | Per-user Seerr state refresh/request creation logic used by the job |
| `src/server/app.ts` | API routes for settings, user links, state reads, manual requests, and the Seerr job row/run action |
| `src/server/db/migrations.ts` | Schema — `seerr_user_links` and `seerr_request_state` (v10) |
| `src/server/db/settings.ts` | `getSeerrSettings()`, `updateSeerrSettings()` |
| `src/shared/types.ts` | `SeerrSettingsView`, `SeerrSettingsPatch`, `SeerrUser`, `SeerrUserLink`, `SeerrRequestState`, `SeerrRequestOutcome` |
| `src/client/pages/Settings.tsx` | Seerr tab — connection form and request behaviour toggles |
| `src/client/pages/Users.tsx` | Seerr section in the edit modal |
| `src/client/pages/Watchlists.tsx` | Poster Seerr status icon, Requested filter chip, passes `seerrSettings` to `WatchlistItemModal` |
| `src/client/pages/Dashboard.tsx` | Poster Seerr status icon, passes `seerrSettings` to `WatchlistItemModal` |
| `src/client/components/WatchlistItemModal.tsx` | Badge dedup, Request/Retry buttons, ghost row |
| `src/client/pages/History.tsx` | Seerr action label mapping |
| `src/client/lib/useSettings.ts` | Shared settings hook used by Seerr-aware pages |
| `public/seerr-icon.svg` | Seerr logo used in poster indicators and modal badges |

---

## Known Seerr API Quirks

- **`POST /user` ignores `permissions`** — always applies `settings.main.defaultPermissions`.
  Use `PUT /user/{id}` to set permissions after creation.
- **Large inline avatars fail with `413 Payload Too Large`** — use a remote URL,
  not a base64 `data:` URL.
- **`X-API-User` requires sufficient permissions** — the impersonated user must
  have `MANAGE_REQUESTS` for admin-level operations.
- **`POST /request` `userId` field** — only accepted when the authenticated user
  (via `X-API-User`) has `MANAGE_USERS` or `MANAGE_REQUESTS` permission.
- **Status 7 exists** — Seerr's OpenAPI spec only documents statuses 1–6 but
  status 7 ("Deleted" variant) has been observed in production. The whitelist
  approach handles this by treating any undocumented status as requestable.
