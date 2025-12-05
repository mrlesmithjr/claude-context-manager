#!/usr/bin/env node
/**
 * Install Script for claude-context-manager
 *
 * This script:
 * 1. Copies plugin files to ~/.claude/plugins/context-manager/
 * 2. Creates symlink to node_modules
 * 3. Adds hooks to ~/.claude/settings.json (idempotently)
 */

import { existsSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const PLUGIN_DIR = join(homedir(), '.claude', 'plugins', 'context-manager');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CONTEXT_DIR = join(homedir(), '.claude-context');

// Hook definitions to add to settings.json
const CONTEXT_MANAGER_HOOKS = {
  SessionStart: {
    matcher: 'startup|clear|compact',
    hooks: [
      {
        type: 'command',
        command: 'node ~/.claude/plugins/context-manager/dist/hooks/context-inject.js',
        timeout: 5000,
      },
    ],
  },
  PostToolUse: {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: 'node ~/.claude/plugins/context-manager/dist/hooks/capture-tool.js',
        timeout: 1000,
      },
    ],
  },
  Stop: {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: 'node ~/.claude/plugins/context-manager/dist/hooks/session-end.js',
        timeout: 5000,
      },
    ],
  },
};

// Marker to identify our hooks in settings.json
const HOOK_MARKER = 'context-manager';

function log(message) {
  console.log(`[context-manager] ${message}`);
}

function error(message) {
  console.error(`[context-manager] ERROR: ${message}`);
}

/**
 * Copy plugin files to ~/.claude/plugins/context-manager/
 */
function copyPluginFiles() {
  log('Copying plugin files...');

  // Create plugin directory
  mkdirSync(PLUGIN_DIR, { recursive: true });

  // Copy dist directory
  const distSrc = join(PROJECT_ROOT, 'dist');
  const distDest = join(PLUGIN_DIR, 'dist');
  if (existsSync(distSrc)) {
    cpSync(distSrc, distDest, { recursive: true });
    log(`  Copied dist/ to ${distDest}`);
  } else {
    error('dist/ directory not found. Run "npm run build" first.');
    process.exit(1);
  }

  // Copy hooks.json
  const hooksJsonSrc = join(PROJECT_ROOT, 'plugin', 'hooks.json');
  const hooksJsonDest = join(PLUGIN_DIR, 'hooks.json');
  if (existsSync(hooksJsonSrc)) {
    cpSync(hooksJsonSrc, hooksJsonDest);
    log(`  Copied hooks.json to ${hooksJsonDest}`);
  }

  // Create symlink to node_modules
  const nodeModulesSrc = join(PROJECT_ROOT, 'node_modules');
  const nodeModulesDest = join(PLUGIN_DIR, 'node_modules');

  // Remove existing symlink if present
  if (existsSync(nodeModulesDest)) {
    unlinkSync(nodeModulesDest);
  }

  if (existsSync(nodeModulesSrc)) {
    symlinkSync(nodeModulesSrc, nodeModulesDest);
    log(`  Created symlink: ${nodeModulesDest} -> ${nodeModulesSrc}`);
  } else {
    error('node_modules/ not found. Run "npm install" first.');
    process.exit(1);
  }
}

/**
 * Check if a hook array contains our context-manager hook
 */
function hasContextManagerHook(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER))
  );
}

/**
 * Add hooks to settings.json (idempotently)
 */
function updateSettings() {
  log('Updating settings.json...');

  // Read existing settings or create default
  let settings = { hooks: {} };
  if (existsSync(SETTINGS_PATH)) {
    try {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);
      if (!settings.hooks) {
        settings.hooks = {};
      }
    } catch (err) {
      error(`Failed to parse settings.json: ${err.message}`);
      error('Please fix the JSON syntax and try again.');
      process.exit(1);
    }
  } else {
    log('  Creating new settings.json');
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  }

  let updated = false;

  // Add each hook type
  for (const [hookType, hookConfig] of Object.entries(CONTEXT_MANAGER_HOOKS)) {
    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    // Check if our hook already exists
    if (!hasContextManagerHook(settings.hooks[hookType])) {
      settings.hooks[hookType].push(hookConfig);
      log(`  Added ${hookType} hook`);
      updated = true;
    } else {
      log(`  ${hookType} hook already exists, skipping`);
    }
  }

  if (updated) {
    // Write settings with nice formatting
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    log('  Settings saved');
  } else {
    log('  No changes needed to settings.json');
  }
}

/**
 * Create context storage directory
 */
function createContextDir() {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
    log(`Created context directory: ${CONTEXT_DIR}`);
  }
}

/**
 * Main install function
 */
function install() {
  console.log('\n========================================');
  console.log('  claude-context-manager installer');
  console.log('========================================\n');

  copyPluginFiles();
  updateSettings();
  createContextDir();

  console.log('\n========================================');
  console.log('  Installation complete!');
  console.log('========================================');
  console.log('\nRestart Claude Code to activate the plugin.\n');
  console.log('Hooks installed:');
  console.log('  - SessionStart: Injects previous context at session start');
  console.log('  - PostToolUse: Captures tool interactions');
  console.log('  - Stop: Saves session summary on exit');
  console.log('\nData stored in: ~/.claude-context/');
  console.log('CLI available: node ~/.claude/plugins/context-manager/dist/cli.js\n');
}

// Run installer
install();
