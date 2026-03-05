/**
 * Context Builder
 *
 * Build context for injection with token budgeting.
 * Supports hierarchical project grouping for parent directories.
 */

import type { Observation } from '../storage/interface.js';

/**
 * Calculate relative time string from a date
 */
function calculateTimeAgo(dateStr: string): string {
  const createdDate = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - createdDate.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return diffMinutes <= 1 ? 'just now' : `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    const diffWeeks = Math.floor(diffDays / 7);
    return `${diffWeeks}w ago`;
  }
}

/**
 * Format a single observation for display
 */
function formatObservation(obs: Observation, index: number): string {
  const fileInfo =
    obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';

  const timeAgo = calculateTimeAgo(obs.created_at);

  return `${index + 1}. [${timeAgo}] ${obs.summary}${fileInfo}`;
}

/**
 * Group observations by immediate child project
 *
 * Example: basePath = /Projects/Work
 *   /Projects/Work/ProjectA/... -> "ProjectA"
 *   /Projects/Work/ProjectB/... -> "ProjectB"
 *   /Projects/Work -> "_root"
 */
function groupBySubProject(
  observations: Observation[],
  basePath: string
): Map<string, Observation[]> {
  // Normalize: remove trailing slash if present
  const normalizedBase = basePath.endsWith('/')
    ? basePath.slice(0, -1)
    : basePath;

  const groups = new Map<string, Observation[]>();

  for (const obs of observations) {
    let groupKey: string;

    if (obs.project === normalizedBase) {
      // Observation from parent directory itself
      groupKey = '_root';
    } else if (obs.project.startsWith(normalizedBase + '/')) {
      // Extract immediate child project name
      const relativePath = obs.project.substring(normalizedBase.length + 1);
      const parts = relativePath.split('/');
      groupKey = parts[0] || '_root';
    } else {
      // Defensive: handle observations outside the base path hierarchy.
      // Should not occur with correct prefix-matching queries from storage layer,
      // but protects against storage inconsistencies or edge cases.
      groupKey = '_other';
    }

    // Efficiently add to group
    let existing = groups.get(groupKey);
    if (!existing) {
      existing = [];
      groups.set(groupKey, existing);
    }
    existing.push(obs);
  }

  return groups;
}

/**
 * Build context block for injection
 *
 * @param observations - Observations to include
 * @param basePath - The current working directory (used for grouping)
 * @param summary - Optional session summary
 * @param previouslyContext - Optional "Previously" context from prior sessions
 */
export function buildContext(
  observations: Observation[],
  basePath: string,
  summary?: string,
  previouslyContext?: string | null
): string {
  if (observations.length === 0 && !summary && !previouslyContext) {
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

  if (previouslyContext) {
    lines.push('### Previously');
    lines.push(previouslyContext);
    lines.push('');
  }

  if (summary) {
    lines.push('### Recent Session Summary');
    lines.push(summary);
    lines.push('');
  }

  if (observations.length > 0) {
    // Check if we have multiple sub-projects
    const groups = groupBySubProject(observations, basePath);
    const hasMultipleProjects =
      groups.size > 1 || (groups.size === 1 && !groups.has('_root'));

    if (hasMultipleProjects) {
      // Grouped format - organize by sub-project
      lines.push(
        `### Recent Activity by Project (${observations.length} observations, ~${totalTokens} tokens)`
      );
      lines.push('');

      // Sort groups by most recent activity (newest first)
      const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
        const aNewest = a[1][0]?.created_at || '';
        const bNewest = b[1][0]?.created_at || '';
        return bNewest.localeCompare(aNewest);
      });

      for (const [groupKey, groupObservations] of sortedGroups) {
        if (groupKey === '_root') {
          lines.push(
            `#### Root Directory (${groupObservations.length} observations)`
          );
        } else if (groupKey === '_other') {
          lines.push(`#### Other (${groupObservations.length} observations)`);
        } else {
          lines.push(`#### ${groupKey} (${groupObservations.length} observations)`);
        }
        lines.push('');

        for (let i = 0; i < groupObservations.length; i++) {
          const obs = groupObservations[i];
          if (obs) {
            lines.push(formatObservation(obs, i));
          }
        }
        lines.push('');
      }
    } else {
      // Flat format (single project or leaf directory)
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
  }

  lines.push('</claude-context>');

  return lines.join('\n');
}

/**
 * Build visibility message showing what was injected
 *
 * This is displayed to the user to show what context was loaded.
 */
export function buildVisibilityMessage(
  observations: Observation[],
  basePath?: string
): string {
  if (observations.length === 0) {
    return '[context-manager] No previous context found for this project';
  }

  const totalTokens = observations.reduce(
    (sum, obs) => sum + obs.token_estimate,
    0
  );

  const lines: string[] = [];

  // Check for multiple sub-projects
  if (basePath) {
    const groups = groupBySubProject(observations, basePath);
    const hasMultipleProjects =
      groups.size > 1 || (groups.size === 1 && !groups.has('_root'));

    if (hasMultipleProjects) {
      // Show project breakdown
      // P2 fix: Count only actual projects (exclude _root and _other)
      const projectCount = Array.from(groups.keys()).filter(
        key => key !== '_root' && key !== '_other'
      ).length;

      // P3 fix: Include Root/Other in breakdown for consistency with context
      const projectCounts = Array.from(groups.entries())
        .map(([key, obs]) => {
          const label = key === '_root' ? 'Root' : key === '_other' ? 'Other' : key;
          return `${label}: ${obs.length}`;
        })
        .join(', ');

      lines.push(
        `[context-manager] Injected ${observations.length} observations (${totalTokens} tokens) from ${projectCount} projects:`
      );
      lines.push(`  Projects: ${projectCounts}`);
      return lines.join('\n');
    }
  }

  // Single project - show preview
  lines.push(
    `[context-manager] Injected ${observations.length} observations (${totalTokens} tokens):`
  );

  // Show first 3 observations as preview
  const preview = observations.slice(0, 3);
  for (const obs of preview) {
    const timeAgo = calculateTimeAgo(obs.created_at);
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

/**
 * Calculate recency multiplier with 48-hour half-life
 */
function recencyMultiplier(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return Math.pow(0.5, ageHours / 48);
}

/**
 * Select observations using multi-factor relevance scoring within token budget
 *
 * Scoring formula:
 *   final_score = (importance_score * 0.70) + (recency * 0.30) + file_overlap_boost
 *
 * Diversity cap: no single tool type can consume >60% of budget.
 * Uses continue (not break) so smaller high-scoring observations can still fit.
 * Final selection sorted chronologically for readable output.
 */
export function selectRelevantWithinBudget(
  candidates: Observation[],
  tokenBudget: number,
  workingFileSet?: Set<string>
): Observation[] {
  const effectiveBudget = Math.floor(tokenBudget * 0.8);
  const toolBudgetCap = Math.floor(effectiveBudget * 0.6);

  // Score each candidate
  const scored = candidates.map(obs => {
    const importanceWeight = (obs.importance_score ?? 0.5) * 0.70;
    const recencyWeight = recencyMultiplier(obs.created_at) * 0.30;

    // File overlap boost
    let fileOverlapBoost = 0;
    if (workingFileSet && workingFileSet.size > 0) {
      const hasOverlap = obs.files_touched.some(f => workingFileSet.has(f));
      if (hasOverlap) fileOverlapBoost = 0.20;
    }

    // Compacted summary bonus (token-efficient, represents multiple actions)
    const compactedBonus = obs.is_compacted ? 0.10 : 0;

    const finalScore = importanceWeight + recencyWeight + fileOverlapBoost + compactedBonus;

    return { obs, finalScore };
  });

  // Sort by score descending
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Greedy select within budget, with diversity cap
  const selected: Observation[] = [];
  let totalTokens = 0;
  const toolTokens: Record<string, number> = {};

  for (const { obs } of scored) {
    if (totalTokens + obs.token_estimate > effectiveBudget) {
      continue; // Try smaller observations
    }

    // Diversity cap check
    const currentToolTokens = toolTokens[obs.tool_name] || 0;
    if (currentToolTokens + obs.token_estimate > toolBudgetCap) {
      continue;
    }

    selected.push(obs);
    totalTokens += obs.token_estimate;
    toolTokens[obs.tool_name] = currentToolTokens + obs.token_estimate;
  }

  // Sort chronologically for readable output
  selected.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return selected;
}
