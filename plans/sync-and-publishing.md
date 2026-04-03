# Hubarr Sync And Publishing

## Job Model

Hubarr uses separate background jobs so each job has one clear responsibility:

- `Watchlist RSS Sync`
- `Watchlist GraphQL Sync`
- `Plex Recently Added Scan`
- `Plex Full Library Scan`
- `Collection Sync`
- `Plex Refresh Token`

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
- `Collection Sync` interval
- `Plex Recently Added Scan` interval
- `Plex Full Library Scan` interval

### Important Terminology

#### Watchlist item

A title Hubarr knows is on a user's Plex watchlist.

#### Matched item

A watchlist item that Hubarr has successfully linked to an item already present in a Plex library.

#### Collection Sync

The job that updates Plex collections and hub visibility from cached Hubarr state.

#### Startup Sync

The boot-time sequence that runs:

1. `Plex Full Library Scan`
2. `Watchlist GraphQL Sync`
3. `Collection Sync`

#### Sync history

The persisted run history for watchlist and collection operations shown in the History page.

#### Job state

The persisted last-run timestamp and status used by the Jobs page so run times remain truthful across restarts.

## Startup Sync

If `Startup Sync` is enabled, Hubarr runs this sequence on boot:

1. `Plex Full Library Scan`
2. `Watchlist GraphQL Sync`
3. `Collection Sync`

This gives Hubarr a fresh view of Plex library availability, then a fresh watchlist reconciliation, then a collection update pass.

## Watchlist RSS Sync

Purpose:
- pick up watchlist changes quickly

How it works:
- Hubarr primes self and friends RSS caches at startup
- it polls both feeds on the configured interval
- new feed items are diffed using stable keys
- self items are attributed directly to the owner user
- friends items are attributed using the RSS author field
- new items are stored in the watchlist cache
- Hubarr attempts an immediate Plex library match for those items

Notes:
- RSS is the fast path, not the only source of truth
- Plex Pass is important for the best RSS experience

## Watchlist GraphQL Sync

Purpose:
- reconcile watchlist state from Plex more completely

How it works:
- fetches full watchlists for enabled users through Plex GraphQL
- enriches metadata separately
- attempts Plex library matching for all fetched items
- replaces the cached watchlist state for that user

This is the recovery path for anything RSS missed.

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

## Collection Sync

Purpose:
- perform all collection and hub-row updates

How it works:
- loads the cached watchlist state for each enabled user
- builds the movie and TV collections for that user from matched items
- ensures collection labels and sort behavior are correct
- updates Plex hub visibility settings
- reapplies user visibility isolation rules

Only this job should perform collection updates.

## Matching Behavior

- Watchlist items are matched against Plex library items
- RSS and GraphQL syncs both try to match immediately
- Plex library scans exist to catch items that appear later
- Availability is represented by whether a watchlist item has a `matchedRatingKey`

## Visibility Isolation

Hubarr uses labels plus Plex shared-user filter exclusions to keep tracked users from seeing each other's watchlist rows where Plex supports that correctly.

## History, Jobs, And Logs

### History

History stores higher-level sync runs such as:

- `rss`
- `full`
- `publish`
- `friend`

It also stores per-run detail rows for actions such as watchlist fetches, match failures, and collection updates.

### Jobs

Jobs shows scheduler-oriented information:

- next scheduled execution
- last run time
- last run status

For scheduler-managed jobs, last-run state is persisted so a restart does not reset the truth shown in the UI.

### Logs

Logs are the broader operational record.

Use Logs for:
- runtime warnings
- detailed diagnostics
- low-level troubleshooting

Use History for:
- understanding what a specific sync run did
- reviewing user-facing operational outcomes
