# Maintenance Tasks

This document describes Hubarr's maintenance job, what it is responsible for,
and how to add new maintenance work in the future.

## Overview

Hubarr has a dedicated `Maintenance Tasks` background job for housekeeping work
that should run automatically but does not need to happen inline with a user
flow or sync pass.

Current schedule:

- `Maintenance Tasks` — daily at `5:30 AM`

The job is surfaced in `Settings → Jobs`, persists its last-run state like the
other scheduler-managed jobs, and can also be triggered manually with `Run Now`.

## Current Tasks

At the moment the maintenance job performs image-cache cleanup for watchlist
posters:

1. Find `image_cache` rows where:
   - `kind = 'poster'`
   - `entity_id` no longer matches any current `watchlist_cache.plex_item_id`
2. Delete those orphaned metadata rows.
3. Prune any local files in `/config/image-cache/` that are no longer
   referenced by any remaining `image_cache.local_web_path`.

This keeps watchlist-owned derived poster data aligned with the current
watchlist state without touching unrelated caches such as avatars or
`watchlist_activity_cache`.

## How It Fits Together

The maintenance flow is intentionally layered:

- `src/server/services.ts`
  owns the top-level `runMaintenanceTasks()` workflow and job-level logging
- `src/server/image-cache.ts`
  owns image-cache-specific maintenance steps
- `src/server/db/image-cache.ts`
  owns the SQL that identifies and deletes orphaned poster rows

That split keeps the scheduler job generic while still letting each subsystem
own its own cleanup logic.

## Logging Expectations

Maintenance work should be observable in production.

For each task:

- log when the overall maintenance job starts and finishes
- log meaningful counts for rows/files/items removed
- use `debug` when nothing needed to be done
- use `warn` or `error` when cleanup fails or only partially succeeds

The goal is to make housekeeping visible without making the logs noisy when the
system is already clean.

## Adding New Maintenance Tasks

When adding a new maintenance task in the future:

1. Decide whether the work is true maintenance.
   Use this job for cleanup, pruning, retention, repair, or consistency checks
   that can safely happen later. Do not put user-visible sync logic here if it
   needs to happen immediately to keep core state correct.
2. Add the subsystem-specific logic near the subsystem that owns the data.
   For example, image-cache cleanup belongs in `image-cache.ts`, not as raw SQL
   directly inside the scheduler registration.
3. Call that logic from `HubarrServices.runMaintenanceTasks()`.
4. Add intentional logging with counts and outcomes.
5. Add or update tests that prove the task removes only the intended data.
6. Update this document if the maintenance job gains a new responsibility.

## Design Rule

`Maintenance Tasks` is a bucket for scheduled housekeeping, not a place to hide
unstructured miscellaneous logic.

Each task should still have:

- one clear owner
- explicit scope
- tests where practical
- docs when the behavior is long-lived or non-obvious
