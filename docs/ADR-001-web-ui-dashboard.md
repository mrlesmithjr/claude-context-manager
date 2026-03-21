# ADR-001: Web UI Dashboard for claude-context-manager

## Status

**Implemented** (v0.3.0+)

---

## Context

The claude-context-manager plugin provides context persistence through SQLite storage with MCP tool access (`context_stats`, `context_list`, `context_search`) and CLI commands. Users have requested a local web interface for richer browsing, searching, and analytics capabilities.

### Current State Assessment

| Component | Status | Notes |
|-----------|--------|-------|
| Storage Layer | Production | `src/storage/sqlite.ts` with FTS5, 704 lines, well-tested |
| Interface | Production | `src/storage/interface.ts` defines types and contracts |
| CLI | Production | `cli/index.ts` - basic list/search/stats/vacuum |
| Build System | Production | esbuild for hooks, TypeScript compilation |
| Plugin System | Production | Marketplace-based installation |

### Technology Constraints

1. **Must reuse existing storage layer** - SQLiteStorage class in `src/storage/sqlite.ts`
2. **Native module handling** - better-sqlite3 requires special bundling (see `scripts/build-hooks.js`)
3. **Existing build tooling** - esbuild, TypeScript 5.3+, Node 18+
4. **Local context** - Simple deployment, no production infrastructure

---

## Decision

Implement a lightweight local web dashboard using:

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **API Server** | Node.js + Fastify | Lightweight, fast, TypeScript-native, minimal dependencies |
| **Frontend** | Vanilla JS + Preact + Tailwind | Zero build complexity for frontend, fast initial load |
| **Bundling** | esbuild (existing) | Reuse existing toolchain |
| **Database** | SQLite (existing) | Reuse existing storage layer directly |

### Why Fastify over Express/Hono/others?

- **Performance**: Fastest Node.js framework in benchmarks
- **TypeScript**: First-class TypeScript support with JSON schema validation
- **Low overhead**: ~200KB bundle size, minimal dependencies
- **Plugin ecosystem**: Structured plugin system for CORS, static files
- **Schema validation**: Built-in request/response validation

### Why Preact over React/Vue/Svelte?

- **Size**: 3KB vs React's 45KB
- **Compatibility**: Drop-in React replacement, same JSX syntax
- **No build step required**: Can use htm for JSX-like syntax without compilation
- **Simplicity**: Perfect for a personal tool dashboard

### Why Tailwind CSS?

- **No build step**: Use CDN for development, optional PostCSS build for production
- **Utility-first**: Rapid prototyping without custom CSS files
- **Small footprint**: Only include what you use

---

## Architecture

### System Overview

```
+------------------------------------------------------------------+
|                        User Browser                               |
|  (http://localhost:3847)                                         |
+------------------------------------------------------------------+
                              |
                              | HTTP
                              v
+------------------------------------------------------------------+
|                      Web Server Layer                             |
|                       (Fastify)                                   |
+------------------------------------------------------------------+
|  /api/sessions    GET     - List sessions with filters           |
|  /api/sessions/:id GET    - Get session detail with observations |
|  /api/observations GET    - Search/list observations             |
|  /api/stats       GET     - Get statistics                       |
|  /api/stats/timeline GET  - Token usage over time                |
|  /api/projects    GET     - List unique projects                 |
|  /                GET     - Serve SPA (static files)             |
+------------------------------------------------------------------+
                              |
                              | Direct Access
                              v
+------------------------------------------------------------------+
|                     Storage Layer                                 |
|            (src/storage/sqlite.ts - REUSE EXISTING)              |
+------------------------------------------------------------------+
|  SQLiteStorage class                                             |
|  - getRecentSessions()                                           |
|  - getRecent()                                                   |
|  - search()                                                      |
|  - getStats()                                                    |
|  + NEW: getTimeline() - aggregate by day/week                    |
|  + NEW: getProjects() - distinct project list                    |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                    SQLite Database                                |
|              ~/.claude-context/context.db                        |
+------------------------------------------------------------------+
```

### Directory Structure

```
claude-context-manager/
+-- web/                           # NEW: Web UI module
|   +-- server/
|   |   +-- index.ts               # Fastify server entry point
|   |   +-- routes/
|   |   |   +-- api.ts             # API route handlers
|   |   |   +-- static.ts          # Static file serving
|   |   +-- services/
|   |       +-- analytics.ts       # Analytics queries (timeline, aggregations)
|   +-- client/
|   |   +-- index.html             # SPA entry point
|   |   +-- app.js                 # Preact application (no build)
|   |   +-- components/
|   |   |   +-- SessionList.js     # Session browser component
|   |   |   +-- ObservationSearch.js # Search interface
|   |   |   +-- TokenAnalytics.js  # Charts and graphs
|   |   |   +-- ProjectFilter.js   # Project selector
|   |   +-- styles/
|   |       +-- main.css           # Minimal custom CSS (Tailwind CDN)
|   +-- package.json               # Web-specific dependencies (optional)
+-- src/
|   +-- storage/
|       +-- sqlite.ts              # EXTEND with new query methods
|       +-- interface.ts           # EXTEND interface
+-- scripts/
|   +-- start-web.js               # Server startup script
+-- package.json                   # Add web scripts
```

---

## API Design

### Endpoints

#### `GET /api/sessions`

List sessions with optional filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | - | Filter by project path (prefix match) |
| `status` | string | - | Filter by status: `active`, `complete` |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "sessions": [
    {
      "id": "session-abc123",
      "project": "/home/user/projects/my-app",
      "started_at": "2025-12-13T10:00:00Z",
      "ended_at": "2025-12-13T11:30:00Z",
      "summary": "Implemented Web UI dashboard architecture",
      "status": "complete",
      "observation_count": 42,
      "total_tokens": 8500
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

#### `GET /api/sessions/:id`

Get session detail with all observations.

**Response:**
```json
{
  "session": {
    "id": "session-abc123",
    "project": "/home/user/projects/my-app",
    "started_at": "2025-12-13T10:00:00Z",
    "ended_at": "2025-12-13T11:30:00Z",
    "summary": "Implemented Web UI dashboard architecture",
    "status": "complete"
  },
  "observations": [
    {
      "id": 1234,
      "tool_name": "Read",
      "summary": "Read src/storage/sqlite.ts",
      "files_touched": ["src/storage/sqlite.ts"],
      "token_estimate": 150,
      "created_at": "2025-12-13T10:05:00Z"
    }
  ],
  "prompts": [
    {
      "id": 56,
      "prompt_number": 1,
      "prompt_text": "Design a Web UI Dashboard...",
      "created_at": "2025-12-13T10:00:00Z"
    }
  ]
}
```

#### `GET /api/observations`

Search and list observations.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | - | Full-text search query |
| `project` | string | - | Filter by project path |
| `tool` | string | - | Filter by tool name |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "observations": [
    {
      "id": 1234,
      "session_id": "session-abc123",
      "project": "/home/user/projects/...",
      "tool_name": "Read",
      "summary": "Read src/storage/sqlite.ts",
      "files_touched": ["src/storage/sqlite.ts"],
      "metadata": {},
      "token_estimate": 150,
      "created_at": "2025-12-13T10:05:00Z"
    }
  ],
  "total": 500,
  "limit": 50,
  "offset": 0
}
```

#### `GET /api/stats`

Get statistics (reuses existing `getStats()` method).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | - | Filter by project path |

**Response:**
```json
{
  "total_observations": 5000,
  "total_sessions": 150,
  "oldest_observation": "2025-11-01T00:00:00Z",
  "newest_observation": "2025-12-13T12:00:00Z",
  "total_tokens": 1500000,
  "avg_tokens_per_observation": 300,
  "avg_tokens_per_session": 10000,
  "tokens_by_tool": {
    "Read": 500000,
    "Bash": 400000,
    "Edit": 300000
  },
  "token_budget": 4000,
  "typical_injection_tokens": 3200
}
```

#### `GET /api/stats/timeline`

Get token usage over time for charts.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | - | Filter by project |
| `interval` | string | `day` | Grouping: `hour`, `day`, `week` |
| `days` | number | 30 | Number of days to include |

**Response:**
```json
{
  "timeline": [
    {
      "date": "2025-12-13",
      "tokens": 25000,
      "observations": 150,
      "sessions": 3
    },
    {
      "date": "2025-12-12",
      "tokens": 18000,
      "observations": 120,
      "sessions": 2
    }
  ]
}
```

#### `GET /api/projects`

List unique project paths for filter dropdown.

**Response:**
```json
{
  "projects": [
    {
      "path": "/home/user/projects/my-app",
      "observation_count": 500,
      "last_activity": "2025-12-13T12:00:00Z"
    },
    {
      "path": "/home/user/projects/another-project",
      "observation_count": 1200,
      "last_activity": "2025-12-12T18:00:00Z"
    }
  ]
}
```

---

## Frontend Components

### Page Structure

```
+------------------------------------------------------------------+
|  [Context Manager Dashboard]                    [Project: All v]  |
+------------------------------------------------------------------+
|  [Sessions] [Search] [Analytics]                                  |
+------------------------------------------------------------------+
|                                                                   |
|  +------------------------------------------------------------+  |
|  |                     Main Content Area                       |  |
|  |                                                             |  |
|  |  (SessionList | ObservationSearch | TokenAnalytics)        |  |
|  |                                                             |  |
|  +------------------------------------------------------------+  |
|                                                                   |
+------------------------------------------------------------------+
|  Stats: 5000 observations | 150 sessions | 1.5M tokens           |
+------------------------------------------------------------------+
```

### Component Details

#### SessionList Component

- Paginated list of sessions
- Click to expand: shows observations and prompts
- Status badges (active/complete)
- Token count per session
- Relative timestamps ("2 hours ago")

#### ObservationSearch Component

- Full-text search input
- Tool filter dropdown (Read, Write, Bash, etc.)
- Results with highlighted matches
- Click to see full metadata

#### TokenAnalytics Component

- Line chart: tokens over time (using lightweight charting library)
- Bar chart: tokens by tool type
- Summary cards: total tokens, budget utilization, session averages

#### ProjectFilter Component

- Dropdown with all project paths
- Shows observation count per project
- Supports hierarchical display (grouped by parent directory)

---

## Storage Layer Extensions

Add these methods to `src/storage/interface.ts`:

```typescript
export interface TimelineEntry {
  date: string;           // ISO date (YYYY-MM-DD)
  tokens: number;
  observations: number;
  sessions: number;
}

export interface ProjectEntry {
  path: string;
  observation_count: number;
  last_activity: string;
}

export interface ContextStorage {
  // ... existing methods ...

  /**
   * Get token usage timeline for analytics
   */
  getTimeline(project?: string, days?: number): Promise<TimelineEntry[]>;

  /**
   * Get list of unique projects with activity stats
   */
  getProjects(): Promise<ProjectEntry[]>;

  /**
   * Get observations for a specific session
   */
  getSessionObservations(sessionId: string): Promise<Observation[]>;

  /**
   * Get prompts for a specific session
   */
  getSessionPrompts(sessionId: string): Promise<UserPrompt[]>;

  /**
   * Count observations with optional filters
   */
  countObservations(project?: string, tool?: string): Promise<number>;

  /**
   * Count sessions with optional filters
   */
  countSessions(project?: string, status?: string): Promise<number>;
}
```

---

## Build Configuration

### New npm Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "build:web": "esbuild web/server/index.ts --bundle --outfile=dist/web/server.js --platform=node --target=node18 --format=esm --external:better-sqlite3",
    "web": "node dist/web/server.js",
    "web:dev": "npx tsx watch web/server/index.ts"
  }
}
```

### New Dependencies

```json
{
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/cors": "^10.0.0"
  }
}
```

**Total new dependencies**: 3 packages (Fastify ecosystem)

### Frontend (No Build Required)

Frontend uses CDN links for development simplicity:

```html
<!-- web/client/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Context Manager Dashboard</title>
  <script src="https://unpkg.com/preact@10/dist/preact.min.js"></script>
  <script src="https://unpkg.com/htm@3/dist/htm.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

---

## Server Startup

### Configuration

| Setting | Default | Environment Variable |
|---------|---------|---------------------|
| Port | 3847 | `CONTEXT_MANAGER_PORT` |
| Host | localhost | `CONTEXT_MANAGER_HOST` |
| Database | ~/.claude-context/context.db | `CONTEXT_MANAGER_DB` |

Port 3847 chosen as: unlikely to conflict, easy to remember (CTXM on phone keypad).

### Lifecycle

```bash
# Start server
npm run web
# > Context Manager Dashboard running at http://localhost:3847

# Development mode with auto-reload
npm run web:dev

# Or via the context-manager CLI (future enhancement)
context-manager web --port 3847
```

### Integration with Plugin

The web server is **independent** of the plugin hooks:
- Plugin hooks run inside Claude Code's process
- Web server is a standalone process
- Both access the same SQLite database (WAL mode supports concurrent reads)

No conflicts expected because:
1. Plugin hooks perform brief writes during tool capture
2. Web dashboard performs read-only queries
3. SQLite WAL mode handles concurrent access

---

## Security Considerations

### Local-Only Access

- Bind to `localhost` by default (127.0.0.1)
- No authentication required (local user only)
- CORS disabled by default (same-origin)

### Input Validation

- Validate all query parameters via Fastify JSON schema
- Sanitize project paths (no path traversal)
- Rate limiting not required for local use

### Data Privacy

- No data leaves localhost
- No telemetry or analytics
- Existing `<private>` tag stripping applies to stored data

---

## Implementation Plan

### Phase 1: Backend API (MVP)

1. Create `web/server/` directory structure
2. Implement Fastify server with basic routes
3. Add new storage methods (`getTimeline`, `getProjects`, etc.)
4. Add `npm run web` script
5. Manual testing with curl/httpie

### Phase 2: Frontend Shell

1. Create `web/client/` structure
2. Build index.html with Preact + Tailwind CDN
3. Implement routing (hash-based, no build)
4. Create SessionList component (table view)
5. Create basic ProjectFilter dropdown

### Phase 3: Search and Detail Views

1. Implement ObservationSearch component
2. Add session detail view (expand/collapse)
3. Implement full-text search highlighting
4. Add tool filter dropdown

### Phase 4: Analytics Dashboard

1. Research lightweight charting (Chart.js or uPlot)
2. Implement TokenAnalytics component
3. Add timeline chart (tokens over time)
4. Add tool distribution chart
5. Summary statistics cards

### Phase 5: Polish and Documentation

1. Loading states and error handling
2. Responsive design adjustments
3. README documentation
4. Add to plugin marketplace description

---

## Consequences

### Positive

1. **Richer exploration** - Visual browsing superior to CLI for large datasets
2. **Analytics visibility** - Token usage patterns become visible
3. **Reuses existing storage** - No data migration, no new dependencies for core function
4. **Minimal complexity** - No build step for frontend, small dependency footprint
5. **Development experience** - Fastify + Preact are fast and type-safe

### Negative

1. **Additional process** - User must start server separately
2. **New dependencies** - Adds ~3 npm packages (Fastify ecosystem)
3. **Maintenance surface** - More code to maintain
4. **No real-time updates** - Requires manual refresh (polling could be added later)

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| better-sqlite3 bundling issues | Medium | High | Reuse existing build pattern from hooks |
| Concurrent access conflicts | Low | Medium | SQLite WAL mode handles this well |
| Feature creep | Medium | Medium | Strict MVP scope, defer enhancements |
| CDN dependency for frontend | Low | Low | Can inline or self-host if needed |

---

## Alternatives Considered

### Alternative 1: Electron App

**Rejected because:**
- Heavy dependency (~150MB)
- Complex packaging
- Overkill for a personal dashboard

### Alternative 2: Full React/Vite Build

**Rejected because:**
- Adds build complexity
- Larger bundle size
- Not necessary for simple dashboard

### Alternative 3: CLI-only (TUI with blessed/ink)

**Rejected because:**
- Limited visualization capabilities
- No charts or graphs
- Harder to browse large datasets

### Alternative 4: HTTP Service for Plugin (as in original claude-mem)

**Rejected because:**
- Already decided against this in v0.1
- Adds operational complexity
- Direct SQLite access is simpler

---

**Last Updated**: March 4, 2026
**Author**: Infrastructure Architect Agent
**Status**: Implemented (v0.3.0+)
