/**
 * TokenAnalytics Component
 *
 * Analytics dashboard with charts and statistics.
 */

import { html, Component } from '/vendor/preact-htm.js';

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

const TAG_COLORS = [
  '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#f472b6',
  '#22d3ee', '#fb923c', '#a78bfa', '#2dd4bf', '#f87171',
];

const PROJ_COLORS = [
  '#60a5fa', '#4ade80', '#facc15', '#c084fc',
  '#f472b6', '#22d3ee', '#fb923c', '#a78bfa',
];

/**
 * TokenAnalytics Component
 */
export class TokenAnalytics extends Component {
  constructor(props) {
    super(props);
    this.state = {
      stats: null,
      timeline: [],
      fileTouchData: [],
      tagTrendData: [],
      velocityData: [],
      loading: true,
      error: null,
      days: 30,
    };

    this.timelineChart = null;
    this.toolChart = null;
    this.fileTouchChart = null;
    this.tagTrendChart = null;
    this.velocityChart = null;

    this.timelineCanvasRef = null;
    this.toolCanvasRef = null;
    this.fileTouchCanvasRef = null;
    this.tagTrendCanvasRef = null;
    this.velocityCanvasRef = null;
  }

  componentDidMount() {
    this.setupChartDefaults();
    // In network mode, skip the initial fetch until a project is selected
    if (this.props.projectRequired && !this.props.project) return;
    this.loadData();
  }

  componentDidUpdate(prevProps) {
    // Reload when project filter changes
    if (prevProps.project !== this.props.project) {
      // In network mode, skip the fetch if no project is selected
      if (this.props.projectRequired && !this.props.project) return;
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
    if (this.fileTouchChart) this.fileTouchChart.destroy();
    if (this.tagTrendChart) this.tagTrendChart.destroy();
    if (this.velocityChart) this.velocityChart.destroy();
  }

  setupChartDefaults() {
    // Configure Chart.js defaults for dark mode
    if (window.Chart) {
      Chart.defaults.color = '#9ca3af'; // gray-400
      Chart.defaults.borderColor = '#374151'; // gray-700
    }
  }

  async loadData() {
    // Guard: do not fetch without a project in network mode
    if (this.props.projectRequired && !this.props.project) return;

    const { project } = this.props;
    const { days } = this.state;

    this.setState({ loading: true, error: null });

    try {
      const statsParams = new URLSearchParams();
      if (project) statsParams.append('project', project);

      const timelineParams = new URLSearchParams({ days: String(days) });
      if (project) timelineParams.append('project', project);

      // Tag trend and velocity always use a fixed 12-week window regardless of
      // the timeframe dropdown (which controls the token timeline and file touch
      // chart). These two charts need a longer horizon to show meaningful trends.
      const tagTrendParams = new URLSearchParams({ weeks: '12' });
      if (project) tagTrendParams.append('project', project);
      const velocityParams = new URLSearchParams({ weeks: '12' });
      if (project) velocityParams.append('project', project);

      const fileTouchParams = new URLSearchParams({ days: String(days) });
      if (project) fileTouchParams.append('project', project);

      const [statsResponse, timelineResponse, fileTouchResponse, tagTrendResponse, velocityResponse] =
        await Promise.all([
          apiFetch(`/api/stats?${statsParams}`),
          apiFetch(`/api/stats/timeline?${timelineParams}`),
          apiFetch(`/api/stats/file-touch-frequency?${fileTouchParams}`),
          apiFetch(`/api/stats/tag-trend?${tagTrendParams}`),
          apiFetch(`/api/stats/project-velocity?${velocityParams}`),
        ]);

      if (!statsResponse.ok) throw new Error('Failed to load stats');
      if (!timelineResponse.ok) throw new Error('Failed to load timeline');

      const stats = await statsResponse.json();
      const timelineData = await timelineResponse.json();
      const fileTouchData = fileTouchResponse.ok
        ? (await fileTouchResponse.json()).file_touch_frequency
        : [];
      const tagTrendData = tagTrendResponse.ok
        ? (await tagTrendResponse.json()).tag_trend
        : [];
      const velocityData = velocityResponse.ok
        ? (await velocityResponse.json()).project_velocity
        : [];

      this.setState(
        {
          stats,
          timeline: timelineData.timeline || [],
          fileTouchData,
          tagTrendData,
          velocityData,
          loading: false,
        },
        () => {
          // Render charts after state update
          this.renderCharts();
          this.drawTrendCharts();
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

  drawTrendCharts() {
    if (!window.Chart) return;
    this.drawFileTouchChart();
    this.drawTagTrendChart();
    this.drawVelocityChart();
  }

  drawFileTouchChart() {
    const { fileTouchData } = this.state;
    if (this.fileTouchChart) { this.fileTouchChart.destroy(); this.fileTouchChart = null; }
    if (!this.fileTouchCanvasRef || !fileTouchData || fileTouchData.length < 2) return;

    const labels = fileTouchData.map((d) => {
      const parts = d.file_path.split('/').filter(Boolean);
      return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : d.file_path;
    });

    this.fileTouchChart = new Chart(this.fileTouchCanvasRef, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Touch count',
            data: fileTouchData.map((d) => d.touch_count),
            backgroundColor: '#60a5fa',
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1f2937',
            titleColor: '#f3f4f6',
            bodyColor: '#d1d5db',
            borderColor: '#374151',
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0, color: '#9ca3af' },
            grid: { color: '#374151' },
          },
          y: {
            ticks: { font: { size: 11 }, color: '#9ca3af' },
            grid: { display: false },
          },
        },
      },
    });
  }

  drawTagTrendChart() {
    const { tagTrendData } = this.state;
    if (this.tagTrendChart) { this.tagTrendChart.destroy(); this.tagTrendChart = null; }
    if (!this.tagTrendCanvasRef || !tagTrendData || tagTrendData.length === 0) return;

    const weeks = [...new Set(tagTrendData.map((d) => d.week))].sort();
    const tags = [...new Set(tagTrendData.map((d) => d.tag))];

    if (weeks.length < 2) return;

    const weekLabels = weeks.map((w) => {
      const d = new Date(w);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const datasets = tags.map((tag, i) => {
      const countsByWeek = new Map(
        tagTrendData.filter((d) => d.tag === tag).map((d) => [d.week, d.count])
      );
      return {
        label: tag,
        data: weeks.map((w) => countsByWeek.get(w) || 0),
        borderColor: TAG_COLORS[i % TAG_COLORS.length],
        backgroundColor: TAG_COLORS[i % TAG_COLORS.length] + '33',
        fill: true,
        tension: 0.3,
      };
    });

    this.tagTrendChart = new Chart(this.tagTrendCanvasRef, {
      type: 'line',
      data: { labels: weekLabels, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 12, font: { size: 11 }, color: '#9ca3af' },
          },
          tooltip: {
            backgroundColor: '#1f2937',
            titleColor: '#f3f4f6',
            bodyColor: '#d1d5db',
            borderColor: '#374151',
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            ticks: { maxRotation: 45, color: '#9ca3af' },
            grid: { color: '#374151' },
          },
          y: {
            beginAtZero: true,
            stacked: true,
            ticks: { precision: 0, color: '#9ca3af' },
            grid: { color: '#374151' },
          },
        },
      },
    });
  }

  drawVelocityChart() {
    const { velocityData } = this.state;
    if (this.velocityChart) { this.velocityChart.destroy(); this.velocityChart = null; }
    if (!this.velocityCanvasRef || !velocityData || velocityData.length === 0) return;

    const weeks = [...new Set(velocityData.map((d) => d.week))].sort();
    const projects = [...new Set(velocityData.map((d) => d.project))];

    if (weeks.length < 2) return;

    const weekLabels = weeks.map((w) => {
      const d = new Date(w);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const datasets = projects.map((proj, i) => {
      const byWeek = new Map(
        velocityData.filter((d) => d.project === proj).map((d) => [d.week, d.observations])
      );
      const parts = proj.split('/').filter(Boolean);
      const label = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : proj;
      return {
        label,
        data: weeks.map((w) => byWeek.get(w) || 0),
        backgroundColor: PROJ_COLORS[i % PROJ_COLORS.length] + 'bb',
        borderRadius: 3,
      };
    });

    this.velocityChart = new Chart(this.velocityCanvasRef, {
      type: 'bar',
      data: { labels: weekLabels, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 12, font: { size: 11 }, color: '#9ca3af' },
          },
          tooltip: {
            backgroundColor: '#1f2937',
            titleColor: '#f3f4f6',
            bodyColor: '#d1d5db',
            borderColor: '#374151',
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#9ca3af' },
            grid: { color: '#374151' },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { precision: 0, color: '#9ca3af' },
            grid: { color: '#374151' },
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
    const { loading, error, stats, timeline, fileTouchData, tagTrendData, velocityData, days } =
      this.state;

    // In network mode, require a project selection before showing anything
    if (this.props.projectRequired && !this.props.project) {
      return html`
        <div class="text-center py-16 text-gray-500">Select a project above to view analytics.</div>
      `;
    }

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

    const tagWeekCount = [...new Set(tagTrendData.map((d) => d.week))].length;
    const velocityWeekCount = [...new Set(velocityData.map((d) => d.week))].length;

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

        <!-- File Touch Frequency -->
        <div class="bg-gray-800 rounded-lg p-4 mt-6">
          <h3 class="text-sm font-medium text-gray-400 mb-3">Most Touched Files (last ${days} days)</h3>
          ${fileTouchData.length < 2
            ? html`<p class="text-gray-500 text-sm text-center py-4">Not enough data yet.</p>`
            : html`<canvas ref=${(el) => { this.fileTouchCanvasRef = el; }} height="220"></canvas>`}
        </div>

        <!-- Tag Frequency Trend -->
        <div class="bg-gray-800 rounded-lg p-4 mt-6">
          <h3 class="text-sm font-medium text-gray-400 mb-3">Tag Trend (last 12 weeks)</h3>
          ${tagWeekCount < 2
            ? html`<p class="text-gray-500 text-sm text-center py-4">Not enough data yet (need 2+ weeks).</p>`
            : html`<canvas ref=${(el) => { this.tagTrendCanvasRef = el; }} height="200"></canvas>`}
        </div>

        <!-- Project Velocity -->
        <div class="bg-gray-800 rounded-lg p-4 mt-6">
          <h3 class="text-sm font-medium text-gray-400 mb-3">Project Velocity (last 12 weeks)</h3>
          ${velocityWeekCount < 2
            ? html`<p class="text-gray-500 text-sm text-center py-4">Not enough data yet (need 2+ weeks).</p>`
            : html`<canvas ref=${(el) => { this.velocityCanvasRef = el; }} height="200"></canvas>`}
        </div>
      </div>
    `;
  }
}
