# Hubarr Architecture Overview

## What Hubarr Is

Hubarr is a single-purpose Plex companion app.

It tracks the owner's Plex watchlist and selected friends' watchlists, stores that watchlist state locally, matches items against Plex libraries, and keeps per-user Plex collections and hub rows up to date.

Hubarr does not request or download media.

## Core Model

- Plex is the source of truth for watchlists
- Hubarr is the source of truth for cached watchlist state, job history, and collection sync state
- Each enabled user gets one movie collection and one TV collection
- Both collections share the same visible name for that user
- Hubarr is a single-owner app: the first Plex account to onboard becomes the only admin

## Deployment Model

Hubarr runs as a single self-hosted container:

- Express backend and API
- React frontend
- background job scheduler
- Plex integration layer
- SQLite database
- log file output

Persistent data is stored in `/config`.

## Database Migrations

Hubarr uses SQLite `PRAGMA user_version` for schema migrations.

- Versioned migrations live in `src/server/db/migrations.ts`
- The current baseline schema is migration `1`
- `runMigrations(db)` runs on startup, applies any migration whose version is higher than the current `user_version`, and advances `user_version` after each successful migration
- Each migration runs inside a transaction so a failure should leave the database unchanged

When changing the schema in the future:

1. Add a new migration entry with the next integer version
2. Write the schema change in that migration's `up(db)` function
3. Do not edit older migrations that may already have shipped
4. Keep default-setting seeding separate from schema migrations

## Auth And Setup

- Authentication is Plex-only OAuth
- No local password login exists
- The owner record is persisted after first setup
- Setup flow is:
  1. log in with Plex
  2. choose the Plex server
  3. discover and enable users
  4. configure target libraries and visibility defaults

## Major Subsystems

### Watchlist ingestion

Hubarr ingests watchlist state through:

- Watchlist RSS Sync for fast updates
- Watchlist GraphQL Sync for scheduled reconciliation

### Plex matching

Hubarr tries to match watchlist items against Plex library items so it can tell whether something is already available locally.

### Collection publishing

Hubarr creates and updates Plex collections, applies Hubarr labels, configures sort behavior, and publishes those collections into Plex hubs.

### Visibility isolation

Hubarr rewrites Plex shared-user content filters so tracked users only see the watchlist rows intended for them, subject to Plex platform limitations.

## Important Invariants

- Only enabled users participate in syncing and collection updates
- Matching status is stored per watchlist item
- Collection updates happen in the dedicated `Collection Sync` job
- Startup Sync runs three steps in order:
  1. `Plex Full Library Scan`
  2. `Watchlist GraphQL Sync`
  3. `Collection Sync`
- Job last-run state is persisted so the Jobs page stays truthful across restarts
