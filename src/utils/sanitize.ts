/**
 * Content Sanitization Utilities
 *
 * ReDoS-safe implementations for removing private tags and sensitive data.
 */

/**
 * Strip <private> tags from content (ReDoS-safe implementation)
 *
 * Uses character-by-character processing to avoid catastrophic backtracking.
 */
export function stripPrivateTags(content: string): string {
  let result = '';
  let i = 0;
  const openTag = '<private>';
  const closeTag = '</private>';

  while (i < content.length) {
    const remainingLength = content.length - i;

    // Check for opening tag
    if (
      remainingLength >= openTag.length &&
      content.substring(i, i + openTag.length) === openTag
    ) {
      // Find matching close tag
      const closeIndex = content.indexOf(closeTag, i + openTag.length);

      if (closeIndex !== -1) {
        // Skip entire private section
        result += '[REDACTED]';
        i = closeIndex + closeTag.length;
      } else {
        // No closing tag — redact everything from the opening tag to end of string
        result += '[REDACTED]';
        i = content.length;
      }
      continue;
    }

    // Copy character if not in private section
    result += content[i];
    i++;
  }

  return result;
}

/**
 * Patterns for sensitive data detection
 */
const SENSITIVE_PATTERNS = [
  // API keys
  { pattern: /\b(sk|pk|api|token)[-_]?[a-zA-Z0-9]{20,}\b/gi, replacement: '[API_KEY_REDACTED]' },

  // AWS credentials
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[AWS_KEY_REDACTED]' },
  {
    pattern: /aws_secret_access_key\s*=\s*[^\s]+/gi,
    replacement: 'aws_secret_access_key=[REDACTED]',
  },

  // JWT tokens (basic pattern - 3 base64 segments separated by dots)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: '[JWT_REDACTED]',
  },

  // URLs with embedded credentials
  {
    pattern: /(\w+):\/\/[^:]+:[^@]+@[^\s]+/gi,
    replacement: (match: string) => {
      try {
        const url = new URL(match);
        return `${url.protocol}//${url.hostname}${url.pathname}`;
      } catch {
        return '[URL_WITH_CREDENTIALS_REDACTED]';
      }
    },
  },

  // Environment variables with common secret names
  {
    pattern:
      /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIALS?)\s*[:=]\s*['"]?([^\s'"]+)['"]?/gi,
    replacement: '$1=[REDACTED]',
  },

  // Private keys
  {
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY_REDACTED]',
  },
];

/**
 * Sanitize sensitive data patterns from content
 */
export function sanitizeSensitiveData(content: string): string {
  let sanitized = content;

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    if (typeof replacement === 'function') {
      sanitized = sanitized.replace(pattern, replacement);
    } else {
      sanitized = sanitized.replace(pattern, replacement);
    }
  }

  return sanitized;
}

/**
 * Sanitize content: strip private tags and sensitive data
 */
export function sanitizeContent(content: string): string {
  // First strip private tags
  let sanitized = stripPrivateTags(content);

  // Then sanitize sensitive patterns
  sanitized = sanitizeSensitiveData(sanitized);

  return sanitized;
}

/**
 * Estimate token count from text (heuristic: 4 chars ≈ 1 token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within token budget
 */
export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) {
    return text;
  }

  return text.substring(0, maxChars) + '... [truncated]';
}
