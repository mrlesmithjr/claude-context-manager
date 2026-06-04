/**
 * AdminPanel Component
 *
 * Database maintenance UI: prune observations by filters, run vacuum.
 * refs #131
 */

import { html, Component } from '/vendor/preact-htm.js';

export class AdminPanel extends Component {
  constructor(props) {
    super(props);
    this.state = {
      // Shared tool list loaded from stats
      tools: [],

      // Prune form state
      toolName: '',
      importance: '',
      olderThanDays: '',
      dryRun: false,
      pruneResult: null,
      pruneLoading: false,
      pruneError: null,

      // Vacuum form state
      vacuumOlderThanDays: '',
      vacuumResult: null,
      vacuumLoading: false,
      vacuumError: null,
    };
  }

  componentDidMount() {
    
    this.loadTools();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.project !== this.props.project) {
      
      this.loadTools();
    }
  }

  async loadTools() {
    try {
      const params = new URLSearchParams();
      if (this.props.project) params.append('project', this.props.project);
      const response = await apiFetch(`/api/stats?${params}`);
      if (!response.ok) throw new Error('Failed to load stats');
      const stats = await response.json();
      const tools = Object.keys(stats.tokens_by_tool || {}).sort();
      this.setState({ tools });
    } catch (error) {
      console.error('Failed to load tools:', error);
    }
  }

  handlePrune = async (isDryRun) => {
    const { toolName, importance, olderThanDays } = this.state;

    if (!toolName && !importance && !olderThanDays) {
      this.setState({ pruneError: 'At least one filter is required.' });
      return;
    }

    this.setState({ pruneLoading: true, pruneError: null, pruneResult: null, dryRun: isDryRun });

    try {
      const body = { dryRun: isDryRun };
      if (toolName) body.toolName = toolName;
      if (importance) body.importance = importance;
      if (olderThanDays) body.olderThanDays = parseInt(olderThanDays, 10);

      const response = await apiFetch('/api/admin/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Prune failed');
      }

      const result = await response.json();
      this.setState({ pruneResult: { ...result, isDryRun }, pruneLoading: false });
    } catch (error) {
      this.setState({ pruneError: error.message, pruneLoading: false });
    }
  };

  handleVacuum = async () => {
    const { vacuumOlderThanDays } = this.state;

    this.setState({ vacuumLoading: true, vacuumError: null, vacuumResult: null });

    try {
      const body = {};
      if (vacuumOlderThanDays) body.olderThanDays = parseInt(vacuumOlderThanDays, 10);

      const response = await apiFetch('/api/admin/vacuum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Vacuum failed');
      }

      const result = await response.json();
      this.setState({ vacuumResult: result, vacuumLoading: false });
    } catch (error) {
      this.setState({ vacuumError: error.message, vacuumLoading: false });
    }
  };

  renderPruneSection() {
    const {
      tools,
      toolName,
      importance,
      olderThanDays,
      dryRun,
      pruneResult,
      pruneLoading,
      pruneError,
    } = this.state;

    return html`
      <div>
        <h3 class="text-lg font-semibold text-white mb-4">Prune Observations</h3>
        <p class="text-sm text-gray-400 mb-4">
          Remove observations matching the selected filters. Use Preview first to inspect before deleting.
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <!-- Tool filter -->
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Tool</label>
            <select
              class="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value=${toolName}
              onChange=${(e) => this.setState({ toolName: e.target.value, pruneResult: null })}
            >
              <option value="">All Tools</option>
              ${tools.map((t) => html`<option value=${t}>${t}</option>`)}
            </select>
          </div>

          <!-- Importance filter -->
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Importance</label>
            <select
              class="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value=${importance}
              onChange=${(e) => this.setState({ importance: e.target.value, pruneResult: null })}
            >
              <option value="">All</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <!-- Older-than-days filter -->
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Older Than (days)</label>
            <input
              type="number"
              min="1"
              class="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g. 30"
              value=${olderThanDays}
              onInput=${(e) => this.setState({ olderThanDays: e.target.value, pruneResult: null })}
            />
          </div>
        </div>

        <!-- Action buttons -->
        <div class="flex items-center gap-3 mb-4">
          <button
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm font-medium
                   disabled:opacity-50 disabled:cursor-not-allowed"
            onClick=${() => this.handlePrune(true)}
            disabled=${pruneLoading}
          >
            ${pruneLoading && dryRun ? 'Previewing...' : 'Preview'}
          </button>
          <button
            class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white text-sm font-medium
                   disabled:opacity-50 disabled:cursor-not-allowed"
            onClick=${() => this.handlePrune(false)}
            disabled=${pruneLoading}
          >
            ${pruneLoading && !dryRun ? 'Deleting...' : 'Execute'}
          </button>
        </div>

        ${pruneError && html`
          <div class="text-red-400 text-sm mb-4">${pruneError}</div>
        `}

        ${pruneResult && pruneResult.isDryRun && html`
          <div class="bg-gray-900 rounded-lg p-4 mb-4">
            <div class="text-sm text-gray-400 mb-2">
              Preview: ${pruneResult.deleted.toLocaleString()} observation${pruneResult.deleted !== 1 ? 's' : ''} would be deleted
            </div>
            ${pruneResult.preview && pruneResult.preview.length > 0 && html`
              <pre class="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">${pruneResult.preview.join('\n')}</pre>
            `}
          </div>
        `}

        ${pruneResult && !pruneResult.isDryRun && html`
          <div class="text-green-400 text-sm mb-4">
            Deleted ${pruneResult.deleted.toLocaleString()} observation${pruneResult.deleted !== 1 ? 's' : ''}.
          </div>
        `}
      </div>
    `;
  }

  renderVacuumSection() {
    const { vacuumOlderThanDays, vacuumResult, vacuumLoading, vacuumError } = this.state;

    return html`
      <div>
        <h3 class="text-lg font-semibold text-white mb-4">Vacuum Database</h3>

        <div class="bg-yellow-900/30 border border-yellow-700/50 rounded-lg p-3 mb-4">
          <p class="text-sm text-yellow-300">
            SQLite VACUUM briefly locks the database. Use only for maintenance.
          </p>
        </div>

        <div class="flex items-end gap-4 mb-4">
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Older Than (days, optional)</label>
            <input
              type="number"
              min="1"
              class="bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Leave blank to vacuum all"
              value=${vacuumOlderThanDays}
              onInput=${(e) => this.setState({ vacuumOlderThanDays: e.target.value, vacuumResult: null })}
            />
          </div>
          <button
            class="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded text-white text-sm font-medium
                   disabled:opacity-50 disabled:cursor-not-allowed"
            onClick=${this.handleVacuum}
            disabled=${vacuumLoading}
          >
            ${vacuumLoading ? 'Running...' : 'Run Vacuum'}
          </button>
        </div>

        ${vacuumError && html`
          <div class="text-red-400 text-sm mb-4">${vacuumError}</div>
        `}

        ${vacuumResult && html`
          <div class="bg-gray-900 rounded-lg p-4">
            <h4 class="text-sm font-semibold text-gray-300 mb-3">Vacuum Results</h4>
            <table class="w-full text-sm">
              <tbody>
                <tr class="border-b border-gray-700">
                  <td class="py-1.5 text-gray-400">Observations deleted</td>
                  <td class="py-1.5 text-white text-right">${vacuumResult.observations.toLocaleString()}</td>
                </tr>
                <tr class="border-b border-gray-700">
                  <td class="py-1.5 text-gray-400">Sessions removed</td>
                  <td class="py-1.5 text-white text-right">${vacuumResult.sessions.toLocaleString()}</td>
                </tr>
                <tr class="border-b border-gray-700">
                  <td class="py-1.5 text-gray-400">Compacted groups created</td>
                  <td class="py-1.5 text-white text-right">${vacuumResult.compacted.toLocaleString()}</td>
                </tr>
                <tr class="border-b border-gray-700">
                  <td class="py-1.5 text-gray-400">Originals compacted</td>
                  <td class="py-1.5 text-white text-right">${vacuumResult.compacted_originals.toLocaleString()}</td>
                </tr>
                <tr>
                  <td class="py-1.5 text-gray-400">Stale sessions closed</td>
                  <td class="py-1.5 text-white text-right">${vacuumResult.closedStaleSessions.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  render() {
    // In network mode, require a project selection before showing anything

    return html`
      <div>
        <h2 class="text-xl font-bold text-white mb-6">Database Maintenance</h2>

        <div class="bg-gray-800 rounded-lg p-6 mb-6">
          ${this.renderPruneSection()}
        </div>

        <div class="border-t border-gray-700 my-6"></div>

        <div class="bg-gray-800 rounded-lg p-6">
          ${this.renderVacuumSection()}
        </div>
      </div>
    `;
  }
}
