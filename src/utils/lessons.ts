/**
 * Automatic lesson writing utilities.
 *
 * Reads Observation[] produced by SQLiteStorage.getSessionLessonCandidates()
 * and writes dated bullet entries to .lessons.md sidecar files for skills
 * that were invoked during the session.
 *
 * Agent lesson writing is intentionally disabled: agents migrated to native
 * Claude Code agent memory (MEMORY.md + topic files written by the agent
 * itself). Auto-writing agent .lessons.md sidecars would recreate files that
 * are no longer read or maintained by the agent lifecycle.
 *
 * This module has no SQLite dependency -- all I/O is filesystem only.
 * It is called from session-end.ts (Stop hook) in local mode only.
 *
 * Path conventions:
 *   skill: ~/.claude/skills/<name>/.lessons.md
 *   agent: ~/.claude/agents/<name>.lessons.md  (resolveLessonsPath only; write is skipped)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Observation } from '../storage/interface.js';

/** Only accept kebab-case identifiers matching this pattern. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Minimum importance score for an Agent or Skill invocation observation
 * to trigger lesson writing for that name. Prevents noisy one-off invocations
 * from generating lesson file entries.
 */
const INVOCATION_THRESHOLD = 0.5;

export interface WriteLessonsResult {
  written: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Extract lesson bullet text from a single observation summary.
 * Strips everything after the first newline and caps at 200 chars.
 * Returns an empty string if the summary is absent or blank.
 */
function summarizeObservation(obs: Observation): string {
  if (!obs.summary) return '';
  // Use split rather than a regex with the `s` flag for portability.
  const firstLine = obs.summary.split('\n')[0] ?? '';
  return firstLine.trim().substring(0, 200);
}

/**
 * Build deduplicated lesson bullet strings from a group of observations.
 * Observations with a lesson_type are prefixed: "[error] ..." etc.
 * Exact-duplicate first lines are silently dropped.
 */
export function buildLessonBullets(observations: Observation[]): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();

  for (const obs of observations) {
    const text = summarizeObservation(obs);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const prefix = obs.lesson_type ? `[${obs.lesson_type}] ` : '';
    bullets.push(`- ${prefix}${text}`);
  }

  return bullets;
}

/**
 * Resolve the absolute path to a .lessons.md file for the given name and kind.
 *
 * agent: ~/.claude/agents/<name>.lessons.md
 * skill: ~/.claude/skills/<name>/.lessons.md
 */
export function resolveLessonsPath(name: string, toolKind: 'agent' | 'skill'): string {
  if (toolKind === 'agent') {
    return join(homedir(), '.claude', 'agents', `${name}.lessons.md`);
  }
  return join(homedir(), '.claude', 'skills', name, '.lessons.md');
}

/**
 * Append lesson bullets to a .lessons.md sidecar file, creating it if absent.
 *
 * If the file already contains today's date heading, new bullets are inserted
 * immediately before the next date heading (or at the end of the section).
 * If today's date heading is absent, a new section is appended at the end.
 */
function appendLessons(
  filePath: string,
  name: string,
  toolKind: 'agent' | 'skill',
  today: string,
  bullets: string[]
): void {
  const mcpTool =
    toolKind === 'agent'
      ? `context_agent_lessons`
      : `context_skill_lessons skill:${name}`;
  const header = `# Lessons: ${name}\n\n> Accumulated experience. Load via MCP: ${mcpTool}\n`;
  const dateHeading = `## ${today}`;
  const bulletBlock = bullets.join('\n');

  if (!existsSync(filePath)) {
    // Create the parent directory if needed (skills may need their skill dir created).
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(filePath, `${header}\n${dateHeading}\n${bulletBlock}\n`, 'utf8');
    return;
  }

  // File exists — insert under the today heading or append a new section.
  const content = readFileSync(filePath, 'utf8');
  // Normalize: strip the trailing empty element produced by a file-ending newline
  // so that bullet insertion doesn't create spurious blank lines inside a section.
  const rawLines = content.split('\n');
  const lines = rawLines.at(-1) === '' ? rawLines.slice(0, -1) : rawLines;
  const headingIdx = lines.findIndex(l => l.trim() === dateHeading);

  if (headingIdx !== -1) {
    // Find the end of this date section: next ## heading or EOF.
    let insertIdx = headingIdx + 1;
    while (insertIdx < lines.length && !lines[insertIdx]!.startsWith('## ')) {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, ...bullets);
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  } else {
    // Append new date section at end.
    const suffix = content.endsWith('\n') ? '' : '\n';
    writeFileSync(filePath, `${content}${suffix}\n${dateHeading}\n${bulletBlock}\n`, 'utf8');
  }
}

/**
 * Write dated lesson entries for skills referenced in the provided observations
 * array. Agent groups are silently skipped (agents use native Claude Code memory
 * instead of .lessons.md sidecars).
 *
 * Called from session-end.ts after the auto-memory export, in local mode only.
 * Observations without a `skill` field are silently skipped -- they carry no
 * agent/skill attribution.
 *
 * Write thresholds (either must be met for a name to trigger a write):
 *   1. At least one Skill invocation observation with importance >= INVOCATION_THRESHOLD
 *   2. At least one observation with a lesson_type (error/build_failure/etc.)
 *
 * Names that fail the kebab-case validation or produce zero bullet text are
 * recorded in `skipped` rather than written.
 *
 * @param observations - Lesson candidates from getSessionLessonCandidates()
 * @param today - ISO date string (YYYY-MM-DD); defaults to today's date
 */
export function writeSessionLessons(
  observations: Observation[],
  today: string = new Date().toISOString().slice(0, 10)
): WriteLessonsResult {
  // Group observations by skill name.
  const groups = new Map<string, Observation[]>();
  for (const obs of observations) {
    if (!obs.skill) continue;
    if (!groups.has(obs.skill)) groups.set(obs.skill, []);
    groups.get(obs.skill)!.push(obs);
  }

  const result: WriteLessonsResult = { written: [], skipped: [], errors: [] };

  for (const [name, group] of groups) {
    try {
      if (!SAFE_NAME.test(name)) {
        result.skipped.push(name);
        continue;
      }

      // Determine kind: Agent invocations are tagged with tool_name='Agent'.
      const toolKind: 'agent' | 'skill' = group.some(o => o.tool_name === 'Agent')
        ? 'agent'
        : 'skill';

      // Agent .lessons.md auto-write is retired: agents use native Claude Code
      // memory (MEMORY.md). Skip silently so existing files are not recreated.
      if (toolKind === 'agent') {
        result.skipped.push(name);
        continue;
      }

      // Apply write threshold: at least one significant invocation or lesson.
      const hasSignificantInvocation = group.some(
        o =>
          (o.tool_name === 'Agent' || o.tool_name === 'Skill') &&
          (o.importance_score ?? 0) >= INVOCATION_THRESHOLD
      );
      const hasLessonType = group.some(o => o.lesson_type != null);

      if (!hasSignificantInvocation && !hasLessonType) {
        result.skipped.push(name);
        continue;
      }

      const bullets = buildLessonBullets(group);
      if (bullets.length === 0) {
        result.skipped.push(name);
        continue;
      }

      const filePath = resolveLessonsPath(name, toolKind);
      appendLessons(filePath, name, toolKind, today, bullets);
      result.written.push(name);
    } catch (err) {
      result.errors.push(`${name}: ${String(err)}`);
    }
  }

  return result;
}
