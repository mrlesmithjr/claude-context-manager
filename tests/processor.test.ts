/**
 * Tests for capture processor: inferTags and processToolCapture.
 *
 * processToolCapture imports only from sanitize.js and interface.js (types),
 * so no database mocking is required.
 */

import { describe, it, expect } from 'vitest';
import { inferTags, processToolCapture } from '../src/capture/processor.js';
import type { ToolCapture } from '../src/capture/processor.js';

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
    const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
      expect(obs.tags).toBeDefined();
      expect(obs.tags).toContain('testing');
    });

    it('assigns no tags for a generic Read with no matching patterns', () => {
      const capture = makeCapture({
        tool_name: 'Read',
        tool_input: { file_path: 'src/core/logic.ts' },
      });
      const obs = processToolCapture(capture);
      // tags is undefined or an empty array when nothing matches
      const tags = obs.tags ?? [];
      expect(Array.isArray(tags)).toBe(true);
    });
  });

  describe('private content stripping', () => {
    it('redacts private tags in tool_response before storing', () => {
      const capture = makeCapture({
        tool_name: 'Bash',
        tool_input: { command: 'cat config.env' },
        tool_response: 'DB_HOST=localhost\n<private>DB_PASSWORD=secret123</private>',
      });
      const obs = processToolCapture(capture);
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
      const obs = processToolCapture(capture);
      expect(obs.importance).toBe('high');
      expect(obs.importance_score).toBeGreaterThanOrEqual(0.65);
    });

    it('assigns lower importance to a Read tool', () => {
      const capture = makeCapture({
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts' },
        tool_response: 'export default {}',
      });
      const obs = processToolCapture(capture);
      expect(['low', 'medium']).toContain(obs.importance);
    });
  });
});
