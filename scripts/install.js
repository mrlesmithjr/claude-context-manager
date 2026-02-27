#!/usr/bin/env node
/**
 * Install Script for claude-context-manager
 *
 * This script prepares the plugin for installation via the Claude Code marketplace.
 * It verifies the build and provides instructions for marketplace installation.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const CONTEXT_DIR = join(homedir(), '.claude-context');
const PLUGIN_SCRIPTS_DIR = join(PROJECT_ROOT, 'plugin', 'scripts');
const PLUGIN_JSON_PATH = join(PROJECT_ROOT, 'plugin', '.claude-plugin', 'plugin.json');

function log(message) {
  console.log(`[context-manager] ${message}`);
}

function error(message) {
  console.error(`[context-manager] ERROR: ${message}`);
}

/**
 * Verify plugin/scripts directory exists
 */
function verifyBuild() {
  const requiredFiles = [
    'context-inject.js',
    'capture-prompt.js',
    'capture-tool.js',
    'session-end.js'
  ];

  log('Verifying build...');

  for (const file of requiredFiles) {
    const path = join(PLUGIN_SCRIPTS_DIR, file);
    if (!existsSync(path)) {
      error(`Missing: ${path}`);
      error('Run "npm run build" first.');
      process.exit(1);
    }
  }

  log('  All hook scripts found');
}

/**
 * Create context storage directory
 */
function createContextDir() {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
    log(`Created context directory: ${CONTEXT_DIR}`);
  } else {
    log(`Context directory exists: ${CONTEXT_DIR}`);
  }
}

/**
 * Sync version from package.json to plugin.json
 */
function syncPluginVersion() {
  log('Syncing version to plugin.json...');

  // Read version from package.json
  const packageJson = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')
  );
  const version = packageJson.version;

  // Read plugin.json
  const pluginJson = JSON.parse(
    readFileSync(PLUGIN_JSON_PATH, 'utf-8')
  );

  // Update version
  pluginJson.version = version;

  // Write back
  writeFileSync(PLUGIN_JSON_PATH, JSON.stringify(pluginJson, null, 2) + '\n');

  log(`  Version synced: ${version}`);
}

/**
 * Install slash commands to ~/.claude/commands/
 * Commands are generated dynamically with the correct CLI path
 */
function installSlashCommands() {
  log('Installing slash commands...');

  // Create commands directory if needed
  mkdirSync(COMMANDS_DIR, { recursive: true });

  const CLI_PATH = join(PROJECT_ROOT, 'dist', 'cli.js');

  // Define commands with dynamic CLI path
  const commands = {
    'ctx-list.md': `List recent observations captured by context-manager for the current project.

Run this command and display the results:
\`\`\`bash
node ${CLI_PATH} list --project "$PWD" --limit 20
\`\`\`

Format the output as a readable list showing the observation summaries, tools used, and timestamps.
`,
    'ctx-stats.md': `Show context-manager statistics for the current project.

Run this command and display the results:
\`\`\`bash
node ${CLI_PATH} stats --project "$PWD"
\`\`\`

Summarize the output showing: total observations, sessions, tokens, and date range.
`,
    'ctx-search.md': `Search observations in context-manager.

Usage: /ctx-search <query>

The user will provide a search query as an argument. Run this command with their query:
\`\`\`bash
node ${CLI_PATH} search "<query>" --project "$PWD"
\`\`\`

Display the matching observations with their summaries and timestamps.

If no query is provided, ask the user what they want to search for.
`,
    'ctx-vacuum.md': `Clean up old observations and orphaned sessions from context-manager.

Usage: /ctx-vacuum [days]

If a number of days is provided, delete observations older than that many days.
If no argument is provided, run orphan cleanup and database optimization only.

First show current stats:
\`\`\`bash
node ${CLI_PATH} stats
\`\`\`

Then confirm with the user before running:
\`\`\`bash
node ${CLI_PATH} vacuum --days <N>
\`\`\`

Or without --days to just clean up orphaned sessions and optimize:
\`\`\`bash
node ${CLI_PATH} vacuum
\`\`\`

Report how many observations and orphaned sessions were deleted.
`,
    'ctx-web.md': `Start the context-manager web dashboard.

This command starts the web dashboard server and opens it in your browser.

First check if the server is already running:
\`\`\`bash
curl -s http://localhost:3847/api/health 2>/dev/null | head -c 100
\`\`\`

If the health check returns JSON with "status":"ok", the server is already running.
Just tell the user: "Web dashboard is already running at http://localhost:3847"

If the health check fails (empty response or connection refused), start the server:
\`\`\`bash
cd ${PROJECT_ROOT} && npm run web > /dev/null 2>&1 &
sleep 2
\`\`\`

Then open the browser (macOS):
\`\`\`bash
open http://localhost:3847
\`\`\`

Tell the user:
- Web dashboard started at http://localhost:3847
- The server runs in the background
- To stop it: \`pkill -f "node dist/web/server.js"\` or close the terminal

Features available:
- Sessions: Browse all Claude Code sessions
- Search: Full-text search across observations
- Analytics: Token usage charts and statistics
`
  };

  for (const [filename, content] of Object.entries(commands)) {
    const dest = join(COMMANDS_DIR, filename);
    writeFileSync(dest, content);
    log(`  Installed /${filename.replace('.md', '')}`);
  }
}

/**
 * Main install function
 */
function install() {
  console.log('\n========================================');
  console.log('  claude-context-manager');
  console.log('  Build & Preparation Script');
  console.log('========================================\n');

  verifyBuild();
  createContextDir();
  syncPluginVersion();
  installSlashCommands();

  console.log('\n========================================');
  console.log('  Build preparation complete!');
  console.log('========================================');
  console.log('\nNOTE: This script only builds and prepares the plugin.');
  console.log('To actually install, run these commands in Claude Code:\n');
  console.log(`  /plugin marketplace add ${PROJECT_ROOT}`);
  console.log('  /plugin install context-manager');
  console.log('  (then restart Claude Code)\n');
  console.log('Data will be stored in: ~/.claude-context/');
  console.log('\nSlash commands available after install:');
  console.log('  - /ctx-stats   Show statistics');
  console.log('  - /ctx-list    List recent observations');
  console.log('  - /ctx-search  Search observations');
  console.log('  - /ctx-vacuum  Clean up old data');
  console.log('  - /ctx-web     Start web dashboard');
  console.log(`\nCLI available: node ${join(PROJECT_ROOT, 'dist', 'cli.js')}\n`);
}

// Run installer
install();
