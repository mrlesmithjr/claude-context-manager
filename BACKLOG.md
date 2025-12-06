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

### Phase 2: Transcript Import (Minimal - Dec 2025)
- [x] Import script: `scripts/import-transcripts.ts`
- [x] Support for `--source`, `--project`, `--filter`, `--dry-run` flags
- [x] JSONL parsing with session summary extraction
- [x] Path remapping (import from old path, store under new project path)
- [x] Successfully imported 46 ProjectA sessions from my-product backup

---

## In Progress

- [ ] Testing across multiple projects to validate per-project isolation
- [ ] Monitoring token usage and context injection quality
- [ ] Polishing Phase 2 import into full CLI command (currently standalone script)

---

## Backlog

### Implementation Roadmap

**Phased approach** - each phase is independently useful:

| Phase | Focus | LOE | Status | Notes |
|-------|-------|-----|--------|-------|
| 1 | Config file support | ~4 hrs | Pending | Foundation for boundary config |
| 2 | Transcript import with path remapping | ~4 hrs | ✅ Done | Minimal impl complete, polish remaining |
| 3 | Configurable boundaries | ~8 hrs | Lower Priority | Prefix matching already provides hierarchical visibility |
| 4 | Custom groups | ~8 hrs | Future | Cross-boundary sharing |

**Total remaining LOE**: ~20 hrs (reduced from ~30 hrs)

### High Priority
- [ ] **Phase 1: Config File Support** (~4 hrs) - `~/.claude-context/config.json`
- [x] **Phase 2: Transcript Import Feature** - ✅ Minimal implementation complete (see Completed section)
  - [ ] Polish into full CLI command with better error handling (~4 hrs remaining)
  - [ ] Add `/ctx-import` slash command
- [ ] Implement observation summarization/compression for older entries
- [ ] Add "importance" scoring to prioritize which observations to inject

### Medium Priority (Future)
- [ ] **Phase 3: Configurable Boundaries** (~8 hrs) - Block parent visibility for compliance (see details below)
- [ ] **Phase 4: Custom Groups** (~8 hrs) - Cross-boundary sharing via explicit groups

#### How Context Visibility Actually Works (Dec 2025 Discovery)

**IMPORTANT**: The original backlog incorrectly stated context was "isolated by exact directory path."

**Actual behavior**: The system uses **prefix matching** via SQL `LIKE`:
```sql
WHERE project LIKE '/Users/user/Projects/Work%'
```

This means **hierarchical visibility is already implemented**:

| Working Directory | Query Matches | Result |
|-------------------|---------------|--------|
| `~/Projects/Work` | `~/Projects/Work%` | Sees Work + ProjectA + ProjectB + all children |
| `~/Projects/Work/ProjectA` | `~/Projects/Work/ProjectA%` | Sees only ProjectA and its children |
| `~/Projects/MyCompany` | `~/Projects/MyCompany%` | Sees only MyCompany tree |
| `~/Projects` | `~/Projects%` | Sees **everything** |

**Natural sibling isolation**: Because prefix matching is used:
- `~/Projects/Work` does NOT match `~/Projects/MyCompany` (different prefix)
- `~/Projects/Work/ProjectA` does NOT match `~/Projects/Work/ProjectB` (different prefix)

**This is the desired behavior for most use cases**:
- Work from a specific project → focused context
- Work from parent directory → broader context across children
- Siblings naturally isolated without configuration

**When Phase 3 boundaries would be needed**:
Only for compliance/regulatory requirements where you need to BLOCK parent visibility:
- Prevent `~/Projects` from seeing `~/Projects/Work/*` (client data isolation)
- Prevent `~/Projects/Work` from seeing specific client subdirectories

#### Phase 3: Configurable Boundaries (Future - Lower Priority)

**Status**: Lower priority - current prefix matching works well for most use cases

**Use case**: Organizations requiring strict data isolation between projects

**Configuration** (`~/.claude-context/config.json`):
```json
{
  "contextSharing": {
    "boundaries": [
      "~/Projects/Work",
      "~/Projects/MyCompany"
    ]
  }
}
```

**Behavior with boundaries**:
- Working from `~/Projects` would NOT see children of boundary directories
- Working from `~/Projects/Work` would see all Work children normally
- Boundaries block upward inheritance, not downward visibility

#### Transcript Import Feature Details

**Status**: ✅ Minimal implementation complete (Dec 2025)

**Problem**: The "Previously" context feature only works for sessions recorded in the SQLite database. Old transcripts from before the plugin was installed (or from backups) are not discoverable.

**Solution implemented**: `scripts/import-transcripts.ts`

**Current usage**:
```bash
cd ~/Projects/Personal/claude-context-manager

# Dry run first
npm run import -- \
  --source ~/Backups/.claude.backup/projects/-Users-...-my-product-io/ \
  --project ~/Projects/Work/ProjectA \
  --filter ProjectA \
  --dry-run

# Actual import
npm run import -- \
  --source <backup-path> \
  --project <target-project> \
  --filter <optional-text-filter>
```

**What works**:
- JSONL parsing with session summary extraction
- Path remapping (import from old path, store under new project path)
- Content filtering (`--filter` flag)
- Dry run mode (`--dry-run` flag)
- Timestamp extraction from messages

**Remaining polish** (~4 hrs):
- [ ] Integrate into main CLI as `npm run cli -- import`
- [ ] Add `/ctx-import` slash command
- [ ] Better error handling and progress reporting
- [ ] Support `--all` flag to import entire backup directory

**Test data available**:
```
~/Backups/.claude.backup/           # Older backup with my-product ProjectA sessions
~/.claude-backup-20251205-202920/   # Recent backup (Dec 5, 2025)
~/.claude.backup/                   # Another backup location
```

### Other Medium Priority Items
- [ ] Add `/ctx-clear` command to reset project context
- [ ] Implement session continuity detection (resume vs new session)
- [ ] Add observation categories/tags for better filtering
- [ ] Export/import functionality for backup
- [ ] Web viewer for browsing observation history

### Low Priority

#### Display Enhancements (inspired by claude-mem)
- [ ] **Day Headers** - Add `### Dec 5` section headers for long observation lists
  - Groups observations by day for easier scanning
  - Low effort
- [ ] **File Grouping** - Group consecutive observations touching the same file
  - Shows related work together
  - Medium effort

#### Other
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

### Dec 2025: Context Visibility Discovery

**Key finding**: The system already uses prefix matching (`WHERE project LIKE path%`), NOT exact matching.

This means:
1. **Hierarchical visibility works out of the box** - parent directories see all child contexts
2. **Sibling isolation is automatic** - `~/Projects/Work` can't see `~/Projects/MyCompany`
3. **Phase 3 (boundaries) is only needed for compliance** - blocking parent visibility when required

**Practical implications**:
- Import sessions to specific project paths (e.g., `~/Projects/Work/ProjectA`)
- They become visible from parent directories (e.g., `~/Projects/Work`, `~/Projects`)
- No configuration needed for normal hierarchical use

**Code reference**: `src/storage/sqlite.ts` lines 220-225, 262-266
```typescript
const rows = stmt.all(project + '%', limit)  // Prefix matching
```
