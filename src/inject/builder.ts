/**
 * Context Builder
 *
 * Build context for injection with token budgeting.
 */

import type { Observation } from '../storage/interface.js';

/**
 * Format a single observation for display
 */
function formatObservation(obs: Observation, index: number): string {
  const fileInfo =
    obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';

  // Calculate relative time
  const createdDate = new Date(obs.created_at);
  const now = new Date();
  const diffMs = now.getTime() - createdDate.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  let timeAgo: string;
  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    timeAgo = diffMinutes <= 1 ? 'just now' : `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    timeAgo = `${diffHours}h ago`;
  } else if (diffDays < 7) {
    timeAgo = `${diffDays}d ago`;
  } else {
    const diffWeeks = Math.floor(diffDays / 7);
    timeAgo = `${diffWeeks}w ago`;
  }

  return `${index + 1}. [${timeAgo}] ${obs.summary}${fileInfo}`;
}

/**
 * Build context block for injection
 */
export function buildContext(
  observations: Observation[],
  summary?: string
): string {
  if (observations.length === 0 && !summary) {
    return '';
  }

  const totalTokens = observations.reduce(
    (sum, obs) => sum + obs.token_estimate,
    0
  );

  const lines: string[] = [];

  lines.push('<claude-context>');
  lines.push('## Previous Context for This Project');
  lines.push('');

  if (summary) {
    lines.push('### Recent Session Summary');
    lines.push(summary);
    lines.push('');
  }

  if (observations.length > 0) {
    lines.push(
      `### Recent Activity (${observations.length} observations, ~${totalTokens} tokens)`
    );
    lines.push('');

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      if (obs) {
        lines.push(formatObservation(obs, i));
      }
    }

    lines.push('');
  }

  lines.push('</claude-context>');

  return lines.join('\n');
}

/**
 * Build visibility message showing what was injected
 *
 * This is displayed to the user to show what context was loaded.
 */
export function buildVisibilityMessage(observations: Observation[]): string {
  if (observations.length === 0) {
    return '[context-manager] No previous context found for this project';
  }

  const totalTokens = observations.reduce(
    (sum, obs) => sum + obs.token_estimate,
    0
  );

  const lines: string[] = [];
  lines.push(
    `[context-manager] Injected ${observations.length} observations (${totalTokens} tokens):`
  );

  // Show first 3 observations as preview
  const preview = observations.slice(0, 3);
  for (const obs of preview) {
    const createdDate = new Date(obs.created_at);
    const now = new Date();
    const diffMs = now.getTime() - createdDate.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    let timeAgo: string;
    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      timeAgo = diffMinutes <= 1 ? 'just now' : `${diffMinutes}m ago`;
    } else if (diffHours < 24) {
      timeAgo = `${diffHours}h ago`;
    } else if (diffDays < 7) {
      timeAgo = `${diffDays}d ago`;
    } else {
      const dateStr = createdDate.toISOString().split('T')[0];
      timeAgo = dateStr || 'unknown'; // Show date
    }

    const firstFile = obs.files_touched[0];
    const fileInfo = firstFile ? ` (${firstFile})` : '';
    lines.push(`  - ${timeAgo}: ${obs.summary}${fileInfo}`);
  }

  if (observations.length > 3) {
    lines.push(`  ... and ${observations.length - 3} more`);
  }

  return lines.join('\n');
}

/**
 * Select observations within token budget
 *
 * Prioritize most recent observations, accumulating until budget exceeded.
 * Applies 80% safety margin to budget.
 */
export function selectWithinBudget(
  observations: Observation[],
  tokenBudget: number
): Observation[] {
  // Apply 80% safety margin (P1 fix from design review)
  const effectiveBudget = Math.floor(tokenBudget * 0.8);

  const selected: Observation[] = [];
  let totalTokens = 0;

  // Observations should already be sorted by created_at DESC
  for (const obs of observations) {
    if (totalTokens + obs.token_estimate > effectiveBudget) {
      break;
    }

    selected.push(obs);
    totalTokens += obs.token_estimate;
  }

  return selected;
}
