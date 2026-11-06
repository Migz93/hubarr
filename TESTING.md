<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Testing

Hubarr has two test layers. [Playwright](https://playwright.dev/) end-to-end
tests run against a **live, fully set-up Hubarr instance** with no test
database, so you need a running app with a real Plex connection before they are
meaningful. A few tests stub individual browser requests to set up states a live
instance can't produce on demand, such as a failed session check or a running
sync in History. Server tests that need persistence use a throwaway SQLite database,
with external services replaced by fakes where needed.

## Docker Pull Request Checks

| Workflow check | What it checks |
|---|---|
| Docker AMD64 build and startup | Production Docker build, fresh unconfigured startup, container health and HTTP endpoint, SQLite native module, writable `/config`, and non-root app process |
| Docker ARM64 build | Production Docker build under QEMU for `linux/arm64`; startup is not tested |

These run automatically on pull requests without publishing images. Builds need
network access to container registries and apt/npm package sources. The startup
smoke test uses an unconfigured instance and does not call configured
integrations. See [Docker Pull Request Checks](docs/workflow.md#docker-pull-request-checks)
for runner, diagnostics, and coverage details. Configured end-to-end tests remain
separate.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs all server tests; persistence-dependent tests use a throwaway SQLite database |
| `npm run test:e2e` | Runs all Playwright tests (auth check + full suite) |
| `npm run test:e2e:auth` | Runs the auth setup step only |
| `npm run check` | Runs TypeScript checks for the client, shared types, and server |
| `npm run lint` | Runs ESLint across the repo |
| `npm run build` | Builds the Vite client and TypeScript server |

## Server Tests

Run all server tests with:

```bash
npm test
```

The test files use Node's built-in test runner through `tsx`. Tests that need
persistence create an isolated SQLite database in a temporary directory, which
is removed after the test completes. They do not require a running Hubarr
instance, Plex, or Seerr, and are safe to run locally and in CI.

## Playwright End-To-End Tests

### Reaching the App From a Devcontainer

If the app runs on the Docker host, set `BASE_URL` in `.env.playwright` to
the app's published URL on a hostname or address reachable from the
devcontainer. Use the published port from Project Facts or the configured
reverse proxy. Inside a devcontainer, `localhost` refers to that container.
Verify connectivity from the devcontainer before running the suite.

For a loopback-only host port, use an existing reachable reverse proxy or
forward the port over SSH. For a manual browser check, run the SSH local
forward on your browser machine. For Playwright, the forward must listen
inside the devcontainer, for example
`ssh -N -L 127.0.0.1:<local-port>:127.0.0.1:<host-port> <docker-host>`
from the devcontainer if it already has authorized SSH access. Set
`BASE_URL` to the forwarded URL. Keep the host port bound to loopback.

Use the same app URL in your browser to obtain the session cookie. When the
URL changes, clear `tests/playwright/.auth/storageState.json` and set a fresh
`SESSION_COOKIE` for the new URL before rerunning the auth setup.

### First-Time Setup

1. Copy the env template:

   ```bash
   cp .env.playwright.example .env.playwright
   ```

2. Edit `.env.playwright` and set `BASE_URL` to your running instance:

   ```
   BASE_URL=http://your-hubarr-host:9301
   ```

3. Grab your session cookie from the browser:
   - Open your Hubarr instance in Chrome or Firefox
   - DevTools → Application → Cookies → find `hubarr_session`
   - Copy the **Value** and paste it into `.env.playwright`:

   ```
   SESSION_COOKIE=<paste here>
   ```

4. Run the tests:

   ```bash
   npm run test:e2e
   ```

The first run validates the cookie and saves the session to
`tests/playwright/.auth/storageState.json` (gitignored). All subsequent runs
reuse the saved session automatically.

### Re-Authenticating

When your session expires, the auth setup will tell you. Clear the saved session
and re-run with a fresh cookie:

```bash
rm tests/playwright/.auth/storageState.json
# Update SESSION_COOKIE in .env.playwright with a fresh value, then:
npm run test:e2e
```

### Generated Files

Playwright-generated files are kept under `tests/` so the repo root stays tidy.
All are gitignored:

- `tests/playwright/.auth/storageState.json` — saved authenticated session state
- `tests/test-results/` — Playwright run artifacts
- `tests/playwright-report/` — Playwright HTML report output

### Rate limiting

The app's rate limits live in `src/server/rate-limit.ts`, which is shared
unchanged across the Migz93 self-hosted apps. There are two limiters: 3,000
requests per minute per client IP across the app, and 10 failed sign-in
attempts per 15 minutes. Built assets (`/assets/`), cached images (`/images/`)
and `/favicon.ico` don't count toward the global limit, so a full Playwright
run stays well under it.

If several unrelated pages suddenly fail together with "Too many requests",
something is making far more requests than expected. Look for a polling loop
or a new route that bypasses the exemptions rather than rerunning the suite.

### Devcontainer Note

Run tests inside the Hubarr devcontainer. Because the devcontainer
has no display, a headed browser window cannot be opened — which is why auth uses
the `SESSION_COOKIE` env var rather than a Playwright-driven OAuth flow.

Elsewhere the suite still runs, as long as `BASE_URL` points at a reachable
instance.

---

## Test Suite

### Server tests

| File | What it checks |
|---|---|
| `tests/server/collection-artwork.test.ts` | Generated collection posters are Plex poster-sized JPEGs and vary by media type |
| `tests/server/collection-order-validation.test.ts` | Collection ordering is republished when live order drifts, and validation failures retain retry state and history |
| `tests/server/config.test.ts` | Runtime log-level configuration accepts supported levels and safely falls back for invalid values |
| `tests/server/dashboard.test.ts` | Dashboard GUID merge chains collapse duplicates without merging movies and shows |
| `tests/server/disabled-user-cleanup.test.ts` | Disabled-user collection cleanup handles Plex, database-only fallback, bulk scans, and deletion failures safely |
| `tests/server/history-progress.test.ts` | Running history summaries refresh and activity filtering separates changes from no-change runs |
| `tests/server/identifiers.test.ts` | Media identifier aliases seed and resolve canonical, discover, and GUID lookups |
| `tests/server/isolation-filter-skip.test.ts` | Isolation filters skip, rerun, reset state, and record failures correctly |
| `tests/server/maintenance.test.ts` | Maintenance removes orphaned poster cache rows while preserving active cache entries |
| `tests/server/logs-endpoint.test.ts` | Log-viewer fallback honors both the configured log level and the requested UI filter |
| `tests/server/plex-reorder.test.ts` | Plex collection reordering progressively retries until the requested order converges |
| `tests/server/plex-user-discovery.test.ts` | Plex user discovery includes shared users resolved through the Community API and falls back to friends when the broader account list is unavailable |
| `tests/server/rate-limit.test.ts` | Global and sign-in rate limiters: exempt paths aren't counted, the request past each limit gets a JSON 429, only failed sign-ins count, and one warning is logged per client per window |
| `tests/server/seerr-work.test.ts` | Seerr work only counts linked users with automatic requests enabled |
| `tests/server/watchlist-grouping.test.ts` | Watchlist grouping merges compatible GUID chains once and orders paginated results deterministically |

### `tests/playwright/pages.spec.ts` — Page smoke tests

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Dashboard loads | Navigates to `/dashboard`, asserts the "Dashboard" heading is visible |
| Watchlists loads | Navigates to `/watchlists`, asserts the "Watchlists" heading is visible |
| Users loads | Navigates to `/users`, asserts the "Users" heading is visible |
| History loads | Navigates to `/history`, asserts the "History" heading is visible |
| Settings loads | Navigates to `/settings`, asserts the "Settings" heading is visible |
| Sidebar navigation links are present | On the dashboard, checks all five nav links exist inside `<nav>` (scoped to avoid false matches from dashboard stat chips which share label names) |
| Sidebar navigation works | Clicks each sidebar link in turn and verifies the URL and page heading update correctly |
| Mobile navigation closes from its backdrop or Escape and returns focus to its trigger | Verifies the closed small-screen drawer is inert, the open drawer inerts page content, viewport changes close it without reopening, and either dismissal path restores the menu-button focus |
| Unauthenticated request redirects to login | Opens a fresh browser context with no session cookies and navigates to `/dashboard`, expects a redirect to `/login` |
| Failed session check shows a retry screen, not the login page | Fakes a 429 on `/api/auth/session` in the browser, navigates to `/settings`, expects the "Unable to load Hubarr" error with no Plex login button and the URL unchanged; clicking Retry once the request succeeds loads Settings |

---

### Onboarding flow

Not covered by automated tests (requires a fresh unconfigured instance). The flow has four steps:

| Step | What it covers |
|---|---|
| 1 — Auth | Plex OAuth sign-in |
| 2 — Configure Plex | Server URL, port, SSL, and library selection |
| 3 — General | Track All Users and Startup Sync toggles |
| 4 — Collections | Collection name pattern and sort order |

Step order is enforced server-side by `getCurrentOnboardingStep` in `src/server/db/settings.ts`.

---

### `tests/playwright/settings.spec.ts` — Settings tabs

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| All seven tabs are visible | Navigates to `/settings`, asserts all seven tab buttons (General, Plex, Collections, Seerr, Logs, Jobs, About) are rendered |
| Clicking a tab updates the URL | Clicks Plex, Jobs, and About tabs in turn; asserts the URL gains the expected `?tab=` parameter |
| General tab shows Track All Users, Startup Sync, and History Retention controls | Navigates to `/settings?tab=general`, waits for load, asserts all three setting labels are visible |
| Jobs tab shows the jobs table | Navigates to `/settings?tab=jobs`, asserts the "Job Name" column header is visible |
| Jobs tab lists the Maintenance Tasks job | Navigates to `/settings?tab=jobs`, asserts the `Maintenance Tasks` row is present with its daily schedule and `Run Now` button |
| About tab shows version and support info | Navigates to `/settings?tab=about`, asserts "About Hubarr" and "Version" headings are visible |
| Collections tab shows watchlisted date sort options | Navigates to `/settings?tab=collections`, asserts the ordering `<select>` contains the "Watchlisted Date (New to Old)" and "Watchlisted Date (Old to New)" options |

---

### `tests/playwright/users.spec.ts` — Users page structure

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Active users section heading is visible | Asserts the "Active (N)" heading renders |
| Disabled users accordion toggle is visible | Asserts the "Disabled (N)" toggle button renders |
| Disabled users never show a Sync Watchlist button | Expands the disabled users section and asserts no `Sync Watchlist` button is rendered there |
| Refresh Users button is present | Asserts the Refresh Users button renders |
| Edit modal shows collection ordering override section | Clicks the first user's edit button, asserts the "Collection Ordering" section is visible in the modal, and that the dropdown contains the two watchlist date sort options |
| Edit modal traps focus and restores the trigger after Escape | Opens the edit modal, verifies Tab wraps within it, then verifies Escape returns focus to the edit trigger |
| Watchlist tab is only available when editing the self user | Opens the self user edit modal and asserts the Watchlist tab is present, then opens a non-self user when available and asserts the tab is absent |
| Self Watchlist tab shows cleanup options without changing them | Opens the self user edit modal, navigates to Watchlist, and asserts both cleanup options and explanatory text are visible without saving |
| Watchlist Cleanup job is enabled when cleanup settings are already enabled | Reads current settings; if cleanup is already enabled, verifies the Jobs row is enabled, otherwise skips without changing settings |

---

### `tests/playwright/posters.spec.ts` — Image cache

Tests that cached images are served correctly from `/images/`, that the route is protected, and that user avatars load. Images are cached at sync time — tests log and skip gracefully if no images have been cached yet (run a full sync first).

| Test | What it checks |
|---|---|
| `/images/` route requires authentication | Opens a fresh context with no session and requests `/images/test.jpg` — expects a 401 or redirect to login |
| Dashboard recently added posters all load | Waits for the dashboard to finish loading, then checks every `img.object-cover[src*='/images/']` has loaded successfully (`complete && naturalWidth > 0`) |
| Watchlists page 1 posters all load | Same check on the first page of the Watchlists grid |
| Users page avatar images load from /images/ or show fallback | Checks every `img[src*='/images/']` on the Users page has loaded successfully |

---

### `tests/playwright/history.spec.ts` — History filters

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Type filter buttons are all visible | Verifies the history type filter includes All, GraphQL, RSS, Manual, and Collection |
| Status filter buttons are all visible | Verifies the status filter includes All, Success, Error, and Running |
| Activity filter buttons are all visible | Verifies the activity filter includes All, Changes, and No Changes |
| Activity filter starts with All | Verifies the activity filter order is All, Changes, then No Changes |
| Page size select is visible | Verifies the history page-size selector is rendered |
| RSS type filter updates URL | Clicks the RSS type filter and verifies `?type=rss` appears in the URL |
| Success status filter updates URL | Clicks the Success status filter and verifies `?status=success` appears in the URL |
| No Changes activity filter updates URL | Clicks the No Changes activity filter and verifies `?activity=no_changes` appears in the URL |
| All activity filter updates URL | Clicks the All activity filter and verifies `?activity=all` appears in the URL |

---

### `tests/playwright/live-refresh.spec.ts` — Live refresh behaviour

These tests trigger real background work and verify that the open page updates
without a browser reload. They are not read-only.

| Test | What it checks |
|---|---|
| Dashboard recent syncs updates after a background collection sync starts and finishes | Opens `/dashboard`, triggers the collection-sync job through the API, and verifies the `Recent Syncs` panel first shows a running Publish entry and then updates to the finished summary without a reload |
| History shows a new collection sync row move from running to its terminal status without reload | Opens `/history`, triggers the collection-sync job through the API, and verifies the newest row appears as running and then changes to its final status/summary automatically |
| Jobs shows a scheduler-managed job running and then returning to Run Now after polling catches completion | Opens `Settings > Jobs`, clicks `Run Now` for `Collection Sync`, verifies the row enters a running state, and then returns to idle with an updated terminal status once the job finishes |

---

### `tests/playwright/history-background-refresh.spec.ts` — History background polling

Read-only. Safe to run against a live instance. These tests stub the History API
responses in-browser so they can verify polling behaviour without triggering real
jobs on the server.

| Test | What it checks |
|---|---|
| Running history rows show `Just now` and live elapsed text | Opens `/history` with a stubbed running sync and verifies the row shows capitalised relative time plus a live `Running for ...` duration |
| History list keeps polling while the tab is hidden when a run is active | Opens `/history` with a stubbed running sync, switches to another tab, and verifies the hidden History page still polls `/api/history` |
| Expanded history details keep polling while the tab is hidden when a run is active | Expands a stubbed running History row, switches to another tab, and verifies the hidden page keeps polling `/api/history/:runId` for updated details |
| Expanded errors stay collapsed by default and grouped steps render readable labels | Opens a stubbed failed History run, verifies the errors section stays collapsed initially, and checks that repeated low-level steps render as grouped human-readable labels |
| RSS runs show feed checks and descriptive item labels | Opens a stubbed RSS History run and verifies feed-check steps and found-item labels render instead of a generic empty-details state |

---

### `tests/playwright/seerr.spec.ts` — Seerr integration

Read-only. Safe to run against a live instance whether or not Seerr is configured.
Tests that depend on Seerr being enabled are skipped gracefully when the
integration is off.

| Test | What it checks |
|---|---|
| Seerr tab button is visible | Navigates to `/settings`, asserts the "Seerr" tab button is rendered |
| Clicking the Seerr tab updates the URL | Clicks the Seerr tab and asserts the URL gains `?tab=seerr` |
| Seerr tab loads without error and shows the connection form | Navigates to `/settings?tab=seerr`, asserts the "Seerr Integration" section, base URL field, and "Test Connection" button are visible |
| Seerr tab shows the Behaviour section with request toggles | Navigates to `/settings?tab=seerr`, asserts the "Behaviour" divider and "Automatic Requests" and "Use Hubarr Service Account" toggles are visible |
| Seerr action labels render correctly when stubbed into the history API | Stubs the History API with a run containing Seerr step entries and verifies the readable labels "Seerr request created", "Already in Seerr", and "Seerr request skipped" appear in the expanded details |
| Edit modal Seerr section visibility matches the Seerr enabled state | Reads current settings to determine whether Seerr is enabled; opens the first user's edit modal and asserts that the Seerr tab is present (or absent) accordingly |

---

## Adding New Tests

Which layer to reach for — server test or Playwright — is covered in `AGENTS.md`
under Tests. Mechanically:

- **Playwright:** create a `*.spec.ts` file in `tests/playwright/` and it is picked
  up automatically. The saved session in `storageState.json` is loaded for every
  test, so all tests start already authenticated.
- **Server tests:** create a `*.test.ts` file in `tests/server/`. It is picked
  up automatically by `npm test`; use the existing test database and helper
  modules to keep tests isolated from external services.

When a test is agreed and written, add a row for it in the relevant table above.

## Manual Smoke Test

1. In the app's devcontainer, run the checks listed in Project Facts in
   [AGENTS.md](AGENTS.md#project-facts) and any tests relevant to the change. On the Docker host, build the production image
   from that same checkout with a unique candidate tag. Record the source revision and the
   resulting image ID.
2. Start that image ID in a disposable container named `zdev-<app>-smoke-<id>`,
   using the app name and a unique test ID. Use bridge networking and fresh
   writable storage at `/config`, such as tmpfs or an
   anonymous volume. Use no live data mounts, live integration credentials,
   or restart policy. For a browser outside Docker, use a separate loopback
   port and forward it as described above. For Playwright in a devcontainer,
   use the smoke container's address and app port on a shared private bridge
   when reachable, or use the loopback tunnel from inside the devcontainer.
   For startup and health checks alone, leave the port unpublished.
3. Wait for Docker health and check that `GET /api/health` returns HTTP 200.
   Verify that the app runs as a non-root user. Exercise the changed behaviour
   where possible with disposable data or mocked integrations. Record which
   checks require real configuration or data. Collect sanitized failure
   evidence if needed and remove the disposable container and storage in
   either case.
4. After the required checks pass, deploy the exact tested image ID to the
   live app by default for implementation work. Stop at validation when the
   owner requests it. A failed required check stops the flow before replacement.

### Live replacement and verification

Record the current image ID and runtime settings, including the data mount,
port mapping, network, restart policy, overrides and deployment method. Remove
the disposable smoke-test container before replacing the live app.

- For a standalone deployment, stop and remove the current live container
  while preserving its data. Start the exact tested image under the original
  live name with the recorded settings.
- For a Compose deployment, record the Compose project, config files and
  runtime overrides. In a persistent deployment-local Compose override
  outside the Git checkout, set the service image to the tested image's
  unique local tag and set `pull_policy: never`. Clear any inherited
  `build` section with `build: !reset null`. Add that override last, keeping
  the existing files and project settings. Check that the merged service has
  no build configuration and that the local tag resolves to the tested image
  ID. Stop and remove the old service container through Compose, preserving
  its data. Recreate only that service through Compose with pulls and builds
  disabled. Use the same file list and project settings for subsequent
  operations so the service continues to use the tested image.

Verify the image ID, Docker health, HTTP health, and relevant app behaviour.
If verification fails, report the failure and keep the prior image available.
For an approved rollback with compatible live data, recreate from the prior
image and settings through the same deployment method. For Compose, update the
persistent image override to the prior image before recreating the service.
Repeat the health checks.

Check configured behaviour separately from disposable startup. When relevant,
verify that the dashboard and Settings load, that unauthenticated routes return
the expected status, and that the changed feature works with the live
configuration. Run a real sync or another operation that changes live data only
when authorized. Report the limits of testing against existing data and real
integrations.
