# Technical Docs

This folder is Hubarr's long-term technical reference area.

Use these docs for implementation details, subsystem behavior, and architecture
notes that should stay useful after the branch or issue that introduced them is
long gone.

## What's Here

- [architecture.md](architecture.md) — high-level system shape, core
  invariants, deployment model, and the main subsystems that make Hubarr work
- [sync.md](sync.md) — background jobs, startup sequencing, terminology, sync
  orchestration, and how history/jobs/logs fit together
- [watchlist.md](watchlist.md) — deep reference for watchlist ingestion,
  GraphQL/RSS/activity-cache behavior, date resolution, and sync flows
- [image-caching.md](image-caching.md) — poster/avatar caching design, stale
  refresh behavior, storage model, and cache lifecycle details
- [maintenance.md](maintenance.md) — scheduled housekeeping tasks, current
  cleanup responsibilities, and how to add new maintenance work safely

## When To Read Which Doc

- Start with [architecture.md](architecture.md) if you need the big-picture
  mental model before touching the code.
- Read [sync.md](sync.md) when changing scheduled jobs, startup behavior, or
  how work moves through the system.
- Read [watchlist.md](watchlist.md) when changing watchlist fetching, matching,
  `addedAt` handling, or collection publish triggers.
- Read [image-caching.md](image-caching.md) when changing poster/avatar fetch,
  storage, refresh, or serving behavior.
- Read [maintenance.md](maintenance.md) when adding background cleanup,
  consistency checks, pruning, or other housekeeping tasks.

## Maintenance Rule

When a major feature or long-lived internal behavior changes, update the
relevant doc in this folder in the same branch/PR. If no existing doc fits, add
a new topic doc here and link it from this index.
