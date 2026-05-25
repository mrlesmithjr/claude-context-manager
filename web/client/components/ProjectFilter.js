/**
 * ProjectFilter Component
 *
 * Dropdown selector for filtering by project path.
 * Shows observation count per project.
 */

import { html, Component } from '/vendor/preact-htm.js';

/**
 * Shorten project path for display (show last 2-3 segments)
 */
function shortenPath(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;

  // Show last 3 parts with ellipsis
  return '.../' + parts.slice(-3).join('/');
}

/**
 * ProjectFilter Component
 */
export class ProjectFilter extends Component {
  constructor(props) {
    super(props);
    this.state = {
      projects: [],
      loading: false,
      error: null,
    };
  }

  componentDidMount() {
    this.loadProjects();
  }

  async loadProjects() {
    this.setState({ loading: true, error: null });

    try {
      const response = await fetch('/api/projects');
      if (!response.ok) throw new Error('Failed to load projects');

      const data = await response.json();
      this.setState({
        projects: data.projects,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to load projects:', error);
      this.setState({ error: error.message, loading: false });
    }
  }

  handleChange = (e) => {
    const value = e.target.value;
    const project = value === '' ? null : value;
    this.props.onProjectChange(project);
  };

  render() {
    const { selectedProject } = this.props;
    const { projects, loading, error } = this.state;

    if (loading) {
      return html`
        <div class="text-gray-500 text-sm">Loading projects...</div>
      `;
    }

    if (error) {
      return html`
        <div class="text-red-500 text-sm">Failed to load projects</div>
      `;
    }

    return html`
      <div class="relative">
        <label for="project-filter" class="block text-sm font-medium text-gray-400 mb-1">
          Filter by Project
        </label>
        <select
          id="project-filter"
          class="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          onChange=${this.handleChange}
          value=${selectedProject || ''}
        >
          <option value="">All Projects (${projects.reduce((sum, p) => sum + p.observation_count, 0).toLocaleString()})</option>
          ${projects.map(
            (project) => html`
              <option value=${project.path} title=${project.path}>
                ${shortenPath(project.path)} (${project.observation_count.toLocaleString()})
              </option>
            `
          )}
        </select>

        <!-- Dropdown icon -->
        <div class="absolute right-3 top-9 pointer-events-none text-gray-400">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>
    `;
  }
}
