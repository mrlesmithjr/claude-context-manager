/**
 * Unit tests for getWithinBudget() and getSessionObservations()
 * — the two storage methods rewritten in v0.8.96 (issue #121).
 *
 * Uses an in-memory SQLite database so these tests run without any
 * filesystem setup and complete in milliseconds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import type { Observation } from '../src/storage/interface.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal observation payload ready for storage.save(). */
function makeObs(overrides: Partial<Omit<Observation, 'id'>> = {}): Omit<Observation, 'id'> {
  return {
    session_id: randomUUID(),
    project: '/test/project',
    tool_name: 'Edit',
    // Unique summary per call to avoid content-hash dedup between tests.
    summary: `Edited file-${randomUUID().slice(0, 8)}`,
    files_touched: [],
    metadata: {},
    token_estimate: 100,
    importance: 'medium',
    importance_score: 0.5,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Force-set is_compacted = 1 on an observation by ID via rawDb. */
function markCompacted(storage: SQLiteStorage, id: number): void {
  storage.rawDb.prepare('UPDATE observations SET is_compacted = 1 WHERE id = ?').run(id);
}

/** Force-set superseded_by on an observation by ID via rawDb. */
function markSuperseded(storage: SQLiteStorage, id: number, supersededById: number): void {
  storage.rawDb
    .prepare('UPDATE observations SET superseded_by = ? WHERE id = ?')
    .run(supersededById, id);
}

// ---------------------------------------------------------------------------
// getWithinBudget
// ---------------------------------------------------------------------------

describe('getWithinBudget', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns empty array when no observations exist', async () => {
    const results = await storage.getWithinBudget('/test/project', 4000);
    expect(results).toHaveLength(0);
  });

  it('excludes compacted observations', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    const id1 = await storage.save(makeObs({ session_id: sessionId, importance_score: 0.80, token_estimate: 50 }));
    const id2 = await storage.save(makeObs({ session_id: sessionId, importance_score: 0.70, token_estimate: 50 }));

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    markCompacted(storage, id1!);

    const results = await storage.getWithinBudget('/test/project', 4000);
    const resultIds = results.map(r => r.id);
    expect(resultIds).not.toContain(id1);
    expect(resultIds).toContain(id2);
  });

  it('excludes superseded observations', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    const id1 = await storage.save(makeObs({ session_id: sessionId, importance_score: 0.80, token_estimate: 50 }));
    const id2 = await storage.save(makeObs({ session_id: sessionId, importance_score: 0.80, token_estimate: 50 }));

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    markSuperseded(storage, id1!, id2!);

    const results = await storage.getWithinBudget('/test/project', 4000);
    const resultIds = results.map(r => r.id);
    expect(resultIds).not.toContain(id1);
    expect(resultIds).toContain(id2);
  });

  it('places observations with importance_score >= 0.65 in Pass 1 and includes the rest via Pass 2', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    // budget=1000 → effectiveBudget=800 → highBudget=480, remainingBudget=320
    // 3 high-importance obs at 100 tokens each (300 total, fits in 480)
    // 1 low-importance obs at 100 tokens (fits in remainingBudget=500)
    const highIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await storage.save(makeObs({
        session_id: sessionId,
        summary: `High importance edit ${i} uuid-${randomUUID()}`,
        importance_score: 0.80,
        importance: 'high',
        token_estimate: 100,
      }));
      if (id !== undefined) highIds.push(id);
    }
    const lowId = await storage.save(makeObs({
      session_id: sessionId,
      summary: `Low importance read uuid-${randomUUID()}`,
      importance_score: 0.40,
      importance: 'low',
      token_estimate: 100,
    }));

    const results = await storage.getWithinBudget('/test/project', 1000);
    const resultIds = results.map(r => r.id);

    // All 4 should fit within the 800-token effective budget
    expect(results).toHaveLength(4);
    for (const id of highIds) {
      expect(resultIds).toContain(id);
    }
    expect(resultIds).toContain(lowId);
  });

  it('never returns more tokens than effectiveBudget (TOKEN_BUDGET * 0.8)', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    // budget=500 → effectiveBudget=400; insert 6 items at 100 tokens = 600 total
    for (let i = 0; i < 6; i++) {
      await storage.save(makeObs({
        session_id: sessionId,
        summary: `Medium obs ${i} uuid-${randomUUID()}`,
        importance_score: 0.50,
        token_estimate: 100,
      }));
    }

    const results = await storage.getWithinBudget('/test/project', 500);
    const totalTokens = results.reduce((sum, o) => sum + o.token_estimate, 0);

    expect(totalTokens).toBeLessThanOrEqual(400); // effectiveBudget = floor(500 * 0.8)
    expect(results.length).toBeLessThanOrEqual(4);
  });

  it('uses continue in Pass 1 — smaller high-importance items are included after a large one is skipped', async () => {
    // This is the correctness fix from code review: if we used break instead of
    // continue, obs B and C would never be considered after A overflows the budget.
    //
    // budget=500 → effectiveBudget=400 → highBudget=240
    // A: importance 0.90, 300 tokens → 300 > 240, skip (continue)
    // B: importance 0.80, 100 tokens → 100 <= 240, include; highTokens=100
    // C: importance 0.70, 100 tokens → 100+100=200 <= 240, include; highTokens=200
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    // Insert in descending importance order so decay sort puts A first.
    await storage.save(makeObs({
      session_id: sessionId,
      summary: `Large high-importance obs A uuid-${randomUUID()}`,
      importance_score: 0.90,
      importance: 'high',
      token_estimate: 300,
    }));
    const idB = await storage.save(makeObs({
      session_id: sessionId,
      summary: `Small high-importance obs B uuid-${randomUUID()}`,
      importance_score: 0.80,
      importance: 'high',
      token_estimate: 100,
    }));
    const idC = await storage.save(makeObs({
      session_id: sessionId,
      summary: `Small high-importance obs C uuid-${randomUUID()}`,
      importance_score: 0.70,
      importance: 'high',
      token_estimate: 100,
    }));

    expect(idB).toBeDefined();
    expect(idC).toBeDefined();

    const results = await storage.getWithinBudget('/test/project', 500);
    const resultIds = results.map(r => r.id);

    // B and C fit even though A (which sorts first) was skipped for being too large.
    expect(resultIds).toContain(idB);
    expect(resultIds).toContain(idC);
  });

  it('uses prefix matching — parent project path sees child project observations', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project/child');

    const id = await storage.save(makeObs({
      session_id: sessionId,
      project: '/test/project/child',
      importance_score: 0.80,
      token_estimate: 50,
    }));
    expect(id).toBeDefined();

    const results = await storage.getWithinBudget('/test/project', 4000);
    const resultIds = results.map(r => r.id);
    expect(resultIds).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// getSessionObservations
// ---------------------------------------------------------------------------

describe('getSessionObservations', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('excludes compacted observations from session view', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    const id1 = await storage.save(makeObs({ session_id: sessionId, summary: `Active obs uuid-${randomUUID()}` }));
    const id2 = await storage.save(makeObs({ session_id: sessionId, summary: `Compacted obs uuid-${randomUUID()}` }));

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    markCompacted(storage, id2!);

    const results = await storage.getSessionObservations(sessionId);
    const resultIds = results.map(r => r.id);
    expect(resultIds).toContain(id1);
    expect(resultIds).not.toContain(id2);
  });

  it('excludes superseded observations from session view', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    const id1 = await storage.save(makeObs({ session_id: sessionId, summary: `Old fact uuid-${randomUUID()}` }));
    const id2 = await storage.save(makeObs({ session_id: sessionId, summary: `New fact uuid-${randomUUID()}` }));

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    markSuperseded(storage, id1!, id2!);

    const results = await storage.getSessionObservations(sessionId);
    const resultIds = results.map(r => r.id);
    expect(resultIds).not.toContain(id1);
    expect(resultIds).toContain(id2);
  });

  it('returns active observations ordered by created_at ascending', async () => {
    const sessionId = randomUUID();
    await storage.createSession(sessionId, '/test/project');

    const earlier = new Date(Date.now() - 60000).toISOString();
    const later = new Date().toISOString();

    const id1 = await storage.save(makeObs({
      session_id: sessionId,
      summary: `Earlier obs uuid-${randomUUID()}`,
      created_at: earlier,
    }));
    const id2 = await storage.save(makeObs({
      session_id: sessionId,
      summary: `Later obs uuid-${randomUUID()}`,
      created_at: later,
    }));

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();

    const results = await storage.getSessionObservations(sessionId);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const resultIds = results.map(r => r.id);
    expect(resultIds.indexOf(id1!)).toBeLessThan(resultIds.indexOf(id2!));
  });
});
