#!/usr/bin/env node
/**
 * Uninstall Script for claude-context-manager
 *
 * This script:
 * 1. Removes hooks from ~/.claude/settings.json
 * 2. Removes plugin directory ~/.claude/plugins/context-manager/
 * 3. Optionally removes data directory ~/.claude-context/
 */

import { existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const PLUGIN_DIR = join(homedir(), '.claude', 'plugins', 'context-manager');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CONTEXT_DIR = join(homedir(), '.claude-context');

// Marker to identify our hooks in settings.json
const HOOK_MARKER = 'context-manager';

function log(message) {
  console.log(`[context-manager] ${message}`);
}

function error(message) {
  console.error(`[context-manager] ERROR: ${message}`);
}

/**
 * Prompt user for confirmation
 */
async function confirm(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Remove context-manager hooks from a hook array
 */
function removeContextManagerHooks(hookArray) {
  if (!Array.isArray(hookArray)) return hookArray;
  return hookArray.filter(
    (entry) => !entry.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER))
  );
}

/**
 * Remove hooks from settings.json
 */
function removeFromSettings() {
  log('Removing hooks from settings.json...');

  if (!existsSync(SETTINGS_PATH)) {
    log('  settings.json not found, skipping');
    return;
  }

  let settings;
  try {
    const content = readFileSync(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(content);
  } catch (err) {
    error(`Failed to parse settings.json: ${err.message}`);
    return;
  }

  if (!settings.hooks) {
    log('  No hooks found in settings.json');
    return;
  }

  let updated = false;
  const hookTypes = ['SessionStart', 'PostToolUse', 'Stop'];

  for (const hookType of hookTypes) {
    if (settings.hooks[hookType]) {
      const before = settings.hooks[hookType].length;
      settings.hooks[hookType] = removeContextManagerHooks(settings.hooks[hookType]);
      const after = settings.hooks[hookType].length;

      if (before !== after) {
        log(`  Removed ${hookType} hook`);
        updated = true;
      }

      // Remove empty arrays
      if (settings.hooks[hookType].length === 0) {
        delete settings.hooks[hookType];
      }
    }
  }

  if (updated) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    log('  Settings saved');
  } else {
    log('  No context-manager hooks found');
  }
}

/**
 * Remove plugin directory
 */
function removePluginDir() {
  log('Removing plugin directory...');

  if (existsSync(PLUGIN_DIR)) {
    rmSync(PLUGIN_DIR, { recursive: true, force: true });
    log(`  Removed ${PLUGIN_DIR}`);
  } else {
    log('  Plugin directory not found, skipping');
  }
}

/**
 * Remove data directory (with confirmation)
 */
async function removeDataDir() {
  if (!existsSync(CONTEXT_DIR)) {
    log('Data directory not found, skipping');
    return;
  }

  console.log('');
  const shouldRemove = await confirm(
    `Remove data directory ${CONTEXT_DIR}? This will delete all stored context. (y/N): `
  );

  if (shouldRemove) {
    rmSync(CONTEXT_DIR, { recursive: true, force: true });
    log(`Removed ${CONTEXT_DIR}`);
  } else {
    log('Keeping data directory');
  }
}

/**
 * Main uninstall function
 */
async function uninstall() {
  console.log('\n========================================');
  console.log('  claude-context-manager uninstaller');
  console.log('========================================\n');

  // Check for --keep-data flag
  const keepData = process.argv.includes('--keep-data');
  // Check for --remove-data flag (no prompt)
  const removeData = process.argv.includes('--remove-data');

  removeFromSettings();
  removePluginDir();

  if (removeData) {
    if (existsSync(CONTEXT_DIR)) {
      rmSync(CONTEXT_DIR, { recursive: true, force: true });
      log(`Removed ${CONTEXT_DIR}`);
    }
  } else if (!keepData) {
    await removeDataDir();
  } else {
    log('Keeping data directory (--keep-data flag)');
  }

  console.log('\n========================================');
  console.log('  Uninstallation complete!');
  console.log('========================================');
  console.log('\nRestart Claude Code to apply changes.\n');
}

// Run uninstaller
uninstall();
