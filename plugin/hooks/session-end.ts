#!/usr/bin/env node
/**
 * Session End Hook (Stop + PreCompact)
 *
 * Triggered when Claude Code session ends (Stop) or when /compact is invoked
 * (PreCompact). Both events provide the same JSON input fields. The script
 * is intentionally reused for both events: endSession is idempotent on
 * repeat calls, insight deduplication guards against duplicate observations,
 * and auto-memory export uses an exported_at guard to avoid double-export.
 *
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
import { estimateTokens } from '../../src/utils/sanitize.js';
import type { Observation, ImportanceLevel } from '../../src/storage/interface.js';
import * as fs from 'fs';
import {
  remoteEndSession,
  remoteSaveObservation,
  remoteExportMemory,
} from '../../src/capture/remote-client.js';
import { loadDotEnv } from '../../src/utils/env.js';
import {
  extractTextFromTranscriptLine,
  pickBestNarrative,
  type TranscriptLine,
} from '../../src/utils/transcript.js';

// Injected by esbuild banner. True when plugin/node_modules/ native binaries are present.
declare const __nativeModulesAvailable: boolean;

// Duplicated in capture-tool.ts, capture-prompt.ts, and context-inject.ts.
// Plugin hooks are compiled independently by esbuild into single-file bundles;
// there is no shared hook module to import from, so each file carries its own copy.
const NO_NATIVE_ERROR =
  '[context-manager] No server configured and native SQLite modules are not available.\n' +
  "Run 'make server-quickstart' (macOS) or 'make server-start' (Docker) to set up a server,\n" +
  'then restart Claude Code.\n' +
  "For local SQLite mode: clone the repo, run 'npm install', and install locally with\n" +
  "'/plugin marketplace add /path/to/repo'.";

const debugLog = createDebugLogger('stop-hook-debug.log');

// Re-export the shared type alias for use within this file
type TranscriptMessage = TranscriptLine;

/**
 * Extract session summary and extended narrative from pre-parsed transcript lines.
 * Accepts string[] (already read+split) so the caller controls the single file read.
 * Delegates to pickBestNarrative() from the shared transcript util.
 */
function extractSummaryFromLines(lines: string[]): {
  summary: string | undefined;
  summaryExtended: string | undefined;
  bestScore: number;
} {
  try {
    if (lines.length === 0) {
      debugLog('TRANSCRIPT_EMPTY', { lineCount: 0 });
      return { summary: undefined, summaryExtended: undefined, bestScore: 0 };
    }

    const result = pickBestNarrative(lines);

    if (!result.summary) {
      debugLog('NO_ASSISTANT_MESSAGE_FOUND', { lineCount: lines.length });
    } else {
      debugLog('EXTRACTED_SUMMARY', { length: result.summary.length, preview: result.summary.substring(0, 200) });
      if (result.summaryExtended) {
        debugLog('EXTRACTED_SUMMARY_EXTENDED', { length: result.summaryExtended.length });
      }
    }

    return result;
  } catch (error) {
    debugLog('TRANSCRIPT_PARSE_ERROR', { error: String(error) });
    return { summary: undefined, summaryExtended: undefined, bestScore: 0 };
  }
}

/**
 * High-signal content patterns in assistant responses.
 * These indicate synthesized knowledge worth indexing.
 */
const HIGH_SIGNAL_PATTERNS = {
  /** Markdown tables — structured comparisons, recommendations, specs */
  hasTable: (text: string): boolean => {
    const lines = text.split('\n');
    let tableRows = 0;
    for (const line of lines) {
      if (line.includes('|') && line.trim().startsWith('|')) {
        tableRows++;
        if (tableRows >= 3) return true; // header + separator + at least 1 data row
      }
    }
    return false;
  },

  /** Decision/recommendation language */
  hasRecommendation: (text: string): boolean => {
    const lower = text.toLowerCase();
    const patterns = [
      'recommend', 'my take', 'i\'d go with', 'best option',
      'here\'s what you need', 'you should', 'the winner',
      'updated recommendation', 'revised', 'landing on',
      'option 1', 'option 2', 'comparison',
    ];
    return patterns.some(p => lower.includes(p));
  },

  /** Price/cost analysis */
  hasPriceAnalysis: (text: string): boolean => {
    const pricePattern = /\$\d+[\d,.]*.*\$\d+[\d,.]*|\btotal\b.*\$\d+/i;
    return pricePattern.test(text);
  },

  /** User fact statements (short, declarative) */
  hasUserFact: (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes('you don\'t have') ||
      lower.includes('you don\'t own') ||
      lower.includes('you confirmed') ||
      lower.includes('you mentioned') ||
      lower.includes('you said')
    );
  },
};

/**
 * Score an assistant text block for signal quality.
 * Returns 0.0-1.0 (0 = skip, higher = more valuable).
 */
function scoreAssistantBlock(text: string): number {
  // Skip very short or very long blocks (tool orchestration or raw dumps)
  if (text.length < 100 || text.length > 15000) return 0;

  // Skip blocks that are purely tool orchestration
  const lower = text.toLowerCase();
  if (lower.startsWith('let me ') && text.length < 200) return 0;
  if (lower.startsWith('i\'ll ') && text.length < 200) return 0;
  if (lower.includes('let me check') && text.length < 200) return 0;
  if (lower.includes('let me search') && text.length < 200) return 0;

  let score = 0;

  if (HIGH_SIGNAL_PATTERNS.hasTable(text)) score += 0.4;
  if (HIGH_SIGNAL_PATTERNS.hasRecommendation(text)) score += 0.3;
  if (HIGH_SIGNAL_PATTERNS.hasPriceAnalysis(text)) score += 0.2;
  if (HIGH_SIGNAL_PATTERNS.hasUserFact(text)) score += 0.2;

  // Bonus for structured content (headers, bullet lists)
  const headerCount = (text.match(/^#{1,3}\s/gm) || []).length;
  const bulletCount = (text.match(/^[-*]\s/gm) || []).length;
  if (headerCount >= 2) score += 0.1;
  if (bulletCount >= 3) score += 0.1;

  return Math.min(1.0, score);
}

/**
 * Compress an assistant text block into a concise summary for storage.
 * Extracts the key information (tables, decisions, facts) and discards filler.
 */
function compressAssistantBlock(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let totalLen = 0;
  const MAX_SUMMARY = 600; // ~150 tokens

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Always keep: table rows, headers, bullet points with data
    const isTable = trimmed.startsWith('|') && trimmed.includes('|');
    const isHeader = /^#{1,3}\s/.test(trimmed);
    const isBullet = /^[-*]\s/.test(trimmed);
    const hasMoney = /\$\d+/.test(trimmed);
    const isDecision = /\b(recommend|total|option|best|winner|you don't)\b/i.test(trimmed);

    // Skip table separator rows
    if (isTable && /^\|[\s-:|]+\|$/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }

    if (isTable || isHeader || (isBullet && (hasMoney || trimmed.length > 20)) || isDecision || hasMoney) {
      if (totalLen + trimmed.length > MAX_SUMMARY) break;
      kept.push(trimmed);
      totalLen += trimmed.length;
    }
  }

  return kept.join('\n');
}

/**
 * Extract high-signal conversation insights from all assistant messages.
 * Returns observations ready to be saved.
 */
/**
 * Extract high-signal conversation insights from pre-parsed transcript lines.
 * Accepts string[] (already read+split) so the caller controls the single file read.
 */
function extractConversationInsights(
  lines: string[],
  sessionId: string,
  project: string
): Array<Omit<Observation, 'id'>> {
  const insights: Array<Omit<Observation, 'id'>> = [];

  try {
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as TranscriptMessage;
        if (msg.type !== 'assistant' || msg.message?.role !== 'assistant') continue;

        // Extract text from assistant message using shared utility
        const text = extractTextFromTranscriptLine(msg);

        if (!text) continue;

        // Score the block
        const score = scoreAssistantBlock(text);
        if (score < 0.3) continue; // Skip low-signal blocks

        // Compress into summary
        const compressed = compressAssistantBlock(text);
        if (compressed.length < 30) continue; // Not enough signal after compression

        // Build a one-line summary from the first header or first meaningful line
        let summary = 'Conversation insight';
        const firstHeader = text.match(/^#{1,3}\s+(.+)$/m);
        if (firstHeader?.[1]) {
          summary = firstHeader[1].substring(0, 100);
        } else {
          // Use first non-empty, non-short line
          const firstLine = text.split('\n').find(l => l.trim().length > 20);
          if (firstLine) {
            summary = firstLine.trim().substring(0, 100);
          }
        }

        const tokenEstimate = estimateTokens(`${summary}\n${compressed}`);

        // Map score to importance
        let importance: ImportanceLevel;
        if (score >= 0.5) importance = 'high';
        else if (score >= 0.3) importance = 'medium';
        else importance = 'low';

        insights.push({
          session_id: sessionId,
          project,
          tool_name: 'Conversation',
          summary,
          files_touched: [],
          metadata: {
            stored_output: compressed,
            output_stats: {
              original_length: text.length,
              line_count: text.split('\n').length,
              truncated: compressed.length < text.length,
            },
          },
          token_estimate: tokenEstimate,
          importance,
          importance_score: Math.round(score * 100) / 100,
          created_at: new Date().toISOString(),
        });
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    // Cap at 10 insights per session to bound token budget
    // Sort by score descending, keep top 10
    insights.sort((a, b) => b.importance_score - a.importance_score);
    return insights.slice(0, 10);
  } catch (error) {
    debugLog('CONVERSATION_EXTRACT_ERROR', { error: String(error) });
    return [];
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

async function main() {
  // Load .env before reading any process.env values so remote mode activates
  // even when Claude Code was launched from the Dock, Spotlight, or after a reboot.
  loadDotEnv();

  // Storage is only opened in local mode; remote mode has no local SQLite footprint.
  let storage: SQLiteStorage | null = null;

  try {
    const inputStr = await readStdin();

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      debugLog('JSON_PARSE_ERROR', { error: String(parseError) });
      console.error('[context-manager] Invalid JSON input');
      await writeResponse({ status: 'error' });
      return;
    }

    // Log metadata only — raw input may contain file paths or session context
    debugLog('PARSED_KEYS', Object.keys(rawInput).join(', '));
    debugLog('HAS_TRANSCRIPT_PATH', {
      has: 'transcript_path' in rawInput,
      hasValue: typeof rawInput.transcript_path === 'string' && rawInput.transcript_path.length > 0,
    });

    // Validate and sanitize input
    const input = validateStopInput(rawInput);

    // Read and parse the transcript once — both summary extraction and insight
    // extraction need it, and reading a large file twice wastes Stop hook timeout.
    let transcriptLines: string[] | undefined;
    if (input.transcript_path) {
      try {
        const content = fs.readFileSync(input.transcript_path, 'utf8');
        transcriptLines = content.trim().split('\n').filter(line => line.trim());
      } catch {
        debugLog('TRANSCRIPT_READ_ERROR', { path: input.transcript_path });
      }
    }

    // Extract summary from pre-read lines
    let summary: string | undefined;
    let summaryExtended: string | undefined;
    let narrativeBestScore = 0;
    if (transcriptLines) {
      ({ summary, summaryExtended, bestScore: narrativeBestScore } = extractSummaryFromLines(transcriptLines));
    }

    debugLog('SUMMARY_RESULT', {
      hasTranscriptPath: !!input.transcript_path,
      hasSummary: !!summary,
      summaryLength: summary?.length
    });

    // --- Remote mode: send insights, end session, and trigger server export ---
    const remoteUrl = (process.env['CONTEXT_MANAGER_URL'] ?? '').trim();
    const remoteToken = (process.env['CONTEXT_MANAGER_TOKEN'] ?? '').trim();

    if (remoteUrl) {
      if (!remoteToken) {
        console.error(
          '[context-manager] CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is missing — remote session end skipped'
        );
        await writeResponse({ status: 'error' });
        return;
      }

      const client = { url: remoteUrl, token: remoteToken };

      // Extract conversation insights locally (pure computation from transcript)
      if (transcriptLines) {
        try {
          const insights = extractConversationInsights(
            transcriptLines,
            input.session_id,
            input.cwd
          );
          for (const insight of insights) {
            try {
              await remoteSaveObservation(client, insight);
            } catch (err) {
              console.error('[context-manager] Remote insight save failed:', err);
            }
          }
          if (insights.length > 0) {
            debugLog('CONVERSATION_INSIGHTS_REMOTE', { count: insights.length });
            console.error(`[context-manager] Sent ${insights.length} conversation insights to server`);
          }
        } catch (insightError) {
          console.error('[context-manager] Conversation insight extraction failed:', insightError);
        }
      }

      // End session on the remote server
      try {
        await remoteEndSession(client, input.session_id, summary, summaryExtended);
      } catch (err) {
        console.error('[context-manager] Remote session end failed:', err);
      }

      // Trigger server-side memory export (writes to server's memory file).
      // remoteExportMemory never throws; it returns '' on any error.
      // The returned content is not used here: the next SessionStart fetches it via GET /memory.
      const exportedContent = await remoteExportMemory(client, input.cwd, input.session_id);
      if (exportedContent.trim().length > 0) {
        console.error('[context-manager] Server-side memory export triggered');
      }

      await writeResponse({ status: 'complete' });
      return;
    }

    // --- Local mode: direct SQLite access ---
    if (!__nativeModulesAvailable) {
      console.error(NO_NATIVE_ERROR);
      await writeResponse({ status: 'error', error: 'Native SQLite modules not available. Configure CONTEXT_MANAGER_URL or install locally.' });
      return;
    }

    storage = new SQLiteStorage();
    await storage.initialize();

    // Extract and save conversation insights before ending session
    if (transcriptLines) {
      try {
        const insights = extractConversationInsights(
          transcriptLines,
          input.session_id,
          input.cwd
        );
        // Deduplicate: skip insights that already exist in this session
        // (Stop hook can fire multiple times for the same session on restart)
        const existingObs = await storage.getSessionObservations(input.session_id);
        const existingSummaries = new Set(
          existingObs
            .filter(o => o.tool_name === 'Conversation')
            .map(o => o.summary)
        );
        for (const insight of insights) {
          if (!existingSummaries.has(insight.summary)) {
            await storage.save(insight);
          }
        }
        if (insights.length > 0) {
          debugLog('CONVERSATION_INSIGHTS', { count: insights.length });
          console.error(`[context-manager] Extracted ${insights.length} conversation insights`);
        }
      } catch (insightError) {
        debugLog('CONVERSATION_INSIGHT_ERROR', { error: String(insightError) });
        console.error('[context-manager] Conversation insight extraction failed:', insightError);
      }
    }

    // Conversation fallback: when narrative scoring yields a weak result (score < 0.20),
    // use the top Conversation observation summary instead. This handles discussion and
    // planning sessions that produce no code-change signals (no file paths, action verbs,
    // or code blocks) but may have rich synthesized content from the insight extractor.
    if (narrativeBestScore < 0.20) {
      try {
        const topConversation = await storage.getTopConversationObservation(input.session_id);
        if (topConversation?.summary) {
          summary = topConversation.summary;
          debugLog('SUMMARY_CONVERSATION_FALLBACK', { sessionId: input.session_id, summary: summary.substring(0, 100) });
        }
      } catch (fallbackError) {
        debugLog('SUMMARY_FALLBACK_ERROR', { error: String(fallbackError) });
      }
    }

    // End session with summary
    await storage.endSession(input.session_id, summary, summaryExtended);

    // Export high-importance observations to auto-memory topic file
    try {
      const result = await exportToAutoMemory(storage, input.cwd, input.session_id);
      if (result.exported > 0) {
        console.error(`[context-manager] Exported ${result.exported} observations to auto-memory`);
      }
    } catch (exportError) {
      console.error('[context-manager] Auto-memory export failed:', exportError);
    }

    await writeResponse({ status: 'complete' });
  } catch (error) {
    debugLog('SESSION_END_ERROR', { error: String(error) });
    console.error('[context-manager] Session end error:', error);
    await writeResponse({ status: 'error' });
  } finally {
    if (storage) await storage.close();
  }
}

main();
