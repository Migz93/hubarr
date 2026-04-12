# Testing

Hubarr uses [Playwright](https://playwright.dev/) for end-to-end tests. Tests run against a **live, fully set-up Hubarr instance** — there is no mocking or test database. You need a running app with a real Plex connection before the tests are meaningful.

## First-time setup

1. Copy the env template:
   ```bash
   cp .env.playwright.example .env.playwright
   ```

2. Edit `.env.playwright` and set `BASE_URL` to your running instance:
   ```
   BASE_URL=http://your-hubarr-host:3000
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

   The first run validates the cookie and saves the session to `tests/playwright/.auth/storageState.json` (gitignored). Test run artifacts are written to `tests/test-results/` (also gitignored). All subsequent runs reuse the saved session automatically.

## Re-authenticating

When your session expires, the auth setup will tell you. Clear the saved session and re-run with a fresh cookie:

```bash
rm tests/playwright/.auth/storageState.json
# Update SESSION_COOKIE in .env.playwright with a fresh value, then:
npm run test:e2e
```

## Generated test files

Playwright-generated files are kept under `tests/` so the repo root stays tidy:

- `tests/playwright/.auth/storageState.json` — saved authenticated session state
- `tests/test-results/` — Playwright run artifacts
- `tests/playwright-report/` — Playwright HTML report output

Both are gitignored.

## Commands

| Command | What it does |
|---|---|
| `npm run test:e2e` | Run all tests (auth check + full suite) |
| `npm run test:e2e:auth` | Run the auth setup step only |

## Devcontainer note

The tests run inside the VS Code devcontainer. Because the devcontainer has no display, a headed browser window cannot be opened — which is why auth uses the `SESSION_COOKIE` env var rather than a Playwright-driven OAuth flow.

## Adding new tests

Create a `*.spec.ts` file in `tests/playwright/` and it will be picked up automatically. The saved session in `storageState.json` is loaded for every test, so all tests start already authenticated.

---

## Test suite

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
| Unauthenticated request redirects to login | Opens a fresh browser context with no session cookies and navigates to `/dashboard`, expects a redirect to `/login` |

---

### `tests/playwright/settings.spec.ts` — Settings tabs

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| All six tabs are visible | Navigates to `/settings`, asserts all six tab buttons (General, Plex, Collections, Logs, Jobs, About) are rendered |
| Clicking a tab updates the URL | Clicks Plex, Jobs, and About tabs in turn; asserts the URL gains the expected `?tab=` parameter |
| General tab shows Startup Sync toggle and History Retention field | Navigates to `/settings?tab=general`, waits for load, asserts both setting labels are visible |
| Jobs tab shows the jobs table | Navigates to `/settings?tab=jobs`, asserts the "Job Name" column header is visible |
| About tab shows version and support info | Navigates to `/settings?tab=about`, asserts "About Hubarr" and "Version" headings are visible |
| Collections tab shows watchlisted date sort options | Navigates to `/settings?tab=collections`, asserts the ordering `<select>` contains the "Watchlisted Date (New to Old)" and "Watchlisted Date (Old to New)" options |

---

### `tests/playwright/users.spec.ts` — Users page structure

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Active users section heading is visible | Asserts the "Active (N)" heading renders |
| Disabled users accordion toggle is visible | Asserts the "Disabled (N)" toggle button renders |
| Refresh Users button is present | Asserts the Refresh Users button renders |
| Edit modal shows collection ordering override section | Clicks the first user's edit button, asserts the "Collection Ordering" section is visible in the modal, and that the dropdown contains the two watchlist date sort options |

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

### `tests/playwright/live-refresh.spec.ts` — Live refresh behavior

These tests trigger real background work and verify that the open page updates
without a browser reload. They are not read-only.

| Test | What it checks |
|---|---|
| Dashboard recent syncs updates after a background collection sync starts and finishes | Opens `/dashboard`, triggers the collection-sync job through the API, and verifies the `Recent Syncs` panel first shows a running Publish entry and then updates to the finished summary without a reload |
| History shows a new collection sync row move from running to its terminal status without reload | Opens `/history`, triggers the collection-sync job through the API, and verifies the newest row appears as running and then changes to its final status/summary automatically |
| Jobs shows a scheduler-managed job running and then returning to Run Now after polling catches completion | Opens `Settings > Jobs`, clicks `Run Now` for `Collection Sync`, verifies the row enters a running state, and then returns to idle with an updated terminal status once the job finishes |
