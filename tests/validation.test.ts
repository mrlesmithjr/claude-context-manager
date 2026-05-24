/**
 * Tests for input validation utilities.
 *
 * validateProjectPath uses realpathSync which follows symlinks, so tests must
 * use paths that actually exist on the filesystem.
 *
 * We use homedir() as the base for "valid" paths — it is always in
 * ALLOWED_PROJECT_ROOTS and always exists (local dev, CI, Docker). Paths under
 * ~/Projects or ~/Dev may not exist on every machine, so we avoid them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';
import { mkdtempSync, rmdirSync } from 'fs';
import {
  validateProjectPath,
  validateSessionStartInput,
  validateStopInput,
} from '../src/utils/validation.js';

const HOME = homedir();

// Temp directory created under homedir — guaranteed to exist and be in ALLOWED_PROJECT_ROOTS
let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(HOME, 'ctx-test-'));
});
afterEach(() => {
  try { rmdirSync(tmpDir); } catch { /* already removed */ }
});

describe('validateProjectPath', () => {
  it('accepts a valid path that exists under homedir', () => {
    // tmpDir exists and is under homedir — always in ALLOWED_PROJECT_ROOTS
    const result = validateProjectPath(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('accepts the home directory itself', () => {
    const result = validateProjectPath(HOME);
    expect(result).toBe(HOME);
  });

  it('accepts a non-existent path inside an allowed root (uses path.resolve fallback)', () => {
    // Path does not exist so realpathSync throws, but path.resolve normalizes it,
    // and homedir is in ALLOWED_PROJECT_ROOTS so the check passes
    const input = path.join(HOME, 'NonExistentProject', 'subdir');
    const result = validateProjectPath(input);
    expect(result.startsWith(HOME)).toBe(true);
  });

  it('throws for a path clearly outside allowed roots', () => {
    expect(() => validateProjectPath('/etc/passwd')).toThrow(/outside allowed roots/);
  });

  it('throws for /tmp which is not under any allowed root', () => {
    expect(() => validateProjectPath('/tmp/evil')).toThrow();
  });

  it('throws for /var/log', () => {
    expect(() => validateProjectPath('/var/log')).toThrow();
  });
});

describe('validateSessionStartInput', () => {
  it('accepts valid input with session_id and cwd', () => {
    const input = {
      session_id: 'test-session-123',
      cwd: tmpDir,
    };
    const result = validateSessionStartInput(input);
    expect(result.session_id).toBe('test-session-123');
    expect(result.cwd).toBeTruthy();
  });

  it('generates a session_id when not provided', () => {
    const input = { cwd: tmpDir };
    const result = validateSessionStartInput(input);
    expect(typeof result.session_id).toBe('string');
    expect(result.session_id.length).toBeGreaterThan(0);
  });

  it('does not throw when cwd is outside allowed roots — falls back to process.cwd() or homedir()', () => {
    const input = {
      session_id: 'fallback-test',
      cwd: '/etc/invalid-path',
    };
    // Should not throw — falls back gracefully
    expect(() => validateSessionStartInput(input)).not.toThrow();
    const result = validateSessionStartInput(input);
    // cwd should be some allowed path (process.cwd() or homedir())
    expect(result.cwd).toBeTruthy();
    expect(result.cwd.startsWith(HOME)).toBe(true);
  });

  it('handles empty object — generates session_id and uses process.cwd()', () => {
    const result = validateSessionStartInput({});
    expect(typeof result.session_id).toBe('string');
    expect(result.session_id.length).toBeGreaterThan(0);
    expect(result.cwd).toBeTruthy();
  });

  it('handles null input gracefully — generates session_id', () => {
    const result = validateSessionStartInput(null);
    expect(typeof result.session_id).toBe('string');
  });

  it('handles non-object input gracefully', () => {
    const result = validateSessionStartInput('not an object');
    expect(typeof result.session_id).toBe('string');
  });
});

describe('validateStopInput', () => {
  it('accepts valid input and returns validated object', () => {
    const input = {
      session_id: 'stop-session-1',
      cwd: tmpDir,
    };
    const result = validateStopInput(input);
    expect(result.session_id).toBe('stop-session-1');
    expect(result.cwd).toBeTruthy();
    expect(result.transcript_path).toBeUndefined();
  });

  it('throws for missing session_id', () => {
    expect(() =>
      validateStopInput({ cwd: tmpDir })
    ).toThrow(/session_id/);
  });

  it('throws for missing cwd', () => {
    expect(() =>
      validateStopInput({ session_id: 'abc' })
    ).toThrow(/cwd/);
  });

  it('throws for null input', () => {
    expect(() => validateStopInput(null)).toThrow();
  });

  it('returns transcript_path as undefined when path does not exist', () => {
    const nonExistentTranscript = path.join(
      HOME,
      '.claude',
      'projects',
      'fake-project',
      'transcript-doesnt-exist.jsonl'
    );
    const input = {
      session_id: 'session-abc',
      cwd: tmpDir,
      transcript_path: nonExistentTranscript,
    };
    const result = validateStopInput(input);
    // realpathSync throws for non-existent path — silently dropped
    expect(result.transcript_path).toBeUndefined();
  });

  it('returns transcript_path as undefined when path is outside ~/.claude/projects', () => {
    const outsidePath = path.join(HOME, 'Documents', 'some-transcript.jsonl');
    const input = {
      session_id: 'session-abc',
      cwd: tmpDir,
      transcript_path: outsidePath,
    };
    const result = validateStopInput(input);
    expect(result.transcript_path).toBeUndefined();
  });

  it('returns transcript_path as undefined when transcript_path is missing', () => {
    const input = {
      session_id: 'session-no-transcript',
      cwd: tmpDir,
    };
    const result = validateStopInput(input);
    expect(result.transcript_path).toBeUndefined();
  });

  it('throws for cwd outside allowed roots', () => {
    expect(() =>
      validateStopInput({ session_id: 'abc', cwd: '/etc' })
    ).toThrow();
  });
});
