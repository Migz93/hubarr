# Hubarr Architecture Overview

## What Hubarr Is

Hubarr is a single-purpose Plex companion app.

It tracks the owner's Plex watchlist and selected friends' watchlists, stores
that watchlist state locally, matches items against Plex libraries, and keeps
per-user Plex collections and hub rows up to date.

When Seerr integration is enabled, Hubarr can also submit missing watchlist items as Seerr requests on behalf of the matching user.

---

## Core Model

- Plex is the source of truth for watchlists
- Hubarr is the source of truth for cached watchlist state, job history, and collection sync state
- Each enabled user gets one movie collection and one TV collection
- Both collections share the same visible name for that user
- Hubarr is a single-owner app: the first Plex account to onboard becomes the only admin

---

## Deployment Model

Hubarr runs as a single self-hosted container:

- Express backend and API
- React frontend
- background job scheduler
- Plex integration layer
- SQLite database
- log file output

Persistent data is stored in `/config`.

---

## Database Migrations

Hubarr uses SQLite `PRAGMA user_version` for schema migrations.

- Versioned migrations live in `src/server/db/migrations.ts`
- `runMigrations(db)` runs on startup, applies any migration whose version is higher than the current `user_version`, and advances `user_version` after each successful migration
- Each migration runs inside a transaction so a failure should leave the database unchanged

**V2 baseline:** the schema was flattened at the V2 release. Migration version 1 is a single `CREATE TABLE` block that defines every table and index in its final form. A fresh install runs it once and is immediately at the correct state — there are no intermediate ALTER TABLE steps or sequential migrations to follow.

When changing the schema in the future:

1. Add a new migration entry with the next integer version
2. Write the schema change in that migration's `up(db)` function (ALTER TABLE, CREATE TABLE, etc.)
3. Do not edit older migrations that may already have shipped
4. Keep default-setting seeding separate from schema migrations

---

## Auth And Setup

- Authentication is Plex-only OAuth
- No local password login exists
- The owner record is persisted after first setup
- Setup flow is:
  1. log in with Plex
  2. choose the Plex server
  3. discover and enable users
  4. configure target libraries and visibility defaults

---

## Major Subsystems

### Watchlist ingestion

Hubarr ingests watchlist state through three complementary mechanisms:

- **Watchlist RSS Sync** — fast path, picks up new additions within seconds
- **Watchlist GraphQL Sync** — scheduled reconciliation, authoritative list of what is on each watchlist
- **Activity Cache Fetch** — fetches Plex Community watchlist activity events to resolve when items were originally added (`addedAt`)

See [docs/watchlist.md](watchlist.md) for how these work together, including date resolution priority and the ad-hoc sync flow triggered by the dashboard and per-user sync buttons.

### Plex matching

Hubarr tries to match watchlist items against Plex library items so it can tell whether something is already available locally.

### Collection publishing

Hubarr creates and updates Plex collections, applies Hubarr labels, configures sort behavior, and publishes those collections into Plex hubs.

### Frontend freshness

Hubarr's frontend uses page-level polling for views that need to reflect
background sync and scheduler changes while they are open. Polling pauses when
the tab is hidden, avoids overlapping requests, and uses faster intervals while
the page is showing active work.

### Seerr integration

When enabled, Hubarr connects to a Seerr instance and turns missing watchlist items into Seerr requests. Each user can be linked to a Seerr account — matched automatically by username or mapped manually. Requests are attributed to the watchlist owner, with an optional Hubarr service account handling execution. See [docs/seerr.md](seerr.md) for full details.

### Visibility isolation

Hubarr rewrites Plex shared-user content filters so tracked users only see the watchlist rows intended for them, subject to Plex platform limitations.

---

## Important Invariants

- Only enabled users participate in syncing and collection updates
- Matching status is stored per watchlist item
- The dedicated `Collection Sync` job is the scheduled path for collection updates; RSS and GraphQL syncs also trigger an immediate collection publish when they detect changes, so Plex collections stay current without waiting for the next scheduled job
- Startup Sync (when enabled) runs three steps in order:
  1. `Plex Full Library Scan`
  2. `Watchlist GraphQL Sync`
  3. `Collection Sync`
- The Activity Cache is also fetched at startup independently of the Startup Sync sequence
- Job last-run state is persisted so the Jobs page stays truthful across restarts
