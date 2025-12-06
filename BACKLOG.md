# claude-context-manager Backlog

**Status**: Active Development
**Last Updated**: December 6, 2025

---

## Completed

### v0.1.0 - Initial Implementation
- [x] Core SQLite storage with FTS5 full-text search
- [x] SessionStart hook - inject relevant past context
- [x] UserPromptSubmit hook - capture user prompts
- [x] PostToolUse hook - capture tool interactions
- [x] Stop hook - save session summary
- [x] CLI tool (stats, list, search, vacuum commands)
- [x] Slash commands (/ctx-stats, /ctx-list, /ctx-search, /ctx-vacuum)
- [x] Privacy tag support (`<private>` content redacted)
- [x] Per-project scoping of observations
- [x] Token-aware context injection with configurable budget

### Infrastructure
- [x] TypeScript with esbuild bundling
- [x] better-sqlite3 for synchronous SQLite access
- [x] Claude Code marketplace plugin system integration
- [x] Dynamic slash command generation during install

---

## In Progress

- [ ] Testing across multiple projects to validate per-project isolation
- [ ] Monitoring token usage and context injection quality

---

## Backlog

### High Priority
- [ ] Add configuration file support (~/.claude-context/config.json)
- [ ] Implement observation summarization/compression for older entries
- [ ] Add "importance" scoring to prioritize which observations to inject
- [ ] Support for cross-project context (opt-in)

### Medium Priority
- [ ] Add `/ctx-clear` command to reset project context
- [ ] Implement session continuity detection (resume vs new session)
- [ ] Add observation categories/tags for better filtering
- [ ] Export/import functionality for backup
- [ ] Web viewer for browsing observation history

### Low Priority
- [ ] Integration with external vector stores (ChromaDB, etc.)
- [ ] AI-powered summarization of observations
- [ ] Metrics dashboard (observations over time, token usage trends)
- [ ] Multi-user support (separate contexts per user)

### Ideas / Future Exploration
- [ ] Semantic search using embeddings
- [ ] Automatic project detection from git remote
- [ ] Integration with other Claude Code plugins
- [ ] Publish to npm for easier installation

---

## Known Issues

None currently tracked.

---

## Repository Decision

**Current location**: `~/Projects/Personal/claude-context-manager`

**Options to consider**:
1. Keep in Personal projects (current)
2. Move to `mrlesmithjr` GitHub organization
3. Create dedicated GitHub organization for Claude Code plugins
4. Publish to npm registry

**Decision**: TBD - tracking locally until decided

---

## Notes

- Marketplace plugin system now working reliably for SessionStart hooks
- Hook scripts must be in `plugin/scripts/` and use `${CLAUDE_PLUGIN_ROOT}` variable
- Slash commands are installed to `~/.claude/commands/` during `npm run plugin:install`
