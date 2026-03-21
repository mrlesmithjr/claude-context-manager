#!/usr/bin/env node
/**
 * Uninstall Script for claude-context-manager
 *
 * This script:
 * 1. Removes legacy slash commands from ~/.claude/commands/ (if present)
 * 2. Optionally removes data directory ~/.claude-context/
 * 3. Provides instructions for marketplace uninstallation
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const CONTEXT_DIR = join(homedir(), '.claude-context');

// Slash commands to remove
const SLASH_COMMANDS = ['ctx-stats.md', 'ctx-list.md', 'ctx-search.md', 'ctx-vacuum.md', 'ctx-export.md', 'ctx-web.md'];

function log(message) {
  console.log(`[context-manager] ${message}`);
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
 * Remove legacy slash commands from ~/.claude/commands/ (pre-v0.5.0)
 */
function removeLegacySlashCommands() {
  let removed = 0;
  for (const cmd of SLASH_COMMANDS) {
    const cmdPath = join(COMMANDS_DIR, cmd);
    if (existsSync(cmdPath)) {
      rmSync(cmdPath);
      log(`  Removed legacy /${cmd.replace('.md', '')}`);
      removed++;
    }
  }

  if (removed > 0) {
    log(`  Cleaned up ${removed} legacy slash command(s)`);
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
  console.log('  (Claude Code Marketplace Plugin)');
  console.log('========================================\n');

  // Check for --keep-data flag
  const keepData = process.argv.includes('--keep-data');
  // Check for --remove-data flag (no prompt)
  const removeData = process.argv.includes('--remove-data');

  removeLegacySlashCommands();

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
  console.log('  Cleanup complete!');
  console.log('========================================');
  console.log('\nTo uninstall the plugin, run this command in Claude Code:\n');
  console.log('  /plugin uninstall context-manager\n');
  if (!removeData) {
    console.log('Note: Context data preserved in ~/.claude-context/');
  } else {
    console.log('Note: Context data removed from ~/.claude-context/');
  }
  console.log('');
}

// Run uninstaller
uninstall();
