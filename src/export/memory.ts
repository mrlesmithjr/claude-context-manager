/**
 * Auto-Memory Export Module
 *
 * Exports high-importance observations to Claude Code's auto-memory
 * topic files (~/.claude/projects/<path>/memory/).
 *
 * Writes to a dedicated topic file (context-manager-activity.md),
 * never touches MEMORY.md.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { convertPathToDashed } from '../utils/transcript.js';
import type { Observation, ContextStorage } from '../storage/interface.js';

const TOPIC_FILE = 'context-manager-activity.md';
const DEFAULT_MAX_LINES = 150;

/**
 * Resolve the auto-memory directory for a project.
 * Returns ~/.claude/projects/{dashed-path}/memory/
 */
export function resolveMemoryDir(projectPath: string): string {
  const dashedPath = convertPathToDashed(projectPath);
  return join(homedir(), '.claude', 'projects', dashedPath, 'memory');
}

/**
 * Format high-importance observations as dated markdown for the topic file.
 * Groups by session, shows action verb + file + detail.
 */
export function formatObservationsForMemory(
  observations: Observation[]
): string {
  if (observations.length === 0) return '';

  // Group by date then session
  const byDate = new Map<string, Map<string, Observation[]>>();

  for (const obs of observations) {
    const date = obs.created_at.split('T')[0] ?? 'unknown'; // YYYY-MM-DD
    if (!byDate.has(date)) byDate.set(date, new Map());
    const dateGroup = byDate.get(date)!;
    if (!dateGroup.has(obs.session_id)) dateGroup.set(obs.session_id, []);
    dateGroup.get(obs.session_id)!.push(obs);
  }

  const lines: string[] = [];

  for (const [date, sessions] of byDate) {
    lines.push(`## ${date}`);
    lines.push('');

    for (const [sessionId, sessionObs] of sessions) {
      const shortId = sessionId.substring(0, 8);
      const first = sessionObs[0]!;
      const last = sessionObs[sessionObs.length - 1]!;
      const startTime = first.created_at.split('T')[1]?.substring(0, 5) ?? '';
      const endTime = last.created_at.split('T')[1]?.substring(0, 5) ?? '';

      lines.push(`### Session ${shortId} (${startTime} - ${endTime})`);

      for (const obs of sessionObs) {
        lines.push(`- ${formatObservationLine(obs)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format a single observation as a concise markdown line.
 */
function formatObservationLine(obs: Observation): string {
  const file = obs.files_touched[0] || '';
  const shortFile = file ? file.split('/').slice(-2).join('/') : '';

  switch (obs.tool_name) {
    case 'Edit':
      return `**Edited** ${shortFile} — ${describeEdit(obs)}`;
    case 'Write':
      return `**Created** ${shortFile}`;
    case 'Bash': {
      if (obs.summary.includes('git commit')) {
        const msg = obs.summary.match(/commit -m ["'](.+?)["']/)?.[1]
          || obs.summary.match(/"([^"]+)"/)?.[1]
          || '';
        return `**Git commit** — "${msg.substring(0, 80)}"`;
      }
      if (obs.summary.includes('git push')) return `**Git push** — ${obs.summary.substring(0, 80)}`;
      if (obs.summary.includes('npm run build')) return `**Build** — ${obs.summary.substring(0, 80)}`;
      if (obs.summary.includes('npm install')) return `**Install** — ${obs.summary.substring(0, 80)}`;
      if (obs.summary.includes('npm run test') || obs.summary.includes('npm test')) return `**Test** — ${obs.summary.substring(0, 80)}`;
      return `**Ran** ${obs.summary.substring(0, 80)}`;
    }
    case 'Read':
      return `**Read** ${shortFile}`;
    default:
      return `**${obs.tool_name}** ${obs.summary.substring(0, 80)}`;
  }
}

/**
 * Describe an Edit observation by analyzing the old_string/new_string diff
 * in the metadata to produce a meaningful summary of what changed.
 */
function describeEdit(obs: Observation): string {
  const toolInput = obs.metadata?.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return 'modified';

  const oldStr = (toolInput.old_string as string) || '';
  const newStr = (toolInput.new_string as string) || '';

  if (!oldStr && !newStr) return 'modified';

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

  // Check for renames/replacements
  if (oldLines.length > 0 && newLines.length > 0 && oldLines.length === newLines.length) {
    // Single-line change — show what changed
    if (oldLines.length === 1 && newLines.length === 1) {
      const old = oldLines[0]!;
      const new_ = newLines[0]!;
      // If lines are similar, describe the change
      if (old.length < 80 && new_.length < 80) {
        return `Changed "${old.substring(0, 40)}" → "${new_.substring(0, 40)}"`;
      }
    }
  }

  // Summarize by size of change
  const netLines = newLines.length - oldLines.length;
  if (netLines > 5) return `Added ~${netLines} lines`;
  if (netLines < -5) return `Removed ~${Math.abs(netLines)} lines`;
  if (addedLines.length > 0) {
    // Use first meaningful added line as hint
    const hint = addedLines[0]!.substring(0, 60);
    return `Changed: ${hint}`;
  }

  return 'modified';
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

  // Combine existing body + new content
  const fullBody = existingBody
    ? existingBody.trimEnd() + '\n\n' + newContent.trimEnd()
    : newContent.trimEnd();

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

  const formatted = formatObservationsForMemory(observations);
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
