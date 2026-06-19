/**
 * Tests for writeSessionLessons in src/utils/lessons.ts.
 *
 * Verifies that:
 *   - Skills with qualifying observations are written to disk.
 *   - Agent groups are always skipped (agent .lessons.md auto-write retired).
 *   - Mixed sessions (skill + agent) write the skill but skip the agent.
 *   - Groups that fall below the write threshold are reported as skipped.
 *   - buildLessonBullets deduplicates exact-duplicate first lines.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Observation } from '../src/storage/interface.js';
import { writeSessionLessons, buildLessonBullets, resolveLessonsPath } from '../src/utils/lessons.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Observation with only the fields lessons.ts reads. */
function makeObs(overrides: Partial<Observation> & { summary: string; tool_name: string }): Observation {
  return {
    id: 1,
    project: '/test/project',
    session_id: 'sess-1',
    tool_name: overrides.tool_name,
    summary: overrides.summary,
    files_touched: [],
    metadata: {},
    token_estimate: 10,
    importance: 'medium',
    importance_score: overrides.importance_score ?? 0.6,
    created_at: '2026-06-19T00:00:00.000Z',
    skill: overrides.skill ?? null,
    lesson_type: overrides.lesson_type ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Redirect homedir to a temp directory so tests never touch real ~/.claude
// ---------------------------------------------------------------------------

let tmpHome: string;
const originalHomedir = process.env.HOME;

beforeEach(() => {
  tmpHome = join(tmpdir(), `lessons-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHomedir;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildLessonBullets
// ---------------------------------------------------------------------------

describe('buildLessonBullets', () => {
  it('returns empty array for observations with no summary', () => {
    const obs = makeObs({ summary: '', tool_name: 'Skill' });
    expect(buildLessonBullets([obs])).toEqual([]);
  });

  it('prefixes lesson_type when present', () => {
    const obs = makeObs({ summary: 'Build failed: missing dep', tool_name: 'Bash', lesson_type: 'build_failure' });
    const bullets = buildLessonBullets([obs]);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toBe('- [build_failure] Build failed: missing dep');
  });

  it('deduplicates identical first lines', () => {
    const obs1 = makeObs({ summary: 'Same error happened', tool_name: 'Bash' });
    const obs2 = makeObs({ summary: 'Same error happened', tool_name: 'Bash', id: 2 });
    const bullets = buildLessonBullets([obs1, obs2]);
    expect(bullets).toHaveLength(1);
  });

  it('truncates summaries to 200 characters', () => {
    const long = 'x'.repeat(300);
    const obs = makeObs({ summary: long, tool_name: 'Skill' });
    const bullets = buildLessonBullets([obs]);
    expect(bullets[0]!.length).toBeLessThanOrEqual(202); // '- ' + 200 chars
  });
});

// ---------------------------------------------------------------------------
// resolveLessonsPath
// ---------------------------------------------------------------------------

describe('resolveLessonsPath', () => {
  it('agent path ends with <name>.lessons.md under .claude/agents/', () => {
    const p = resolveLessonsPath('code-reviewer', 'agent');
    expect(p).toMatch(/\.claude[/\\]agents[/\\]code-reviewer\.lessons\.md$/);
  });

  it('skill path ends with .lessons.md under .claude/skills/<name>/', () => {
    const p = resolveLessonsPath('dev-framework', 'skill');
    expect(p).toMatch(/\.claude[/\\]skills[/\\]dev-framework[/\\]\.lessons\.md$/);
  });
});

// ---------------------------------------------------------------------------
// writeSessionLessons: skill path
// ---------------------------------------------------------------------------

describe('writeSessionLessons - skills', () => {
  it('writes a .lessons.md file for a qualifying skill', () => {
    const obs = makeObs({
      tool_name: 'Skill',
      summary: 'Used dev-framework to plan the feature',
      skill: 'dev-framework',
      importance_score: 0.7,
    });

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.written).toContain('dev-framework');
    expect(result.skipped).not.toContain('dev-framework');
    expect(result.errors).toHaveLength(0);

    const expectedPath = join(tmpHome, '.claude', 'skills', 'dev-framework', '.lessons.md');
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, 'utf8');
    expect(content).toContain('## 2026-06-19');
    expect(content).toContain('Used dev-framework to plan the feature');
  });

  it('appends to existing date section without duplicating the heading', () => {
    const skillDir = join(tmpHome, '.claude', 'skills', 'blog-writer');
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, '.lessons.md');
    const existing = `# Lessons: blog-writer\n\n> Load via MCP: context_skill_lessons skill:blog-writer\n\n## 2026-06-19\n- First bullet\n`;
    require('fs').writeFileSync(filePath, existing, 'utf8');

    const obs = makeObs({
      tool_name: 'Skill',
      summary: 'Second bullet from later in the session',
      skill: 'blog-writer',
      importance_score: 0.8,
    });

    writeSessionLessons([obs], '2026-06-19');

    const content = readFileSync(filePath, 'utf8');
    const headingMatches = (content.match(/## 2026-06-19/g) ?? []).length;
    expect(headingMatches).toBe(1);
    expect(content).toContain('First bullet');
    expect(content).toContain('Second bullet from later in the session');
  });

  it('skips a skill group that has no significant invocation and no lesson_type', () => {
    const obs = makeObs({
      tool_name: 'Skill',
      summary: 'Minor low-importance use',
      skill: 'low-prio-skill',
      importance_score: 0.1,
    });

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.skipped).toContain('low-prio-skill');
    expect(result.written).not.toContain('low-prio-skill');
  });

  it('writes a skill with lesson_type even when importance is below threshold', () => {
    const obs = makeObs({
      tool_name: 'Bash',
      summary: 'npm install failed with peer dep error',
      skill: 'install-skill',
      importance_score: 0.1,
      lesson_type: 'build_failure',
    });

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.written).toContain('install-skill');
    const filePath = join(tmpHome, '.claude', 'skills', 'install-skill', '.lessons.md');
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeSessionLessons: agent path (must always be skipped)
// ---------------------------------------------------------------------------

describe('writeSessionLessons - agents', () => {
  it('skips an agent group even when importance is above threshold', () => {
    const obs = makeObs({
      tool_name: 'Agent',
      summary: 'code-reviewer caught a null-deref bug',
      skill: 'code-reviewer',
      importance_score: 0.9,
    });

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.skipped).toContain('code-reviewer');
    expect(result.written).not.toContain('code-reviewer');
    expect(result.errors).toHaveLength(0);
  });

  it('does not create a .lessons.md file for an agent', () => {
    const obs = makeObs({
      tool_name: 'Agent',
      summary: 'Agent invocation with lesson_type',
      skill: 'typescript-developer',
      importance_score: 0.95,
      lesson_type: 'error',
    });

    writeSessionLessons([obs], '2026-06-19');

    const agentLessonsPath = join(tmpHome, '.claude', 'agents', 'typescript-developer.lessons.md');
    expect(existsSync(agentLessonsPath)).toBe(false);
  });

  it('skips agent but writes skill in a mixed session', () => {
    const agentObs = makeObs({
      tool_name: 'Agent',
      summary: 'Agent did something important',
      skill: 'agent-x',
      importance_score: 0.9,
    });
    const skillObs = makeObs({
      tool_name: 'Skill',
      summary: 'Skill did something important',
      skill: 'skill-y',
      importance_score: 0.9,
      id: 2,
    });

    const result = writeSessionLessons([agentObs, skillObs], '2026-06-19');

    expect(result.skipped).toContain('agent-x');
    expect(result.written).toContain('skill-y');
    expect(existsSync(join(tmpHome, '.claude', 'agents', 'agent-x.lessons.md'))).toBe(false);
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'skill-y', '.lessons.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeSessionLessons: safety guards
// ---------------------------------------------------------------------------

describe('writeSessionLessons - safety guards', () => {
  it('skips observations with no skill field', () => {
    const obs = makeObs({
      tool_name: 'Edit',
      summary: 'Edited a file',
      importance_score: 0.8,
    });
    // skill defaults to null in makeObs

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips a name that fails kebab-case validation', () => {
    const obs = makeObs({
      tool_name: 'Skill',
      summary: 'This skill has a bad name',
      skill: 'bad name with spaces',
      importance_score: 0.9,
    });

    const result = writeSessionLessons([obs], '2026-06-19');

    expect(result.skipped).toContain('bad name with spaces');
    expect(result.written).toHaveLength(0);
  });

  it('returns empty result for an empty observations array', () => {
    const result = writeSessionLessons([], '2026-06-19');
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
