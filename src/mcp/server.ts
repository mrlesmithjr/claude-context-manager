/**
 * MCP Server for claude-context-manager
 *
 * Exposes context-manager query capabilities as MCP tools.
 * Reads from the same SQLite database that the plugin hooks write to.
 *
 * Runs as a stdio MCP server, registered via the plugin's .mcp.json.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SQLiteStorage } from '../storage/sqlite.js';
import {
  exportToAutoMemory,
  resolveMemoryDir,
  formatObservationsForMemory,
} from '../export/memory.js';
import { getEmbeddingService } from '../embedding/service.js';
import type { Observation, Stats } from '../storage/interface.js';

// Version injected by esbuild
declare const PLUGIN_VERSION: string;

const server = new McpServer({
  name: 'context-manager',
  version: typeof PLUGIN_VERSION !== 'undefined' ? PLUGIN_VERSION : '0.5.0',
});

let storage: SQLiteStorage | null = null;

async function getStorage(): Promise<SQLiteStorage> {
  if (!storage) {
    storage = new SQLiteStorage();
    await storage.initialize();
  }
  return storage;
}

/**
 * Format observations for tool output
 */
function formatObservations(observations: Observation[]): string {
  if (observations.length === 0) {
    return 'No observations found.';
  }

  const lines: string[] = [];
  for (const obs of observations) {
    const date = new Date(obs.created_at);
    const fileInfo =
      obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';
    lines.push(
      `[${date.toISOString()}] ${obs.tool_name}: ${obs.summary}${fileInfo}`
    );
  }
  return lines.join('\n');
}

/**
 * Format stats for tool output
 */
interface VectorStats {
  vector_search_enabled: boolean;
  embedded_count: number;
  unembedded_count: number;
  embedding_status: string;
}

function formatStats(stats: Stats, project?: string, vectorStats?: VectorStats): string {
  const lines: string[] = [];

  lines.push('Context Manager Statistics');
  lines.push('');
  lines.push(project ? `Project: ${project}` : 'All Projects');
  lines.push('');

  lines.push('=== Storage ===');
  lines.push(`Total Observations: ${stats.total_observations}`);
  lines.push(`Total Sessions: ${stats.total_sessions}`);
  lines.push(
    `Date Range: ${stats.oldest_observation || 'N/A'} to ${stats.newest_observation || 'N/A'}`
  );

  lines.push('');
  lines.push('=== Token Economics ===');
  lines.push(`Total Tokens Stored: ${stats.total_tokens.toLocaleString()}`);
  lines.push(`Avg per Observation: ${stats.avg_tokens_per_observation} tokens`);
  lines.push(
    `Avg per Session: ${stats.avg_tokens_per_session.toLocaleString()} tokens`
  );

  if (Object.keys(stats.tokens_by_tool).length > 0) {
    lines.push('');
    lines.push('=== Tokens by Tool ===');
    const tools = Object.entries(stats.tokens_by_tool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [tool, tokens] of tools) {
      const pct = Math.round((tokens / stats.total_tokens) * 100);
      lines.push(`  ${tool}: ${tokens.toLocaleString()} (${pct}%)`);
    }
  }

  const imp = stats.importance_counts;
  const impTotal = imp.high + imp.medium + imp.low;
  if (impTotal > 0) {
    lines.push('');
    lines.push('=== Importance Distribution ===');
    lines.push(
      `  High:   ${imp.high.toLocaleString()} (${Math.round((imp.high / impTotal) * 100)}%)`
    );
    lines.push(
      `  Medium: ${imp.medium.toLocaleString()} (${Math.round((imp.medium / impTotal) * 100)}%)`
    );
    lines.push(
      `  Low:    ${imp.low.toLocaleString()} (${Math.round((imp.low / impTotal) * 100)}%)`
    );
  }

  if (stats.compacted_count > 0) {
    lines.push('');
    lines.push('=== Compaction ===');
    lines.push(
      `  Compacted: ${stats.compacted_count} observations (from ${stats.compacted_original_count} originals)`
    );
  }

  if (vectorStats) {
    lines.push('');
    lines.push('=== Vector Search ===');
    lines.push(`  Enabled: ${vectorStats.vector_search_enabled ? 'yes' : 'no'}`);
    if (vectorStats.vector_search_enabled) {
      const total = vectorStats.embedded_count + vectorStats.unembedded_count;
      const pct = total > 0 ? Math.round((vectorStats.embedded_count / total) * 100) : 0;
      lines.push(`  Embedded: ${vectorStats.embedded_count.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
      lines.push(`  Pending: ${vectorStats.unembedded_count.toLocaleString()}`);
      lines.push(`  Model Status: ${vectorStats.embedding_status}`);
    }
  }

  return lines.join('\n');
}

// --- Tool Definitions ---

server.tool(
  'context_search',
  'Search past Claude Code session activity using full-text search. Use when the user references past work, asks "where did I...", "when did I...", or needs to find previous changes.',
  {
    query: z.string().describe('Search query (keywords, file names, tool names, etc.)'),
    project: z
      .string()
      .optional()
      .describe(
        'Project path to scope search. Omit to search all projects.'
      ),
  },
  async ({ query, project }) => {
    const db = await getStorage();
    const observations = await db.search(query, project);
    return {
      content: [
        {
          type: 'text' as const,
          text: observations.length > 0
            ? `Found ${observations.length} observations matching "${query}":\n\n${formatObservations(observations)}`
            : `No observations found matching "${query}".`,
        },
      ],
    };
  }
);

server.tool(
  'context_list',
  'List recent Claude Code session activity for a project. Use to understand what was done recently or get context on recent changes.',
  {
    project: z
      .string()
      .describe('Project path to list observations for'),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('Maximum number of observations to return (default: 20)'),
  },
  async ({ project, limit }) => {
    const db = await getStorage();
    const observations = await db.getRecent(project, limit);
    return {
      content: [
        {
          type: 'text' as const,
          text: observations.length > 0
            ? `Recent observations for ${project}:\n\n${formatObservations(observations)}`
            : `No observations found for ${project}.`,
        },
      ],
    };
  }
);

server.tool(
  'context_stats',
  'Show context-manager statistics including observation counts, token usage, and importance distribution.',
  {
    project: z
      .string()
      .optional()
      .describe(
        'Project path to get stats for. Omit for all projects.'
      ),
  },
  async ({ project }) => {
    const db = await getStorage();
    const stats = await db.getStats(project);

    // Gather vector search stats
    const vecEnabled = db.isVectorSearchEnabled();
    const embeddingService = getEmbeddingService();
    const vectorStats: VectorStats = {
      vector_search_enabled: vecEnabled,
      embedded_count: 0,
      unembedded_count: 0,
      embedding_status: vecEnabled ? embeddingService.getStatus().status : 'n/a',
    };
    if (vecEnabled) {
      vectorStats.unembedded_count = db.countUnembedded(project);
      vectorStats.embedded_count = stats.total_observations - vectorStats.unembedded_count;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: formatStats(stats, project, vectorStats),
        },
      ],
    };
  }
);

server.tool(
  'context_export',
  'Export high-importance observations to auto-memory topic file. Use at end of significant work sessions or when asked to save context.',
  {
    project: z.string().describe('Project path to export observations for'),
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe('Preview what would be exported without writing files'),
  },
  async ({ project, dry_run }) => {
    const db = await getStorage();
    const observations = await db.getUnexportedHighImportance(project);

    if (observations.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No unexported high-importance observations found.',
          },
        ],
      };
    }

    if (dry_run) {
      const formatted = formatObservationsForMemory(observations);
      const targetDir = resolveMemoryDir(project);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Would export ${observations.length} observations to ${targetDir}/context-manager-activity.md:\n\n${formatted}`,
          },
        ],
      };
    }

    const result = await exportToAutoMemory(db, project);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Exported ${result.exported} observations to auto-memory.${result.filePath ? `\nTopic file: ${result.filePath}` : ''}`,
        },
      ],
    };
  }
);

server.tool(
  'context_vacuum',
  'Clean up old observations and optimize the context-manager database. Use for maintenance.',
  {
    days: z
      .number()
      .optional()
      .describe(
        'Delete observations older than this many days. Omit to only clean orphaned sessions and optimize.'
      ),
  },
  async ({ days }) => {
    const db = await getStorage();
    const result = await db.vacuum(days);

    const lines: string[] = [];
    if (days) {
      lines.push(`Deleted ${result.observations} observations older than ${days} days.`);
    }
    if (result.compacted > 0) {
      lines.push(
        `Compacted ${result.compacted_originals} observations into ${result.compacted} summaries.`
      );
    }
    if (result.sessions > 0) {
      lines.push(`Cleaned up ${result.sessions} orphaned sessions.`);
    }
    lines.push('Database optimized.');

    return {
      content: [
        {
          type: 'text' as const,
          text: lines.join('\n'),
        },
      ],
    };
  }
);

server.tool(
  'context_semantic_search',
  'Search past Claude Code session activity using semantic similarity. Finds conceptually related observations even when exact keywords differ. Requires embeddings to be generated first via context_embed.',
  {
    query: z.string().describe('Natural language query describing what you are looking for'),
    project: z
      .string()
      .optional()
      .describe('Project path to scope search. Omit to search all projects.'),
    top_k: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
  },
  async ({ query, project, top_k }) => {
    const db = await getStorage();

    if (!db.isVectorSearchEnabled()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Vector search is not available (sqlite-vec extension not loaded). FTS5 keyword search via context_search is still available.',
          },
        ],
      };
    }

    const embeddingService = getEmbeddingService();
    const queryEmbedding = await embeddingService.embed(query);

    if (!queryEmbedding) {
      const { status, error } = embeddingService.getStatus();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Embedding model not available (status: ${status}).${error ? ` ${error}` : ''}\n\nFTS5 keyword search via context_search is still available.`,
          },
        ],
      };
    }

    const observations = await db.vectorSearch(queryEmbedding, project, top_k);
    return {
      content: [
        {
          type: 'text' as const,
          text: observations.length > 0
            ? `Found ${observations.length} semantically similar observations for "${query}":\n\n${formatObservations(observations)}`
            : `No embedded observations found${project ? ` for ${project}` : ''}. Run context_embed first to generate embeddings.`,
        },
      ],
    };
  }
);

server.tool(
  'context_embed',
  'Generate vector embeddings for observations that are missing them. Embeddings enable semantic search via context_semantic_search. First run auto-installs dependencies (~265MB) and downloads the model (~80MB) — this may take a few minutes.',
  {
    project: z
      .string()
      .optional()
      .describe('Project path to scope embedding. Omit to embed all projects.'),
    batch_size: z
      .number()
      .optional()
      .default(50)
      .describe('Number of observations to embed per batch (default: 50)'),
    limit: z
      .number()
      .optional()
      .default(500)
      .describe('Maximum total observations to embed in this call (default: 500)'),
  },
  async ({ project, batch_size, limit }) => {
    const db = await getStorage();

    if (!db.isVectorSearchEnabled()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Vector search is not available (sqlite-vec extension not loaded). Cannot generate embeddings.',
          },
        ],
      };
    }

    const embeddingService = getEmbeddingService();
    const loaded = await embeddingService.load();

    if (!loaded) {
      const { error } = embeddingService.getStatus();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to load embedding model.${error ? ` ${error}` : ''}`,
          },
        ],
      };
    }

    const unembedded = await db.getUnembeddedObservations(limit, project);

    if (unembedded.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `All observations${project ? ` for ${project}` : ''} already have embeddings.`,
          },
        ],
      };
    }

    let embedded = 0;
    let errors = 0;

    // Process in batches
    for (let i = 0; i < unembedded.length; i += batch_size) {
      const batch = unembedded.slice(i, i + batch_size);

      // Build text for embedding: summary + files
      const texts = batch.map(obs => {
        const parts = [obs.summary];
        if (obs.files_touched.length > 0) {
          parts.push(obs.files_touched.join(', '));
        }
        return parts.join(' | ');
      });

      const embeddings = await embeddingService.embedBatch(texts);
      if (!embeddings) {
        errors += batch.length;
        continue;
      }

      for (let j = 0; j < batch.length; j++) {
        const obs = batch[j];
        const emb = embeddings[j];
        if (!obs?.id || !emb) { errors++; continue; }
        try {
          await db.saveEmbedding(obs.id, emb);
          embedded++;
        } catch {
          errors++;
        }
      }
    }

    const lines: string[] = [];
    const { didAutoInstall } = embeddingService.getStatus();
    if (didAutoInstall) {
      lines.push('Auto-installed @huggingface/transformers + onnxruntime-node.');
    }
    lines.push(`Embedded ${embedded} observations.`);
    if (errors > 0) {
      lines.push(`${errors} observations failed to embed.`);
    }
    const remaining = unembedded.length - embedded;
    if (remaining > 0 && unembedded.length === limit) {
      lines.push(`More observations may remain — run again to continue.`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: lines.join('\n'),
        },
      ],
    };
  }
);

// --- Background Embedding ---

/**
 * Embed observations in the background after MCP server starts.
 * Runs in batches with a delay between each to avoid hogging resources.
 * Silently skips if dependencies aren't installed yet (first context_embed
 * call will trigger auto-install and future startups will embed automatically).
 */
async function backgroundEmbed(): Promise<void> {
  // Short delay to let the server finish startup
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    const db = await getStorage();
    if (!db.isVectorSearchEnabled()) return;

    // Check if there's anything to embed
    const pending = db.countUnembedded();
    if (pending === 0) return;

    const embeddingService = getEmbeddingService();

    // Only proceed if transformers is already installed.
    // Don't auto-install in background — that's a first-run experience
    // that should happen via explicit context_embed call.
    const { status } = embeddingService.getStatus();
    if (status === 'unavailable') return;

    const loaded = await embeddingService.load();
    if (!loaded) return;

    console.error(`[context-manager-mcp] Background embedding: ${pending} observations pending`);

    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 500; // pause between batches to stay gentle
    let totalEmbedded = 0;

    while (true) {
      const batch = await db.getUnembeddedObservations(BATCH_SIZE);
      if (batch.length === 0) break;

      const texts = batch.map(obs => {
        const parts = [obs.summary];
        if (obs.files_touched.length > 0) {
          parts.push(obs.files_touched.join(', '));
        }
        return parts.join(' | ');
      });

      const embeddings = await embeddingService.embedBatch(texts);
      if (!embeddings) break;

      for (let j = 0; j < batch.length; j++) {
        const obs = batch[j];
        const emb = embeddings[j];
        if (!obs?.id || !emb) continue;
        try {
          await db.saveEmbedding(obs.id, emb);
          totalEmbedded++;
        } catch {
          // skip individual failures
        }
      }

      // Pause between batches
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }

    if (totalEmbedded > 0) {
      console.error(`[context-manager-mcp] Background embedding complete: ${totalEmbedded} observations embedded`);
    }
  } catch (err) {
    // Background task should never crash the server
    console.error('[context-manager-mcp] Background embedding error:', err);
  }
}

// --- Server Startup ---

async function main() {
  // All logging must go to stderr — stdout is reserved for MCP protocol
  console.error('[context-manager-mcp] Starting MCP server...');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[context-manager-mcp] MCP server connected via stdio');

  // Start background embedding (fire-and-forget)
  backgroundEmbed();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.error('[context-manager-mcp] Shutting down...');
    storage?.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[context-manager-mcp] Shutting down...');
    storage?.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[context-manager-mcp] Fatal error:', error);
  storage?.close();
  process.exit(1);
});
