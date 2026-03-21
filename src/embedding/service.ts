/**
 * Embedding Service
 *
 * Provides local text embedding using Hugging Face Transformers.js (ONNX).
 * Lazy-loads the model on first use. Gracefully degrades if the optional
 * @huggingface/transformers dependency is not installed.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~80MB, cached to ~/.cache/huggingface/)
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export type EmbeddingStatus = 'not-loaded' | 'loading' | 'ready' | 'error' | 'unavailable';

// Pipeline type from @huggingface/transformers
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ tolist(): number[][] }>;

export class EmbeddingService {
  private pipeline: FeatureExtractionPipeline | null = null;
  private status: EmbeddingStatus = 'not-loaded';
  private error: string | null = null;

  /**
   * Get current status of the embedding service
   */
  getStatus(): { status: EmbeddingStatus; error: string | null } {
    return { status: this.status, error: this.error };
  }

  /**
   * Load the embedding model (called automatically on first embed call)
   */
  async load(): Promise<boolean> {
    if (this.status === 'ready') return true;
    if (this.status === 'unavailable') return false;

    this.status = 'loading';
    this.error = null;

    try {
      // Dynamic import — fails gracefully if not installed
      const { pipeline } = await import('@huggingface/transformers');

      this.pipeline = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
      }) as unknown as FeatureExtractionPipeline;

      this.status = 'ready';
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Cannot find module') || message.includes('MODULE_NOT_FOUND')) {
        this.status = 'unavailable';
        this.error = '@huggingface/transformers is not installed. Install it with: npm install @huggingface/transformers';
      } else {
        this.status = 'error';
        this.error = `Failed to load embedding model: ${message}`;
      }
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
