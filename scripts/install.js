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
import { SLASH_COMMANDS } from '../dist/commands/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const CONTEXT_DIR = join(homedir(), '.claude-context');
const PLUGIN_SCRIPTS_DIR = join(PROJECT_ROOT, 'plugin', 'scripts');
const PLUGIN_JSON_PATH = join(PROJECT_ROOT, 'plugin', '.claude-plugin', 'plugin.json');
const MARKETPLACE_JSON_PATH = join(PROJECT_ROOT, '.claude-plugin', 'marketplace.json');

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
    'session-end.js',
    'index.js',           // CLI bundled for plugin
    'web/index.cjs',      // Web server bundled for plugin
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
 * Sync version from package.json to plugin.json and marketplace.json
 */
function syncPluginVersion() {
  log('Syncing version...');

  // Read version from package.json
  const packageJson = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')
  );
  const version = packageJson.version;

  // Sync plugin.json
  const pluginJson = JSON.parse(
    readFileSync(PLUGIN_JSON_PATH, 'utf-8')
  );
  pluginJson.version = version;
  writeFileSync(PLUGIN_JSON_PATH, JSON.stringify(pluginJson, null, 2) + '\n');

  // Sync marketplace.json
  const marketplaceJson = JSON.parse(
    readFileSync(MARKETPLACE_JSON_PATH, 'utf-8')
  );
  if (marketplaceJson.plugins?.[0]) {
    marketplaceJson.plugins[0].version = version;
  }
  writeFileSync(MARKETPLACE_JSON_PATH, JSON.stringify(marketplaceJson, null, 2) + '\n');

  log(`  Version synced to ${version} (plugin.json + marketplace.json)`);
}

/**
 * Install slash commands to ~/.claude/commands/
 *
 * Uses shared definitions from src/commands/definitions.ts.
 * The SessionStart hook also auto-provisions these for users who
 * install via the plugin marketplace without cloning the repo.
 */
function installSlashCommands() {
  log('Installing slash commands...');

  // Create commands directory if needed
  mkdirSync(COMMANDS_DIR, { recursive: true });

  for (const [filename, content] of Object.entries(SLASH_COMMANDS)) {
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
  console.log('  - /ctx-export  Export to auto-memory');
  console.log('  - /ctx-web     Start web dashboard');
  console.log(`\nCLI available: node ${join(PROJECT_ROOT, 'dist', 'cli.js')}\n`);
}

// Run installer
install();
