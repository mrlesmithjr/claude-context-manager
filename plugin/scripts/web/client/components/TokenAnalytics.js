/**
 * TokenAnalytics Component
 *
 * Analytics dashboard with charts and statistics.
 */

import { html, Component } from 'https://unpkg.com/htm/preact/standalone.module.js';

/**
 * Format large numbers (e.g., 1234567 → "1.2M" or "1,234K")
 */
function formatLargeNumber(num) {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toLocaleString();
}

/**
 * Format date for chart labels (e.g., "Dec 13")
 */
function formatChartDate(dateStr) {
  const date = new Date(dateStr);
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${month} ${day}`;
}

/**
 * Get tool color (matches ObservationSearch)
 */
function getToolColor(toolName) {
  const colors = {
    Read: '#60a5fa',      // blue-400
    Write: '#4ade80',     // green-400
    Edit: '#facc15',      // yellow-400
    Bash: '#c084fc',      // purple-400
    Grep: '#f472b6',      // pink-400
    Glob: '#a78bfa',      // indigo-400
    Task: '#fb923c',      // orange-400
    WebFetch: '#22d3ee',  // cyan-400
    WebSearch: '#2dd4bf', // teal-400
  };

  return colors[toolName] || '#9ca3af'; // gray-400
}

/**
 * TokenAnalytics Component
 */
export class TokenAnalytics extends Component {
  constructor(props) {
    super(props);
    this.state = {
      stats: null,
      timeline: [],
      loading: true,
      error: null,
      days: 30,
    };

    this.timelineChart = null;
    this.toolChart = null;
    this.timelineCanvasRef = null;
    this.toolCanvasRef = null;
  }

  componentDidMount() {
    this.loadData();
    this.setupChartDefaults();
  }

  componentDidUpdate(prevProps) {
    // Reload when project filter changes
    if (prevProps.project !== this.props.project) {
      this.loadData();
    }
  }

  componentWillUnmount() {
    // Clean up charts
    if (this.timelineChart) {
      this.timelineChart.destroy();
    }
    if (this.toolChart) {
      this.toolChart.destroy();
    }
  }

  setupChartDefaults() {
    // Configure Chart.js defaults for dark mode
    if (window.Chart) {
      Chart.defaults.color = '#9ca3af'; // gray-400
      Chart.defaults.borderColor = '#374151'; // gray-700
    }
  }

  async loadData() {
    const { project } = this.props;
    const { days } = this.state;

    this.setState({ loading: true, error: null });

    try {
      // Load stats and timeline in parallel
      const statsParams = new URLSearchParams();
      if (project) statsParams.append('project', project);

      const timelineParams = new URLSearchParams({ days });
      if (project) timelineParams.append('project', project);

      const [statsResponse, timelineResponse] = await Promise.all([
        fetch(`/api/stats?${statsParams}`),
        fetch(`/api/stats/timeline?${timelineParams}`),
      ]);

      if (!statsResponse.ok) throw new Error('Failed to load stats');
      if (!timelineResponse.ok) throw new Error('Failed to load timeline');

      const stats = await statsResponse.json();
      const timelineData = await timelineResponse.json();

      this.setState(
        {
          stats,
          timeline: timelineData.timeline || [],
          loading: false,
        },
        () => {
          // Render charts after state update
          this.renderCharts();
        }
      );
    } catch (error) {
      console.error('Failed to load analytics data:', error);
      this.setState({ error: error.message, loading: false });
    }
  }

  renderCharts() {
    // Wait for Chart.js to be available
    if (!window.Chart) {
      console.error('Chart.js not loaded');
      return;
    }

    this.renderTimelineChart();
    this.renderToolChart();
  }

  renderTimelineChart() {
    const { timeline } = this.state;

    if (!this.timelineCanvasRef || timeline.length === 0) return;

    // Destroy existing chart
    if (this.timelineChart) {
      this.timelineChart.destroy();
    }

    const ctx = this.timelineCanvasRef.getContext('2d');

    this.timelineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeline.map((entry) => formatChartDate(entry.date)),
        datasets: [
          {
            label: 'Tokens',
            data: timeline.map((entry) => entry.tokens),
            borderColor: '#60a5fa', // blue-400
            backgroundColor: 'rgba(96, 165, 250, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Observations',
            data: timeline.map((entry) => entry.observations),
            borderColor: '#4ade80', // green-400
            backgroundColor: 'rgba(74, 222, 128, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: '#d1d5db', // gray-300
              font: {
                size: 12,
              },
            },
          },
          tooltip: {
            backgroundColor: '#1f2937', // gray-800
            titleColor: '#f3f4f6', // gray-100
            bodyColor: '#d1d5db', // gray-300
            borderColor: '#374151', // gray-700
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            grid: {
              color: '#374151', // gray-700
            },
            ticks: {
              color: '#9ca3af', // gray-400
            },
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            grid: {
              color: '#374151', // gray-700
            },
            ticks: {
              color: '#9ca3af', // gray-400
              callback: function (value) {
                return formatLargeNumber(value);
              },
            },
            title: {
              display: true,
              text: 'Tokens',
              color: '#60a5fa', // blue-400
            },
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              color: '#9ca3af', // gray-400
            },
            title: {
              display: true,
              text: 'Observations',
              color: '#4ade80', // green-400
            },
          },
        },
      },
    });
  }

  renderToolChart() {
    const { stats } = this.state;

    if (!this.toolCanvasRef || !stats || !stats.tokens_by_tool) return;

    // Destroy existing chart
    if (this.toolChart) {
      this.toolChart.destroy();
    }

    // Sort tools by token count descending
    const toolEntries = Object.entries(stats.tokens_by_tool).sort((a, b) => b[1] - a[1]);
    const toolNames = toolEntries.map(([name]) => name);
    const toolTokens = toolEntries.map(([, tokens]) => tokens);
    const toolColors = toolNames.map((name) => getToolColor(name));

    const ctx = this.toolCanvasRef.getContext('2d');

    this.toolChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: toolNames,
        datasets: [
          {
            label: 'Tokens by Tool',
            data: toolTokens,
            backgroundColor: toolColors.map((color) => color + '80'), // Add transparency
            borderColor: toolColors,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y', // Horizontal bars
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: '#1f2937', // gray-800
            titleColor: '#f3f4f6', // gray-100
            bodyColor: '#d1d5db', // gray-300
            borderColor: '#374151', // gray-700
            borderWidth: 1,
            callbacks: {
              label: function (context) {
                return `${context.parsed.x.toLocaleString()} tokens`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: '#374151', // gray-700
            },
            ticks: {
              color: '#9ca3af', // gray-400
              callback: function (value) {
                return formatLargeNumber(value);
              },
            },
          },
          y: {
            grid: {
              display: false,
            },
            ticks: {
              color: '#9ca3af', // gray-400
            },
          },
        },
      },
    });
  }

  handleDaysChange = (e) => {
    const days = parseInt(e.target.value, 10);
    this.setState({ days }, () => this.loadData());
  };

  renderSummaryCards() {
    const { stats } = this.state;

    if (!stats) return null;

    const budgetUtilization =
      stats.token_budget > 0 ? (stats.typical_injection_tokens / stats.token_budget) * 100 : 0;

    return html`
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <!-- Total Observations -->
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-gray-400 text-sm mb-1">Total Observations</div>
          <div class="text-2xl font-bold text-white">${formatLargeNumber(stats.total_observations)}</div>
          <div class="text-xs text-gray-500 mt-1">
            ${(stats.total_observations || 0).toLocaleString()} total
          </div>
        </div>

        <!-- Total Sessions -->
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-gray-400 text-sm mb-1">Total Sessions</div>
          <div class="text-2xl font-bold text-white">${formatLargeNumber(stats.total_sessions)}</div>
          <div class="text-xs text-gray-500 mt-1">${(stats.total_sessions || 0).toLocaleString()} total</div>
        </div>

        <!-- Total Tokens -->
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-gray-400 text-sm mb-1">Total Tokens</div>
          <div class="text-2xl font-bold text-white">${formatLargeNumber(stats.total_tokens)}</div>
          <div class="text-xs text-gray-500 mt-1">${(stats.total_tokens || 0).toLocaleString()} total</div>
        </div>

        <!-- Avg Tokens per Session -->
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-gray-400 text-sm mb-1">Avg Tokens/Session</div>
          <div class="text-2xl font-bold text-white">
            ${formatLargeNumber(Math.round(stats.avg_tokens_per_session))}
          </div>
          <div class="text-xs text-gray-500 mt-1">
            ${Math.round(stats.avg_tokens_per_session || 0).toLocaleString()} avg
          </div>
        </div>

        <!-- Token Budget Usage -->
        <div class="bg-gray-800 rounded-lg p-4 sm:col-span-2">
          <div class="text-gray-400 text-sm mb-1">Token Budget Utilization</div>
          <div class="flex items-baseline gap-2">
            <div class="text-2xl font-bold text-white">
              ${formatLargeNumber(stats.typical_injection_tokens)}
            </div>
            <div class="text-sm text-gray-500">
              / ${formatLargeNumber(stats.token_budget)} budget
            </div>
          </div>
          <div class="mt-2">
            <div class="bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                class="${budgetUtilization > 90 ? 'bg-red-500' : budgetUtilization > 70 ? 'bg-yellow-500' : 'bg-green-500'}"
                style="width: ${Math.min(budgetUtilization, 100)}%; height: 100%;"
              ></div>
            </div>
            <div class="text-xs text-gray-500 mt-1">${budgetUtilization.toFixed(1)}% of budget</div>
          </div>
        </div>

        <!-- Avg Tokens per Observation -->
        <div class="bg-gray-800 rounded-lg p-4 sm:col-span-2">
          <div class="text-gray-400 text-sm mb-1">Avg Tokens/Observation</div>
          <div class="text-2xl font-bold text-white">
            ${formatLargeNumber(Math.round(stats.avg_tokens_per_observation))}
          </div>
          <div class="text-xs text-gray-500 mt-1">
            ${Math.round(stats.avg_tokens_per_observation || 0).toLocaleString()} avg
          </div>
        </div>
      </div>
    `;
  }

  renderTimeframeSelector() {
    const { days } = this.state;

    return html`
      <div class="flex items-center gap-2 mb-4">
        <label class="text-sm text-gray-400">Timeframe:</label>
        <select
          class="bg-gray-700 text-white border border-gray-600 rounded px-3 py-1 text-sm
                 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          onChange=${this.handleDaysChange}
          value=${days}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="60">Last 60 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>
    `;
  }

  render() {
    const { loading, error, stats, timeline } = this.state;

    if (loading) {
      return html`
        <div class="text-center py-20">
          <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          <div class="text-gray-500 mt-4">Loading analytics...</div>
        </div>
      `;
    }

    if (error) {
      return html`
        <div class="text-center py-20">
          <div class="text-red-500 text-lg mb-4">Error Loading Analytics</div>
          <div class="text-gray-500">${error}</div>
          <button
            class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
            onClick=${() => this.loadData()}
          >
            Retry
          </button>
        </div>
      `;
    }

    if (!stats) {
      return html`
        <div class="text-center py-20">
          <div class="text-gray-500 text-lg">No data available</div>
        </div>
      `;
    }

    return html`
      <div>
        ${this.renderSummaryCards()}

        ${this.renderTimeframeSelector()}

        <!-- Charts Grid -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Timeline Chart -->
          <div class="bg-gray-800 rounded-lg p-4">
            <h3 class="text-lg font-semibold text-white mb-4">Token Usage Over Time</h3>
            <div style="height: 300px; position: relative;">
              ${timeline.length > 0
                ? html`<canvas ref=${(el) => (this.timelineCanvasRef = el)}></canvas>`
                : html`
                    <div class="flex items-center justify-center h-full text-gray-500">
                      No timeline data available
                    </div>
                  `}
            </div>
          </div>

          <!-- Tool Distribution Chart -->
          <div class="bg-gray-800 rounded-lg p-4">
            <h3 class="text-lg font-semibold text-white mb-4">Tokens by Tool</h3>
            <div style="height: 300px; position: relative;">
              ${stats.tokens_by_tool && Object.keys(stats.tokens_by_tool).length > 0
                ? html`<canvas ref=${(el) => (this.toolCanvasRef = el)}></canvas>`
                : html`
                    <div class="flex items-center justify-center h-full text-gray-500">
                      No tool data available
                    </div>
                  `}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
