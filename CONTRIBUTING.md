# Contributing to claude-context-manager

Thank you for your interest in contributing. This guide covers everything you need to submit a clean, reviewable change.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Branch Strategy](#branch-strategy)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Privacy and Security](#privacy-and-security)
- [Issue Labels](#issue-labels)
- [Getting Help](#getting-help)

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Node.js | 18+ | Required |
| npm | 9+ | Comes with Node.js |
| Docker | 24+ | Required for E2E tests only |
| Docker Compose | v2.20+ | Compose v1 will not work for E2E |

---

## Getting Started

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-fork>/claude-context-manager.git
cd claude-context-manager

# Install dependencies (also installs the pre-push hook that blocks direct pushes to main)
npm install

# Build all components
npm run build

# Confirm tests pass
npm test
```

---

## Branch Strategy

**All development targets `develop`. `main` is release-only and is protected.**

| Branch | Purpose | Who pushes |
|--------|---------|------------|
| `develop` | Active development | Contributors (via PR) |
| `main` | Stable releases only | Maintainer (automated release workflow only) |

When contributing:

1. Fork the repository.
2. Create a branch off `develop` in your fork: `git checkout -b feat/my-feature develop`
3. Push to your fork and open a PR targeting `develop`, not `main`.

The pre-push hook installed by `npm install` will block accidental pushes to `main`.

---

## Making Changes

### Before writing code

Search for an existing issue that covers your change:

```bash
gh issue list --repo mrlesmithjr/claude-context-manager --state open --search "<keywords>"
```

If none exists, open one before starting work. This keeps discussion and decisions visible.

### Shippable units

Break larger changes into shippable units: discrete changes that are independently committable, testable in isolation, and useful even if later units are never delivered.

- One commit per logical unit.
- Tests and type checks must pass on each commit standalone.
- Do not combine unrelated fixes in a single commit.

### Version bump

Do not bump the version number in `package.json`. The maintainer handles version management as part of the release workflow.

---

## Testing

### Unit tests

```bash
npm test                  # Run once
npm run test:watch        # Watch mode during development
npm run test:coverage     # Coverage report
npm run typecheck         # Type check without emitting
```

All unit tests must pass before opening a PR.

### End-to-end tests (Docker required)

```bash
make test-e2e             # Build, run all 5 scenarios, tear down
make test-e2e-up          # Start services for manual exploration
make test-e2e-down        # Stop and clean up containers
```

E2E tests are not required for every change, but are required when modifying:
- Hook behavior (`plugin/hooks/`)
- SQLite storage layer (`src/storage/`)
- MCP server tools (`src/mcp/`)
- The HTTP server (`src/server/`)

---

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

[optional body]

fixes #<issue-number>
```

**Types:**

| Type | When to use |
|------|------------|
| `feat` | New feature or tool |
| `fix` | Bug fix |
| `refactor` | Code change with no behavior change |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `chore` | Build, CI, dependency changes |
| `perf` | Performance improvement |

**Issue reference rules:**

- Use `fixes #N` when the commit **fully resolves** the issue (GitHub auto-closes it on merge).
- Use `refs #N` only for **partial work** where the issue should stay open.
- Never use `refs` for a commit that completes the work.

Every commit to a file inside this repository must reference a GitHub issue.

---

## Pull Request Process

1. **Open a draft PR early** if you want feedback before the work is complete.
2. Target `develop`, not `main`.
3. Fill out the PR description: what changed, why, and how you tested it.
4. All of the following must be green before requesting review:
   - `npm run typecheck`
   - `npm test`
   - No unresolved merge conflicts with `develop`
5. A maintainer will review and may request changes. Expect at least one review round.
6. Squash commits if the history is noisy before final merge.

---

## Code Style

- **TypeScript** throughout. No JavaScript files in `src/` or `plugin/hooks/`.
- **No comments** unless the why is non-obvious: a hidden constraint, a subtle invariant, or a workaround for a specific external bug.
- **No emojis** anywhere: code, comments, commit messages, PR descriptions.
- **No em-dashes** (`--` or `---` is fine; `—` is not). Use a comma, a period, or a colon instead.
- Prefer editing existing files over creating new ones.
- Do not add error handling for scenarios that cannot happen. Only validate at system boundaries.
- Keep hook code fast: hooks have tight timeouts (5-10s wall-clock). No network calls, no blocking I/O loops.

---

## Privacy and Security

This plugin captures Claude Code tool interactions. Privacy constraints are not optional:

- **Never log prompt content**, even at debug level. The `capture-prompt.ts` hook writes only metadata.
- **Never store `old_string`, `new_string`, or `content`** fields from Edit/Write tool results.
- Wrap any test fixtures containing realistic-looking credentials or PII in `<private>` tags.
- Report security vulnerabilities privately by email to `mrlesmithjr@gmail.com` rather than opening a public issue.

---

## Issue Labels

| Label | Meaning |
|-------|---------|
| `good first issue` | Low complexity, good entry point |
| `help wanted` | Maintainer would welcome a PR |
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `documentation` | Docs-only change |
| `refactor` | Internal cleanup, no behavior change |
| `performance` | Speed or resource improvement |
| `security` | Security hardening or vulnerability |
| `p0` - `p4` | Priority (p0 = critical, p4 = low) |

Look for `good first issue` and `help wanted` if you are looking for somewhere to start.

---

## Getting Help

- **Questions about the codebase**: open a GitHub Discussion or comment on a relevant issue.
- **Bug reports**: open an issue with the `bug` label. Include your OS, Node.js version, plugin version (from `package.json`), and steps to reproduce.
- **Feature requests**: open an issue with the `enhancement` label. Describe the use case, not just the solution.
- **Security issues**: email `mrlesmithjr@gmail.com` directly.
