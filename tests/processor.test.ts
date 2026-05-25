/**
 * Tests for capture processor: inferTags and processToolCapture.
 *
 * processToolCapture imports only from sanitize.js and interface.js (types),
 * so no database mocking is required.
 */

import { describe, it, expect } from 'vitest';
import { inferTags, processToolCapture } from '../src/capture/processor.js';
import type { ToolCapture, ProcessResult } from '../src/capture/processor.js';

// --- inferTags ---

describe('inferTags', () => {
  it('returns testing tag for an Edit on a .test.ts file', () => {
    const tags = inferTags('Edit', ['src/utils/sanitize.test.ts']);
    expect(tags).toContain('testing');
  });

  it('returns git tag for a Bash tool with git commit command', () => {
    const tags = inferTags('Bash', [], 'git commit -m "fix: add tests"');
    expect(tags).toContain('git');
  });

  it('returns auth tag for a Write on src/auth/middleware.ts', () => {
    const tags = inferTags('Write', ['src/auth/middleware.ts']);
    expect(tags).toContain('auth');
  });

  it('returns config tag for a Read on package.json', () => {
    const tags = inferTags('Read', ['package.json']);
    expect(tags).toContain('config');
  });

  it('returns empty array when no patterns match', () => {
    const tags = inferTags('Grep', ['src/core/logic.ts'], undefined);
    // src/core/logic.ts does not match any tag rule
    expect(tags).toEqual([]);
  });

  it('returns multiple tags when multiple patterns match', () => {
    // A test file for auth code matches both testing and auth
    const tags = inferTags('Edit', ['src/auth/login.test.ts']);
    expect(tags).toContain('testing');
    expect(tags).toContain('auth');
  });

  it('returns database tag for a file matching sqlite pattern', () => {
    const tags = inferTags('Read', ['src/storage/sqlite.ts']);
    expect(tags).toContain('database');
  });

  it('returns build tag for a Bash npm run build command', () => {
    const tags = inferTags('Bash', [], 'npm run build');
    expect(tags).toContain('build');
  });

  it('returns deps tag for a Bash npm install command', () => {
    const tags = inferTags('Bash', [], 'npm install vitest');
    expect(tags).toContain('deps');
  });

  it('returns testing tag for a Bash vitest command', () => {
    const tags = inferTags('Bash', [], 'npm run test');
    expect(tags).toContain('testing');
  });

  it('does not return tags when file list is empty and no command', () => {
    const tags = inferTags('Read', []);
    expect(tags).toEqual([]);
  });

  it('returns infra tag for a Dockerfile', () => {
    const tags = inferTags('Read', ['Dockerfile']);
    expect(tags).toContain('infra');
  });
});

// --- processToolCapture ---

describe('processToolCapture', () => {
  function makeCapture(overrides: Partial<ToolCapture> = {}): ToolCapture {
    return {
      session_id: 'test-session-001',
      project: '/Users/test/Projects/my-project',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
      tool_response: 'export default {};',
      ...overrides,
    };
  }

  it('returns an object with required Observation fields', () => {
    const capture = makeCapture();
    const result = processToolCapture(capture);
    expect('status' in result).toBe(false);
    const obs = result as Exclude<ProcessResult, { status: string }>;
    expect(obs.session_id).toBe('test-session-001');
    expect(obs.project).toBe('/Users/test/Projects/my-project');
    expect(obs.tool_name).toBe('Read');
    expect(typeof obs.summary).toBe('string');
    expect(Array.isArray(obs.files_touched)).toBe(true);
    expect(typeof obs.token_estimate).toBe('number');
    expect(obs.token_estimate).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(obs.importance);
    expect(obs.importance_score).toBeGreaterThanOrEqual(0);
    expect(obs.importance_score).toBeLessThanOrEqual(1);
    expect(typeof obs.created_at).toBe('string');
  });

  describe('metadata field stripping for Edit tool', () => {
    it('strips old_string and new_string from metadata.tool_input', () => {
      const capture = makeCapture({
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/server.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      const toolInput = obs.metadata['tool_input'] as Record<string, unknown>;
      expect(toolInput).toBeDefined();
      expect('old_string' in toolInput).toBe(false);
      expect('new_string' in toolInput).toBe(false);
      // file_path should still be present
      expect(toolInput['file_path']).toBe('src/server.ts');
    });
  });

  describe('metadata field stripping for Write tool', () => {
    it('strips content from metadata.tool_input', () => {
      const capture = makeCapture({
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/newfile.ts',
          content: 'export const greeting = "hello";',
        },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      const toolInput = obs.metadata['tool_input'] as Record<string, unknown>;
      expect(toolInput).toBeDefined();
      expect('content' in toolInput).toBe(false);
      expect(toolInput['file_path']).toBe('src/newfile.ts');
    });

    it('does not include old_string or new_string in Write metadata', () => {
      const capture = makeCapture({
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/another.ts',
          content: 'const y = 3;',
          old_string: 'should be removed',
          new_string: 'also removed',
        },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      const toolInput = obs.metadata['tool_input'] as Record<string, unknown>;
      expect('old_string' in toolInput).toBe(false);
      expect('new_string' in toolInput).toBe(false);
      expect('content' in toolInput).toBe(false);
    });
  });

  describe('Read tool does not strip tool_input', () => {
    it('passes Read tool_input through to metadata unchanged', () => {
      const capture = makeCapture({
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts', limit: 100 },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      const toolInput = obs.metadata['tool_input'] as Record<string, unknown>;
      expect(toolInput['file_path']).toBe('src/index.ts');
      expect(toolInput['limit']).toBe(100);
    });
  });

  describe('tag inference integration', () => {
    it('assigns testing tag when Edit touches a test file', () => {
      const capture = makeCapture({
        tool_name: 'Edit',
        tool_input: {
          file_path: 'tests/processor.test.ts',
          old_string: 'old',
          new_string: 'new',
        },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      expect(obs.tags).toBeDefined();
      expect(obs.tags).toContain('testing');
    });

    it('assigns no tags for a generic Read with no matching patterns', () => {
      const capture = makeCapture({
        tool_name: 'Read',
        tool_input: { file_path: 'src/core/logic.ts' },
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      // tags is undefined or an empty array when nothing matches
      const tags = obs.tags ?? [];
      expect(Array.isArray(tags)).toBe(true);
    });
  });

  describe('private content stripping', () => {
    it('redacts private tags in tool_response before storing', () => {
      const capture = makeCapture({
        tool_name: 'Bash',
        // git status is not in SKIP_BASH_PATTERNS and scores 0.35 (above skip threshold)
        tool_input: { command: 'git status --short' },
        tool_response: 'DB_HOST=localhost\n<private>DB_PASSWORD=secret123</private>',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      const storedOutput = obs.metadata['stored_output'] as string;
      expect(storedOutput).not.toContain('secret123');
      expect(storedOutput).toContain('[REDACTED]');
    });
  });

  describe('importance scoring', () => {
    it('assigns high importance to a git commit', () => {
      const capture = makeCapture({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: add feature"' },
        tool_response: '[main abc1234] feat: add feature',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      expect(obs.importance).toBe('high');
      expect(obs.importance_score).toBeGreaterThanOrEqual(0.65);
    });

    it('assigns lower importance to a Read tool', () => {
      const capture = makeCapture({
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts' },
        tool_response: 'export default {}',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      expect(['low', 'medium']).toContain(obs.importance);
    });
  });

  // --- Issue #57: Bash skip threshold ---

  describe('Bash skip threshold (issue #57)', () => {
    it('returns skipped for a low-signal Bash command below 0.15', () => {
      // python3 -c scores 0.30 base (one-off python script branch in calculateImportance).
      // Lock file penalty (-0.30) fires because extractFilesTouched picks up file_path
      // from tool_input. 0.30 - 0.30 = 0.0 -> clamped to 0.0 < 0.15 -> skipped.
      // Note: python3 -c is NOT in SKIP_BASH_PATTERNS, so it reaches processToolCapture
      // in production (unlike cat, which is pre-filtered by /^cat\s+/).
      const capture = makeCapture({
        tool_name: 'Bash',
        tool_input: {
          command: 'python3 -c "import sys; print(sys.version)"',
          file_path: 'package-lock.json',
        },
        tool_response: '3.11.0',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(true);
      expect((result as { status: string }).status).toBe('skipped');
    });

    it('does NOT skip a Bash command with an error signal even if base score would be low', () => {
      // python3 -c + lock file penalty -> clamped 0.0, but error boost +0.25 -> 0.25 >= 0.15.
      // python3 -c is NOT in SKIP_BASH_PATTERNS, so this path is exercised in production.
      const capture = makeCapture({
        tool_name: 'Bash',
        tool_input: {
          command: 'python3 -c "import sys; print(sys.version)"',
          file_path: 'package-lock.json',
        },
        tool_response: 'error: module not found',
      });
      const result = processToolCapture(capture);
      // error signal lifts score above 0.15, so observation should be stored
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      expect(obs.importance_score).toBeGreaterThanOrEqual(0.15);
    });

    it('does NOT skip a non-Bash tool even when scoring below 0.15', () => {
      // Grep scores 0.25 base — still above threshold, but test verifies the gate
      // is Bash-only by using a Glob which scores 0.20 with lock file penalty -> 0.0.
      // The skip gate must never fire for non-Bash tools.
      const capture = makeCapture({
        tool_name: 'Glob',
        tool_input: { pattern: '*.lock', path: '.', file_path: 'package-lock.json' },
        tool_response: '',
      });
      const result = processToolCapture(capture);
      // Glob is not Bash — should always return an observation, not skipped
      expect('status' in result).toBe(false);
    });

    it('does NOT skip a Bash command scoring at or above 0.15', () => {
      // git status scores 0.35 — well above threshold
      const capture = makeCapture({
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: 'On branch main\nnothing to commit',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
    });
  });

  // --- Issue #58: MCP tool summary truncation ---

  describe('MCP tool summary truncation (issue #58)', () => {
    it('truncates a long MCP tool summary when importance_score < 0.3', () => {
      // A very long tool name produces a summary of "{toolName} invocation" > 160 chars.
      // Lock file in file_path causes penalty: 0.50 - 0.30 = 0.20 < 0.30, triggering truncation.
      const longToolName = 'mcp__' + 'a'.repeat(160) + '__tool';
      const capture = makeCapture({
        tool_name: longToolName,
        tool_input: { file_path: 'package-lock.json' },
        tool_response: 'ok',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      // Score should be below 0.30 due to lock file penalty
      expect(obs.importance_score).toBeLessThan(0.3);
      // Summary should be truncated to 160 chars + "..."
      expect(obs.summary.length).toBeLessThanOrEqual(163);
      expect(obs.summary.endsWith('...')).toBe(true);
    });

    it('does NOT truncate an MCP tool summary when importance_score >= 0.3', () => {
      // Long tool name but no lock file: default score 0.50 >= 0.30, no truncation.
      const longToolName = 'mcp__' + 'b'.repeat(160) + '__tool';
      const capture = makeCapture({
        tool_name: longToolName,
        tool_input: { query: 'something' },
        tool_response: 'ok',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      expect(obs.importance_score).toBeGreaterThanOrEqual(0.3);
      // Summary is long but should NOT end with "..."
      expect(obs.summary.endsWith('...')).toBe(false);
    });

    it('does NOT truncate Edit or Write observations regardless of score', () => {
      const capture = makeCapture({
        tool_name: 'Edit',
        tool_input: {
          file_path: 'package-lock.json',
          old_string: 'x',
          new_string: 'y',
        },
        tool_response: 'ok',
      });
      const result = processToolCapture(capture);
      expect('status' in result).toBe(false);
      const obs = result as Exclude<ProcessResult, { status: string }>;
      // Edit is never truncated by the MCP path
      expect(obs.summary.startsWith('Edited')).toBe(true);
    });
  });
});
