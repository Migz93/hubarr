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

Do not use `host`, `none`, or custom named networks unless explicitly requested.

## Summary checklist before creating any container

- [ ] Image name matches the app name
- [ ] Container name matches the app name
- [ ] `/opt/hubarr` on the host bind-mounted as a single volume
- [ ] Host directory documented or created in setup steps
- [ ] `--network bridge` / `network_mode: bridge` set

## GitHub Workflow And Release Process

When working on GitHub-related tasks for Hubarr, assume this repository uses a simple branch flow:

- day-to-day work goes to `develop`
- once `develop` is ready, it is promoted to `main`
- actual releases are cut from `main`
- stable releases are created by pushing a version tag like `v0.1.0`

Do not guess the user's release intent when it matters. If a task could reasonably target either `develop` or `main`, pause and ask the user which branch they want the change prepared for.

Use these defaults unless the user explicitly says otherwise:

- normal feature work, bug fixes, experiments, and testing changes: target `develop`
- production-ready promotion or release-prep work: target `main`
- release publishing work: only from `main`

### GitHub CLI Usage

For GitHub-related work in this repository, prefer using the GitHub CLI (`gh`) whenever it is available and authenticated.

Use `gh` as the default tool for tasks such as:

- inspecting pull requests, branches, checks, workflow runs, and releases
- viewing PR metadata, comments, review state, and mergeability
- checking CodeQL and GitHub code scanning alerts
- pushing branches when the user has asked for GitHub changes to be published
- opening PRs or gathering the exact PR URL after a branch is pushed

Prefer `gh` over guessing from local git state when the task depends on what GitHub currently knows, for example:

- whether a PR is open, merged, failing, or obsolete
- whether Dependabot has raised or refreshed a PR
- whether code scanning alerts are open or fixed
- whether a branch already exists on the remote

When pushing work, still follow the branch rules in this file:

- push `develop` for normal day-to-day work when the user wants the remote updated
- push feature or chore branches when the user wants a PR prepared
- do not push extra scratch or temporary branches unless the user clearly wants them published

If the user asks about GitHub-side security or automation results, prefer checking them with `gh` first rather than assuming the local repository tells the full story.

### Branch And Release Rules

- Treat `develop` as the default integration branch.
- Treat `main` as the stable branch.
- Do not suggest releasing directly from `develop` unless the user explicitly asks for that workflow.
- If the user asks to "release" Hubarr, confirm whether they mean:
  - prepare changes on `main`
  - create/push the release tag
  - or both
- If the user asks for a change on `main` and it is not clearly release-related, confirm that they really want it on `main` instead of `develop`.

### Pull Requests

When preparing PR-related work:

- prefer semantic PR titles such as `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `ci:`
- keep PR descriptions concise and practical
- include:
  - what changed
  - why it changed
  - anything the reviewer should verify
  - release impact if relevant
- if the work affects release behavior, Docker publishing, auth, database schema, or user-visible setup, call that out explicitly in the PR description

If the user asks for help writing a PR title or description, follow the semantic title convention and keep the body focused on reviewer usefulness rather than long changelog prose.

### Releases

For Hubarr, assume a release means:

1. the intended release changes are already on `main`
2. version numbers are updated in the app where needed
3. the user chooses the release bump type if it is not obvious
4. the release tag is created from `main` in the form `vX.Y.Z`

If the user asks for a release and the next version is not explicitly given, the agent should ask a short clarifying question such as:

- `Do you want this to be a patch, minor, or major release?`
- `Should I bump from v0.1.0 to v0.1.1, v0.2.0, or v1.0.0?`

Do not invent the next version if the bump level is ambiguous.

### Version Bump Checklist

Before creating a release tag, verify the current version and check whether it needs updating in the app.

At minimum, review and update these places if needed:

- `package.json`
- `package-lock.json`
- `src/server/version.ts`

Also verify version usage in UI/API surfaces before releasing. At the time these instructions were written, version display is surfaced from the backend and shown in places such as:

- `src/server/app.ts`
- `src/server/integrations/plex.ts`
- `src/client/components/Sidebar.tsx`
- `src/client/pages/Settings.tsx`

When doing a release-prep pass, the agent should:

- identify the current version
- identify every location that appears to require a version bump
- tell the user what will be updated
- update the version consistently before tagging if the user wants the release completed

If version references appear to be duplicated or hard-coded in a risky way, mention that clearly to the user instead of silently assuming only one file matters.

### Tagging

- Release tags should use the form `vX.Y.Z`
- Tags should be created from `main`
- If the user asks for an actual release, confirm whether they want the agent to create the tag now
- If the user only wants release prep, do not create the tag unless asked

### Agent Behavior Expectations

When helping with GitHub workflow or release tasks, the agent should actively guide the process instead of waiting for perfect instructions.

That means:

- if branch choice is unclear, ask whether this belongs on `develop` or `main`
- if release scope is unclear, ask whether this is release prep or an actual release
- if version bump size is unclear, ask the user to choose patch/minor/major
- if a main-branch change has release consequences, mention them
- if a release is requested, verify version-related files before tagging

The agent is allowed to ask concise clarifying questions when needed for branch selection, release intent, or version bump choice.
