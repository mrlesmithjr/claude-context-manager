/**
 * Transcript Mining
 *
 * Backfills session history from Claude Code's JSONL transcript files.
 * Walks ~/.claude/projects/, decodes project paths, pairs tool_use + tool_result
 * events, and runs them through the standard processToolCapture() pipeline.
 *
 * Sessions already present in the DB are skipped.
 * Local mode only: returns an error when CONTEXT_MANAGER_URL is set.
 *
 * refs #249
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SQLiteStorage } from '../storage/sqlite.js';
import { processToolCapture } from './processor.js';
import { shouldCaptureTool } from '../utils/validation.js';
import { decodeDashedPath } from '../utils/transcript.js';
import { findProjectRoot } from '../utils/find-project-root.js';

// ---- JSONL entry shapes ----

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface TranscriptEntry {
  type: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

// ---- Paired tool event ----

interface ToolPair {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: string;
  timestamp: string;
  cwd: string;
  branch: string | null;
}

// ---- Public API ----

export interface MineOptions {
  /** Filter to one project path (decoded real path). Omit to process all projects. */
  project?: string;
  /** Preview without writing to the DB (default: false). */
  dry_run?: boolean;
  /** Cap the number of sessions processed (for incremental runs). */
  limit_sessions?: number;
}

export interface MineResult {
  sessions_processed: number;
  sessions_skipped: number;
  observations_imported: number;
  duplicates_skipped: number;
  errors: string[];
}

/**
 * Extract a plain-text string from a tool_result content field.
 * Claude Code uses either a bare string or Array<{type,text}> blocks.
 */
function extractResultContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n');
  }
  return '';
}

/**
 * Parse all JSONL entries from a single transcript file.
 * Lines that fail JSON.parse are silently skipped (corrupt / partial writes).
 */
function parseEntries(filePath: string): TranscriptEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Extract tool_use blocks from an assistant message's content.
 * A single assistant message can contain multiple tool_use blocks.
 */
function extractToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ToolUseBlock =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: string }).type === 'tool_use' &&
      typeof (b as ToolUseBlock).id === 'string' &&
      typeof (b as ToolUseBlock).name === 'string'
  );
}

/**
 * Extract tool_result blocks from a user message's content.
 */
function extractToolResultBlocks(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ToolResultBlock =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: string }).type === 'tool_result' &&
      typeof (b as ToolResultBlock).tool_use_id === 'string'
  );
}

/**
 * Pair tool_use and tool_result events from a session's JSONL entries.
 *
 * Strategy: build a map from tool_use_id -> ToolUseBlock + entry metadata, then
 * match each tool_result to its use by tool_use_id. Unpaired tool_use entries
 * (session cut off before result arrived) are silently discarded.
 *
 * Returns only pairs that pass shouldCaptureTool() to avoid indexing skip-listed tools.
 */
function pairToolEvents(entries: TranscriptEntry[]): ToolPair[] {
  const pending = new Map<string, {
    block: ToolUseBlock;
    cwd: string;
    branch: string | null;
    timestamp: string;
  }>();
  const pairs: ToolPair[] = [];

  for (const entry of entries) {
    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      const toolUses = extractToolUseBlocks(content);
      if (toolUses.length === 0) continue;

      const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
      const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch : null;
      const timestamp = typeof entry.timestamp === 'string'
        ? entry.timestamp
        : new Date().toISOString();

      for (const block of toolUses) {
        pending.set(block.id, { block, cwd, branch, timestamp });
      }
    } else if (entry.type === 'user') {
      const content = entry.message?.content;
      const results = extractToolResultBlocks(content);

      for (const result of results) {
        const use = pending.get(result.tool_use_id);
        if (!use) continue;
        pending.delete(result.tool_use_id);

        const toolName = use.block.name;
        const toolInput = use.block.input;
        if (!shouldCaptureTool(toolName, toolInput)) continue;

        const toolResponse = extractResultContent(result.content);
        pairs.push({
          toolName,
          toolInput,
          toolResponse,
          timestamp: use.timestamp,
          cwd: use.cwd,
          branch: use.branch,
        });
      }
    }
  }

  return pairs;
}

/**
 * Walk ~/.claude/projects/ and return a list of {encodedDir, sessionFile} pairs.
 * Each .jsonl file is a session. Skips non-file entries and entries without a .jsonl suffix.
 *
 * When `projectFilter` is set (real path), only sessions whose decoded project path
 * starts with the filter are included.
 */
interface SessionEntry {
  sessionId: string;
  filePath: string;
  decodedProject: string;
}

function discoverSessions(projectFilter?: string): SessionEntry[] {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return [];

  const entries: SessionEntry[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const dirPath = join(projectsRoot, dir);

    // Decode the directory name to a real project path
    const decodedProject = decodeDashedPath(dir);
    if (decodedProject === null) continue;

    // Apply project filter if given
    if (projectFilter) {
      const normalizedFilter = projectFilter.endsWith('/')
        ? projectFilter
        : projectFilter + '/';
      const normalizedDecoded = decodedProject.endsWith('/')
        ? decodedProject
        : decodedProject + '/';
      if (
        decodedProject !== projectFilter &&
        !normalizedDecoded.startsWith(normalizedFilter)
      ) {
        continue;
      }
    }

    // List .jsonl files inside this project directory
    let files: string[];
    try {
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) continue;
      files = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      // Basic UUID sanity check (8-4-4-4-12 hex)
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) continue;

      entries.push({
        sessionId,
        filePath: join(dirPath, file),
        decodedProject,
      });
    }
  }

  return entries;
}

/**
 * Main orchestrator. Walks transcripts, skips known sessions, processes tool pairs
 * through the capture pipeline, and writes to the database.
 *
 * @param storage - Initialized SQLiteStorage instance
 * @param opts - Mine options (project filter, dry_run, limit_sessions)
 * @returns Summary counts
 */
export async function mineTranscripts(
  storage: SQLiteStorage,
  opts: MineOptions
): Promise<MineResult> {
  const { project, dry_run = false, limit_sessions } = opts;

  const result: MineResult = {
    sessions_processed: 0,
    sessions_skipped: 0,
    observations_imported: 0,
    duplicates_skipped: 0,
    errors: [],
  };

  // Resolve the project filter: if provided, normalize to project root
  const projectFilter = project ? findProjectRoot(project) : undefined;

  const sessions = discoverSessions(projectFilter);

  let sessionsAttempted = 0;

  for (const session of sessions) {
    if (limit_sessions !== undefined && sessionsAttempted >= limit_sessions) {
      break;
    }
    sessionsAttempted++;

    const { sessionId, filePath, decodedProject } = session;

    // Skip sessions already in the DB
    let alreadyExists = false;
    try {
      alreadyExists = await storage.sessionExists(sessionId);
    } catch (err) {
      result.errors.push(`sessionExists check failed for ${sessionId}: ${String(err)}`);
      continue;
    }

    if (alreadyExists) {
      result.sessions_skipped++;
      continue;
    }

    // Parse and pair tool events
    const entries = parseEntries(filePath);
    const pairs = pairToolEvents(entries);

    if (pairs.length === 0) {
      // No capturable tool pairs — skip entirely (don't create a DB session row)
      continue;
    }

    result.sessions_processed++;

    if (dry_run) {
      result.observations_imported += pairs.length;
      continue;
    }

    // Determine the project key (normalized to project root)
    const projectKey = findProjectRoot(decodedProject);

    // Derive branch from the most common gitBranch in this session's entries
    const branch = deriveBranch(entries);

    // Create the session row with source='mine' and status='complete'
    try {
      // Use a minimal createSession that sets source and status correctly.
      // createSession sets status='active', so we immediately end it.
      await storage.createSession(sessionId, projectKey, branch);
    } catch (err) {
      result.errors.push(`createSession failed for ${sessionId}: ${String(err)}`);
      continue;
    }

    // Process each tool pair through the capture pipeline
    let sessionObs = 0;
    for (const pair of pairs) {
      try {
        const captureResult = processToolCapture({
          session_id: sessionId,
          project: projectKey,
          tool_name: pair.toolName,
          tool_input: pair.toolInput,
          tool_response: pair.toolResponse,
        });

        if ('status' in captureResult) {
          // Skipped by capture floor
          result.duplicates_skipped++;
          continue;
        }

        // Attach branch and override created_at with the original timestamp
        const observation = {
          ...captureResult,
          branch: pair.branch,
          created_at: pair.timestamp,
        };

        const id = await storage.save(observation);
        if (id === undefined) {
          // Deduped by content_hash
          result.duplicates_skipped++;
        } else {
          result.observations_imported++;
          sessionObs++;
        }
      } catch (err) {
        result.errors.push(`save failed in session ${sessionId}: ${String(err)}`);
      }
    }

    // Patch source FIRST (separate try/catch so endSession failure can't suppress it)
    try {
      const rawDb = (storage as unknown as { db: import('better-sqlite3').Database }).db;
      if (!rawDb) throw new Error('SQLiteStorage.db not accessible — source patch cannot be applied');
      rawDb.prepare(`UPDATE sessions SET source = 'mine' WHERE id = ?`).run(sessionId);
    } catch (err) {
      result.errors.push(`source patch failed for ${sessionId}: ${String(err)}`);
    }

    const summary = `Mined session: ${sessionObs} observation${sessionObs !== 1 ? 's' : ''} imported`;
    try {
      await storage.endSession(sessionId, summary);
    } catch (err) {
      result.errors.push(`endSession failed for ${sessionId}: ${String(err)}`);
    }
  }

  return result;
}

/**
 * Determine the most-common gitBranch value across a session's transcript entries.
 * Returns null when no branch information is present.
 */
function deriveBranch(entries: TranscriptEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
      counts.set(entry.gitBranch, (counts.get(entry.gitBranch) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [branch, count] of counts) {
    if (count > bestCount) {
      best = branch;
      bestCount = count;
    }
  }
  return best;
}
