/**
 * DecisionLog Component
 *
 * Searchable log of architectural decisions captured during sessions.
 * refs #129
 */

import { html, Component } from '/vendor/preact-htm.js';
import { formatRelativeTime, parseTags, getImportanceBadge, escapeHtml } from './utils.js';

/**
 * DecisionLog Component
 */
export class DecisionLog extends Component {
  constructor(props) {
    super(props);
    this.state = {
      query: '',
      decisions: [],
      total: 0,
      loading: false,
      error: null,
      expandedDecision: null,
      hasLoaded: false,
    };

    this.debounceTimer = null;
  }

  componentDidMount() {
    
    this.loadDecisions();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.project !== this.props.project) {
      
      this.loadDecisions();
    }
  }

  handleQueryChange = (e) => {
    const query = e.target.value;
    this.setState({ query });

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.loadDecisions();
    }, 300);
  };

  async loadDecisions() {
    const { query } = this.state;
    const { project } = this.props;

    this.setState({ loading: true, error: null });

    try {
      const params = new URLSearchParams({ limit: 20 });
      if (query.trim()) params.append('q', query.trim());
      if (project) params.append('project', project);

      const response = await apiFetch(`/api/decisions?${params}`);
      if (!response.ok) throw new Error('Failed to load decisions');

      const data = await response.json();
      this.setState({
        decisions: data.decisions,
        total: data.total,
        loading: false,
        hasLoaded: true,
      });
    } catch (error) {
      console.error('Failed to load decisions:', error);
      this.setState({ error: error.message, loading: false, hasLoaded: true });
    }
  }

  handleDecisionClick = (id) => {
    const { expandedDecision } = this.state;
    this.setState({ expandedDecision: expandedDecision === id ? null : id });
  };

  renderDecisionCard(decision) {
    const { expandedDecision } = this.state;
    const isExpanded = expandedDecision === decision.id;
    const tags = parseTags(decision.tags);
    const { label: impLabel, colorClass: impColor } = getImportanceBadge(
      null,
      decision.importance_score
    );

    return html`
      <div class="bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-750 transition-colors">
        <div
          class="px-4 py-3 cursor-pointer"
          onClick=${() => this.handleDecisionClick(decision.id)}
        >
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-2 flex-wrap">
              ${decision.decision_number != null ? html`
                <span class="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-gray-600/60 text-gray-300">
                  #${decision.decision_number}
                </span>
              ` : null}
              ${impLabel ? html`
                <span class="px-2 py-0.5 text-xs font-semibold rounded ${impColor}">
                  ${impLabel}
                </span>
              ` : null}
              <span class="text-xs text-gray-500">
                ${formatRelativeTime(decision.captured_at)}
              </span>
              ${tags.map((tag) => html`
                <span class="px-2 py-0.5 text-xs rounded bg-indigo-500/20 text-indigo-300">
                  ${tag}
                </span>
              `)}
            </div>
            <svg
              class="w-4 h-4 text-gray-500 flex-shrink-0 transition-transform mt-0.5 ${isExpanded ? 'rotate-90' : ''}"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </div>

          <!-- Decision text preview -->
          <div class="mt-2 text-sm text-gray-300 line-clamp-2">
            ${decision.decision_text}
          </div>
        </div>

        <!-- Expanded detail -->
        ${isExpanded && html`
          <div class="border-t border-gray-700 bg-gray-850 px-4 py-3 space-y-3">
            <!-- Full decision text -->
            <div>
              <h5 class="text-xs font-semibold text-gray-400 mb-1">Decision</h5>
              <div class="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
                ${decision.decision_text}
              </div>
            </div>

            <!-- Context -->
            ${decision.context ? html`
              <div>
                <h5 class="text-xs font-semibold text-gray-400 mb-1">Context</h5>
                <div class="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                  ${decision.context}
                </div>
              </div>
            ` : null}

            <!-- Project and session -->
            <div class="flex flex-wrap gap-4 pt-1 border-t border-gray-700">
              ${decision.project ? html`
                <div class="text-xs text-gray-500 font-mono">${decision.project}</div>
              ` : null}
              ${decision.session_id ? html`
                <div class="text-xs text-gray-600 font-mono">
                  session: ${decision.session_id.slice(0, 8)}
                </div>
              ` : null}
            </div>
          </div>
        `}
      </div>
    `;
  }

  renderEmptyState() {
    const { query, hasLoaded } = this.state;

    if (!hasLoaded) return null;

    return html`
      <div class="text-center py-20">
        <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <h3 class="text-xl font-semibold text-gray-400 mb-2">No Decisions Found</h3>
        <p class="text-gray-500">
          ${query.trim()
            ? `No decisions matching "${escapeHtml(query)}"`
            : 'Decisions are captured automatically during sessions'}
        </p>
      </div>
    `;
  }

  render() {
    const { decisions, total, loading, error, query } = this.state;


    return html`
      <div>
        <!-- Search controls -->
        <div class="bg-gray-800 rounded-lg p-4 mb-6">
          <div>
            <label for="decision-search" class="block text-sm font-medium text-gray-400 mb-2">
              Search Decisions
            </label>
            <div class="relative">
              <input
                id="decision-search"
                type="text"
                class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2 pr-10
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Filter decisions..."
                value=${query}
                onInput=${this.handleQueryChange}
              />
              <div class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        ${loading && html`
          <div class="text-center py-20">
            <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            <div class="text-gray-500 mt-4">Loading decisions...</div>
          </div>
        `}

        ${error && html`
          <div class="text-center py-20">
            <div class="text-red-500 text-lg mb-4">Error Loading Decisions</div>
            <div class="text-gray-500">${error}</div>
            <button
              class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              onClick=${() => this.loadDecisions()}
            >
              Retry
            </button>
          </div>
        `}

        ${!loading && !error && decisions.length === 0 && this.renderEmptyState()}

        ${!loading && !error && decisions.length > 0 && html`
          <div>
            <div class="flex items-center justify-between mb-4">
              <div class="text-sm text-gray-400">
                ${total} decision${total !== 1 ? 's' : ''}
              </div>
            </div>
            <div class="space-y-2">
              ${decisions.map((d) => this.renderDecisionCard(d))}
            </div>
          </div>
        `}
      </div>
    `;
  }
}
