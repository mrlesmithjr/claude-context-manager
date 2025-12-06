#!/usr/bin/env node
/**
 * Install Script for claude-context-manager
 *
 * This script installs the plugin by adding hooks directly to settings.json.
 * We use direct hooks instead of the marketplace plugin system because
 * SessionStart hooks don't fire reliably through the plugin system.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const COMMANDS_DIR = join(CLAUDE_DIR, 'commands');
const CONTEXT_DIR = join(homedir(), '.claude-context');

// Absolute path to hook scripts
const HOOKS_DIR = join(PROJECT_ROOT, 'dist', 'hooks');

function log(message) {
  console.log(`[context-manager] ${message}`);
}

function error(message) {
  console.error(`[context-manager] ERROR: ${message}`);
}

/**
 * Create hook configuration for settings.json
 */
function createHooksConfig() {
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: `node ${join(HOOKS_DIR, 'context-inject.js')}`,
            timeout: 5000
          }
        ]
      }
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: `node ${join(HOOKS_DIR, 'capture-prompt.js')}`,
            timeout: 1000
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node ${join(HOOKS_DIR, 'capture-tool.js')}`,
            timeout: 1000
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: `node ${join(HOOKS_DIR, 'session-end.js')}`,
            timeout: 5000
          }
        ]
      }
    ]
  };
}

/**
 * Merge context-manager hooks into settings.json
 * Preserves existing hooks and settings
 */
function updateSettings() {
  log('Updating settings.json...');

  // Ensure .claude directory exists
  mkdirSync(CLAUDE_DIR, { recursive: true });

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);
    } catch (err) {
      error(`Failed to parse settings.json: ${err.message}`);
      error('Please fix the JSON syntax and try again.');
      process.exit(1);
    }
  }

  // Initialize hooks object if needed
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const newHooks = createHooksConfig();

  // For each hook type, merge our hooks with existing ones
  for (const [hookType, hookConfig] of Object.entries(newHooks)) {
    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    // Remove context-manager hooks from existing entries (at individual hook level)
    // This preserves non-context-manager hooks like dispatcher
    settings.hooks[hookType] = settings.hooks[hookType].map(entry => {
      if (!entry.hooks) return entry;

      // Filter out only context-manager hooks, keep others
      const filteredHooks = entry.hooks.filter(
        hook => !hook.command?.includes('context-manager')
      );

      // If entry still has hooks, keep it
      if (filteredHooks.length > 0) {
        return { ...entry, hooks: filteredHooks };
      }
      return null;
    }).filter(entry => entry !== null);

    // Add our hooks as a new entry
    settings.hooks[hookType].push(...hookConfig);
    log(`  Added ${hookType} hook`);
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  log('  Settings saved');
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
 * Verify dist/hooks directory exists
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
    const path = join(HOOKS_DIR, file);
    if (!existsSync(path)) {
      error(`Missing: ${path}`);
      error('Run "npm run build" first.');
      process.exit(1);
    }
  }

  log('  All hook scripts found');
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
    'ctx-vacuum.md': `Clean up old observations from context-manager.

Usage: /ctx-vacuum [days]

If a number of days is provided, delete observations older than that many days.
If no argument is provided, default to 30 days.

First show what will be deleted:
\`\`\`bash
node ${CLI_PATH} stats
\`\`\`

Then confirm with the user before running:
\`\`\`bash
node ${CLI_PATH} vacuum --days <N>
\`\`\`

Report how many observations were deleted.
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
  console.log('  claude-context-manager installer');
  console.log('  (Direct Settings.json Hooks)');
  console.log('========================================\n');

  verifyBuild();
  updateSettings();
  createContextDir();
  installSlashCommands();

  console.log('\n========================================');
  console.log('  Installation complete!');
  console.log('========================================');
  console.log('\nHooks added to: ~/.claude/settings.json');
  console.log('Data stored in: ~/.claude-context/');
  console.log('\nRestart Claude Code to activate.\n');
  console.log('Hooks registered:');
  console.log('  - SessionStart: Injects previous context');
  console.log('  - UserPromptSubmit: Captures user prompts');
  console.log('  - PostToolUse: Captures tool interactions');
  console.log('  - Stop: Saves session summary on exit');
  console.log('\nSlash commands (if installed):');
  console.log('  - /ctx-stats   Show statistics');
  console.log('  - /ctx-list    List recent observations');
  console.log('  - /ctx-search  Search observations');
  console.log('  - /ctx-vacuum  Clean up old data');
  console.log(`\nCLI available: node ${join(PROJECT_ROOT, 'dist', 'cli.js')}\n`);
}

// Run installer
install();
