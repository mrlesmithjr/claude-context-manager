#!/usr/bin/env node
/**
 * Build Script for Plugin Hooks
 *
 * Builds hook scripts with version injection for runtime version checking.
 */

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')
);
const VERSION = packageJson.version;

console.log(`[build-hooks] Building hooks with version: ${VERSION}`);

// Build hooks with version injection
await build({
  entryPoints: [
    'plugin/hooks/context-inject.ts',
    'plugin/hooks/capture-prompt.ts',
    'plugin/hooks/capture-tool.ts',
    'plugin/hooks/session-end.ts'
  ],
  bundle: true,
  outdir: 'plugin/scripts',
  platform: 'node',
  target: 'node18',
  format: 'esm',
  external: ['better-sqlite3'],
  define: {
    'PLUGIN_VERSION': JSON.stringify(VERSION)
  }
});

console.log('[build-hooks] Build complete');
