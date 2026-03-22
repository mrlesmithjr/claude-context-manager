/**
 * Session Enrichment Text Builder
 *
 * Assembles rich, semantically meaningful text from session data
 * for vector embedding. Combines user prompts (intent), high-value
 * observations (actions), and session summary (outcome) into a
 * single text block optimized for MiniLM-L6-v2 (200-500 tokens).
 *
 * No AI required — purely data assembly from existing captures.
 */

import type { Observation, UserPrompt } from '../storage/interface.js';

const MAX_TEXT_LENGTH = 2000; // ~500 tokens for MiniLM

/**
 * Build enriched text for a session embedding.
 *
 * Structure:
 *   User goals: <prompts>
 *   Actions: <high-value observations>
 *   Files: <unique files touched>
 *   Outcome: <session summary>
 */
export function buildSessionEmbeddingText(
  prompts: UserPrompt[],
  observations: Observation[],
  sessionSummary?: string
): string {
  const parts: string[] = [];

  // 1. User prompts — highest signal (describes intent)
  const promptText = buildPromptSection(prompts);
  if (promptText) parts.push(promptText);

  // 2. High-value observations — what was done
  const actionText = buildActionSection(observations);
  if (actionText) parts.push(actionText);

  // 3. Files touched — scope of work
  const filesText = buildFilesSection(observations);
  if (filesText) parts.push(filesText);

  // 4. Session summary — outcome
  if (sessionSummary) {
    const cleaned = cleanSummary(sessionSummary);
    if (cleaned) parts.push(`Outcome: ${cleaned}`);
  }

  const text = parts.join('\n');
  return text.length > MAX_TEXT_LENGTH
    ? text.substring(0, MAX_TEXT_LENGTH)
    : text;
}

/**
 * Build the user goals section from prompts.
 * Takes the first few substantive prompts.
 */
function buildPromptSection(prompts: UserPrompt[]): string {
  if (prompts.length === 0) return '';

  const substantive = prompts
    .map(p => p.prompt_text.trim())
    .filter(t => t.length > 10) // skip very short prompts like "yes", "ok"
    .slice(0, 5); // cap at 5 prompts

  if (substantive.length === 0) return '';

  const truncated = substantive.map(p =>
    p.length > 200 ? p.substring(0, 200) : p
  );

  return `User goals: ${truncated.join('. ')}`;
}

/**
 * Build the actions section from high-value observations.
 * Skips low-signal observations (Read, Grep, Glob).
 */
function buildActionSection(observations: Observation[]): string {
  const highValue = observations.filter(obs => {
    // Skip low-signal tools
    if (['Read', 'Grep', 'Glob'].includes(obs.tool_name)) return false;
    // Skip low importance
    if (obs.importance === 'low') return false;
    return true;
  });

  if (highValue.length === 0) return '';

  const actions = highValue.slice(0, 10).map(obs => {
    return describeAction(obs);
  });

  return `Actions: ${actions.join('. ')}`;
}

/**
 * Describe a single observation as a meaningful action string.
 */
function describeAction(obs: Observation): string {
  const file = obs.files_touched[0];
  const shortFile = file ? file.split('/').pop() : undefined;

  switch (obs.tool_name) {
    case 'Edit': {
      const toolInput = obs.metadata?.tool_input as Record<string, unknown> | undefined;
      const oldStr = (toolInput?.old_string as string) || '';
      const newStr = (toolInput?.new_string as string) || '';

      if (oldStr && newStr && shortFile) {
        // Try to extract meaningful change description
        const oldFirst = oldStr.split('\n')[0]?.substring(0, 60) || '';
        const newFirst = newStr.split('\n')[0]?.substring(0, 60) || '';
        return `Edited ${shortFile}: "${oldFirst}" → "${newFirst}"`;
      }
      return shortFile ? `Edited ${shortFile}` : obs.summary;
    }

    case 'Write':
      return shortFile ? `Created ${shortFile}` : obs.summary;

    case 'Bash': {
      const toolInput = obs.metadata?.tool_input as Record<string, unknown> | undefined;
      const command = (toolInput?.command as string) || '';

      if (command.includes('git commit')) {
        const msg = command.match(/commit -m ["'](.+?)["']/)?.[1]
          || command.match(/"([^"]+)"/)?.[1]
          || '';
        return msg ? `Git commit: "${msg.substring(0, 80)}"` : 'Git commit';
      }
      if (command.includes('git push')) return 'Git push';
      if (command.includes('npm run build')) return 'Build';
      if (command.includes('npm run test') || command.includes('npm test')) return 'Ran tests';
      if (command.includes('npm install') || command.includes('npm add')) return 'Installed dependencies';
      if (command.includes('npm version')) return 'Version bump';

      return command.length > 80 ? command.substring(0, 80) : command;
    }

    default:
      return obs.summary.length > 80 ? obs.summary.substring(0, 80) : obs.summary;
  }
}

/**
 * Build the files section — unique files touched, basenames only.
 */
function buildFilesSection(observations: Observation[]): string {
  const allFiles = new Set<string>();

  for (const obs of observations) {
    for (const file of obs.files_touched) {
      // Use basename to reduce noise
      const basename = file.split('/').pop();
      if (basename) allFiles.add(basename);
    }
  }

  if (allFiles.size === 0) return '';

  const fileList = [...allFiles].slice(0, 15).join(', ');
  return `Files: ${fileList}`;
}

/**
 * Clean a session summary for embedding.
 * Session summaries are often the last assistant message — may be conversational.
 */
function cleanSummary(summary: string): string {
  // Strip markdown formatting
  let text = summary
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/#{1,6}\s*/g, '')
    .trim();

  // Take first ~500 chars
  if (text.length > 500) {
    // Try to cut at sentence boundary
    const sentenceEnd = text.substring(400, 500).search(/[.!?]\s/);
    if (sentenceEnd > 0) {
      text = text.substring(0, 400 + sentenceEnd + 1);
    } else {
      text = text.substring(0, 500);
    }
  }

  return text;
}
