#!/usr/bin/env node
/**
 * Agent Context Hook (PreToolUse)
 *
 * Triggered before Agent tool invocations. If the agent has an accumulated
 * lessons file at ~/.dotfiles/.claude/agents/<name>.lessons.md, its content
 * is injected as additional context so Claude invokes the agent with its own
 * learned corrections already loaded.
 *
 * Guards:
 *   1. Agent name must match the safe-name allowlist regex (lowercase, digits, hyphens).
 *   2. Content is capped at 3000 characters, truncated at the last newline boundary.
 *   3. Remote mode: does NOT skip here. Lessons files live on the local machine
 *      alongside the agent directories, not on the remote server.
 *   4. Any error: returns {} silently (never block an Agent invocation).
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "tool_name": "Agent",
 *   "tool_input": { "subagent_type": "code-reviewer" }
 * }
 *
 * Output (stdout JSON) when lessons file exists:
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "additionalContext": "<lessons content>"
 *   }
 * }
 *
 * Output (stdout JSON) when no file, invalid name, or any error:
 * {}
 */

import { loadDotEnv } from '../../src/utils/env.js';
import { createDebugLogger } from '../../src/utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// No native module guard needed: this hook uses only fs.readFileSync, not SQLite.

const debugLog = createDebugLogger('agent-context-hook-debug.log');

/** Maximum characters to inject from a .lessons.md file. */
const LESSONS_CONTENT_CAP = 3000;

/** Allowlist regex for safe agent names: lowercase letters, digits, hyphens only. */
const SAFE_AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

/** Write JSON to stdout and wait for it to flush before continuing. */
function writeResponse(data: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(JSON.stringify(data) + '\n');
    if (ok) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
      process.stdout.once('error', reject);
    }
  });
}

/**
 * Truncate content to cap characters, breaking at the last newline boundary
 * before the cap to avoid mid-sentence cuts.
 */
function capContent(content: string, cap: number): string {
  if (content.length <= cap) return content;
  const slice = content.slice(0, cap);
  const lastNewline = slice.lastIndexOf('\n');
  // > 0 intentional: position 0 means only a leading blank line found;
  // fall back to raw slice rather than returning an empty string.
  return lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
}

async function main() {
  // Load .env before reading any process.env values so remote mode activates
  // even when Claude Code was launched from the Dock, Spotlight, or after a reboot.
  loadDotEnv();

  // Unlike other hooks, remote mode does NOT skip here.
  // .lessons.md files live on the local machine alongside the agent directories,
  // not on the remote server. We can always read them directly with fs.readFileSync.

  try {
    const inputStr = await readStdin();

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(inputStr);
    } catch {
      debugLog('PARSE_ERROR', 'invalid JSON input');
      await writeResponse({});
      return;
    }

    const obj = (typeof rawInput === 'object' && rawInput !== null)
      ? rawInput as Record<string, unknown>
      : {};

    const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : '';

    // Only handle Agent invocations (matcher in hooks.json also filters, but be explicit).
    if (toolName !== 'Agent') {
      await writeResponse({});
      return;
    }

    // Extract agent name from tool_input.subagent_type.
    const toolInput = (typeof obj.tool_input === 'object' && obj.tool_input !== null)
      ? obj.tool_input as Record<string, unknown>
      : {};
    const agentName = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : '';

    if (!agentName) {
      await writeResponse({});
      return;
    }

    // Guard 1: validate agent name against allowlist regex to prevent path traversal.
    if (!SAFE_AGENT_NAME.test(agentName)) {
      debugLog('AGENT_CONTEXT_INVALID_NAME', { agentName });
      await writeResponse({});
      return;
    }

    const lessonsPath = join(homedir(), '.dotfiles', '.claude', 'agents', agentName + '.lessons.md');

    debugLog('AGENT_CONTEXT_REQUEST', { agentName, lessonsPath });

    if (!existsSync(lessonsPath)) {
      debugLog('AGENT_CONTEXT_NO_FILE', { agentName, lessonsPath });
      await writeResponse({});
      return;
    }

    const rawContent = readFileSync(lessonsPath, 'utf8');
    const content = capContent(rawContent.trim(), LESSONS_CONTENT_CAP);

    if (!content) {
      debugLog('AGENT_CONTEXT_EMPTY', { agentName });
      await writeResponse({});
      return;
    }

    debugLog('AGENT_CONTEXT_INJECT', { agentName, chars: content.length });

    await writeResponse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: content,
      },
    });
  } catch (error) {
    // Any error must return empty response. Never block an Agent invocation.
    debugLog('AGENT_CONTEXT_ERROR', String(error));
    console.error('[context-manager] agent-context hook error:', error);
    await writeResponse({});
  }
}

main();
