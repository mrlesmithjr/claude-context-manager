#!/usr/bin/env node
/**
 * Import JSONL transcripts into claude-context-manager
 *
 * Usage:
 *   npx ts-node scripts/import-transcripts.ts --source <dir> --project <path> [--dry-run] [--filter <text>]
 *
 * Example:
 *   npx ts-node scripts/import-transcripts.ts \
 *     --source ~/Backups/.claude.backup/projects/-Users-you-Projects-OldProject/ \
 *     --project ~/Projects/Work/ProjectA \
 *     --filter "some-keyword" \
 *     --dry-run
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { SQLiteStorage } from '../src/storage/sqlite.js';

interface TranscriptMessage {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string }>;
  };
}

interface ImportStats {
  totalFiles: number;
  matchedFilter: number;
  imported: number;
  skipped: number;
  errors: number;
}

function parseArgs(): {
  source: string;
  project: string;
  dryRun: boolean;
  filter?: string;
} {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  const projectIdx = args.indexOf('--project');
  const filterIdx = args.indexOf('--filter');

  if (sourceIdx === -1 || projectIdx === -1) {
    console.error('Usage: import-transcripts --source <dir> --project <path> [--dry-run] [--filter <text>]');
    process.exit(1);
  }

  const source = args[sourceIdx + 1]?.replace(/^~/, homedir());
  const project = args[projectIdx + 1]?.replace(/^~/, homedir());
  const filter = filterIdx !== -1 ? args[filterIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');

  if (!source || !project) {
    console.error('Error: --source and --project require path arguments');
    process.exit(1);
  }

  return { source, project, dryRun, filter };
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Score a message based on quality indicators for summary extraction.
 * Higher scores indicate better summary content.
 */
function scoreMessage(text: string): number {
  let score = 0;

  // Positive indicators
  if (text.includes('|---|')) score += 20; // markdown table (reduced - ctx-list also has tables)
  if (/^##\s+(Summary|Key Findings|Analysis|Results|Recommendations|Data Sources|Overview)/im.test(text)) score += 25;
  if (/^\d+\.\s+/m.test(text)) score += 10; // numbered list
  if (text.length > 500) score += 15;
  if (text.length > 1000) score += 10;

  // Content quality indicators
  if (/implementation|architecture|design|solution/i.test(text)) score += 15;
  if (/completed|accomplished|created|implemented/i.test(text)) score += 10;

  // Negative indicators - ctx-list/utility outputs
  if (/Context Observations|Recent Activity/i.test(text)) score -= 40; // ctx-list output
  if (/\| # \| Timestamp/i.test(text)) score -= 40; // ctx-list table header
  if (/\| Tool \| Summary/i.test(text)) score -= 30; // observation table

  // General negative indicators
  if (text.endsWith('?')) score -= 20;
  if (text.length < 100) score -= 20;
  if (/would you like|let me know if/i.test(text)) score -= 15;

  return score;
}

/**
 * Extract the best summary content from transcript messages.
 * Scores all assistant messages and selects the highest-quality one.
 * Falls back to the last assistant message if no message scores well.
 */
function extractSummary(messages: TranscriptMessage[]): string {
  interface ScoredMessage {
    text: string;
    score: number;
    index: number;
  }

  const scoredMessages: ScoredMessage[] = [];

  // Score all assistant messages
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.message?.role === 'assistant') {
      const content = msg.message.content;
      let text: string;

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Extract text from content blocks
        text = content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join(' ');
      } else {
        continue;
      }

      const score = scoreMessage(text);
      scoredMessages.push({ text, score, index: i });
    }
  }

  if (scoredMessages.length === 0) {
    return 'No summary available';
  }

  // Sort by score (descending), then by index (descending) to prefer later messages on ties
  scoredMessages.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.index - a.index;
  });

  // Return the highest-scoring message, truncated to 500 chars
  return scoredMessages[0].text.substring(0, 500);
}

function parseJsonl(filePath: string): TranscriptMessage[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      messages.push(parsed);
    } catch (error) {
      // Skip invalid JSON lines
    }
  }

  return messages;
}

function containsFilter(messages: TranscriptMessage[], filter: string): boolean {
  const fullText = messages
    .map((msg) => {
      if (msg.message?.content) {
        const content = msg.message.content;
        if (typeof content === 'string') {
          return content;
        } else if (Array.isArray(content)) {
          return content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join(' ');
        }
      }
      return '';
    })
    .join(' ');

  return fullText.toLowerCase().includes(filter.toLowerCase());
}

async function importTranscript(
  storage: SQLiteStorage,
  sessionId: string,
  project: string,
  messages: TranscriptMessage[],
  fileModTime: Date
): Promise<void> {
  // Extract timestamps
  const timestamps = messages
    .filter((msg) => msg.timestamp)
    .map((msg) => new Date(msg.timestamp!));

  const startedAt = timestamps.length > 0 ? timestamps[0] : fileModTime;
  const endedAt = timestamps.length > 0 ? timestamps[timestamps.length - 1] : fileModTime;

  // Extract summary from last assistant message
  const summary = extractSummary(messages);

  // Create session record
  await storage.createSession(sessionId, project);

  // End the session with summary
  await storage.endSession(sessionId, summary);

  // Update started_at and ended_at manually
  // (createSession sets started_at to now, we need to override it)
  const db = (storage as any).db;
  const stmt = db.prepare(`
    UPDATE sessions
    SET started_at = ?, ended_at = ?
    WHERE id = ?
  `);

  stmt.run(startedAt.toISOString(), endedAt.toISOString(), sessionId);
}

async function main() {
  const { source, project, dryRun, filter } = parseArgs();

  console.log('\nImport Transcripts to claude-context-manager');
  console.log('='.repeat(50));
  console.log(`Source: ${source}`);
  console.log(`Target Project: ${project}`);
  if (filter) {
    console.log(`Filter: ${filter}`);
  }
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'IMPORT'}`);
  console.log('='.repeat(50));
  console.log();

  const storage = new SQLiteStorage();
  await storage.initialize();

  const stats: ImportStats = {
    totalFiles: 0,
    matchedFilter: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    const files = readdirSync(source).filter((f) => extname(f) === '.jsonl');
    stats.totalFiles = files.length;

    console.log(`Found ${files.length} JSONL files\n`);

    for (const file of files) {
      const filePath = join(source, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        // Parse JSONL
        const messages = parseJsonl(filePath);

        if (messages.length === 0) {
          stats.skipped++;
          continue;
        }

        // Apply filter if specified
        if (filter && !containsFilter(messages, filter)) {
          stats.skipped++;
          continue;
        }

        stats.matchedFilter++;

        if (!dryRun) {
          // Get file modification time
          const fileStats = statSync(filePath);
          const fileModTime = fileStats.mtime;

          // Import to database
          await importTranscript(storage, sessionId, project, messages, fileModTime);
          stats.imported++;
        }

        console.log(`✓ ${sessionId} (${messages.length} messages)`);
      } catch (error) {
        console.error(`✗ ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        stats.errors++;
      }
    }
  } finally {
    storage.close();
  }

  console.log('\n' + '='.repeat(50));
  console.log('Import Summary');
  console.log('='.repeat(50));
  console.log(`Total files: ${stats.totalFiles}`);
  if (filter) {
    console.log(`Matched filter: ${stats.matchedFilter}`);
  }
  if (dryRun) {
    console.log(`Would import: ${stats.matchedFilter}`);
  } else {
    console.log(`Imported: ${stats.imported}`);
  }
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
