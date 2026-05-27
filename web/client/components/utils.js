/**
 * Shared UI utilities for Context Manager Dashboard components.
 * refs #129
 */

/**
 * Format a date as relative time (e.g., "2 hours ago").
 * Extracted from ObservationSearch.js and SessionList.js to avoid duplication.
 */
export function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}

/**
 * Parse tags from various storage formats.
 * Handles: JSON array string '["auth","api"]', comma-separated 'auth,api', or null.
 * Returns a plain string[].
 */
export function parseTags(rawTags) {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) return rawTags;
  const str = String(rawTags).trim();
  if (!str) return [];
  // Try JSON array first
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (_) {
      // Fall through to comma-split
    }
  }
  // Comma-separated fallback
  return str.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Get display metadata for an importance level.
 * @param {string} importance - 'high' | 'medium' | 'low'
 * @param {number} score - numeric score 0.0-1.0
 * @returns {{ label: string, colorClass: string }}
 */
export function getImportanceBadge(importance, score) {
  const scoreStr = typeof score === 'number' ? score.toFixed(2) : '';
  const label = importance
    ? `${importance.toUpperCase()}${scoreStr ? ' ' + scoreStr : ''}`
    : scoreStr || '';

  const colorMap = {
    high: 'bg-red-500/20 text-red-400',
    medium: 'bg-yellow-500/20 text-yellow-400',
    low: 'bg-gray-500/20 text-gray-400',
  };
  const colorClass = colorMap[importance] || 'bg-gray-500/20 text-gray-400';

  return { label, colorClass };
}

/**
 * Human-readable label for a lesson type key.
 * @param {string} type - e.g. 'build_failure'
 * @returns {string}
 */
export function getLessonTypeLabel(type) {
  const labels = {
    error: 'Error',
    build_failure: 'Build Failure',
    test_failure: 'Test Failure',
    permission_denied: 'Permission Denied',
  };
  return labels[type] || type || 'Lesson';
}

/**
 * Tailwind color class for a lesson type.
 * @param {string} type
 * @returns {string}
 */
export function getLessonTypeColor(type) {
  const colors = {
    error: 'bg-red-500/20 text-red-400',
    build_failure: 'bg-orange-500/20 text-orange-400',
    test_failure: 'bg-yellow-500/20 text-yellow-400',
    permission_denied: 'bg-purple-500/20 text-purple-400',
  };
  return colors[type] || 'bg-gray-500/20 text-gray-400';
}

/**
 * Escape HTML special characters to prevent XSS.
 * Apply before inserting any user-derived content into dangerouslySetInnerHTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
