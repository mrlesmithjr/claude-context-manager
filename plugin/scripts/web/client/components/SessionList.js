/**
 * SessionList Component
 *
 * Displays paginated list of sessions with expand/collapse detail view.
 */

import { html, Component } from '/vendor/preact-htm.js';
import { formatRelativeTime } from './utils.js';

/**
 * Format duration between two dates
 */
function formatDuration(startStr, endStr) {
  if (!endStr) return 'Active';

  const start = new Date(startStr);
  const end = new Date(endStr);
  const diffMs = end - start;
  const diffMin = Math.floor(diffMs / (1000 * 60));
  const diffHour = Math.floor(diffMin / 60);

  if (diffHour > 0) {
    const remainingMin = diffMin % 60;
    return `${diffHour}h ${remainingMin}m`;
  }
  return `${diffMin}m`;
}

/**
 * SessionList Component
 */
export class SessionList extends Component {
  constructor(props) {
    super(props);
    this.state = {
      sessions: [],
      total: 0,
      limit: 20,
      offset: 0,
      loading: false,
      error: null,
      expandedSession: null,
      sessionDetail: null,
      loadingDetail: false,
    };
  }

  componentDidMount() {
    // In network mode, skip the initial fetch until a project is selected
    if (this.props.projectRequired && !this.props.project) return;
    this.loadSessions();
  }

  componentDidUpdate(prevProps) {
    // Reload when project filter changes
    if (prevProps.project !== this.props.project) {
      // In network mode, skip the fetch if no project is selected
      if (this.props.projectRequired && !this.props.project) return;
      this.setState({ offset: 0 }, () => this.loadSessions());
    }
  }

  async loadSessions() {
    // Guard: do not fetch without a project in network mode
    if (this.props.projectRequired && !this.props.project) return;

    const { limit, offset } = this.state;
    const { project } = this.props;

    this.setState({ loading: true, error: null });

    try {
      const params = new URLSearchParams({ limit, offset });
      if (project) params.append('project', project);

      const response = await apiFetch(`/api/sessions?${params}`);
      if (!response.ok) throw new Error('Failed to load sessions');

      const data = await response.json();
      this.setState({
        sessions: data.sessions,
        total: data.total,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to load sessions:', error);
      this.setState({ error: error.message, loading: false });
    }
  }

  async loadSessionDetail(sessionId) {
    this.setState({ loadingDetail: true });

    try {
      const response = await apiFetch(`/api/sessions/${sessionId}`);
      if (!response.ok) throw new Error('Failed to load session detail');

      const data = await response.json();
      this.setState({
        sessionDetail: data,
        expandedSession: sessionId,
        loadingDetail: false,
      });
    } catch (error) {
      console.error('Failed to load session detail:', error);
      this.setState({ loadingDetail: false });
    }
  }

  handleSessionClick = (sessionId) => {
    const { expandedSession } = this.state;

    if (expandedSession === sessionId) {
      // Collapse if already expanded
      this.setState({ expandedSession: null, sessionDetail: null });
    } else {
      // Expand and load detail
      this.loadSessionDetail(sessionId);
    }
  };

  handlePrevPage = () => {
    const { offset, limit } = this.state;
    const newOffset = Math.max(0, offset - limit);
    this.setState({ offset: newOffset, expandedSession: null, sessionDetail: null }, () => this.loadSessions());
  };

  handleNextPage = () => {
    const { offset, limit, total } = this.state;
    const newOffset = offset + limit;
    if (newOffset < total) {
      this.setState({ offset: newOffset, expandedSession: null, sessionDetail: null }, () => this.loadSessions());
    }
  };

  renderStatusBadge(status) {
    const isActive = status === 'active';
    const bgColor = isActive ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400';

    return html`
      <span class="px-2 py-1 text-xs font-semibold rounded ${bgColor}">
        ${status}
      </span>
    `;
  }

  renderSessionRow(session) {
    const { expandedSession } = this.state;
    const isExpanded = expandedSession === session.id;

    return html`
      <div class="bg-gray-800 rounded-lg mb-2 overflow-hidden hover:bg-gray-750 transition-colors">
        <div
          class="px-4 py-3 cursor-pointer flex items-start gap-4"
          onClick=${() => this.handleSessionClick(session.id)}
        >
          <!-- Expand indicator -->
          <div class="text-gray-500 mt-1">
            <svg
              class="w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </div>

          <!-- Main content -->
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-4 mb-2">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  ${this.renderStatusBadge(session.status)}
                  <span class="text-xs text-gray-500">
                    ${formatRelativeTime(session.started_at)}
                  </span>
                  <span class="text-xs text-gray-600">•</span>
                  <span class="text-xs text-gray-500">
                    ${formatDuration(session.started_at, session.ended_at)}
                  </span>
                </div>
                <div class="text-sm font-mono text-gray-400 truncate">
                  ${session.project}
                </div>
              </div>
              <div class="text-right text-sm">
                <div class="text-gray-400">
                  ${session.observation_count} observations
                </div>
                <div class="text-gray-500 text-xs">
                  ${(session.total_tokens || 0).toLocaleString()} tokens
                </div>
              </div>
            </div>
            ${session.summary
              ? html`<div class="text-sm text-gray-300">${session.summary}</div>`
              : html`<div class="text-sm text-gray-500 italic">No summary</div>`}
          </div>
        </div>

        <!-- Expanded detail -->
        ${isExpanded && this.renderSessionDetail(session)}
      </div>
    `;
  }

  renderSessionDetail(session) {
    const { sessionDetail, loadingDetail } = this.state;

    if (loadingDetail) {
      return html`
        <div class="border-t border-gray-700 px-4 py-8 text-center">
          <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <div class="text-gray-500 mt-2">Loading details...</div>
        </div>
      `;
    }

    if (!sessionDetail) return null;

    const { observations, prompts } = sessionDetail;

    // Parse summary_extended beats from the session list data (not the detail API, which lacks it).
    // Delimiter matches the write path in plugin/hooks/session-end.ts extractSummaryFromTranscript().
    const BEAT_SEPARATOR = '\n\n---\n\n';
    const beats = session.summary_extended
      ? session.summary_extended.split(BEAT_SEPARATOR)
      : [];

    return html`
      <div class="border-t border-gray-700 bg-gray-850">
        <!-- Narrative Beats -->
        ${beats.length > 0 ? html`
          <div class="px-4 py-3 border-b border-gray-700">
            <h4 class="text-sm font-semibold text-indigo-400 mb-2">
              Narrative Beats (${beats.length})
            </h4>
            <div class="space-y-3">
              ${beats.map((beat, i) => html`
                <div class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                  ${i > 0 ? html`<div class="border-t border-gray-700 mb-3"></div>` : null}
                  ${beat}
                </div>
              `)}
            </div>
          </div>
        ` : null}

        <!-- Prompts -->
        ${prompts && prompts.length > 0 ? html`
          <div class="px-4 py-3 border-b border-gray-700">
            <h4 class="text-sm font-semibold text-gray-400 mb-2">Prompts (${prompts.length})</h4>
            <div class="space-y-2">
              ${prompts.slice(0, 3).map(
                (prompt) => html`
                  <div class="text-sm">
                    <span class="text-gray-500">#${prompt.prompt_number}:</span>
                    <span class="text-gray-300 ml-2">
                      ${prompt.prompt_text.length > 100
                        ? prompt.prompt_text.slice(0, 100) + '...'
                        : prompt.prompt_text}
                    </span>
                  </div>
                `
              )}
              ${prompts.length > 3 ? html`
                <div class="text-xs text-gray-500">
                  ... and ${prompts.length - 3} more
                </div>
              ` : null}
            </div>
          </div>
        ` : null}

        <!-- Observations -->
        ${observations && observations.length > 0 ? html`
          <div class="px-4 py-3">
            <h4 class="text-sm font-semibold text-gray-400 mb-2">
              Observations (${observations.length})
            </h4>
            <div class="space-y-2 max-h-96 overflow-y-auto">
              ${observations.map(
                (obs) => html`
                  <div class="text-sm bg-gray-800/50 rounded p-2">
                    <div class="flex items-center justify-between mb-1">
                      <span class="font-mono text-blue-400">${obs.tool_name}</span>
                      <span class="text-xs text-gray-500">
                        ${obs.token_estimate} tokens
                      </span>
                    </div>
                    <div class="text-gray-300">${obs.summary}</div>
                    ${obs.files_touched && obs.files_touched.length > 0 ? html`
                      <div class="text-xs text-gray-500 mt-1 font-mono">
                        ${obs.files_touched.join(', ')}
                      </div>
                    ` : null}
                  </div>
                `
              )}
            </div>
          </div>
        ` : null}
      </div>
    `;
  }

  render() {
    const { sessions, total, limit, offset, loading, error } = this.state;

    // In network mode, require a project selection before showing anything
    if (this.props.projectRequired && !this.props.project) {
      return html`
        <div class="text-center py-16 text-gray-500">Select a project above to view sessions.</div>
      `;
    }

    if (loading && sessions.length === 0) {
      return html`
        <div class="text-center py-20">
          <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          <div class="text-gray-500 mt-4">Loading sessions...</div>
        </div>
      `;
    }

    if (error) {
      return html`
        <div class="text-center py-20">
          <div class="text-red-500 text-lg mb-4">Error loading sessions</div>
          <div class="text-gray-500">${error}</div>
          <button
            class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
            onClick=${() => this.loadSessions()}
          >
            Retry
          </button>
        </div>
      `;
    }

    if (sessions.length === 0) {
      return html`
        <div class="text-center py-20">
          <div class="text-gray-500 text-lg">No sessions found</div>
          <div class="text-gray-600 text-sm mt-2">Try adjusting your filters</div>
        </div>
      `;
    }

    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);

    return html`
      <div>
        <!-- Session list -->
        <div class="mb-6">
          ${sessions.map((session) => this.renderSessionRow(session))}
        </div>

        <!-- Pagination -->
        <div class="flex items-center justify-between">
          <div class="text-sm text-gray-500">
            Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total.toLocaleString()}
          </div>
          <div class="flex gap-2">
            <button
              class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
              onClick=${this.handlePrevPage}
              disabled=${offset === 0}
            >
              Previous
            </button>
            <div class="px-4 py-2 bg-gray-800 rounded text-gray-400">
              Page ${currentPage} of ${totalPages}
            </div>
            <button
              class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
              onClick=${this.handleNextPage}
              disabled=${offset + limit >= total}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
