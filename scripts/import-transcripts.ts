#!/usr/bin/env node
/**
 * Import JSONL transcripts into claude-context-manager
 *
 * Usage:
 *   npx ts-node scripts/import-transcripts.ts --source <dir> --project <path> [--dry-run] [--filter <text>]
 *
 * Example:
 *   npx ts-node scripts/import-transcripts.ts \
 *     --source ~/Backups/.claude.backup/projects/-Users-you-Projects-MyCompany-products-my-product-io/ \
 *     --project ~/Projects/Work/ProjectA \
 *     --filter ProjectA \
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

function extractSummary(messages: TranscriptMessage[]): string {
  // Find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.message?.role === 'assistant') {
      const content = msg.message.content;

      if (typeof content === 'string') {
        // Truncate to 500 chars
        return content.substring(0, 500);
      } else if (Array.isArray(content)) {
        // Extract text from content blocks
        const textBlocks = content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join(' ');
        return textBlocks.substring(0, 500);
      }
    }
  }

  return 'No summary available';
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
