/**
 * Context Manager Dashboard - Main Application
 *
 * Preact-based SPA with hash routing, no build step required.
 */

import { html, Component, render } from '/vendor/preact-htm.js';
import { SessionList } from './components/SessionList.js';
import { ProjectFilter } from './components/ProjectFilter.js';
import { ObservationSearch } from './components/ObservationSearch.js';
import { TokenAnalytics } from './components/TokenAnalytics.js';
import { ImportPanel } from './components/ImportPanel.js';

/**
 * Authenticated fetch helper.
 * Attaches the Bearer token from window.__CTX_TOKEN when present.
 * In local mode the token is an empty string and no Authorization header is added,
 * so existing local-dev behavior is preserved.
 */
window.apiFetch = function apiFetch(path, opts = {}) {
  const token = window.__CTX_TOKEN;
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(path, { ...opts, headers });
};

// Server injects the real token in network mode and '' (empty string) in local mode.
const isNetworkMode = typeof window.__CTX_TOKEN === 'string' && window.__CTX_TOKEN.length > 0;

/**
 * Main application component
 */
class App extends Component {
  constructor() {
    super();
    this.state = {
      currentRoute: 'sessions', // 'sessions' | 'search' | 'analytics'
      selectedProject: null,
      stats: null,
      loading: false,
      error: null,
    };
  }

  componentDidMount() {
    // Initialize route from hash
    this.updateRouteFromHash();
    window.addEventListener('hashchange', () => this.updateRouteFromHash());

    // Load stats for footer; in network mode, defer until a project is selected
    // (loadStats will be called from handleProjectChange instead)
    if (!isNetworkMode) {
      this.loadStats();
    }
  }

  updateRouteFromHash() {
    const hash = window.location.hash.slice(1) || 'sessions';
    const validRoutes = ['sessions', 'search', 'analytics', 'import'];
    const route = validRoutes.includes(hash) ? hash : 'sessions';
    this.setState({ currentRoute: route });
  }

  async loadStats(project) {
    try {
      const params = new URLSearchParams();
      if (project) params.append('project', project);
      const url = '/api/stats' + (params.toString() ? '?' + params.toString() : '');
      const response = await apiFetch(url);
      if (!response.ok) throw new Error('Failed to load stats');
      const stats = await response.json();
      this.setState({ stats });
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  }

  handleProjectChange = (project) => {
    this.setState({ selectedProject: project });
    if (isNetworkMode) {
      this.loadStats(project);
    }
  };

  navigateTo = (route) => {
    window.location.hash = route;
  };

  renderContent() {
    const { currentRoute, selectedProject } = this.state;

    switch (currentRoute) {
      case 'sessions':
        return html`<${SessionList} project=${selectedProject} projectRequired=${isNetworkMode} />`;
      case 'search':
        return html`<${ObservationSearch} project=${selectedProject} projectRequired=${isNetworkMode} />`;
      case 'analytics':
        return html`<${TokenAnalytics} project=${selectedProject} projectRequired=${isNetworkMode} />`;
      case 'import':
        return html`<${ImportPanel} />`;
      default:
        return html`<${SessionList} project=${selectedProject} projectRequired=${isNetworkMode} />`;
    }
  }

  renderStats() {
    const { stats } = this.state;
    if (!stats) {
      return html`
        <div class="text-gray-500 text-sm">Loading stats...</div>
      `;
    }

    return html`
      <div class="flex flex-wrap gap-6 text-sm">
        <div>
          <span class="text-gray-400">Observations:</span>
          <span class="ml-2 font-semibold">${stats.total_observations.toLocaleString()}</span>
        </div>
        <div>
          <span class="text-gray-400">Sessions:</span>
          <span class="ml-2 font-semibold">${stats.total_sessions.toLocaleString()}</span>
        </div>
        <div>
          <span class="text-gray-400">Total Tokens:</span>
          <span class="ml-2 font-semibold">${stats.total_tokens.toLocaleString()}</span>
        </div>
        <div>
          <span class="text-gray-400">Avg Tokens/Session:</span>
          <span class="ml-2 font-semibold">${Math.round(stats.avg_tokens_per_session).toLocaleString()}</span>
        </div>
      </div>
    `;
  }

  render() {
    const { currentRoute, selectedProject } = this.state;

    return html`
      <div class="min-h-screen flex flex-col">
        <!-- Header -->
        <header class="bg-gray-800 border-b border-gray-700">
          <div class="container mx-auto px-4 py-4">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 class="text-2xl font-bold text-white">Context Manager Dashboard</h1>
                <p class="text-gray-400 text-sm mt-1">Browse and analyze Claude Code context history</p>
              </div>
              <div class="sm:w-64">
                <${ProjectFilter}
                  selectedProject=${selectedProject}
                  onProjectChange=${this.handleProjectChange}
                  required=${isNetworkMode}
                />
              </div>
            </div>
          </div>
        </header>

        <!-- Navigation Tabs -->
        <nav class="bg-gray-800 border-b border-gray-700">
          <div class="container mx-auto px-4">
            <div class="flex space-x-1">
              ${['sessions', 'search', 'analytics', 'import'].map(
                (route) => html`
                  <button
                    class="${currentRoute === route
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-700/50'}
                      px-4 py-3 font-medium text-sm rounded-t transition-colors"
                    onClick=${() => this.navigateTo(route)}
                  >
                    ${route.charAt(0).toUpperCase() + route.slice(1)}
                  </button>
                `
              )}
            </div>
          </div>
        </nav>

        <!-- Main Content -->
        <main class="flex-1 container mx-auto px-4 py-6">
          ${this.renderContent()}
        </main>

        <!-- Footer -->
        <footer class="bg-gray-800 border-t border-gray-700">
          <div class="container mx-auto px-4 py-4">
            ${this.renderStats()}
          </div>
        </footer>
      </div>
    `;
  }
}

// Mount application
render(html`<${App} />`, document.getElementById('app'));
