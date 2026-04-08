# Agent Guidelines — Docker Outside of Docker

You are running inside a VS Code devcontainer. Read this file before doing any Docker-related work.

> If a `LOCAL.md` file exists in this directory, read it — it contains environment-specific setup details for this machine. If it doesn't exist, ignore this note.

## Your environment

- You are inside a devcontainer, not on the host machine directly.
- You have access to the host's Docker daemon via Docker-outside-of-Docker (DooD). You can run `docker` and `docker compose` commands normally.
- You **cannot** browse the host filesystem. Paths like `/opt/...` that you reference in Docker configs exist on the host, not inside this container. Do not try to read or write them — just reference them correctly in your Docker configuration.

## Host filesystem conventions

`/opt` paths exist on the **host only**. The agent runs inside a devcontainer and cannot read, list, or inspect anything under `/opt` — do not attempt to `ls`, `cat`, or browse those paths.

Everything for an app lives under a single directory on the host:

```
/opt/hubarr/
```

All files the app needs — config, database, logs, whatever — go directly in there. Do not create subdirectories like `config/`, `data/`, or `logs/` unless the app itself requires a specific path inside the container. Keep it flat.

## Docker naming conventions

When building images or creating containers for this app, use the app name directly — do not suffix with `-app`, `-container`, `-service`, or similar.

| Thing | Correct | Incorrect |
|---|---|---|
| Image name | `hubarr` | `hubarr-app`, `hubarr-image` |
| Container name | `hubarr` | `hubarr-app`, `hubarr-container` |
| Compose service name | `hubarr` | `app`, `hubarr-service` |

If the app has multiple distinct services (e.g. a frontend and an API), use `hubarr-frontend`, `hubarr-api` etc.

## Bind mounts

Bind-mount the entire app directory from the host into the container as a single volume. Do not use named Docker volumes — the user needs to be able to inspect and edit files directly on the host.

Example docker-compose service:

```yaml
services:
  hubarr:
    image: hubarr
    container_name: hubarr
    volumes:
      - /opt/hubarr:/config
    restart: unless-stopped
```

Map `/opt/hubarr` on the host to whatever path the app expects internally (commonly `/config`, `/data`, `/app`, or similar — check the app's documentation).

## Where your app code is

Your workspace is mounted at `/workspaces/hubarr` inside this container.

## Networking

Always use bridge networking — it is the only mode that works reliably with DooD on this host.

- `docker run`: include `--network bridge`
- Compose services: set `network_mode: bridge`
- `docker build`: do **not** pass `--network`

Do not use `host`, `none`, or custom named networks unless explicitly requested.

## Summary checklist before creating any container

- [ ] Image name matches the app name
- [ ] Container name matches the app name
- [ ] `/opt/hubarr` on the host bind-mounted as a single volume
- [ ] Host directory documented or created in setup steps
- [ ] `--network bridge` / `network_mode: bridge` set

## GitHub Workflow And Release Process

### Before Starting Any Work — Branch Check (Mandatory)

Before writing or editing any code, **always check the current branch** with `git branch --show-current`. Then act on what you find:

| Current branch | Situation | Action |
|---|---|---|
| `develop` | On the integration branch | Create a new `type/description` branch from `develop` and switch to it |
| `main` | On the stable branch | Create a new `type/description` branch from `develop` (not main) and switch to it |
| `feat/*`, `fix/*`, `chore/*` etc. | Already on a work branch | Continue work here — no new branch needed |
| Something unexpected | Unfamiliar branch | Ask the user before proceeding |

Do this **before** making any edits, installs, or file changes. Never start work and then create the branch after the fact.

---

### The Full Development Flow

This is the required workflow for all changes. Follow it every time, in order:

```
type/branch-name branch → PR into develop → develop → chore/bump-version → PR into develop → PR into main → tag → release
```

**Step by step:**

1. **Start a new branch** from `develop` for every piece of work — features, bug fixes, chores, CI changes, everything. Never commit new work directly to `develop` or `main`.
   - Branch naming: `feat/short-description`, `fix/short-description`, `chore/short-description`, `ci/short-description`, `docs/short-description`

2. **Do the work** on that branch. Commit as many times as needed. Push the branch to GitHub.

3. **Open a PR** from that branch into `develop` using `gh pr create`. This is what feeds the release notes — the PR title becomes the changelog entry. Use a semantic title (`feat:`, `fix:`, `chore:`, etc.).

4. **Merge the PR** into `develop`. Delete the branch after merging.

5. **Repeat** steps 1–4 for each piece of work. `develop` accumulates all the merged PRs.

6. **When ready to release**, create a `chore/bump-version-X.Y.Z` branch from `develop`.

7. **Bump the version** in `package.json` and `package-lock.json`, open a PR from that branch into `develop`, and merge it.

8. **Open a PR** from `develop` into `main`. Merge it. This triggers the release-drafter to generate release notes from all the PR titles since the last release.

9. **Tag `main`** with `vX.Y.Z` and push the tag. This triggers the Docker build workflow.

10. **Publish the GitHub release** — review the auto-generated draft and publish it.

---

### How The Agent Should Interpret The User's Instructions

The user will not always use precise git terminology. They may say things like:

- *"that's ready, push it"* — this means push the current branch to GitHub if not already pushed, then open a PR from it into `develop`
- *"commit that to develop"* — this means open a PR into `develop`, not a direct commit
- *"let's get this into develop"* — same as above, open a PR
- *"merge develop into main"* or *"push to main"* — this is a release step, see release flow above

**When the user's instruction is ambiguous**, the agent should either:
- Interpret it charitably as the correct workflow step and proceed, explaining what it's doing ("your workflow says we open a PR to develop from this branch, so I'll do that now"), or
- Push back briefly if genuinely unclear ("just to check — did you want me to open a PR into develop, or push directly? Your workflow normally uses PRs.")

**Never silently commit directly to `develop` or `main`** when the user is describing work on a feature or fix. That bypasses PRs and breaks the release notes.

---

### GitHub CLI Usage

For all GitHub-related work, use `gh` as the default tool. Use it for:

- opening PRs (`gh pr create`)
- checking PR status, checks, and mergeability
- merging PRs (`gh pr merge`)
- inspecting workflow runs and CodeQL alerts
- creating and publishing releases

Prefer `gh` over inferring GitHub state from local git — it gives the authoritative picture of what is open, merged, or failing on GitHub.

---

### Branch Rules Summary

| Branch | Purpose | How things get in |
|--------|---------|-------------------|
| `feat/*`, `fix/*`, `chore/*` etc. | Active work | Direct commits |
| `develop` | Integration | PRs from `feat/*`, `fix/*`, `chore/*`, `ci/*`, `docs/*` etc. |
| `main` | Stable/released | PRs from `develop` only |

- Do not push new feature or fix work directly to `develop` or `main`
- Do not open PRs directly from feature branches into `main`

---

### Pull Request Conventions

- Use semantic PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `ci:`
- Keep descriptions concise: what changed, why, anything to verify
- Call out explicitly if the change affects: release behaviour, Docker publishing, auth, database schema, or user-visible setup

---

### Release Process

When the user says it's time to release:

1. Confirm the version bump size — ask for patch / minor / major if not stated
2. Create a `chore/bump-version-X.Y.Z` branch from `develop`
3. Update `package.json` and `package-lock.json` with the new version
4. Open a PR from that branch into `develop` and merge it
5. Open a PR from `develop` into `main` and merge it
6. Push the tag `vX.Y.Z` from `main`
7. Review the release-drafter draft on GitHub and publish it

**Version files to update:**
- `package.json`
- `package-lock.json`

Note: `src/server/version.ts` reads dynamically from `package.json` at runtime — no separate update needed there.

Do not invent the version — always confirm with the user if ambiguous.

**Tag format:** `vX.Y.Z` — always from `main`, never from `develop`.

---

### Agent Behaviour — Snyk

When working through Snyk findings:

1. **Always explain the finding first** — describe what Snyk flagged, why it flagged it, and whether it is a genuine issue or a false positive before suggesting any action.

2. **Recommend Fix or Won't Fix honestly** — if fixing the issue would require writing worse code (less readable, against best practice, or purely to satisfy static analysis), say so clearly and recommend Won't Fix instead.

3. **When recommending Won't Fix**, always provide:
   - A plain-English comment the user can paste into the Snyk GUI (explaining why the code is safe)
   - The correct Snyk category to select: **Won't Fix** for false positives or deliberate decisions, **Ignore Temporarily** only if there is a genuine plan to revisit

4. **Never suggest a change purely to appease Snyk** if it doesn't improve actual security or code quality.

See `SECURITY.md` for the full Snyk tooling guide, scan commands, and philosophy.

---

### End-to-End Tests — Playwright

See `TESTING.md` for the full setup guide and a description of every test. Key points for the agent:

- Tests live in `tests/playwright/` and run with `npm run test:e2e`
- Tests hit a **live running Hubarr instance** — no mocking, no test database
- Auth uses a `SESSION_COOKIE` env var in `.env.playwright` (gitignored), not a browser-driven OAuth flow, because the devcontainer has no display
- Session state is saved to `tests/playwright/.auth/storageState.json` (gitignored) after the first successful auth
- New test files go in `tests/playwright/` as `*.spec.ts` — they are picked up automatically
- `playwright.config.ts` and `tsconfig.playwright.json` control the test runner configuration

**When implementing a new feature**, before closing out the work consider whether a Playwright test makes sense for it. If it does, suggest it to the user — describe what you'd test and ask if they want it added. Don't add tests silently; always check first. When a test is agreed and written, add a row for it in the relevant table in `TESTING.md`.

---

### Agent Behaviour Expectations

Actively guide the workflow rather than waiting for perfect instructions:

- When the user starts new work: create a branch from `develop` automatically
- When the user says the work is ready: open a PR to `develop`, don't push directly
- When the user asks about releasing: confirm whether they mean prep, tag, or both
- When the user asks for a version bump: confirm patch/minor/major if not stated
- When the user's language conflicts with the workflow: interpret charitably or push back clearly — never silently do the wrong thing
