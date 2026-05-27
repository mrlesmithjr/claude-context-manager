#!/usr/bin/env node
/**
 * E2E test data setup script.
 *
 * Inserts a known set of sessions and observations into the shared SQLite DB
 * so the HTTP MCP server scenarios have deterministic data to query.
 *
 * Uses SQLiteStorage from dist/ so the schema (including all migrations) is
 * exactly the same as the live application.
 *
 * Environment variables:
 *   CONTEXT_MANAGER_DB  path to the SQLite database (default /data/context.db)
 *   PROJECT_A           project path for instance A (default /data/projects/project-a)
 *   PROJECT_B           project path for instance B (default /data/projects/project-b)
 *   PROJECT_BUDGET      project path for budget tests (default /data/projects/project-budget)
 *   OBS_COUNT           observations per session per project (default 5)
 */

import { SQLiteStorage } from '../../dist/storage/sqlite.js';
import { randomUUID } from 'crypto';

const DB_PATH = process.env.CONTEXT_MANAGER_DB || '/data/context.db';
const PROJECT_A = process.env.PROJECT_A || '/data/projects/project-a';
const PROJECT_B = process.env.PROJECT_B || '/data/projects/project-b';
// NOTE: intentionally NOT under /data/projects/ to avoid interfering with the
// cross-project isolation test (scenario 02), which queries the /data/projects/
// parent scope and relies on budget not truncating project-a/project-b sessions.
const PROJECT_BUDGET = process.env.PROJECT_BUDGET || '/data/budget-tests/project-budget';
const OBS_COUNT = parseInt(process.env.OBS_COUNT || '5', 10);

const storage = new SQLiteStorage(DB_PATH);
await storage.initialize();

/**
 * Insert a session and N observations for a given project.
 * Returns the session ID.
 */
async function insertSession(project, obsFixtures) {
  const sessionId = randomUUID();

  await storage.createSession(sessionId, project);

  for (const obs of obsFixtures) {
    await storage.save({
      session_id: sessionId,
      project,
      tool_name: obs.toolName,
      summary: obs.summary,
      files_touched: obs.files ?? [],
      metadata: obs.metadata ?? {},
      token_estimate: obs.tokens ?? 50,
      importance: obs.importance ?? 'medium',
      importance_score: obs.score ?? 0.5,
      created_at: obs.createdAt ?? new Date().toISOString(),
      tags: obs.tags ?? undefined,
      content_hash: null,
    });
  }

  await storage.endSession(sessionId, `E2E test session for ${project}`);

  return sessionId;
}

// Observation fixtures for project-a (5 observations: 2 high, 3 medium)
const projectASession = await insertSession(PROJECT_A, [
  {
    toolName: 'Edit',
    summary: 'Added authentication middleware to src/auth/middleware.ts',
    files: ['src/auth/middleware.ts'],
    tokens: 120,
    importance: 'high',
    score: 0.85,
    tags: ['auth', 'api'],
  },
  {
    toolName: 'Write',
    summary: 'Created database schema migration for users table',
    files: ['migrations/001_add_users.sql'],
    tokens: 95,
    importance: 'high',
    score: 0.80,
    tags: ['database'],
  },
  {
    toolName: 'Read',
    summary: 'Read existing API route handlers in src/routes/',
    files: ['src/routes/index.ts'],
    tokens: 40,
    importance: 'medium',
    score: 0.45,
  },
  {
    toolName: 'Bash',
    summary: 'Ran npm test - all 24 tests passed',
    files: [],
    tokens: 60,
    importance: 'medium',
    score: 0.55,
    tags: ['testing'],
  },
  {
    toolName: 'Bash',
    summary: 'git commit -m "feat: add auth middleware and user migration"',
    files: [],
    tokens: 70,
    importance: 'medium',
    score: 0.55,
    tags: ['git'],
  },
]);

// Observation fixtures for project-b (3 observations: 1 high, 2 medium)
const projectBSession = await insertSession(PROJECT_B, [
  {
    toolName: 'Edit',
    summary: 'Refactored build pipeline configuration in webpack.config.js',
    files: ['webpack.config.js'],
    tokens: 90,
    importance: 'high',
    score: 0.80,
    tags: ['build', 'config'],
  },
  {
    toolName: 'Read',
    summary: 'Reviewed package.json dependency versions',
    files: ['package.json'],
    tokens: 35,
    importance: 'medium',
    score: 0.40,
    tags: ['deps'],
  },
  {
    toolName: 'Bash',
    summary: 'Installed frontend dependencies with npm install',
    files: [],
    tokens: 50,
    importance: 'medium',
    score: 0.45,
    tags: ['deps', 'frontend'],
  },
]);

// Budget-enforcement project: 4 sessions designed to trigger context_list truncation.
//
// Default TOKEN_BUDGET = 4000 → effectiveBudget = 3200.
// Each session below contributes ~900 tokens.
// Sessions 1+2+3 = 2700 tokens. Adding session 4 (900 tokens) would reach 3600 > 3200,
// so context_list should stop after 3 sessions and emit a truncation footer.
//
// Each observation uses a unique summary UUID fragment to bypass content-hash dedup.
const budgetSessionIds = [];
for (let s = 0; s < 4; s++) {
  const sessionId = await insertSession(PROJECT_BUDGET, [
    {
      toolName: 'Edit',
      summary: `Budget session ${s} obs 0 — added feature impl to src/feature-${s}-a.ts uuid-${randomUUID()}`,
      files: [`src/feature-${s}-a.ts`],
      tokens: 220,
      importance: 'high',
      score: 0.85,
      tags: ['api'],
    },
    {
      toolName: 'Write',
      summary: `Budget session ${s} obs 1 — created test suite for feature-${s} uuid-${randomUUID()}`,
      files: [`tests/feature-${s}.test.ts`],
      tokens: 220,
      importance: 'high',
      score: 0.80,
      tags: ['testing'],
    },
    {
      toolName: 'Bash',
      summary: `Budget session ${s} obs 2 — ran integration tests, 12 passed uuid-${randomUUID()}`,
      files: [],
      tokens: 220,
      importance: 'medium',
      score: 0.55,
      tags: ['testing'],
    },
    {
      toolName: 'Bash',
      summary: `Budget session ${s} obs 3 — git commit feature-${s} uuid-${randomUUID()}`,
      files: [],
      tokens: 240,
      importance: 'medium',
      score: 0.55,
      tags: ['git'],
    },
  ]);
  budgetSessionIds.push(sessionId);
}

await storage.close();

console.log(`[setup-data] Inserted sessions:`);
console.log(`  ${PROJECT_A}: session ${projectASession} (5 observations)`);
console.log(`  ${PROJECT_B}: session ${projectBSession} (3 observations)`);
console.log(`  ${PROJECT_BUDGET}: ${budgetSessionIds.length} sessions (~900 tokens each, designed to trigger budget truncation)`);
console.log('[setup-data] Done.');
