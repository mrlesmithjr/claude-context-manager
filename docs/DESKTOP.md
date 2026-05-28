# Claude Desktop Integration

This guide covers wiring up Claude Desktop to use context-manager alongside Claude Code. Desktop connects to the same server and database, so observations, search, and session history are shared across both clients.

---

## What Desktop gets

| Capability | Desktop | Code |
|---|---|---|
| MCP tools (`context_add`, `context_search`, `context_reflect`, etc.) | Yes | Yes |
| Automatic capture via hooks | No | Yes |
| Session start context injection | Manual | Automatic (SessionStart hook) |
| Tool capture and importance scoring | No | Automatic (PostToolUse hook) |
| Session summary and auto-memory export | Manual | Automatic (Stop hook) |
| Skills auto-trigger | No | Yes |

Desktop has the full MCP tool surface but none of the hook-driven automation. Everything Code does automatically must be done intentionally in Desktop.

---

## Prerequisites

The context-manager HTTP server must be running before Desktop can connect. Set up Mode 1 (native, macOS) or Mode 2 (Docker) from [SETUP.md](SETUP.md) first.

Verify the server is healthy:

```bash
curl http://localhost:4000/health
```

You also need your bearer token. It is in `~/.claude-context/.env`:

```bash
grep CONTEXT_MANAGER_TOKEN ~/.claude-context/.env
```

---

## Configuration

Add this entry to `~/Library/Application Support/Claude/claude_desktop_config.json` under `mcpServers`:

```json
"context-manager": {
  "command": "node",
  "args": [
    "/path/to/claude-context-manager/plugin/scripts/mcp/server.js"
  ],
  "env": {
    "CONTEXT_MANAGER_URL": "http://localhost:4000",
    "CONTEXT_MANAGER_TOKEN": "<your-token>"
  }
}
```

Replace `/path/to/claude-context-manager` with your actual clone path (e.g. `/Users/yourname/Projects/Personal/claude-context-manager`) and `<your-token>` with the value from `~/.claude-context/.env`.

Restart Claude Desktop to apply the change.

### Why stdio and not streamable-http

The Claude Desktop MCP spec includes a `type: "streamable-http"` transport that would connect directly to `http://localhost:4000/mcp` without a subprocess. As of mid-2026, the Desktop version rejects this config format as invalid. The stdio subprocess with `CONTEXT_MANAGER_URL` set achieves the same result: the node process is a thin proxy that forwards all MCP calls to the HTTP server. Do not attempt the streamable-http format until Desktop supports it.

---

## Project path convention

All Desktop observations should use `/Users/<yourname>/Claude` as the project path. This keeps Desktop captures cleanly separated from Code sessions while still being searchable.

The directory must exist on disk for hierarchical prefix-matching to work correctly:

```bash
mkdir -p ~/Claude
```

Without the directory, `context_add` still stores observations, but it logs a warning and prefix-matching visibility (where sessions scoped to child paths like `~/Claude/something` would surface Desktop observations) will not apply.

---

## The three manual patterns

Since Desktop has no hooks, these three patterns replace what Code does automatically.

### Pattern 1: Session start injection

At the start of a conversation on a topic that may have prior history, load relevant context before responding.

Broad reflection (open-ended topics):

```
context_reflect
  project: /Users/<yourname>/Claude
```

Targeted search (known topic):

```
context_search
  query: <topic>
  project: /Users/<yourname>/Claude
  limit: 10
```

### Pattern 2: Capture during conversation

Call `context_add` when the conversation surfaces a decision, preference, fact, or lesson worth keeping.

```
context_add
  content: <clear, self-contained statement>
  project: /Users/<yourname>/Claude
  importance: 0.8
  tags: ["decision"]   # or "fact", "lesson"
```

Write the content so it is useful with no surrounding conversation context. Future searches will not have this conversation available.

### Pattern 3: Capture this thread

At the end of a substantive conversation, summarize it as a single structured observation.

```
context_add
  content: |
    Topic: <what the conversation was about>
    Key points: <2-4 bullet points>
    Next steps: <follow-on actions if any>
  project: /Users/<yourname>/Claude
  importance: 0.8
  tags: ["session-summary"]
```

Trigger phrases: "capture this conversation", "save this thread", "remember what we discussed."

---

## Making the patterns automatic

Desktop has no hooks and no skill auto-triggers, so the patterns above will not run unless something bridges the gap between "tool is available" and "assistant knows to use it."

The most reliable bridge is a standing instruction in Desktop's server-side memory (`memory_user_edits`). Add a note like:

> At the start of any technical or recurring conversation, call context\_reflect or context\_search (project=/Users/\<yourname>/Claude) to inject relevant prior context. During conversation, call context\_add when decisions or important facts come up. At the end of a substantive conversation, offer to run a thread summary (Pattern 3). Use /Users/\<yourname>/Claude as the project path for all Desktop writes.

This fires in every Desktop conversation automatically, with no trigger phrase needed. Only you can write to `memory_user_edits` — it is stored server-side by Anthropic and injected at conversation start.

---

## Skill reference

A detailed skill with exact parameter syntax and pattern descriptions is at:

```
~/.claude/skills/desktop-context/SKILL.md
```

This skill is registered in Claude Code and can be loaded there with `/skill desktop-context`. It does not auto-trigger in Desktop — `~/.claude/skills/` is a Code-only path. Use it as a reference document.

---

## Known limitations

**No hook-driven capture.** PostToolUse, Stop, and SessionStart hooks do not fire in Desktop. Importance scoring, surprise scoring, relationship inference, auto-memory export, and session narrative extraction are all Code-only.

**Skills do not auto-trigger.** Trigger phrases defined in skill frontmatter only work in Code.

**Singleton sessions are not embedded.** Observations written via `context_add` create single-observation sessions. The enrichment and embedding pipeline was designed for multi-observation hook-driven sessions and skips singletons. This means Desktop observations are not retrievable via semantic or hybrid search. Keyword search (`context_search` with 1-4 word queries) works. Tracked in [issue #172](https://github.com/mrlesmithjr/claude-context-manager/issues/172).

---

## Verify the connection

After restarting Desktop, run:

```
context_stats
```

If the server is connected and the token is correct, you will see observation counts and session statistics. If the tool is not available or returns an auth error, check that the `claude_desktop_config.json` entry is valid JSON, the server is running, and the token matches `~/.claude-context/.env`.
