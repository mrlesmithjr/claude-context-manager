/**
 * Remote HTTP client for hook-to-server communication.
 *
 * Used by hooks when CONTEXT_MANAGER_URL is set in the environment.
 * Provides typed wrappers around the server's /capture/* and /memory
 * write endpoints, plus a helper to call MCP tools over HTTP.
 *
 * All exported functions are designed to be called from hook entry points.
 * They throw on errors; callers are responsible for catching and logging
 * (hooks must never block Claude Code regardless of server availability).
 *
 * Node 18+ native fetch is required. All hooks already target node18+.
 */

import type { Decision, Observation, UserPrompt } from '../storage/interface.js';
import { randomUUID } from 'crypto';

export interface RemoteClient {
  /** Base URL of the context-manager HTTP server, e.g. "http://context-server:4000" */
  url: string;
  /** Bearer token for Authorization header */
  token: string;
}

/** POST JSON to the remote server. Throws on non-2xx or network error. */
async function post(
  client: RemoteClient,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${client.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${client.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Remote ${path} returned ${response.status}: ${text}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * Create a session on the remote server.
 * Throws on error; caller catches and logs without blocking Claude Code.
 */
export async function remoteCreateSession(
  client: RemoteClient,
  sessionId: string,
  project: string,
  branch?: string | null,
): Promise<void> {
  await post(client, '/capture/session', {
    action: 'create',
    session_id: sessionId,
    project,
    ...(branch != null ? { branch } : {}),
  });
}

/**
 * End a session on the remote server with an optional summary.
 * Throws on error; caller catches and logs without blocking Claude Code.
 */
export async function remoteEndSession(
  client: RemoteClient,
  sessionId: string,
  summary?: string,
  summaryExtended?: string,
): Promise<void> {
  await post(client, '/capture/session', {
    action: 'end',
    session_id: sessionId,
    summary,
    summary_extended: summaryExtended,
  });
}

/**
 * Save one observation to the remote server.
 * Throws on error; caller catches and logs without blocking Claude Code.
 */
export async function remoteSaveObservation(
  client: RemoteClient,
  observation: Omit<Observation, 'id'>,
): Promise<void> {
  await post(client, '/capture/observation', observation);
}

/**
 * Save one user prompt to the remote server.
 * Throws on error; caller catches and logs without blocking Claude Code.
 */
export async function remoteSavePrompt(
  client: RemoteClient,
  prompt: Omit<UserPrompt, 'id'>,
): Promise<void> {
  await post(client, '/capture/prompt', prompt);
}

/**
 * Trigger server-side memory export for a project.
 *
 * The server runs exportToAutoMemory(), writes the result to its own memory
 * directory, and returns the formatted content so the caller can optionally
 * write it locally as well.
 *
 * Returns empty string on error (never throws).
 */
export async function remoteExportMemory(
  client: RemoteClient,
  project: string,
  sessionId?: string,
): Promise<string> {
  try {
    const data = (await post(client, '/capture/export', {
      project,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    })) as Record<string, unknown>;
    return typeof data.content === 'string' ? data.content : '';
  } catch {
    return '';
  }
}

/**
 * Fetch the current memory export content for a project from the server.
 *
 * Returns the raw markdown string from the server's memory file,
 * or empty string if the file does not exist or on any error (never throws).
 */
export async function remoteGetMemory(
  client: RemoteClient,
  project: string,
): Promise<string> {
  try {
    const response = await fetch(
      `${client.url}/memory?project=${encodeURIComponent(project)}`,
      {
        headers: {
          'Authorization': `Bearer ${client.token}`,
        },
      },
    );
    if (!response.ok) return '';
    const data = (await response.json()) as Record<string, unknown>;
    return typeof data.content === 'string' ? data.content : '';
  } catch {
    return '';
  }
}

/**
 * Save a manual observation via the remote server's /capture/add endpoint.
 *
 * Returns the session ID used on the server, or undefined on any failure
 * (never throws — callers treat the result as best-effort).
 */
export async function remoteAddObservation(
  client: RemoteClient,
  params: {
    text: string;
    project: string;
    importanceScore: number;
    tags: string | undefined;
    sourceClient?: string;
  },
): Promise<string | undefined> {
  try {
    const data = (await post(client, '/capture/add', {
      text: params.text,
      project: params.project,
      importance_score: params.importanceScore,
      tags: params.tags,
      client: params.sourceClient,
    })) as Record<string, unknown>;
    return typeof data.session_id === 'string' ? data.session_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save a decision to the remote server's /capture/decision endpoint.
 * Throws on error; caller catches and logs without blocking Claude Code.
 */
export async function remoteSaveDecision(
  client: RemoteClient,
  decision: Decision,
): Promise<void> {
  await post(client, '/capture/decision', {
    session_id: decision.session_id,
    project: decision.project,
    decision_text: decision.decision_text,
    context: decision.context ?? null,
    decision_number: decision.decision_number ?? null,
    captured_at: decision.captured_at,
    importance_score: decision.importance_score ?? 0.7,
    tags: decision.tags ?? null,
  });
}

/**
 * Fetch the next sequential decision number for a project from the remote server.
 *
 * Used by the Stop hook in remote mode so decisions are numbered globally rather
 * than always starting from 1 per session.
 *
 * Returns 1 as a safe fallback on any fetch or parse error. Decision numbering
 * is informational only and should never abort session-end.
 */
export async function remoteGetNextDecisionNumber(
  client: RemoteClient,
  project: string,
): Promise<number> {
  try {
    const response = await fetch(
      `${client.url}/api/decisions/next-number?project=${encodeURIComponent(project)}`,
      {
        headers: {
          'Authorization': `Bearer ${client.token}`,
        },
      },
    );
    if (!response.ok) return 1;
    const data = (await response.json()) as Record<string, unknown>;
    const n = data['nextNumber'];
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

/**
 * Trigger stale session GC on the remote server.
 *
 * Equivalent to the local closeStaleActiveSessions() call in context-inject's
 * local mode path. Marks sessions that have been 'active' for more than 2 hours
 * without a Stop hook (e.g. E2E test sessions, crashed runs) as 'complete'.
 *
 * Best-effort: never throws. Callers catch and log independently.
 */
export async function remoteCloseStale(client: RemoteClient): Promise<void> {
  await post(client, '/capture/session/gc', {});
}

/**
 * Check whether the remote server is reachable by hitting its /health endpoint.
 * Returns true if the server responds with a 2xx status, false on any error.
 * Never throws.
 */
export async function remoteHealthCheck(
  client: RemoteClient,
  timeoutMs = 3000,
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // /health is auth-exempt on the server; no Authorization header needed.
    const response = await fetch(`${client.url}/health`, { signal: ac.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call an MCP tool on the remote server and return the text of the first
 * content block, or empty string on any error (never throws).
 *
 * StreamableHTTPServerTransport requires Accept to include both
 * application/json and text/event-stream even in JSON response mode.
 */
export async function remoteMcpText(
  client: RemoteClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const response = await fetch(`${client.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${client.token}`,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: randomUUID(),
        params: { name: toolName, arguments: args },
      }),
    });
    if (!response.ok) return '';
    const data = (await response.json()) as {
      result?: { content: Array<{ type: string; text: string }> };
    };
    return data.result?.content?.[0]?.text ?? '';
  } catch {
    return '';
  }
}
