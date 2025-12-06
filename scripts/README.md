# Import Scripts

## import-transcripts.ts

Import JSONL transcript files into the claude-context-manager database.

### Usage

```bash
npm run import -- --source <dir> --project <path> [--filter <text>] [--dry-run]
```

### Arguments

- `--source <dir>` - Source directory containing JSONL transcript files
- `--project <path>` - Target project path (will be assigned to all imported sessions)
- `--filter <text>` - (Optional) Only import transcripts containing this text
- `--dry-run` - (Optional) Show what would be imported without writing to database

### Examples

**Dry run to preview:**
```bash
npm run import -- \
  --source ~/Backups/.claude.backup/projects/-Users-you-Projects-MyCompany-products-my-product-io/ \
  --project ~/Projects/Work/ProjectA \
  --filter ProjectA \
  --dry-run
```

**Actual import:**
```bash
npm run import -- \
  --source ~/Backups/.claude.backup/projects/-Users-you-Projects-MyCompany-products-my-product-io/ \
  --project ~/Projects/Work/ProjectA \
  --filter ProjectA
```

### How It Works

1. Scans the source directory for `.jsonl` files
2. Parses each JSONL file (one JSON object per line)
3. Optionally filters transcripts by content
4. Extracts:
   - Session ID from filename
   - Timestamps from messages
   - Summary from last assistant message
5. Inserts session records into SQLite database

### Output

The script displays:
- Progress for each file (✓ success, ✗ error)
- Summary statistics:
  - Total files found
  - Files matching filter
  - Files imported
  - Files skipped
  - Errors encountered

### Verification

After import, verify with:

```bash
npm run cli -- stats --project ~/Projects/Work/ProjectA
```

Or query the database directly:

```bash
sqlite3 ~/.claude-context/context.db \
  "SELECT COUNT(*) FROM sessions WHERE project = '~/Projects/Work/ProjectA'"
```
