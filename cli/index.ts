/**
 * CLI Tool for claude-context-manager
 *
 * Commands:
 * - list: List recent observations
 * - search: Full-text search observations
 * - stats: Show statistics
 * - vacuum: Delete old observations
 */

import { SQLiteStorage } from '../src/storage/sqlite.js';
import { exportToAutoMemory, resolveMemoryDir, formatObservationsForMemory } from '../src/export/memory.js';
import { homedir } from 'os';
import path from 'path';

const storage = new SQLiteStorage();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    await storage.initialize();

    switch (command) {
      case 'list':
        await listCommand(args.slice(1));
        break;

      case 'search':
        await searchCommand(args.slice(1));
        break;

      case 'stats':
        await statsCommand(args.slice(1));
        break;

      case 'vacuum':
        await vacuumCommand(args.slice(1));
        break;

      case 'export':
        await exportCommand(args.slice(1));
        break;

      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await storage.close();
  }
}

async function listCommand(args: string[]) {
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 20;

  const projectIndex = args.indexOf('--project');
  let project: string;

  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith('-')) {
      console.error('Error: --project requires a path argument');
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = process.cwd();
  }

  const observations = await storage.getRecent(project, limit);

  if (observations.length === 0) {
    console.log('No observations found.');
    return;
  }

  console.log(`\nRecent observations for ${project}:\n`);

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const date = new Date(obs.created_at);
    const fileInfo =
      obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';

    console.log(
      `${i + 1}. [${date.toISOString()}] ${obs.summary}${fileInfo}`
    );
    console.log(`   Tool: ${obs.tool_name}, Tokens: ${obs.token_estimate}`);
    console.log();
  }
}

async function searchCommand(args: string[]) {
  if (args.length === 0) {
    console.error('Usage: context-manager search <query> [--project <path>]');
    process.exit(1);
  }

  const projectIndex = args.indexOf('--project');
  let project: string | undefined;

  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith('-')) {
      console.error('Error: --project requires a path argument');
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = undefined;
  }

  // Query is all args except --project and its value
  const queryArgs = args.filter(
    (arg, idx) =>
      arg !== '--project' && (idx === 0 || args[idx - 1] !== '--project')
  );
  const query = queryArgs.join(' ');

  const observations = await storage.search(query, project);

  if (observations.length === 0) {
    console.log('No observations found matching query.');
    return;
  }

  console.log(
    `\nFound ${observations.length} observations matching "${query}":\n`
  );

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const date = new Date(obs.created_at);
    const fileInfo =
      obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';

    console.log(
      `${i + 1}. [${date.toISOString()}] ${obs.summary}${fileInfo}`
    );
    console.log(`   Project: ${obs.project}`);
    console.log();
  }
}

async function statsCommand(args: string[]) {
  const projectIndex = args.indexOf('--project');
  let project: string | undefined;

  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith('-')) {
      console.error('Error: --project requires a path argument');
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = undefined;
  }

  const stats = await storage.getStats(project);

  console.log('\nContext Manager Statistics\n');
  if (project) {
    console.log(`Project: ${project}\n`);
  } else {
    console.log('All Projects\n');
  }

  // Basic stats
  console.log('=== Storage ===');
  console.log(`Total Observations: ${stats.total_observations}`);
  console.log(`Total Sessions: ${stats.total_sessions}`);
  console.log(`Date Range: ${stats.oldest_observation || 'N/A'} to ${stats.newest_observation || 'N/A'}`);

  // Token Economics
  console.log('\n=== Token Economics ===');
  console.log(`Total Tokens Stored: ${stats.total_tokens.toLocaleString()}`);
  console.log(`Avg per Observation: ${stats.avg_tokens_per_observation} tokens`);
  console.log(`Avg per Session: ${stats.avg_tokens_per_session.toLocaleString()} tokens`);
  console.log(`Injection Budget: ${stats.token_budget.toLocaleString()} tokens`);
  console.log(`Typical Injection: ~${stats.typical_injection_tokens.toLocaleString()} tokens (${Math.round((stats.typical_injection_tokens / stats.token_budget) * 100)}% of budget)`);

  // Tokens by tool
  if (Object.keys(stats.tokens_by_tool).length > 0) {
    console.log('\n=== Tokens by Tool ===');
    const tools = Object.entries(stats.tokens_by_tool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [tool, tokens] of tools) {
      const pct = Math.round((tokens / stats.total_tokens) * 100);
      console.log(`  ${tool}: ${tokens.toLocaleString()} (${pct}%)`);
    }
  }

  // Importance distribution
  const imp = stats.importance_counts;
  const impTotal = imp.high + imp.medium + imp.low;
  if (impTotal > 0) {
    console.log('\n=== Importance Distribution ===');
    const pctH = Math.round((imp.high / impTotal) * 100);
    const pctM = Math.round((imp.medium / impTotal) * 100);
    const pctL = Math.round((imp.low / impTotal) * 100);
    console.log(`  High:   ${imp.high.toLocaleString()} (${pctH}%)`);
    console.log(`  Medium: ${imp.medium.toLocaleString()} (${pctM}%)`);
    console.log(`  Low:    ${imp.low.toLocaleString()} (${pctL}%)`);
  }

  // Compaction stats
  if (stats.compacted_count > 0) {
    console.log('\n=== Compaction ===');
    console.log(`  Compacted: ${stats.compacted_count} observations (from ${stats.compacted_original_count} originals)`);
  }
}

async function vacuumCommand(args: string[]) {
  const daysIndex = args.indexOf('--days');
  const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1], 10) : undefined;

  if (days) {
    console.log(`Deleting observations older than ${days} days...`);
  }

  console.log('Cleaning up orphaned sessions and optimizing database...');
  const result = await storage.vacuum(days);

  if (days) {
    console.log(`Deleted ${result.observations} observations.`);
  }
  if (result.compacted > 0) {
    console.log(`Compacted ${result.compacted_originals} observations into ${result.compacted} summaries.`);
  }
  if (result.sessions > 0) {
    console.log(`Cleaned up ${result.sessions} orphaned sessions.`);
  }
  console.log('Database optimized.');
}

async function exportCommand(args: string[]) {
  const projectIndex = args.indexOf('--project');
  let project: string;

  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith('-')) {
      console.error('Error: --project requires a path argument');
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = process.cwd();
  }

  const dryRun = args.includes('--dry-run');

  // Get unexported high-importance observations
  const observations = await storage.getUnexportedHighImportance(project);

  if (observations.length === 0) {
    console.log('No unexported high-importance observations found.');
    return;
  }

  console.log(`\nFound ${observations.length} unexported high-importance observations for ${project}:\n`);

  // Show preview
  for (const obs of observations.slice(0, 20)) {
    const date = new Date(obs.created_at);
    const fileInfo = obs.files_touched[0] ? ` (${obs.files_touched[0]})` : '';
    console.log(`  [${date.toISOString()}] ${obs.tool_name}: ${obs.summary.substring(0, 80)}${fileInfo}`);
  }
  if (observations.length > 20) {
    console.log(`  ... and ${observations.length - 20} more`);
  }

  if (dryRun) {
    console.log('\n--- Dry run: formatted output ---\n');
    const formatted = formatObservationsForMemory(observations);
    console.log(formatted);
    console.log(`\nTarget: ${resolveMemoryDir(project)}/context-manager-activity.md`);
    console.log('(dry run — no files written)');
    return;
  }

  const result = await exportToAutoMemory(storage, project);
  console.log(`\nExported ${result.exported} observations to auto-memory.`);
  if (result.filePath) {
    console.log(`Topic file: ${result.filePath}`);
  }
}

function printHelp() {
  console.log(`
claude-context-manager CLI

Usage:
  context-manager <command> [options]

Commands:
  list [--limit N] [--project PATH]
    List recent observations (default: 20)

  search <query> [--project PATH]
    Full-text search observations

  stats [--project PATH]
    Show statistics

  vacuum [--days N]
    Delete observations older than N days, or reclaim disk space

  export [--project PATH] [--dry-run]
    Export high-importance observations to auto-memory topic file

  help
    Show this help message

Examples:
  context-manager list --limit 10
  context-manager search "authentication" --project ~/Projects/my-app
  context-manager stats --project ~/Projects/my-app
  context-manager vacuum --days 30
  context-manager export --dry-run
`);
}

main();
