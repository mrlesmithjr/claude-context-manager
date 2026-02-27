/**
 * Shared Debug Logger
 *
 * Conditional logging controlled by CONTEXT_MANAGER_DEBUG=1 env var.
 * Rotates log files when they exceed 1 MB (keeps last 500 KB).
 */

import { appendFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.claude-context', 'logs');
const MAX_LOG_SIZE = 1 * 1024 * 1024; // 1 MB
const KEEP_SIZE = 500 * 1024;          // 500 KB

function isDebugEnabled(): boolean {
  return process.env.CONTEXT_MANAGER_DEBUG === '1';
}

function rotateIfNeeded(logFile: string): void {
  try {
    const stats = statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const content = readFileSync(logFile, 'utf8');
      // Keep the last KEEP_SIZE bytes
      const trimmed = content.slice(content.length - KEEP_SIZE);
      // Find the first newline to avoid partial lines
      const firstNewline = trimmed.indexOf('\n');
      writeFileSync(logFile, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
    }
  } catch {
    // File doesn't exist yet or other error - ignore
  }
}

/**
 * Create a debug logger for a specific hook/component.
 *
 * Only writes when CONTEXT_MANAGER_DEBUG=1 is set.
 * Automatically rotates log files exceeding 1 MB.
 *
 * @param logFileName - Name of the log file (e.g., 'prompt-hook-debug.log')
 * @returns A logging function that accepts a label and optional data
 */
export function createDebugLogger(logFileName: string): (label: string, data?: unknown) => void {
  const logFile = join(LOG_DIR, logFileName);

  return (label: string, data?: unknown) => {
    if (!isDebugEnabled()) return;

    try {
      mkdirSync(LOG_DIR, { recursive: true });
      rotateIfNeeded(logFile);

      const timestamp = new Date().toISOString();
      const entry = data !== undefined
        ? `[${timestamp}] ${label}: ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`
        : `[${timestamp}] ${label}\n`;
      appendFileSync(logFile, entry);
    } catch {
      // Never fail - logging is best-effort
    }
  };
}
