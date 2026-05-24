import { describe, it, expect } from 'vitest';
import { classifyQuery } from '../src/utils/classify.js';

describe('classifyQuery', () => {
  // keyword: 1-2 words
  it('routes a single word to keyword', () => {
    expect(classifyQuery('sqlite')).toBe('keyword');
  });

  it('routes a two-word query to keyword', () => {
    expect(classifyQuery('sqlite fts5')).toBe('keyword');
  });

  // semantic: NL starters (any length >= 3)
  it('routes a 4-word NL starter query to semantic', () => {
    expect(classifyQuery('how did scoring change')).toBe('semantic');
  });

  it('routes a 5-word NL starter query to semantic', () => {
    expect(classifyQuery('why did the compact break')).toBe('semantic');
  });

  it('routes a 4-word what-starter query to semantic', () => {
    expect(classifyQuery('what is happening here')).toBe('semantic');
  });

  it('routes a 3-word explain-starter query to semantic', () => {
    expect(classifyQuery('explain observation scoring')).toBe('semantic');
  });

  // semantic: 5+ words without an NL starter
  it('routes a 5-word non-NL-starter query to semantic', () => {
    expect(classifyQuery('sqlite fts5 full text search')).toBe('semantic');
  });

  // hybrid: 3-4 words, no NL starter
  it('routes a 3-word non-NL-starter query to hybrid', () => {
    expect(classifyQuery('tag inference rules')).toBe('hybrid');
  });

  it('routes a 4-word non-NL-starter query to hybrid', () => {
    expect(classifyQuery('session end hook failure')).toBe('hybrid');
  });

  it('routes a 4-word query with non-NL-starter first word to hybrid', () => {
    expect(classifyQuery('recent sessions for project')).toBe('hybrid');
  });

  // word count wins over NL starter when query is too short
  it('routes a 2-word NL-starter query to keyword (word count wins)', () => {
    expect(classifyQuery('explain this')).toBe('keyword');
  });

  // multi-word starters: "show me" and "similar to"
  it('routes "show me" multi-word starter to semantic', () => {
    expect(classifyQuery('show me recent errors')).toBe('semantic');
  });

  it('routes "similar to" multi-word starter to semantic', () => {
    expect(classifyQuery('similar to sqlite work')).toBe('semantic');
  });
});
