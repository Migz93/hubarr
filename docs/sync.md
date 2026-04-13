# Hubarr Sync Architecture

## Job Model

Hubarr uses separate background jobs so each job has one clear responsibility:

- `Watchlist RSS Sync`
- `Watchlist GraphQL Sync`
- `Activity Cache Fetch`
- `Plex Recently Added Scan`
- `Plex Full Library Scan`
- `Collection Sync`
- `Refresh Users`
- `Plex Refresh Token`
- `Maintenance Tasks`

For a detailed explanation of how the three watchlist-specific jobs work together
— including date resolution, RSS deduplication, and the activity feed cache —
see [docs/watchlist.md](watchlist.md).

---

## Data And Settings

### Important Stored Data

Hubarr persists its state in SQLite.

The most important data groups are:

- owner/admin settings
- Plex connection settings
- app settings
- discovered users and enabled-user configuration
- cached watchlist items
- tracked Plex collection records
- sync run history
- sync run item details
- persisted job last-run state
- sessions

### Key App Settings

#### General

- `Startup Sync`
- `History Retention`

#### Collections

- collection naming pattern
- collection sort order
- default movie library
- default TV library
- default hub visibility settings

#### Jobs And Sync Timing

- `Watchlist RSS Sync` interval
- `Watchlist GraphQL Sync` interval
- `Activity Cache Fetch` interval
- `Collection Sync` interval
- `Plex Recently Added Scan` interval
- `Plex Full Library Scan` interval
- daily `Maintenance Tasks`

---

## Important Terminology

#### Watchlist item

A title Hubarr knows is on a user's Plex watchlist.

#### Matched item

A watchlist item that Hubarr has successfully linked to an item already present
in a Plex library.

#### Collection Sync

The job that updates Plex collections and hub visibility from cached Hubarr
state.

#### Startup Sync

The boot-time sequence that runs:

1. `Plex Full Library Scan`
2. `Watchlist GraphQL Sync`
3. `Collection Sync`

#### Sync history

The persisted run history for watchlist and collection operations shown in the
History page.

#### Job state

The persisted last-run timestamp and status used by the Jobs page so run times
remain truthful across restarts.

#### Maintenance task

Scheduled housekeeping work that keeps derived or cached data tidy without
changing the main sync flow.

---

## Startup Sync

If `Startup Sync` is enabled, Hubarr runs this sequence on boot:

1. `Plex Full Library Scan`
2. `Watchlist GraphQL Sync`
3. `Collection Sync`

This gives Hubarr a fresh view of Plex library availability, then a fresh
watchlist reconciliation, then a collection update pass.

The activity cache is also fetched at startup independently of this sequence,
before the scheduled job interval kicks in.

---

## Plex Library Scans

### Plex Recently Added Scan

Purpose:
- quickly detect items that were previously unmatched but have now appeared in Plex

How it works:
- scans recent additions from Plex libraries
- checks cached unmatched watchlist items against those results
- updates `matchedRatingKey` where a match is found

### Plex Full Library Scan

Purpose:
- broader safety-net availability reconciliation

How it works:
- scans full Plex libraries
- attempts to match any still-unmatched cached watchlist items

---

## Collection Sync

Purpose:
- perform all collection and hub-row updates

How it works:
- loads the cached watchlist state for each enabled user
- builds the movie and TV collections for that user from matched items
- ensures collection labels and sort behavior are correct
- updates Plex hub visibility settings
- reapplies user visibility isolation rules

Only this job should perform collection updates. The watchlist sync jobs
(RSS and GraphQL) trigger a collection sync immediately after processing
changes — see [docs/watchlist.md](watchlist.md) for details.

---

## Maintenance Tasks

Purpose:
- run daily housekeeping that is useful for long-term correctness or storage
  hygiene, but does not need to run inline with a sync

How it works:
- runs as a separate daily scheduler-managed job
- delegates task-specific cleanup to the subsystem that owns the data
- records last-run state so `Settings → Jobs` stays truthful across restarts

For the current task list and extension guidance, see
[docs/maintenance.md](maintenance.md).

---

## Matching Behavior

- Watchlist items are matched against Plex library items
- RSS and GraphQL syncs both try to match immediately
- Plex library scans exist to catch items that appear later
- Availability is represented by whether a watchlist item has a `matchedRatingKey`

---

## Visibility Isolation

Hubarr uses labels plus Plex shared-user filter exclusions to keep tracked users
from seeing each other's watchlist rows where Plex supports that correctly.

---

## History, Jobs, And Logs

### History

History stores higher-level sync runs such as:

- `rss`
- `full`
- `user`
- `publish`

It also stores per-run detail rows for actions such as watchlist fetches, match
failures, unresolved `addedAt` dates, and collection updates.

### Jobs

Jobs shows scheduler-oriented information:

- next scheduled execution
- last run time
- last run status

For scheduler-managed jobs, last-run state is persisted so a restart does not
reset the truth shown in the UI.

### Logs

Logs are the broader operational record.

Use Logs for:
- runtime warnings
- detailed diagnostics
- low-level troubleshooting

Use History for:
- understanding what a specific sync run did
- reviewing user-facing operational outcomes

---

## UI Freshness

Hubarr uses a polling-first client refresh model for views that depend on
background watchlist or scheduler activity. The client does not currently have
an SSE/WebSocket push channel, so these pages refresh themselves while visible
instead of waiting for a full browser reload.

Pages that auto-refresh:

- Dashboard
- Watchlists
- History
- Users
- Settings → Jobs
- Settings → Logs

Behavior notes:

- refresh polling pauses when the browser tab is hidden
- polling cadence speeds up while relevant work is actively running and slows
  down again once the page is idle
- manual actions still trigger an immediate reload so the UI responds before
  the next scheduled poll

Audit classification for the current frontend:

- Needs live refresh: Dashboard, Watchlists, History, Users, Jobs
- Already handled: Logs
- No refresh needed: General, Plex, Collections, About, Login, Onboarding
