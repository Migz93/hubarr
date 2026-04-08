# Contributing

Thanks for taking an interest in Hubarr.

## Workflow

Hubarr uses a simple branch flow:

- `develop` for normal feature work and bug fixes
- `main` for stable, release-ready code
- release tags like `vX.Y.Z` are created from `main`

Unless a maintainer asks otherwise, please target `develop`.

## Pull Requests

Please keep pull requests focused and practical.

- Use semantic PR titles such as `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, or `ci:`
- Explain what changed and why
- Mention anything a reviewer should verify
- Call out release, Docker, auth, or schema impact when relevant

## Local Development

Requirements:

- Node.js 22
- npm

Useful commands:

```bash
npm ci
npm run check
npm run build
npm run dev
```

The app is designed to run with persistent data stored under `/config` in containers. For local Docker-based runs, follow the setup guidance in the README.

## Testing

Hubarr uses [Playwright](https://playwright.dev/) for end-to-end tests. Tests run against a **live, fully set-up Hubarr instance** — there is no mocking or test database. This means you need a running app with a real Plex connection before the tests are useful.

### First-time setup

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

   The first run validates the cookie and saves the session to `tests/playwright/.auth/storageState.json` (gitignored). All subsequent runs reuse the saved session automatically.

### Re-authenticating

When your session expires, the auth setup will tell you. Clear the saved session and re-run with a fresh cookie:

```bash
rm tests/playwright/.auth/storageState.json
# update SESSION_COOKIE in .env.playwright with a fresh value
npm run test:e2e
```

### Commands

| Command | What it does |
|---|---|
| `npm run test:e2e` | Run all tests (auth check + test suite) |
| `npm run test:e2e:auth` | Run the auth setup step only |

### What is tested

| File | Tests |
|---|---|
| `tests/playwright/pages.spec.ts` | Every main page loads, sidebar links are present and navigate correctly, unauthenticated requests redirect to login |

Tests are read-only and safe to run against a live instance. Adding more test files follows the same pattern — create a `*.spec.ts` file in `tests/playwright/` and it will be picked up automatically.

### Devcontainer note

The tests run inside the VS Code devcontainer. Because the devcontainer has no display, a headed browser window cannot be opened — which is why auth uses the `SESSION_COOKIE` env var rather than a Playwright-driven OAuth flow.

---

## Coding Notes

- Keep changes scoped to the task at hand
- Avoid committing generated output or local-only files
- Prefer updating docs when behavior or setup changes
- If you change release behavior, workflows, Docker publishing, auth, or setup, mention that clearly in the PR

## Reporting Bugs And Requesting Features

If the repository has Discussions or issue templates enabled, use those first. Otherwise, open a clear issue with reproduction steps, expected behavior, and any relevant logs or screenshots.
