import { describe, it, expect } from 'vitest';
import { formatShortDate } from '../src/utils/session-format.js';

describe('formatShortDate', () => {
  it('formats a mid-day UTC date correctly', () => {
    expect(formatShortDate('2026-05-15T14:30:00.000Z')).toBe('May 15');
  });

  it('does not shift the date for UTC-midnight timestamps', () => {
    // 2026-05-24T00:00:00Z is May 24 in UTC.
    // In UTC-5 local time this is May 23 23:00, so getDate() would return 23.
    // getUTCDate() must return 24.
    expect(formatShortDate('2026-05-24T00:00:00.000Z')).toBe('May 24');
  });

  it('handles end-of-month UTC midnight without rolling back', () => {
    // 2026-03-31T00:30:00Z is March 31 in UTC.
    expect(formatShortDate('2026-03-31T00:30:00.000Z')).toBe('Mar 31');
  });

  it('formats a January date correctly', () => {
    expect(formatShortDate('2026-01-01T12:00:00.000Z')).toBe('Jan 1');
  });

  it('formats a December date correctly', () => {
    expect(formatShortDate('2026-12-31T23:59:59.000Z')).toBe('Dec 31');
  });
});
