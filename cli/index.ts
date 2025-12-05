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
    storage.close();
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

  console.log(`Total Observations: ${stats.total_observations}`);
  console.log(`Total Sessions: ${stats.total_sessions}`);
  console.log(`Total Tokens: ${stats.total_tokens}`);
  console.log(
    `Oldest Observation: ${stats.oldest_observation || 'N/A'}`
  );
  console.log(
    `Newest Observation: ${stats.newest_observation || 'N/A'}`
  );
}

async function vacuumCommand(args: string[]) {
  const daysIndex = args.indexOf('--days');
  const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1], 10) : undefined;

  if (days) {
    console.log(`Deleting observations older than ${days} days...`);
    const deleted = await storage.vacuum(days);
    console.log(`Deleted ${deleted} observations.`);
  } else {
    console.log('Running VACUUM to reclaim disk space...');
    await storage.vacuum();
    console.log('Done.');
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

  help
    Show this help message

Examples:
  context-manager list --limit 10
  context-manager search "authentication" --project ~/Projects/my-app
  context-manager stats --project ~/Projects/my-app
  context-manager vacuum --days 30
`);
}

main();
