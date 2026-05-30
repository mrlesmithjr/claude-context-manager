#!/usr/bin/env node
/**
 * Build Script for Plugin Hooks
 *
 * Builds hook scripts with version injection for runtime version checking.
 *
 * IMPORTANT: better-sqlite3 is a native module that cannot be bundled.
 * plugin/node_modules/ is gitignored and NOT committed to the repository.
 * Marketplace installs require server mode (CONTEXT_MANAGER_URL in .env).
 * For local SQLite mode: clone the repo, run npm install, then install
 * with /plugin marketplace add /local/path. npm install populates
 * plugin/node_modules/ via the build:plugin script.
 *
 * The banner wraps the require() calls in a try/catch and sets
 * __nativeModulesAvailable to false when they are missing. Each hook
 * checks this sentinel before entering the local SQLite path and outputs
 * a helpful error message instead of crashing.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs';
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

// Sync version into plugin/.claude-plugin/plugin.json
const pluginJsonPath = join(PROJECT_ROOT, 'plugin', '.claude-plugin', 'plugin.json');
const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
if (pluginJson.version !== VERSION) {
  pluginJson.version = VERSION;
  writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
  console.log(`[build-hooks] Updated plugin.json version to ${VERSION}`);
}

// Copy better-sqlite3 and its runtime dependencies into plugin/node_modules/
// so the plugin is self-contained when installed to Claude Code's plugin cache.
// These vendored deps are committed to git so GitHub-based installs work.
const pluginNodeModules = join(PROJECT_ROOT, 'plugin', 'node_modules');
const nativeDeps = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'sqlite-vec'];

// Also vendor platform-specific sqlite-vec binary package if present
const sqliteVecPlatformPkg = `sqlite-vec-${process.platform}-${process.arch}`;
if (existsSync(join(PROJECT_ROOT, 'node_modules', sqliteVecPlatformPkg))) {
  nativeDeps.push(sqliteVecPlatformPkg);
}

// Clean and recreate to avoid stale files
if (existsSync(pluginNodeModules)) {
  rmSync(pluginNodeModules, { recursive: true });
}
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

// Remove build-time artifacts from better-sqlite3 that aren't needed at runtime
// (deps/ = SQLite source ~9.5MB, src/ = C++ source ~176KB)
const pruneFromSqlite = ['deps', 'src', 'binding.gyp'];
for (const item of pruneFromSqlite) {
  const target = join(pluginNodeModules, 'better-sqlite3', item);
  if (existsSync(target)) {
    rmSync(target, { recursive: true });
  }
}
// Also prune prebuild-install (only needed during npm install, not runtime)
const prebuildInstall = join(pluginNodeModules, 'better-sqlite3', 'node_modules');
if (existsSync(prebuildInstall)) {
  rmSync(prebuildInstall, { recursive: true });
}
console.log(`[build-hooks] Pruned build-time artifacts from better-sqlite3`);

// Create banner that sets up require() for better-sqlite3 using standard
// Node.js module resolution. When plugin/node_modules/ is present (local build),
// require('better-sqlite3') resolves from plugin/scripts/ -> plugin/node_modules/.
// When plugin/node_modules/ is absent (marketplace install without a local build),
// the try/catch sets __nativeModulesAvailable to false and each hook outputs
// a helpful error message instead of crashing.
// Uses __ctxRequire to avoid conflicting with esbuild's own __require polyfill.
const banner = `
import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
let __betterSqlite3, __sqliteVec, __nativeModulesAvailable;
try {
  __betterSqlite3 = __ctxRequire('better-sqlite3');
  __sqliteVec = __ctxRequire('sqlite-vec');
  __nativeModulesAvailable = true;
} catch (_nativeErr) {
  __nativeModulesAvailable = false;
}
`.trim();

// esbuild plugin to shim native modules with the banner-provided variables
const nativeModuleShim = {
  name: 'native-module-shim',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, args => {
      return { path: 'better-sqlite3', namespace: 'shim' };
    });
    build.onResolve({ filter: /^sqlite-vec$/ }, args => {
      return { path: 'sqlite-vec', namespace: 'shim' };
    });
    build.onLoad({ filter: /^better-sqlite3$/, namespace: 'shim' }, args => {
      return {
        contents: 'export default __betterSqlite3;',
        loader: 'js'
      };
    });
    build.onLoad({ filter: /^sqlite-vec$/, namespace: 'shim' }, args => {
      return {
        // Optional chaining is required: __sqliteVec is undefined when native modules
        // are absent (marketplace install without plugin/node_modules/). Accessing
        // .load on undefined throws at module init, before any hook code can run.
        contents: 'export const load = __sqliteVec?.load; export default __sqliteVec;',
        loader: 'js'
      };
    });
  }
};

// Shared build options for all plugin scripts
const sharedOptions = {
  bundle: true,
  outdir: 'plugin/scripts',
  platform: 'node',
  target: 'node18',
  format: 'esm',
  banner: { js: banner },
  external: ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node'],
  define: { 'PLUGIN_VERSION': JSON.stringify(VERSION) },
  plugins: [nativeModuleShim]
};

// Build hooks
await build({
  ...sharedOptions,
  entryPoints: [
    'plugin/hooks/context-inject.ts',
    'plugin/hooks/capture-prompt.ts',
    'plugin/hooks/capture-tool.ts',
    'plugin/hooks/session-end.ts',
    'plugin/hooks/file-context.ts',
    'plugin/hooks/skill-context.ts'
  ],
});
console.log('[build-hooks] Hooks built');

// Build CLI into plugin/scripts/ so it ships with the plugin
await build({
  ...sharedOptions,
  entryPoints: ['cli/index.ts'],
  outdir: 'plugin/scripts',
});
console.log('[build-hooks] CLI built (plugin/scripts/index.js)');

// Build MCP server into plugin/scripts/mcp/ so it ships with the plugin
await build({
  ...sharedOptions,
  entryPoints: ['src/mcp/server.ts'],
  outdir: 'plugin/scripts/mcp',
});
console.log('[build-hooks] MCP server built (plugin/scripts/mcp/server.js)');

// Build web server into plugin/scripts/web/ so it ships with the plugin
// Uses CJS format because Fastify's internals use dynamic require() for Node builtins.
// Output as .cjs so Node treats it correctly even with "type": "module" in package.json.
//
// NOTE: The banner here uses bare require() for native modules (no try/catch), unlike the
// hook banners above. This is intentional. Server processes (web dashboard, HTTP MCP) are
// launched explicitly by the user via `make server-quickstart` or `make server-start`, which
// ensures native modules are installed before the server ever starts. A hard crash on missing
// natives is the correct behavior here: it surfaces the misconfiguration immediately rather
// than silently degrading. Hooks, by contrast, fire on every tool use and must never block
// Claude Code, so they use __nativeModulesAvailable to fail gracefully with instructions.
await build({
  entryPoints: ['web/server/index.ts'],
  bundle: true,
  outfile: 'plugin/scripts/web/index.cjs',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node'],
  define: { 'PLUGIN_VERSION': JSON.stringify(VERSION) },
  banner: {
    js: `const __betterSqlite3 = require('better-sqlite3');\nconst __sqliteVec = require('sqlite-vec');`
  },
  plugins: [nativeModuleShim]
});
console.log('[build-hooks] Web server built (plugin/scripts/web/index.cjs)');

// Build HTTP MCP server into plugin/scripts/mcp-http/ so it ships with the plugin
// Uses CJS format consistent with the web server above.
// Same intentional bare-require banner as the web server — see note above.
await build({
  entryPoints: ['src/server/http.ts'],
  bundle: true,
  outfile: 'plugin/scripts/mcp-http/index.cjs',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node'],
  define: { 'PLUGIN_VERSION': JSON.stringify(VERSION) },
  banner: {
    js: `const __betterSqlite3 = require('better-sqlite3');\nconst __sqliteVec = require('sqlite-vec');`
  },
  plugins: [nativeModuleShim]
});
console.log('[build-hooks] HTTP MCP server built (plugin/scripts/mcp-http/index.cjs)');

// Copy web client files into plugin so the web server can find them
const webClientSrc = join(PROJECT_ROOT, 'web', 'client');
const webClientDest = join(PROJECT_ROOT, 'plugin', 'scripts', 'web', 'client');
if (existsSync(webClientSrc)) {
  if (existsSync(webClientDest)) {
    rmSync(webClientDest, { recursive: true });
  }
  cpSync(webClientSrc, webClientDest, { recursive: true });
  console.log('[build-hooks] Web client files copied');
}

console.log('[build-hooks] Build complete');
