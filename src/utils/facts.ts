/**
 * Fact category definitions for stack preference supersession detection.
 *
 * A "fact" is a statement about a project's current toolchain preference (e.g.
 * "using pnpm", "switched to vitest"). When a new observation states a preference
 * within a known category (package_manager, test_runner, etc.), any older
 * observation in the same category stating a *different* preference is marked
 * superseded so retrieval returns only the authoritative current value.
 *
 * Pure module: no I/O, no side-effects.
 */

export interface FactCategory {
  name: string;
  values: string[];     // the specific tool/version/framework names to detect
  patterns: RegExp[];   // patterns to match in summary text
}

export const FACT_CATEGORIES: FactCategory[] = [
  {
    name: 'package_manager',
    values: ['npm', 'pnpm', 'yarn', 'bun'],
    patterns: [
      /\b(use|using|switched?\s+to|running|with)\s+(npm|pnpm|yarn|bun)\b/i,
      /\b(npm|pnpm|yarn|bun)\s+(install|run|exec|workspace)\b/i,
    ],
  },
  {
    name: 'test_runner',
    values: ['jest', 'vitest', 'mocha', 'pytest', 'jasmine'],
    patterns: [
      /\b(use|using|switched?\s+to|running)\s+(jest|vitest|mocha|pytest|jasmine)\b/i,
      /\b(jest|vitest|mocha|pytest|jasmine)\s+(test|suite|config|run)\b/i,
    ],
  },
  {
    name: 'build_tool',
    values: ['webpack', 'vite', 'esbuild', 'rollup', 'parcel', 'turbopack'],
    patterns: [
      /\b(use|using|switched?\s+to|building with)\s+(webpack|vite|esbuild|rollup|parcel|turbopack)\b/i,
      /\b(webpack|vite|esbuild|rollup|parcel|turbopack)\s+(config|build|bundle)\b/i,
    ],
  },
  {
    name: 'framework',
    values: ['express', 'fastify', 'hono', 'koa', 'nestjs', 'next', 'nuxt'],
    patterns: [
      /\b(use|using|switched?\s+to|built with)\s+(express|fastify|hono|koa|nestjs|next\.?js|nuxt)\b/i,
    ],
  },
];

/**
 * Detect which fact category and value an observation summary represents.
 * Returns { category, value } or null if no match.
 */
export function detectFactType(summary: string | null | undefined): { category: string; value: string } | null {
  if (!summary) return null;
  const lower = summary.toLowerCase();
  for (const cat of FACT_CATEGORIES) {
    for (const pattern of cat.patterns) {
      const match = pattern.exec(lower);
      if (match) {
        // Use the captured group from the regex to identify the matched value.
        // The patterns capture the tool/framework name in a group; find which
        // capture group contains a known category value.
        const capturedValue = match.slice(1).find(g => g && cat.values.includes(g));
        if (capturedValue) {
          return { category: cat.name, value: capturedValue };
        }
      }
    }
  }
  return null;
}
