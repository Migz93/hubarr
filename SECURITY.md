# Security Policy

## Reporting A Vulnerability

Please do not open a public GitHub issue for security-sensitive problems.

If you find a vulnerability in Hubarr, report it privately through GitHub's private vulnerability reporting flow for this repository if it is enabled. If that is not available, contact the maintainer directly through a private channel before disclosing details publicly.

When reporting an issue, please include:

- a short description of the problem
- the affected version or commit if known
- clear reproduction steps
- the expected impact
- any suggested mitigation if you have one

## Disclosure Expectations

- Please allow time for the issue to be investigated and fixed before public disclosure.
- I will try to acknowledge reports promptly and keep you updated on the status.
- Once a fix is available, the goal is to disclose the issue responsibly with enough detail for users to protect themselves.

## Scope

Security reports are especially helpful for issues involving:

- authentication or session handling
- token or secret exposure
- privilege escalation
- remote code execution
- container or deployment security
- unsafe default configuration

## Supported Versions

Hubarr is still early in development. Until a stable release policy is documented, security fixes are handled on the latest supported code line.

---

## Security Scanning with Snyk

### Installation

```bash
npm install -g snyk
snyk auth
```

`snyk auth` will open a browser to authenticate against your Snyk account.

### Scan Commands

| What you're scanning | Command |
|---|---|
| Dependencies (npm packages) | `snyk test` |
| Source code (static analysis) | `snyk code test` |
| Docker image | `snyk container test hubarr` |

Run all three from the repo root (`/workspaces/hubarr`) to get full coverage.

### Philosophy — Fix vs Ignore

We take security seriously, but we don't fix things for the sake of fixing them.

**Fix it** if:
- It's a genuine vulnerability with a realistic attack path
- The fix improves code quality or correctness
- It's straightforward to address without compromising readability or best practice

**Mark as Won't Fix** if:
- Snyk can't trace through your validation logic but the code is demonstrably safe (false positive)
- The "fix" would require writing worse code purely to satisfy static analysis
- The issue requires a contorted workaround that obscures intent more than it improves security

When in doubt, ask whether fixing it actually makes the code safer — or just makes Snyk happy. Those aren't the same thing.

### Marking Something as Won't Fix in the Snyk GUI

Use **Won't Fix** (not "Ignore Temporarily") for confirmed false positives or conscious decisions not to fix. "Ignore Temporarily" implies you plan to revisit; Won't Fix signals a deliberate call.

See the [Agent Behaviour — Snyk](#agent-behaviour--snyk) section in `AGENTS.md` for how Claude handles these decisions and what it will provide when recommending Won't Fix.
