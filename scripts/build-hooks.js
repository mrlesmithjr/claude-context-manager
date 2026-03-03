#!/usr/bin/env node
/**
 * Build Script for Plugin Hooks
 *
 * Builds hook scripts with version injection for runtime version checking.
 *
 * IMPORTANT: better-sqlite3 is a native module that cannot be bundled.
 * We copy the native module and its dependencies into plugin/node_modules/
 * so the plugin is self-contained. The banner uses standard require()
 * resolution (relative to script location) to find the module.
 */

import { build } from 'esbuild';
import { readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
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

// Copy better-sqlite3 and its runtime dependencies into plugin/node_modules/
// so the plugin is self-contained when installed to Claude Code's plugin cache.
const pluginNodeModules = join(PROJECT_ROOT, 'plugin', 'node_modules');
const nativeDeps = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

mkdirSync(pluginNodeModules, { recursive: true });

for (const dep of nativeDeps) {
  const src = join(PROJECT_ROOT, 'node_modules', dep);
  const dest = join(pluginNodeModules, dep);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    console.log(`[build-hooks] Copied ${dep} to plugin/node_modules/`);
  } else {
    console.error(`[build-hooks] WARNING: ${dep} not found in node_modules/`);
  }
}

// Create banner that sets up require() for better-sqlite3 using standard
// Node.js module resolution. Since we copy deps to plugin/node_modules/,
// require('better-sqlite3') resolves from plugin/scripts/ → plugin/node_modules/.
const banner = `
import { createRequire as __createRequire } from 'module';
const __require = __createRequire(import.meta.url);
const __betterSqlite3 = __require('better-sqlite3');
`.trim();

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
