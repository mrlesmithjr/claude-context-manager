#!/usr/bin/env node
/**
 * Session End Hook (Stop)
 *
 * Triggered when Claude Code session ends.
 * Reads the transcript file and extracts a summary to store in SQLite.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "transcript_path": "/path/to/transcript.jsonl"
 * }
 *
 * Output (stdout JSON):
 * {
 *   "status": "complete" | "error"
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { validateStopInput } from '../../src/utils/validation.js';
import { createDebugLogger } from '../../src/utils/logger.js';
import { exportToAutoMemory } from '../../src/export/memory.js';
import * as fs from 'fs';

const debugLog = createDebugLogger('stop-hook-debug.log');

interface TranscriptMessage {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  summary?: string;
}

/**
 * Extract a summary from the transcript file.
 *
 * The transcript is JSONL format. We look for:
 * 1. First line may contain a summary field
 * 2. Last assistant message content
 */
function extractSummaryFromTranscript(transcriptPath: string): string | undefined {
  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog('TRANSCRIPT_NOT_FOUND', transcriptPath);
      return undefined;
    }

    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      debugLog('TRANSCRIPT_EMPTY', transcriptPath);
      return undefined;
    }

    // Check first line for summary field (Claude Code sometimes includes this)
    try {
      const firstLine = JSON.parse(lines[0]) as TranscriptMessage;
      if (firstLine.summary && typeof firstLine.summary === 'string') {
        debugLog('FOUND_SUMMARY_IN_FIRST_LINE', firstLine.summary.substring(0, 200));
        return firstLine.summary;
      }
    } catch {
      // First line might not be valid JSON, continue
    }

    // Find the last assistant message
    let lastAssistantContent: string | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]) as TranscriptMessage;

        if (line.type === 'assistant' && line.message?.role === 'assistant') {
          const msgContent = line.message.content;

          if (typeof msgContent === 'string') {
            lastAssistantContent = msgContent;
            break;
          } else if (Array.isArray(msgContent)) {
            // Content might be an array of content blocks
            const textBlocks = msgContent
              .filter(block => block.type === 'text' && block.text)
              .map(block => block.text)
              .join('\n');
            if (textBlocks) {
              lastAssistantContent = textBlocks;
              break;
            }
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    if (lastAssistantContent) {
      // Truncate to reasonable summary length (first 1500 chars)
      const summary = lastAssistantContent.length > 1500
        ? lastAssistantContent.substring(0, 1500) + '...'
        : lastAssistantContent;
      debugLog('EXTRACTED_LAST_ASSISTANT', summary.substring(0, 200));
      return summary;
    }

    debugLog('NO_ASSISTANT_MESSAGE_FOUND', { lineCount: lines.length });
    return undefined;
  } catch (error) {
    debugLog('TRANSCRIPT_READ_ERROR', { error: String(error), path: transcriptPath });
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const storage = new SQLiteStorage();

  try {
    const inputStr = await readStdin();
    debugLog('RAW_INPUT_STRING', inputStr);

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      debugLog('JSON_PARSE_ERROR', { error: String(parseError), input: inputStr });
      console.error('[context-manager] Invalid JSON input');
      process.stdout.write(JSON.stringify({ status: 'error' }));
      return;
    }

    debugLog('PARSED_INPUT', rawInput);
    debugLog('HAS_TRANSCRIPT_PATH', {
      has: 'transcript_path' in rawInput,
      path: rawInput.transcript_path
    });

    // Validate and sanitize input
    const input = validateStopInput(rawInput);

    // Extract summary from transcript file
    let summary: string | undefined;
    if (input.transcript_path) {
      summary = extractSummaryFromTranscript(input.transcript_path);
    }

    debugLog('SUMMARY_RESULT', {
      hasTranscriptPath: !!input.transcript_path,
      hasSummary: !!summary,
      summaryLength: summary?.length
    });

    // Initialize storage
    await storage.initialize();

    // End session with summary
    await storage.endSession(input.session_id, summary);

    // Export high-importance observations to auto-memory topic file
    try {
      const result = await exportToAutoMemory(storage, input.cwd, input.session_id);
      if (result.exported > 0) {
        console.error(`[context-manager] Exported ${result.exported} observations to auto-memory`);
      }
    } catch (exportError) {
      console.error('[context-manager] Auto-memory export failed:', exportError);
    }

    process.stdout.write(JSON.stringify({ status: 'complete' }));
  } catch (error) {
    debugLog('SESSION_END_ERROR', { error: String(error) });
    console.error('[context-manager] Session end error:', error);
    process.stdout.write(JSON.stringify({ status: 'error' }));
  } finally {
    storage.close();
  }
}

main();
