# Implementation Plan

Step-by-step guide for building claude-context-manager.

**Status**: DRAFT
**Last Updated**: December 5, 2025

---

## Prerequisites

Before starting:

```bash
# Ensure Node.js 18+ is installed
node --version

# Ensure npm is available
npm --version

# Verify the data directory exists
ls ~/.claude-context/
```

---

## Phase 1: Project Setup

### Step 1.1: Initialize Node.js Project

```bash
cd ~/Projects/Personal/claude-context-manager
npm init -y
```

### Step 1.2: Install Dependencies

```bash
# Core dependencies
npm install express better-sqlite3 uuid

# Dev dependencies
npm install -D typescript @types/node @types/express @types/better-sqlite3 esbuild
```

### Step 1.3: Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 1.4: Update package.json Scripts

```json
{
  "scripts": {
    "build": "esbuild src/worker/server.ts --bundle --platform=node --outfile=dist/worker.js --external:better-sqlite3",
    "build:hooks": "esbuild plugin/hooks/*.ts --outdir=plugin/hooks --platform=node --format=cjs",
    "worker:start": "node dist/worker.js &",
    "worker:stop": "pkill -f 'node dist/worker.js' || true",
    "plugin:install": "cp -r plugin ~/.claude/plugins/context-manager",
    "test": "node --test"
  }
}
```

---

## Phase 2: Database Layer

### Step 2.1: Create Schema (`src/db/schema.ts`)

Implement:
- Database initialization with better-sqlite3
- Schema creation (sessions, observations tables)
- FTS5 virtual table setup
- Migration system for future schema changes

Key functions:
```typescript
export function initDatabase(dbPath: string): Database;
export function runMigrations(db: Database): void;
```

### Step 2.2: Create Operations (`src/db/operations.ts`)

Implement CRUD operations:

```typescript
// Sessions
export function createSession(db, sessionId, project): void;
export function endSession(db, sessionId, summary): void;
export function getRecentSessions(db, project, limit): Session[];

// Observations
export function insertObservation(db, observation): number;
export function getObservations(db, project, limit, tokenBudget): Observation[];
export function searchObservations(db, project, query): Observation[];

// Types
interface Session {
  id: string;
  project: string;
  started_at: number;
  ended_at?: number;
  summary?: string;
  status: 'active' | 'complete';
}

interface Observation {
  id: number;
  session_id: string;
  project: string;
  tool_name: string;
  summary: string;
  details?: string;
  files?: string[];
  tokens: number;
  created_at: number;
}
```

---

## Phase 3: Capture Processing

### Step 3.1: Create Processor (`src/capture/processor.ts`)

Implement tool output processing:

```typescript
export function processToolCapture(input: ToolCapture): Observation;
export function stripPrivateTags(content: string): string;
export function estimateTokens(text: string): number;
export function summarizeTool(toolName: string, input: any, output: any): string;
```

Tool-specific summarization logic:
- Read: Extract filename, detect file type
- Write: Note create vs update, filename
- Edit: Describe change briefly
- Bash: Command preview, exit status
- Grep: Pattern and match count
- Glob: Pattern and file count
- Task: Agent type and description

---

## Phase 4: Context Injection

### Step 4.1: Create Builder (`src/inject/builder.ts`)

Implement context formatting:

```typescript
export function buildContext(observations: Observation[], summary?: string): string;
export function formatObservation(obs: Observation): string;
export function selectWithinBudget(observations: Observation[], budget: number): Observation[];
```

Output format (injected into session):
```markdown
<claude-context>
## Previous Context for This Project

### Recent Session Summary
Implemented user authentication using JWT tokens...

### Recent Activity (15 observations, ~2500 tokens)
1. [Read] src/auth/jwt.ts - JWT token utilities
2. [Write] src/auth/middleware.ts - Auth middleware
3. [Edit] src/routes/user.ts - Added auth routes
4. [Bash] npm test - All tests passing
...

</claude-context>
```

---

## Phase 5: Worker Service

### Step 5.1: Create Server (`src/worker/server.ts`)

Implement Express HTTP server:

```typescript
import express from 'express';
import { initDatabase } from '../db/schema';
import { insertObservation, getObservations } from '../db/operations';
import { processToolCapture } from '../capture/processor';
import { buildContext } from '../inject/builder';

const app = express();
app.use(express.json());

// POST /capture - Store tool observation
app.post('/capture', (req, res) => { ... });

// POST /summary - Store session summary
app.post('/summary', (req, res) => { ... });

// GET /context - Retrieve context for injection
app.get('/context', (req, res) => { ... });

// GET /search - Full-text search
app.get('/search', (req, res) => { ... });

// GET /health - Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.CONTEXT_MANAGER_PORT || 37888;
app.listen(PORT, () => console.log(`Context manager running on port ${PORT}`));
```

---

## Phase 6: Hooks

### Step 6.1: Create Context Injection Hook (`plugin/hooks/context-inject.ts`)

```typescript
#!/usr/bin/env node
import { stdin, stdout } from 'process';

interface HookInput {
  session_id: string;
  cwd: string;
}

async function main() {
  // Read input from stdin
  const input: HookInput = JSON.parse(await readStdin());

  // Fetch context from worker
  const response = await fetch(
    `http://localhost:37888/context?project=${encodeURIComponent(input.cwd)}`
  );

  if (!response.ok) {
    // Fail silently - don't block session
    stdout.write(JSON.stringify({ context: '' }));
    return;
  }

  const data = await response.json();

  // Return context for injection
  stdout.write(JSON.stringify({
    context: data.formatted_context
  }));
}

main().catch(() => {
  stdout.write(JSON.stringify({ context: '' }));
});
```

### Step 6.2: Create Capture Hook (`plugin/hooks/capture-tool.ts`)

```typescript
#!/usr/bin/env node
import { stdin, stdout } from 'process';

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: string;
}

async function main() {
  const input: HookInput = JSON.parse(await readStdin());

  // Skip low-value tools
  const skipTools = ['TodoWrite', 'AskUserQuestion', 'SlashCommand'];
  if (skipTools.includes(input.tool_name)) {
    stdout.write(JSON.stringify({ status: 'skipped' }));
    return;
  }

  // Fire and forget - don't wait for response
  fetch('http://localhost:37888/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: input.session_id,
      project: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_output: input.tool_response,
      timestamp: Date.now()
    })
  }).catch(() => {}); // Ignore errors

  stdout.write(JSON.stringify({ status: 'captured' }));
}

main().catch(() => {
  stdout.write(JSON.stringify({ status: 'error' }));
});
```

### Step 6.3: Create Session End Hook (`plugin/hooks/session-end.ts`)

```typescript
#!/usr/bin/env node
import { stdin, stdout } from 'process';

interface HookInput {
  session_id: string;
  cwd: string;
  transcript_summary?: string;
}

async function main() {
  const input: HookInput = JSON.parse(await readStdin());

  await fetch('http://localhost:37888/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: input.session_id,
      project: input.cwd,
      summary: input.transcript_summary || 'Session ended'
    })
  }).catch(() => {});

  stdout.write(JSON.stringify({ status: 'complete' }));
}

main().catch(() => {
  stdout.write(JSON.stringify({ status: 'error' }));
});
```

---

## Phase 7: Plugin Configuration

### Step 7.1: Create hooks.json (`plugin/hooks.json`)

```json
{
  "hooks": {
    "SessionStart": {
      "command": "node",
      "args": ["~/.claude/plugins/context-manager/hooks/context-inject.js"],
      "timeout": 5000
    },
    "PostToolUse": {
      "command": "node",
      "args": ["~/.claude/plugins/context-manager/hooks/capture-tool.js"],
      "timeout": 1000
    },
    "Stop": {
      "command": "node",
      "args": ["~/.claude/plugins/context-manager/hooks/session-end.js"],
      "timeout": 5000
    }
  }
}
```

---

## Phase 8: Testing

### Step 8.1: Manual Testing

```bash
# 1. Start the worker
npm run worker:start

# 2. Test health endpoint
curl http://localhost:37888/health

# 3. Test capture endpoint
curl -X POST http://localhost:37888/capture \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test","project":"/tmp/test","tool_name":"Read","tool_input":{},"tool_output":"test","timestamp":1733400000}'

# 4. Test context endpoint
curl "http://localhost:37888/context?project=/tmp/test"

# 5. Install plugin and restart Claude Code
npm run plugin:install
# Restart Claude Code

# 6. Verify hooks are working
# Check ~/.claude-context/logs/ for hook execution
```

### Step 8.2: Unit Tests

Create `src/db/operations.test.ts`:
- Test CRUD operations
- Test FTS search
- Test token budget selection

Create `src/capture/processor.test.ts`:
- Test privacy tag stripping
- Test tool summarization
- Test token estimation

---

## Phase 9: Polish

### Step 9.1: Error Handling

- Add try-catch in all hooks
- Log errors to `~/.claude-context/logs/error.log`
- Graceful degradation when worker unavailable

### Step 9.2: Logging

Create `src/utils/logger.ts`:
- Structured JSON logging
- Log levels (debug, info, warn, error)
- File rotation (daily)

### Step 9.3: Configuration

Create `src/config.ts`:
- Load from environment variables
- Load from `~/.claude-context/config.json`
- Merge with defaults

---

## Verification Checklist

After implementation, verify:

- [ ] Worker starts without errors
- [ ] Health endpoint returns OK
- [ ] Capture endpoint stores observations
- [ ] Context endpoint returns formatted context
- [ ] Search endpoint returns results
- [ ] SessionStart hook injects context
- [ ] PostToolUse hook captures tools
- [ ] Stop hook saves summary
- [ ] Privacy tags are stripped
- [ ] Token budget is respected
- [ ] Per-project scoping works
- [ ] Errors don't block Claude Code

---

## Estimated Effort

| Phase | Complexity | Notes |
|-------|------------|-------|
| 1. Setup | Low | Standard Node.js project |
| 2. Database | Medium | FTS5 triggers are tricky |
| 3. Capture | Low | Simple string processing |
| 4. Injection | Low | Formatting logic |
| 5. Worker | Medium | HTTP server, routing |
| 6. Hooks | Medium | Stdin/stdout protocol |
| 7. Config | Low | JSON files |
| 8. Testing | Medium | Integration testing |
| 9. Polish | Low | Error handling |

---

## Reference: claude-mem Patterns

Useful patterns from claude-mem to consider:

1. **Edge Processing** - Strip tags in hooks, not worker
2. **WAL Mode** - Enable for concurrent SQLite access
3. **Fire-and-Forget** - Don't block on capture requests
4. **Token Economics** - Show users what context costs
5. **Progressive Disclosure** - Index first, details on demand
