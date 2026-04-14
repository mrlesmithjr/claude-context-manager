import { createHash } from 'crypto';

/**
 * SHA256 hash of a string. Used for exact-match deduplication of observations.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Convert sqlite-vec L2 distance to cosine similarity.
 *
 * Only valid when embeddings are unit-normalized, which they are — the
 * embedding service uses normalize: true for all-MiniLM-L6-v2, so every
 * stored vector has unit norm.
 *
 * Formula: cos_sim = 1 - (L2_dist^2 / 2)
 *
 * Clamps to [0, 1] to guard against floating-point rounding.
 */
export function l2DistanceToCosine(l2Distance: number): number {
  return Math.max(0, Math.min(1, 1 - (l2Distance * l2Distance) / 2));
}
