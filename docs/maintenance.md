<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Maintenance

## Current Housekeeping Responsibilities

Hubarr has a dedicated `Maintenance Tasks` background job for housekeeping work
that should run automatically but does not need to happen inline with a user
flow or sync pass.

| Job | Schedule | What it does |
|---|---|---|
| `Maintenance Tasks` | Daily at 05:30 | Image-cache cleanup for watchlist posters |

The job is surfaced in **Settings → Jobs**, persists its last-run state like the
other scheduler-managed jobs, and can be triggered manually with `Run Now`.

Poster cleanup does three things:

1. Find `image_cache` rows where `kind = 'poster'` and `entity_id` no longer
   matches any current `watchlist_cache.plex_item_id`
2. Delete those orphaned metadata rows
3. Prune any local files in `/config/image-cache/` that are no longer referenced
   by a remaining `image_cache.local_web_path`

This keeps watchlist-owned derived poster data aligned with the current watchlist
state without touching unrelated caches such as avatars or
`watchlist_activity_cache`.

The flow is layered deliberately:

| Layer | Owns |
|---|---|
| `src/server/services.ts` | The top-level `runMaintenanceTasks()` workflow and job-level logging |
| `src/server/image-cache.ts` | Image-cache-specific maintenance steps |
| `src/server/db/image-cache.ts` | The SQL that identifies and deletes orphaned poster rows |

That split keeps the scheduler job generic while letting each subsystem own its
own cleanup logic.

## Data Retention

| Data | Retained | Controlled by |
|---|---|---|
| History runs | Configurable | **Settings → General → History Retention** |
| Poster cache | Until the watchlist item disappears | `Maintenance Tasks`, daily |
| Avatar cache | Not pruned | — |
| `watchlist_activity_cache` | Not pruned | — |

## Adding New Maintenance Work

When adding a new cleanup or consistency task:

1. Decide whether the work is true maintenance. Use this job for cleanup,
   pruning, retention, repair, or consistency checks that can safely happen
   later. Do not put user-visible sync logic here if it needs to happen
   immediately to keep core state correct.
2. Make it idempotent.
3. Add the subsystem-specific logic near the subsystem that owns the data. Image
   cache cleanup belongs in `image-cache.ts`, not as raw SQL inside the scheduler
   registration.
4. Call that logic from `HubarrServices.runMaintenanceTasks()`.
5. Add structured logs around start, finish, skipped work, and failures, with
   counts for anything removed. Use `debug` when there was nothing to do, and
   `warn` or `error` when cleanup fails or only partially succeeds.
6. Add or update tests that prove the task removes only the intended data.
7. Update this doc if the maintenance job gains a new responsibility.

## Safety Rules

- Never prune a cache entry that current state still references. Orphan detection
  is the gate, not age.
- Treat failed Plex or Seerr calls as a reason to skip or warn, not as a reason
  to force cleanup.
- Keep housekeeping visible in the logs without making them noisy when the system
  is already clean.
- `Maintenance Tasks` is a bucket for scheduled housekeeping, not a place to hide
  unstructured miscellaneous logic. Each task should have one clear owner, an
  explicit scope, and tests where practical.
