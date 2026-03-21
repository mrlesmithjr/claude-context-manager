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
function formatStats(stats: Stats, project?: string): string {
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
    return {
      content: [
        {
          type: 'text' as const,
          text: formatStats(stats, project),
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

// --- Server Startup ---

async function main() {
  // All logging must go to stderr — stdout is reserved for MCP protocol
  console.error('[context-manager-mcp] Starting MCP server...');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[context-manager-mcp] MCP server connected via stdio');

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
