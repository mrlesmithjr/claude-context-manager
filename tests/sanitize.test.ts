/**
 * Tests for content sanitization utilities.
 * All pure functions with no I/O side effects.
 */

import { describe, it, expect } from 'vitest';
import {
  stripPrivateTags,
  sanitizeSensitiveData,
  sanitizeContent,
} from '../src/utils/sanitize.js';

describe('stripPrivateTags', () => {
  it('passes normal text through unchanged', () => {
    const input = 'Hello, this is normal text.';
    expect(stripPrivateTags(input)).toBe(input);
  });

  it('redacts a single private section', () => {
    const input = 'before <private>secret</private> after';
    expect(stripPrivateTags(input)).toBe('before [REDACTED] after');
  });

  it('redacts multiple private sections', () => {
    const input = '<private>first</private> middle <private>second</private> end';
    expect(stripPrivateTags(input)).toBe('[REDACTED] middle [REDACTED] end');
  });

  it('redacts everything from unclosed open tag to end of string', () => {
    const input = 'before <private>secret but no close tag';
    expect(stripPrivateTags(input)).toBe('before [REDACTED]');
  });

  it('returns empty string for empty input', () => {
    expect(stripPrivateTags('')).toBe('');
  });

  it('redacts private tag at the very start of the string', () => {
    const input = '<private>secret</private>rest';
    expect(stripPrivateTags(input)).toBe('[REDACTED]rest');
  });

  it('redacts private tag at the very end of the string', () => {
    const input = 'before<private>secret</private>';
    expect(stripPrivateTags(input)).toBe('before[REDACTED]');
  });

  it('handles nested-looking tags gracefully without catastrophic backtracking', () => {
    // Outer <private> is matched first; inner tag is consumed inside the redacted section
    const input = '<private>foo <private>bar</private>';
    // Outer tag opens at index 0, searches for </private> from after <private>
    // Finds the first </private> at the end of "bar</private>"
    // Everything between is redacted
    const result = stripPrivateTags(input);
    expect(result).toBe('[REDACTED]');
    expect(result).not.toContain('foo');
    expect(result).not.toContain('bar');
  });

  it('handles text after closed private tag correctly', () => {
    const input = 'start <private>hidden</private> visible';
    expect(stripPrivateTags(input)).toBe('start [REDACTED] visible');
  });

  it('handles content with only a private tag and nothing else', () => {
    const input = '<private>only secret</private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED]');
  });
});

describe('sanitizeSensitiveData', () => {
  it('passes clean text through unchanged', () => {
    const input = 'This is just normal text with no secrets.';
    expect(sanitizeSensitiveData(input)).toBe(input);
  });

  it('redacts sk- prefixed API keys', () => {
    // Use a variable name that does not overlap the TOKEN env-var pattern so
    // the API key regex fires before the env-var pattern can intercept it.
    const input = 'Authorization: sk-abc123defghijklmnopqrs';
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[API_KEY_REDACTED]');
    expect(result).not.toContain('sk-abc123defghijklmnopqrs');
  });

  it('redacts AWS AKIA access key IDs', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[AWS_KEY_REDACTED]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts JWT tokens (three base64 segments)', () => {
    // A minimal JWT-like token (header.payload.signature pattern with eyJ prefix)
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNTE2MjM5MDIyfQ';
    const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `Authorization: Bearer ${header}.${payload}.${sig}`;
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[JWT_REDACTED]');
    expect(result).not.toContain(header);
  });

  it('strips credentials from URLs', () => {
    const input = 'Connect to https://admin:p4ssw0rd@example.com/db';
    const result = sanitizeSensitiveData(input);
    expect(result).not.toContain('p4ssw0rd');
    expect(result).not.toContain('admin:');
  });

  it('redacts PASSWORD env var assignment', () => {
    const input = 'DB_PASSWORD=supersecret123';
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('supersecret123');
  });

  it('redacts SECRET env var assignment', () => {
    const input = 'APP_SECRET=myrandomsecretvalue';
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('myrandomsecretvalue');
  });

  it('redacts private key PEM blocks', () => {
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = sanitizeSensitiveData(input);
    expect(result).toContain('[PRIVATE_KEY_REDACTED]');
    expect(result).not.toContain('MIIEowIBAAKCAQEA');
  });
});

describe('sanitizeContent', () => {
  it('applies both private tag stripping and sensitive data redaction', () => {
    const input = 'config: <private>sk-realtoken123456789012</private>';
    const result = sanitizeContent(input);
    // The private tag is stripped first, so there is no literal API key left
    expect(result).not.toContain('sk-realtoken123456789012');
    expect(result).toContain('[REDACTED]');
  });

  it('handles content with no secrets cleanly', () => {
    const input = 'Just regular code output without any secrets.';
    expect(sanitizeContent(input)).toBe(input);
  });

  it('strips private tag and then catches any leaked patterns', () => {
    // Content outside the private tag still gets redacted by sensitive-data patterns.
    // AWS_ACCESS_KEY_ID uses the env-var pattern (KEY=); the value is still removed.
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE and <private>other</private>';
    const result = sanitizeContent(input);
    // The value is removed regardless of which pattern fires
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // Private section is also redacted
    expect(result).toContain('[REDACTED]');
  });
});
