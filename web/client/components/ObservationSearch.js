/**
 * ObservationSearch Component
 *
 * Full-text search interface for observations with tool filtering.
 */

import { html, Component } from 'https://unpkg.com/htm/preact/standalone.module.js';

/**
 * Format a date as relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  // Format as date for older entries
  return date.toLocaleDateString();
}

/**
 * Get badge color for tool type
 */
function getToolColor(toolName) {
  const colors = {
    Read: 'bg-blue-500/20 text-blue-400',
    Write: 'bg-green-500/20 text-green-400',
    Edit: 'bg-yellow-500/20 text-yellow-400',
    Bash: 'bg-purple-500/20 text-purple-400',
    Grep: 'bg-pink-500/20 text-pink-400',
    Glob: 'bg-indigo-500/20 text-indigo-400',
    Task: 'bg-orange-500/20 text-orange-400',
    WebFetch: 'bg-cyan-500/20 text-cyan-400',
    WebSearch: 'bg-teal-500/20 text-teal-400',
  };

  return colors[toolName] || 'bg-gray-500/20 text-gray-400';
}

/**
 * Escape HTML special characters to prevent XSS.
 * Must be applied before inserting any user-derived or stored content
 * into dangerouslySetInnerHTML.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Highlight search matches in text.
 * HTML-encodes the source text before injecting so stored observation
 * summaries cannot contain executable markup.
 */
function highlightMatches(text, query) {
  if (!query || query.trim() === '') return escapeHtml(text);
  const safeText = escapeHtml(text);
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeQuery})`, 'gi');
  return safeText.replace(regex, '<mark class="bg-yellow-500/30 text-yellow-200">$1</mark>');
}

/**
 * ObservationSearch Component
 */
export class ObservationSearch extends Component {
  constructor(props) {
    super(props);
    this.state = {
      query: '',
      selectedTool: '',
      observations: [],
      tools: [], // Will be dynamically populated
      total: 0,
      limit: 50,
      offset: 0,
      loading: false,
      error: null,
      expandedObservation: null,
      hasSearched: false,
    };

    this.debounceTimer = null;
  }

  componentDidMount() {
    this.loadTools();
  }

  componentDidUpdate(prevProps) {
    // Reload when project filter changes
    if (prevProps.project !== this.props.project && this.state.hasSearched) {
      this.performSearch();
    }
  }

  /**
   * Load unique tool names from stats
   */
  async loadTools() {
    try {
      const response = await fetch('/api/stats');
      if (!response.ok) throw new Error('Failed to load stats');

      const stats = await response.json();
      const tools = Object.keys(stats.tokens_by_tool || {}).sort();

      this.setState({ tools });
    } catch (error) {
      console.error('Failed to load tools:', error);
    }
  }

  handleQueryChange = (e) => {
    const query = e.target.value;
    this.setState({ query });

    // Debounce search
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (query.trim().length === 0) {
      // Clear results if query is empty
      this.setState({ observations: [], total: 0, hasSearched: false });
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.setState({ offset: 0 }, () => this.performSearch());
    }, 300);
  };

  handleToolChange = (e) => {
    const tool = e.target.value;
    this.setState({ selectedTool: tool, offset: 0 }, () => {
      if (this.state.hasSearched) {
        this.performSearch();
      }
    });
  };

  async performSearch() {
    const { query, selectedTool, limit, offset } = this.state;
    const { project } = this.props;

    this.setState({ loading: true, error: null, hasSearched: true });

    try {
      const params = new URLSearchParams({ limit, offset });
      if (query.trim()) params.append('q', query.trim());
      if (project) params.append('project', project);
      if (selectedTool) params.append('tool', selectedTool);

      const response = await fetch(`/api/observations?${params}`);
      if (!response.ok) throw new Error('Failed to search observations');

      const data = await response.json();
      this.setState({
        observations: data.observations,
        total: data.total,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to search observations:', error);
      this.setState({ error: error.message, loading: false });
    }
  }

  handleObservationClick = (obsId) => {
    const { expandedObservation } = this.state;

    if (expandedObservation === obsId) {
      this.setState({ expandedObservation: null });
    } else {
      this.setState({ expandedObservation: obsId });
    }
  };

  handlePrevPage = () => {
    const { offset, limit } = this.state;
    const newOffset = Math.max(0, offset - limit);
    this.setState({ offset: newOffset }, () => this.performSearch());
  };

  handleNextPage = () => {
    const { offset, limit, total } = this.state;
    const newOffset = offset + limit;
    if (newOffset < total) {
      this.setState({ offset: newOffset }, () => this.performSearch());
    }
  };

  renderSearchControls() {
    const { query, selectedTool, tools } = this.state;

    return html`
      <div class="bg-gray-800 rounded-lg p-4 mb-6">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Search Input -->
          <div>
            <label for="search-query" class="block text-sm font-medium text-gray-400 mb-2">
              Search Observations
            </label>
            <div class="relative">
              <input
                id="search-query"
                type="text"
                class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2 pr-10
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter search terms..."
                value=${query}
                onInput=${this.handleQueryChange}
              />
              <!-- Search icon -->
              <div class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
            </div>
          </div>

          <!-- Tool Filter -->
          <div>
            <label for="tool-filter" class="block text-sm font-medium text-gray-400 mb-2">
              Filter by Tool
            </label>
            <div class="relative">
              <select
                id="tool-filter"
                class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                onChange=${this.handleToolChange}
                value=${selectedTool}
              >
                <option value="">All Tools</option>
                ${tools.map(
                  (tool) => html`
                    <option value=${tool}>${tool}</option>
                  `
                )}
              </select>
              <!-- Dropdown icon -->
              <div class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderObservationCard(obs) {
    const { expandedObservation, query } = this.state;
    const isExpanded = expandedObservation === obs.id;

    // Parse metadata if it's a string
    let metadata = obs.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch (e) {
        metadata = {};
      }
    }

    return html`
      <div class="bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-750 transition-colors">
        <div
          class="px-4 py-3 cursor-pointer"
          onClick=${() => this.handleObservationClick(obs.id)}
        >
          <div class="flex items-start justify-between gap-4 mb-2">
            <!-- Tool badge and timestamp -->
            <div class="flex items-center gap-2 flex-wrap">
              <span class="px-2 py-1 text-xs font-mono font-semibold rounded ${getToolColor(obs.tool_name)}">
                ${obs.tool_name}
              </span>
              <span class="text-xs text-gray-500">
                ${formatRelativeTime(obs.created_at)}
              </span>
              ${obs.session_id && html`
                <span class="text-xs text-gray-600">•</span>
                <span class="text-xs text-gray-500 font-mono">
                  ${obs.session_id.slice(0, 8)}...
                </span>
              `}
            </div>

            <!-- Token count -->
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500">
                ${obs.token_estimate} tokens
              </span>
              <svg
                class="w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>

          <!-- Summary with highlighting -->
          <div class="text-sm text-gray-300 mb-2">
            ${query.trim()
              ? html`<div dangerouslySetInnerHTML=${{ __html: highlightMatches(obs.summary, query) }}></div>`
              : obs.summary}
          </div>

          <!-- Files touched as pills -->
          ${obs.files_touched && obs.files_touched.length > 0 && html`
            <div class="flex flex-wrap gap-1">
              ${obs.files_touched.slice(0, 3).map(
                (file) => html`
                  <span class="px-2 py-1 bg-gray-700 text-gray-400 text-xs font-mono rounded">
                    ${file.split('/').pop()}
                  </span>
                `
              )}
              ${obs.files_touched.length > 3 && html`
                <span class="px-2 py-1 text-gray-500 text-xs">
                  +${obs.files_touched.length - 3} more
                </span>
              `}
            </div>
          `}
        </div>

        <!-- Expanded metadata -->
        ${isExpanded && html`
          <div class="border-t border-gray-700 bg-gray-850 px-4 py-3">
            <div class="space-y-3">
              <!-- Full file list -->
              ${obs.files_touched && obs.files_touched.length > 0 && html`
                <div>
                  <h5 class="text-xs font-semibold text-gray-400 mb-1">Files Touched</h5>
                  <div class="space-y-1">
                    ${obs.files_touched.map(
                      (file) => html`
                        <div class="text-xs font-mono text-gray-300">${file}</div>
                      `
                    )}
                  </div>
                </div>
              `}

              <!-- Project -->
              ${obs.project && html`
                <div>
                  <h5 class="text-xs font-semibold text-gray-400 mb-1">Project</h5>
                  <div class="text-xs font-mono text-gray-300">${obs.project}</div>
                </div>
              `}

              <!-- Metadata (if any) -->
              ${metadata && Object.keys(metadata).length > 0 && html`
                <div>
                  <h5 class="text-xs font-semibold text-gray-400 mb-1">Metadata</h5>
                  <pre class="text-xs text-gray-300 bg-gray-900 p-2 rounded overflow-x-auto">${JSON.stringify(
                    metadata,
                    null,
                    2
                  )}</pre>
                </div>
              `}
            </div>
          </div>
        `}
      </div>
    `;
  }

  renderEmptyState() {
    const { query, hasSearched } = this.state;

    if (!hasSearched) {
      return html`
        <div class="text-center py-20">
          <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <h3 class="text-xl font-semibold text-gray-400 mb-2">Search Observations</h3>
          <p class="text-gray-500">Enter a search term to find observations across sessions</p>
        </div>
      `;
    }

    return html`
      <div class="text-center py-20">
        <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <h3 class="text-xl font-semibold text-gray-400 mb-2">No Results Found</h3>
        <p class="text-gray-500">
          ${query.trim()
            ? `No observations found matching "${query}"`
            : 'Try adjusting your filters or search terms'}
        </p>
      </div>
    `;
  }

  render() {
    const { observations, total, limit, offset, loading, error } = this.state;

    return html`
      <div>
        ${this.renderSearchControls()}

        ${loading && html`
          <div class="text-center py-20">
            <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            <div class="text-gray-500 mt-4">Searching...</div>
          </div>
        `}

        ${error && html`
          <div class="text-center py-20">
            <div class="text-red-500 text-lg mb-4">Search Error</div>
            <div class="text-gray-500">${error}</div>
            <button
              class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              onClick=${() => this.performSearch()}
            >
              Retry
            </button>
          </div>
        `}

        ${!loading && !error && observations.length === 0 && this.renderEmptyState()}

        ${!loading && !error && observations.length > 0 && html`
          <div>
            <!-- Results header -->
            <div class="flex items-center justify-between mb-4">
              <div class="text-sm text-gray-400">
                ${total.toLocaleString()} result${total !== 1 ? 's' : ''} found
              </div>
            </div>

            <!-- Observation cards -->
            <div class="space-y-2 mb-6">
              ${observations.map((obs) => this.renderObservationCard(obs))}
            </div>

            <!-- Pagination -->
            ${total > limit && html`
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
                    Page ${Math.floor(offset / limit) + 1} of ${Math.ceil(total / limit)}
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
            `}
          </div>
        `}
      </div>
    `;
  }
}
