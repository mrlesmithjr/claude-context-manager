/**
 * Auto-Memory Export Module
 *
 * Exports high-importance observations to Claude Code's auto-memory
 * topic files (~/.claude/projects/<path>/memory/).
 *
 * Uses session-level summaries instead of per-observation detail:
 * - Session summary as heading (from Stop hook)
 * - Files deduplicated and grouped by action
 * - Git commits consolidated
 * - Capped at ~5 key items per session
 *
 * Writes to a dedicated topic file (context-manager-activity.md),
 * never touches MEMORY.md.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { convertPathToDashed } from '../utils/transcript.js';
import { computeSessionDuration, extractSessionNarrative } from '../utils/session-format.js';
import type { Observation, Session, ContextStorage } from '../storage/interface.js';

const TOPIC_FILE = 'context-manager-activity.md';
const DEFAULT_MAX_LINES = 150;
const MAX_ITEMS_PER_SESSION = 6;

/**
 * Resolve the auto-memory directory for a project.
 * Returns ~/.claude/projects/{dashed-path}/memory/
 */
export function resolveMemoryDir(projectPath: string): string {
  const dashedPath = convertPathToDashed(projectPath);
  return join(homedir(), '.claude', 'projects', dashedPath, 'memory');
}

/**
 * Format observations as session-level summaries for the topic file.
 * Groups by date → session, deduplicates files, caps per session.
 */
export function formatObservationsForMemory(
  observations: Observation[],
  sessions?: Session[]
): string {
  if (observations.length === 0) return '';

  // Build session lookup
  const sessionLookup = new Map<string, Session>();
  if (sessions) {
    for (const s of sessions) {
      sessionLookup.set(s.id, s);
    }
  }

  // Group by date then session
  const byDate = new Map<string, Map<string, Observation[]>>();

  for (const obs of observations) {
    const date = obs.created_at.split('T')[0] ?? 'unknown';
    if (!byDate.has(date)) byDate.set(date, new Map());
    const dateGroup = byDate.get(date)!;
    if (!dateGroup.has(obs.session_id)) dateGroup.set(obs.session_id, []);
    dateGroup.get(obs.session_id)!.push(obs);
  }

  const lines: string[] = [];

  for (const [date, sessionMap] of byDate) {
    lines.push(`## ${date}`);
    lines.push('');

    for (const [sessionId, sessionObs] of sessionMap) {
      const block = formatSessionBlock(sessionObs, sessionLookup.get(sessionId));
      if (block) {
        lines.push(block);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a single session's observations as a compact block.
 */
function formatSessionBlock(
  observations: Observation[],
  session?: Session
): string {
  const sessionId = observations[0]?.session_id || 'unknown';
  const shortId = sessionId.substring(0, 8);

  // Build session heading with duration and action count
  let heading: string;
  if (session) {
    const duration = computeSessionDuration(session);
    heading = `### Session ${shortId} (${duration}, ${observations.length} actions)`;
  } else {
    heading = `### ${shortId}`;
  }

  // Narrative summary line (not a bullet — plain text under heading)
  const narrative = session ? extractSessionNarrative(session.summary) : '';

  // Categorize observations
  const created: string[] = [];
  const edited = new Map<string, string[]>(); // file → descriptions
  const commits: string[] = [];
  const commands: string[] = [];
  const insights: string[] = [];

  for (const obs of observations) {
    const file = obs.files_touched[0] || '';
    const shortFile = file ? file.split('/').slice(-2).join('/') : '';

    switch (obs.tool_name) {
      case 'Write':
        created.push(shortFile);
        break;
      case 'Edit': {
        const desc = describeEdit(obs);
        if (!edited.has(shortFile)) edited.set(shortFile, []);
        edited.get(shortFile)!.push(desc);
        break;
      }
      case 'Bash': {
        if (obs.summary.includes('git commit')) {
          const msg = obs.summary.match(/commit -m ["'](.+?)["']/)?.[1]
            || obs.summary.match(/"([^"]+)"/)?.[1]
            || '';
          if (msg) commits.push(msg.substring(0, 70));
        } else if (obs.summary.includes('git push')) {
          commands.push('Git push');
        } else if (obs.summary.includes('npm install') || obs.summary.includes('yarn add')) {
          commands.push('Install dependencies');
        } else if (obs.summary.includes('npm run test') || obs.summary.includes('npm test')) {
          commands.push('Tests');
        }
        // Deliberately skip: npm run build, npm version — these are routine noise
        break;
      }
      case 'Conversation': {
        // High-signal conversation insights extracted by session-end hook
        const insightText = obs.summary.substring(0, 80);
        if (insightText.length > 5) {
          insights.push(insightText);
        }
        break;
      }
      default:
        break;
    }
  }

  // Build compact output lines
  const items: string[] = [];

  // Created files
  if (created.length > 0) {
    if (created.length <= 3) {
      items.push(`Created ${created.join(', ')}`);
    } else {
      items.push(`Created ${created.slice(0, 3).join(', ')} + ${created.length - 3} more`);
    }
  }

  // Edited files — show best description per file, skip low-signal edits
  for (const [file, descriptions] of edited) {
    // Filter out empty descriptions (low-signal edits like version bumps)
    const meaningful = descriptions.filter(d => d.length > 0);
    if (meaningful.length === 0) continue; // Skip this file entirely

    // Pick the most informative description (prefer Added/Schema over generic)
    const best = meaningful.find(d => d.startsWith('Added') || d.startsWith('Schema'))
      || meaningful.find(d => d.startsWith('Changed') || d.startsWith('Removed'))
      || meaningful[0]
      || 'modified';
    items.push(`Edited ${file} — ${best}`);
  }

  // Git commits
  if (commits.length > 0) {
    if (commits.length === 1) {
      items.push(`Commit: "${commits[0]}"`);
    } else {
      items.push(`${commits.length} commits: "${commits[0]}", "${commits[1]}"${commits.length > 2 ? ` + ${commits.length - 2} more` : ''}`);
    }
  }

  // Commands (deduplicated)
  const uniqueCommands = [...new Set(commands)];
  if (uniqueCommands.length > 0) {
    items.push(uniqueCommands.join(', '));
  }

  // Conversation insights (cap at 2 to stay within budget)
  for (const insight of insights.slice(0, 2)) {
    items.push(`Key insight: ${insight}`);
  }

  // Cap items per session
  const cappedItems = items.slice(0, MAX_ITEMS_PER_SESSION);
  if (items.length > MAX_ITEMS_PER_SESSION) {
    cappedItems.push(`+ ${items.length - MAX_ITEMS_PER_SESSION} more changes`);
  }

  // If all items were filtered out, skip this session entirely
  if (cappedItems.length === 0 && !narrative) return '';

  const itemLines = cappedItems.map(item => `- ${item}`).join('\n');
  const parts = [heading];
  if (narrative) parts.push(narrative);
  if (itemLines) parts.push(itemLines);
  return parts.join('\n');
}

/**
 * Extract a concise title from a session summary.
 * Session summaries are Claude's last response — often conversational.
 * Extract the first meaningful sentence or phrase.
 */
function extractSessionTitle(summary: string): string {
  // Strip markdown formatting
  let text = summary.replace(/\*\*/g, '').replace(/`/g, '').trim();

  // Take first sentence
  const sentenceEnd = text.search(/[.!?\n]/);
  if (sentenceEnd > 0 && sentenceEnd < 120) {
    text = text.substring(0, sentenceEnd);
  } else if (text.length > 80) {
    // Truncate at word boundary
    text = text.substring(0, 80).replace(/\s+\S*$/, '');
  }

  // Skip if it's a non-informative Claude response
  if (text.match(/^(Let me|I'll|Here's the|Looking at|No response|Checking)/i)) {
    return text.substring(0, 60);
  }

  return text;
}

/**
 * Describe an Edit observation by analyzing the old_string/new_string diff
 * in the metadata to produce a meaningful summary of what changed.
 *
 * Returns empty string for edits that are too low-signal to export
 * (e.g., version bumps, trivial whitespace, identical-looking truncated strings).
 */
function describeEdit(obs: Observation): string {
  const toolInput = obs.metadata?.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return '';

  const oldStr = (toolInput.old_string as string) || '';
  const newStr = (toolInput.new_string as string) || '';

  if (!oldStr && !newStr) return '';

  // Skip version bump edits — low signal
  if (isVersionBump(oldStr, newStr)) return '';

  const oldLines = oldStr.split('\n').map(l => l.trim()).filter(Boolean);
  const newLines = newStr.split('\n').map(l => l.trim()).filter(Boolean);

  // Find lines added (in new but not in old)
  const oldSet = new Set(oldLines);
  const addedLines = newLines.filter(l => !oldSet.has(l));

  // Look for high-signal patterns in added lines
  for (const line of addedLines) {
    // New function/method/class
    const funcMatch = line.match(/(?:function|async function|class|const|export)\s+(\w+)/);
    if (funcMatch) return `Added ${funcMatch[0].substring(0, 60)}`;

    // New import
    const importMatch = line.match(/import\s+.+from\s+['"](.+?)['"]/);
    if (importMatch) return `Added import from '${importMatch[1]}'`;

    // New interface/type
    const typeMatch = line.match(/(?:interface|type)\s+(\w+)/);
    if (typeMatch) return `Added ${typeMatch[0]}`;

    // New tool/route/endpoint
    const toolMatch = line.match(/['"](\w+)['"]/);
    if (line.includes('server.tool') && toolMatch) return `Added tool '${toolMatch[1]}'`;

    // New dependency
    if (line.includes('"dependencies"') || line.match(/["']\w+["']\s*:\s*["']\^/)) {
      const depMatch = line.match(/["'](@?[\w/-]+)["']\s*:/);
      if (depMatch) return `Added dependency ${depMatch[1]}`;
    }

    // New SQL/schema
    if (line.includes('CREATE TABLE') || line.includes('CREATE VIRTUAL TABLE') || line.includes('ALTER TABLE')) {
      return `Schema change: ${line.substring(0, 60)}`;
    }
  }

  // Summarize by size of change (skip tiny diffs that produce noise)
  const netLines = newLines.length - oldLines.length;
  if (netLines > 5) return `Added ~${netLines} lines`;
  if (netLines < -5) return `Removed ~${Math.abs(netLines)} lines`;

  // For small diffs, only report if added lines have meaningful content
  if (addedLines.length > 0) {
    const hint = addedLines[0]!.substring(0, 60);
    // Skip if the hint is too short or looks like punctuation/formatting noise
    if (hint.length >= 10 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Changed: ${hint}`;
    }
  }

  // Low-signal edit — return empty to skip in export
  return '';
}

/**
 * Check if an edit is just a version bump (e.g., "0.5.0" → "0.5.1")
 */
function isVersionBump(oldStr: string, newStr: string): boolean {
  // Single-line version changes in JSON or similar
  const versionPattern = /["']?version["']?\s*[:=]\s*["']?\d+\.\d+\.\d+/;
  const oldHasVersion = versionPattern.test(oldStr);
  const newHasVersion = versionPattern.test(newStr);

  if (oldHasVersion && newHasVersion) {
    // If the only meaningful difference is the version number, it's a bump
    const normalize = (s: string) => s.replace(/\d+\.\d+\.\d+/g, 'X.X.X').trim();
    if (normalize(oldStr) === normalize(newStr)) return true;
  }

  return false;
}

/**
 * Merge new content into existing body, combining blocks for the same session ID.
 * Prevents duplicate session headings when the same session exports multiple times
 * (e.g., across restarts).
 */
function mergeSessionBlocks(existingBody: string, newContent: string): string {
  if (!existingBody && !newContent) return '';
  if (!existingBody) return newContent.trimEnd();
  if (!newContent) return existingBody.trimEnd();

  // Parse existing body into blocks: { heading, sessionId, lines }
  const existingBlocks = parseSessionBlocks(existingBody);
  const newBlocks = parseSessionBlocks(newContent);

  // Merge new blocks into existing — append items to matching session blocks
  for (const newBlock of newBlocks) {
    const existing = existingBlocks.find(b => b.sessionId === newBlock.sessionId);
    if (existing) {
      // Backfill narrative if the existing block predates the narrative fix and has none.
      // Sessions exported before the fix were parsed without a narrative field; the new
      // export carries the correct narrative and should win in that case.
      if (!existing.narrative && newBlock.narrative) {
        existing.narrative = newBlock.narrative;
      }
      // Append new items, deduplicating
      const existingItems = new Set(existing.items.map(l => l.trim()));
      for (const item of newBlock.items) {
        if (!existingItems.has(item.trim())) {
          existing.items.push(item);
        }
      }
      // Cap items per session
      if (existing.items.length > MAX_ITEMS_PER_SESSION) {
        const overflow = existing.items.length - MAX_ITEMS_PER_SESSION;
        existing.items = existing.items.slice(0, MAX_ITEMS_PER_SESSION);
        existing.items.push(`+ ${overflow} more changes`);
      }
    } else {
      existingBlocks.push(newBlock);
    }
  }

  // Rebuild output grouped by date
  return rebuildFromBlocks(existingBlocks);
}

interface SessionBlock {
  date: string;
  sessionId: string;
  heading: string;
  narrative?: string; // Plain-text summary line under the heading (no bullet marker)
  items: string[];
}

/**
 * Parse markdown body into session blocks.
 */
function parseSessionBlocks(body: string): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  let currentDate = '';
  let currentBlock: SessionBlock | null = null;

  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      currentDate = line.substring(3).trim();
    } else if (line.startsWith('### ')) {
      if (currentBlock) blocks.push(currentBlock);
      // Extract session ID — handle both old format (### {id}) and new (### Session {id} (...))
      const headingText = line.substring(4).trim();
      const sessionId = headingText.replace(/^Session\s+/, '').split(/[\s—(]/)[0] || headingText;
      currentBlock = {
        date: currentDate,
        sessionId,
        heading: line,
        items: [],
      };
    } else if (line.startsWith('- ') && currentBlock) {
      currentBlock.items.push(line);
    } else if (line && !line.startsWith('#') && !line.startsWith('**') && currentBlock) {
      // Plain-text line after a heading is the session narrative.
      // Previously dropped silently — now preserved so re-parse round-trips correctly.
      currentBlock.narrative = ((currentBlock.narrative || '') + line + ' ').trimEnd();
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  return blocks;
}

/**
 * Rebuild markdown from parsed session blocks, grouped by date.
 */
function rebuildFromBlocks(blocks: SessionBlock[]): string {
  const byDate = new Map<string, SessionBlock[]>();
  for (const block of blocks) {
    if (!byDate.has(block.date)) byDate.set(block.date, []);
    byDate.get(block.date)!.push(block);
  }

  const lines: string[] = [];
  for (const [date, dateBlocks] of byDate) {
    lines.push(`## ${date}`);
    lines.push('');
    for (const block of dateBlocks) {
      lines.push(block.heading);
      if (block.narrative) lines.push(block.narrative);
      lines.push(...block.items);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Write activity content to the topic file, trimming oldest entries if over limit.
 * Preserves the file header, appends new content, trims from the top of the body.
 */
export function writeActivityToMemory(
  projectPath: string,
  newContent: string,
  maxLines: number = DEFAULT_MAX_LINES
): { filePath: string; linesWritten: number } {
  const memoryDir = resolveMemoryDir(projectPath);
  mkdirSync(memoryDir, { recursive: true });

  const filePath = join(memoryDir, TOPIC_FILE);

  // Header for the topic file
  const header = [
    '# Project Activity Log',
    '',
    `> Auto-generated by context-manager. Updated ${new Date().toISOString()}.`,
    '> Use context_search MCP tool for full history search.',
    '',
  ].join('\n');

  let existingBody = '';
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    // Strip existing header (everything before first ## heading)
    const bodyMatch = existing.match(/^(## .+)/m);
    if (bodyMatch?.index !== undefined) {
      existingBody = existing.substring(bodyMatch.index);
    }
  }

  // Merge same-session blocks before combining
  const fullBody = mergeSessionBlocks(existingBody, newContent);

  // Trim oldest entries if over line limit
  const bodyLines = fullBody.split('\n');
  const trimmedBody = bodyLines.length > maxLines
    ? bodyLines.slice(bodyLines.length - maxLines).join('\n')
    : fullBody;

  const finalContent = header + trimmedBody + '\n';
  writeFileSync(filePath, finalContent);

  return { filePath, linesWritten: trimmedBody.split('\n').length };
}

/**
 * Full export pipeline: query unexported high-importance observations,
 * format them, write to auto-memory topic file, and mark as exported.
 */
export async function exportToAutoMemory(
  storage: ContextStorage,
  projectPath: string,
  sessionId?: string
): Promise<{ exported: number; filePath: string | null }> {
  const observations = await storage.getUnexportedHighImportance(
    projectPath,
    sessionId
  );

  if (observations.length === 0) {
    return { exported: 0, filePath: null };
  }

  // Fetch session summaries for the sessions referenced by these observations
  const sessionIds = [...new Set(observations.map(o => o.session_id))];
  const sessions = await storage.getRecentSessions(projectPath, 50);
  const relevantSessions = sessions.filter(s => sessionIds.includes(s.id));

  const formatted = formatObservationsForMemory(observations, relevantSessions);
  const { filePath } = writeActivityToMemory(projectPath, formatted);

  // Mark as exported
  const ids = observations
    .map(o => o.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length > 0) {
    await storage.markExported(ids);
  }

  return { exported: observations.length, filePath };
}
