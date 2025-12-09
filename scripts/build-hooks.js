#!/usr/bin/env node
/**
 * Build Script for Plugin Hooks
 *
 * Builds hook scripts with version injection for runtime version checking.
 *
 * IMPORTANT: better-sqlite3 is a native module that cannot be bundled.
 * We use a banner to create a shim that imports from an absolute path,
 * ensuring hooks work when installed to Claude Code's plugin cache directory.
 */

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')
);
const VERSION = packageJson.version;

// Absolute path to better-sqlite3 in this project's node_modules
// This ensures hooks work when installed to Claude Code's plugin cache
const betterSqlite3Path = join(PROJECT_ROOT, 'node_modules', 'better-sqlite3');

console.log(`[build-hooks] Building hooks with version: ${VERSION}`);
console.log(`[build-hooks] Using better-sqlite3 from: ${betterSqlite3Path}`);

// Create banner that sets up absolute import for better-sqlite3
// ESM doesn't support require(), so we use createRequire to load native modules
const banner = `
import { createRequire as __createRequire } from 'module';
const __require = __createRequire(import.meta.url);
const __betterSqlite3 = __require('${betterSqlite3Path}');
`.trim();

// Build hooks with version injection and absolute path for native module
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
  banner: {
    js: banner
  },
  // Mark as external - our banner provides the import
  external: ['better-sqlite3'],
  define: {
    'PLUGIN_VERSION': JSON.stringify(VERSION)
  },
  plugins: [{
    name: 'better-sqlite3-shim',
    setup(build) {
      // Intercept better-sqlite3 imports and replace with our shim variable
      build.onResolve({ filter: /^better-sqlite3$/ }, args => {
        return { path: 'better-sqlite3', namespace: 'shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'shim' }, args => {
        return {
          contents: 'export default __betterSqlite3;',
          loader: 'js'
        };
      });
    }
  }]
});

console.log('[build-hooks] Build complete');
