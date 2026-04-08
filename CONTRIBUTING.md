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

See [TESTING.md](TESTING.md) for the full guide — setup, authentication, commands, and a breakdown of every test.

## Coding Notes

- Keep changes scoped to the task at hand
- Avoid committing generated output or local-only files
- Prefer updating docs when behavior or setup changes
- If you change release behavior, workflows, Docker publishing, auth, or setup, mention that clearly in the PR

## Reporting Bugs And Requesting Features

If the repository has Discussions or issue templates enabled, use those first. Otherwise, open a clear issue with reproduction steps, expected behavior, and any relevant logs or screenshots.
