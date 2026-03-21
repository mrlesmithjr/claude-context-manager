/**
 * Embedding Service
 *
 * Provides local text embedding using Hugging Face Transformers.js (ONNX).
 * Lazy-loads the model on first use. Auto-installs the optional dependency
 * if not present (first run may take a few minutes).
 *
 * IMPORTANT: Auto-installed packages go into a separate _embeddings/
 * subdirectory to avoid conflicts with vendored native deps (better-sqlite3,
 * sqlite-vec) in the plugin's node_modules/.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~80MB, cached to ~/.cache/huggingface/)
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export type EmbeddingStatus = 'not-loaded' | 'loading' | 'ready' | 'error' | 'unavailable';

// Pipeline type from @huggingface/transformers
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ tolist(): number[][] }>;

/**
 * Resolve the install directory for embedding dependencies.
 * Uses a separate _embeddings/ subdirectory inside the plugin root
 * to avoid conflicts with vendored native deps in node_modules/.
 *
 * The bundled MCP server runs from plugin/scripts/mcp/server.js,
 * so the plugin root is 3 levels up.
 */
function resolveEmbeddingsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const pluginRoot = dirname(dirname(dirname(thisFile)));
  return join(pluginRoot, '_embeddings');
}

export class EmbeddingService {
  private pipeline: FeatureExtractionPipeline | null = null;
  private status: EmbeddingStatus = 'not-loaded';
  private error: string | null = null;
  private didAutoInstall: boolean = false;

  /**
   * Get current status of the embedding service
   */
  getStatus(): { status: EmbeddingStatus; error: string | null; didAutoInstall: boolean } {
    return { status: this.status, error: this.error, didAutoInstall: this.didAutoInstall };
  }

  /**
   * Auto-install @huggingface/transformers into a separate _embeddings/
   * directory. This keeps the vendored native deps (better-sqlite3,
   * sqlite-vec) in node_modules/ untouched.
   */
  private autoInstall(): boolean {
    const embeddingsDir = resolveEmbeddingsDir();
    const nodeModulesDir = join(embeddingsDir, 'node_modules');

    // If already installed, skip
    if (existsSync(join(nodeModulesDir, '@huggingface', 'transformers'))) {
      return true;
    }

    // Create the embeddings directory and package.json
    mkdirSync(embeddingsDir, { recursive: true });
    const pkgJsonPath = join(embeddingsDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {},
      }, null, 2));
    }

    console.error('[context-manager] Auto-installing @huggingface/transformers + onnxruntime-node...');
    console.error('[context-manager] This is a one-time setup (~265MB download, may take a few minutes)');

    try {
      execSync(
        'npm install @huggingface/transformers onnxruntime-node --no-audit --no-fund --no-package-lock',
        {
          cwd: embeddingsDir,
          stdio: 'pipe',
          timeout: 300000, // 5 minute timeout
          env: { ...process.env, npm_config_loglevel: 'error' },
        }
      );
      console.error('[context-manager] Dependencies installed successfully');
      this.didAutoInstall = true;
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[context-manager] Auto-install failed: ${message}`);
      return false;
    }
  }

  /**
   * Import @huggingface/transformers, auto-installing if needed.
   * Uses createRequire pointed at the _embeddings/ directory since
   * that's where the package is installed (separate from vendored deps).
   */
  private async importTransformers(): Promise<{ pipeline: Function } | null> {
    const embeddingsDir = resolveEmbeddingsDir();
    const embeddingsNodeModules = join(embeddingsDir, 'node_modules');

    // Try loading from _embeddings/ directory first (already installed)
    if (existsSync(join(embeddingsNodeModules, '@huggingface', 'transformers'))) {
      try {
        const require = createRequire(join(embeddingsDir, 'index.js'));
        return require('@huggingface/transformers');
      } catch {
        // Fall through to try other methods
      }
    }

    // Try dynamic import (works if installed in project node_modules during dev)
    try {
      return await import('@huggingface/transformers');
    } catch {
      // Not installed — try auto-install
    }

    const installed = this.autoInstall();
    if (!installed) return null;

    // After auto-install, use createRequire pointed at _embeddings/
    try {
      const require = createRequire(join(embeddingsDir, 'index.js'));
      return require('@huggingface/transformers');
    } catch {
      return null;
    }
  }

  /**
   * Load the embedding model (called automatically on first embed call).
   * On first run: auto-installs dependencies, downloads model (~80MB).
   */
  async load(): Promise<boolean> {
    if (this.status === 'ready') return true;
    if (this.status === 'unavailable') return false;

    this.status = 'loading';
    this.error = null;

    try {
      const transformers = await this.importTransformers();

      if (!transformers) {
        this.status = 'unavailable';
        this.error = 'Failed to install @huggingface/transformers automatically. Check npm and network access.';
        return false;
      }

      this.pipeline = await (transformers.pipeline as Function)('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
      }) as unknown as FeatureExtractionPipeline;

      this.status = 'ready';
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.error = `Failed to load embedding model: ${message}`;
      return false;
    }
  }

  /**
   * Embed a single text string
   * @returns Float32Array of 384 dimensions, or null if service unavailable
   */
  async embed(text: string): Promise<Float32Array | null> {
    const results = await this.embedBatch([text]);
    return results ? results[0] ?? null : null;
  }

  /**
   * Embed a batch of text strings
   * @returns Array of Float32Array (384-dim each), or null if service unavailable
   */
  async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];

    if (this.status !== 'ready') {
      const loaded = await this.load();
      if (!loaded || !this.pipeline) return null;
    }

    const output = await this.pipeline!(texts, {
      pooling: 'mean',
      normalize: true,
    });

    const nested = output.tolist();
    return nested.map((arr: number[]) => new Float32Array(arr));
  }
}

// Singleton instance for the MCP server process
let instance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!instance) {
    instance = new EmbeddingService();
  }
  return instance;
}
