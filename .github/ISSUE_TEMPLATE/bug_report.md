---
name: Bug report
about: Something is broken or behaving unexpectedly
title: 'bug: '
labels: bug
assignees: ''
---

**Describe the bug**
A clear, concise description of what is wrong.

**To reproduce**
Steps to reproduce the behavior:
1. ...
2. ...
3. ...

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened. Include the full error output.

```
# Paste error output here
```

**Environment**

| Field | Value |
|-------|-------|
| Plugin version | e.g. `0.8.108` (check `package.json` or `/plugin list`) |
| Claude Code version | e.g. `1.2.3` |
| Server mode | Native launchd / Docker / Local SQLite |
| OS | e.g. macOS 15.5, Ubuntu 24.04 |
| Node.js version | `node --version` |

**Relevant configuration**
Paste the relevant lines from `~/.claude-context/.env` (omit the token value):

```
CONTEXT_MANAGER_URL=http://localhost:4000
CONTEXT_MANAGER_TOKEN=<redacted>
CONTEXT_MANAGER_DB=...
```

**Server logs (if applicable)**
For native mode: `make server-launchd-status` or check `~/Library/Logs/`
For Docker mode: `make server-logs`

```
# Paste relevant log lines here
```

**Additional context**
Any other details that might help — recent changes to `.env`, plugin updates, Claude Code restarts, etc.
