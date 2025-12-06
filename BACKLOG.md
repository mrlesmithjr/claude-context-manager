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

### Implementation Roadmap

**Phased approach** - each phase is independently useful:

| Phase | Focus | LOE | Unlocks |
|-------|-------|-----|---------|
| 1 | Config file support | ~4 hrs | Foundation for phases 2-4 |
| 2 | Transcript import with path remapping | ~10 hrs | Historical context from backups |
| 3 | Hierarchical context sharing | ~8 hrs | Parent/child context visibility |
| 4 | Custom groups | ~8 hrs | Cross-boundary sharing |

**Total estimated LOE**: ~30 hrs for full implementation

### High Priority
- [ ] **Phase 1: Config File Support** (~4 hrs) - `~/.claude-context/config.json`
- [ ] **Phase 2: Transcript Import Feature** (~10 hrs) - Import historical transcripts from backups
- [ ] **Phase 3: Hierarchical Context Sharing** (~8 hrs) - Parent sees children, respects boundaries
- [ ] **Phase 4: Custom Groups** (~8 hrs) - Cross-boundary sharing via explicit groups
- [ ] Implement observation summarization/compression for older entries
- [ ] Add "importance" scoring to prioritize which observations to inject

#### Cross-Project Context Sharing Details

**Problem**: Context is currently isolated by exact directory path. This creates issues:
- Working in `~/Projects` → can't see context from `~/Projects/Work/ProjectB`
- Starting a new subdirectory → no historical context available
- Related projects don't share learnings

**But strict isolation is sometimes needed**:
- `~/Projects/Work/ProjectB` should NOT see `~/Projects/MyCompany` (client separation)
- `~/Projects/Work/ProjectA` should NOT see `~/Projects/Work/ProjectB` (client separation)

**Solution**: Hierarchical context with configurable boundaries

**Key Principle**: Parent directories see child context, but siblings don't cross-pollinate unless explicitly allowed.

**Example Scenarios**:

| Working Directory | Can See Context From | Cannot See |
|-------------------|---------------------|------------|
| `~/Projects` | All subdirectories (full context) | - |
| `~/Projects/Work` | `~/Projects/Work/*` (all work) | `~/Projects/Personal`, `~/Projects/MyCompany` |
| `~/Projects/Work/ProjectB` | `~/Projects/Work/ProjectB` only | `~/Projects/Work/ProjectA`, other siblings |
| `~/Projects/Personal` | `~/Projects/Personal/*` | `~/Projects/Work/*` |

**Configuration** (`~/.claude-context/config.json`):
```json
{
  "contextSharing": {
    "mode": "hierarchical",  // "strict" | "hierarchical" | "custom"

    // Boundaries that block upward inheritance
    "boundaries": [
      "~/Projects/Work",
      "~/Projects/MyCompany",
      "~/Projects/Personal",
      "~/Projects/Quirkywerks"
    ],

    // Custom groups (optional, for cross-boundary sharing)
    "groups": {
      "all-personal": [
        "~/Projects/Personal/*",
        "~/Projects/MyCompany/*"
      ]
    }
  }
}
```

**Behavior by mode**:

1. **`strict`** (current default): Exact path match only
   - `~/Projects/Work/ProjectB` → sees only ProjectB sessions

2. **`hierarchical`**: Parent sees children, respects boundaries
   - `~/Projects` → sees all (above all boundaries)
   - `~/Projects/Work` → sees all Work/* (boundary root)
   - `~/Projects/Work/ProjectB` → sees ProjectB + inherits from Work boundary root
   - Does NOT cross sibling boundaries

3. **`custom`**: Uses explicit group definitions
   - Only sees context from projects in same group

**Implementation notes**:
- Query changes from `WHERE project = ?` to `WHERE project LIKE ? || '%'` for hierarchical
- Boundary detection: find nearest boundary parent, limit to that subtree
- Groups override hierarchy for cross-boundary sharing

**Why this matters for import**:
When importing historical transcripts, the `--project` flag remaps paths. With hierarchical sharing:
- Import to `~/Projects/Work/ProjectB` → visible from `~/Projects/Work` and `~/Projects`
- Boundaries prevent cross-client contamination

#### Transcript Import Feature Details

**Problem**: The "Previously" context feature only works for sessions recorded in the SQLite database. Old transcripts from before the plugin was installed (or from backups) are not discoverable.

**Solution**: Add `/ctx-import` command and CLI support to:
1. Scan transcript `.jsonl` files in `~/.claude/projects/{dashed-path}/`
2. Create session records in SQLite database for each transcript
3. Parse transcripts for the last assistant message (for "Previously" context)
4. Optionally extract tool interactions as observations

**Implementation approach** (reference: claude-mem's `import-xml-observations.ts`):
- Scan filesystem directly (don't require pre-existing DB records)
- Parse JSONL format (each line is a transcript entry)
- Extract session ID from filename (format: `{session_id}.jsonl`)
- Extract project path from directory structure
- Create `sessions` table entries with `status: 'complete'`
- Support both current project and cross-project imports

**Available test data** (backups in `~`):
```
~/.claude-backup-20251205-202920/  # Recent backup (Dec 5, 2025)
~/.claude.backup/                   # Older backup
```

Both contain `projects/` subdirectories with historical transcripts.

**Path remapping** (critical for moved/renamed projects):
Sessions are stored with exact `project` path. If a project moved, old transcripts won't match.
Import must support remapping source paths to current paths:

```bash
# Import from backup, remap to current location
node dist/cli.js import \
  --source ~/.claude.backup/projects/-Users-you-Projects-Personal-homelab-ansible \
  --project ~/Projects/Personal/homelab/infrastructure

# This stores sessions with project = "~/Projects/Personal/homelab/infrastructure"
# even though the backup was from the old "ansible" path
```

**Validation strategy**:
- Warn if target `--project` directory doesn't exist
- Still import (directory may be restored later)
- Sessions only become visible when working in matching directory

**CLI interface**:
```bash
# Import transcripts for current project (looks in backup for matching path)
node dist/cli.js import --project "$PWD"

# Import from specific backup source
node dist/cli.js import --source ~/.claude-backup-20251205-202920/projects

# Import with path remapping (old path → new path)
node dist/cli.js import \
  --source ~/.claude.backup/projects/-Users-you-Projects-Personal-homelab-ansible \
  --project ~/Projects/Personal/homelab/infrastructure

# Dry run (show what would be imported)
node dist/cli.js import --project "$PWD" --dry-run

# Import all from backup, auto-detect paths
node dist/cli.js import --source ~/.claude.backup/projects --all
```

**Slash command**: `/ctx-import [--dry-run]`

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
