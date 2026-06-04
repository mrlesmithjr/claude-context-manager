/**
 * SkillStats Component
 *
 * Displays skill and agent invocation statistics tracked from session observations.
 * Supports list view (all skills) and detail view (single skill + attributed lessons).
 * refs #232
 */

import { html, Component } from '/vendor/preact-htm.js';
import { formatRelativeTime, getLessonTypeLabel, getLessonTypeColor } from './utils.js';

const DAYS_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

/**
 * Returns badge color classes for a tool_name value.
 * Skill = blue, Agent = purple, Task = gray, unknown = gray.
 */
function getToolTypeBadge(toolName) {
  switch (toolName) {
    case 'Skill':  return 'bg-blue-500/20 text-blue-300';
    case 'Agent':  return 'bg-purple-500/20 text-purple-300';
    case 'Task':   return 'bg-gray-500/20 text-gray-300';
    default:       return 'bg-gray-500/20 text-gray-300';
  }
}

/**
 * SkillStats Component
 */
export class SkillStats extends Component {
  constructor(props) {
    super(props);
    this.state = {
      skills: [],
      total: 0,
      loading: false,
      error: null,
      hasLoaded: false,
      selectedSkill: null,
      detailLessons: [],
      detailLoading: false,
      detailError: null,
      days: '',
    };
  }

  componentDidMount() {
    
    this.loadSkills();
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.project !== this.props.project) {
      
      // Reset detail view when project changes
      this.setState({ selectedSkill: null, detailLessons: [] }, () => this.loadSkills());
      return;
    }
    if (prevState.days !== this.state.days) {
      this.loadSkills();
    }
  }

  handleDaysChange = (e) => {
    this.setState({ days: e.target.value, selectedSkill: null, detailLessons: [] });
  };

  buildParams(extra = {}) {
    const { project } = this.props;
    const { days } = this.state;
    const params = new URLSearchParams();
    if (project) params.append('project', project);
    if (days) params.append('days', days);
    Object.entries(extra).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
    });
    return params;
  }

  async loadSkills() {
    this.setState({ loading: true, error: null });

    try {
      const params = this.buildParams({ limit: 50 });
      const response = await apiFetch(`/api/skills?${params}`);
      if (!response.ok) throw new Error('Failed to load skills');

      const data = await response.json();
      this.setState({
        skills: data.skills || [],
        total: data.total || 0,
        loading: false,
        hasLoaded: true,
      });
    } catch (error) {
      console.error('Failed to load skills:', error);
      this.setState({ error: error.message, loading: false, hasLoaded: true });
    }
  }

  handleSkillClick = async (skill) => {
    this.setState({ selectedSkill: skill, detailLessons: [], detailLoading: true, detailError: null });

    try {
      const params = this.buildParams();
      const response = await apiFetch(`/api/skills/${encodeURIComponent(skill.skill)}?${params}`);
      if (!response.ok) throw new Error('Failed to load skill detail');

      const data = await response.json();
      this.setState({
        detailLessons: data.lessons || [],
        detailLoading: false,
      });
    } catch (error) {
      console.error('Failed to load skill detail:', error);
      this.setState({ detailLoading: false, detailError: error.message });
    }
  };

  handleBack = () => {
    this.setState({ selectedSkill: null, detailLessons: [], detailError: null });
  };

  renderToolTypeBadge(toolName) {
    const colorClass = getToolTypeBadge(toolName);
    const label = toolName || 'Unknown';
    return html`
      <span class="px-2 py-0.5 text-xs font-semibold rounded ${colorClass}">
        ${label}
      </span>
    `;
  }

  renderLessonTypeBadge(lessonType) {
    const colorClass = getLessonTypeColor(lessonType);
    const label = getLessonTypeLabel(lessonType);
    return html`
      <span class="px-2 py-0.5 text-xs font-semibold rounded ${colorClass}">
        ${label}
      </span>
    `;
  }

  renderSkillRow(skill) {
    return html`
      <div
        key=${skill.skill}
        class="bg-gray-800 rounded-lg px-4 py-3 flex items-center gap-4 hover:bg-gray-750 transition-colors cursor-pointer"
        onClick=${() => this.handleSkillClick(skill)}
      >
        <!-- Skill name -->
        <div class="flex-1 min-w-0">
          <button
            class="text-sm font-medium text-blue-400 hover:text-blue-300 truncate text-left"
            onClick=${(e) => { e.stopPropagation(); this.handleSkillClick(skill); }}
          >
            ${skill.skill}
          </button>
        </div>

        <!-- Tool type badge -->
        <div class="flex-shrink-0">
          ${this.renderToolTypeBadge(skill.tool_name)}
        </div>

        <!-- Invocation count -->
        <div class="flex-shrink-0 text-sm font-bold text-white w-12 text-right">
          ${skill.invocation_count}
        </div>

        <!-- Last used -->
        <div class="flex-shrink-0 text-xs text-gray-400 w-28 text-right hidden sm:block">
          ${skill.last_used ? formatRelativeTime(skill.last_used) : 'never'}
        </div>

        <!-- Chevron -->
        <svg class="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    `;
  }

  renderListView() {
    const { skills, total, loading, error, days, hasLoaded } = this.state;

    return html`
      <div>
        <!-- Controls -->
        <div class="bg-gray-800 rounded-lg p-4 mb-6">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div class="text-sm text-gray-400">
              ${hasLoaded && !loading ? html`<span class="font-medium text-white">${total}</span> skill${total !== 1 ? 's' : ''} tracked` : null}
            </div>
            <div class="sm:w-48">
              <label for="skills-days-filter" class="block text-xs font-medium text-gray-400 mb-1">
                Time Range
              </label>
              <div class="relative">
                <select
                  id="skills-days-filter"
                  class="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  onChange=${this.handleDaysChange}
                  value=${days}
                >
                  ${DAYS_OPTIONS.map((opt) => html`
                    <option value=${opt.value}>${opt.label}</option>
                  `)}
                </select>
                <div class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>

        ${loading && html`
          <div class="text-center py-20">
            <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            <div class="text-gray-500 mt-4">Loading skills...</div>
          </div>
        `}

        ${error && html`
          <div class="text-center py-20">
            <div class="text-red-500 text-lg mb-4">Error Loading Skills</div>
            <div class="text-gray-500">${error}</div>
            <button
              class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              onClick=${() => this.loadSkills()}
            >
              Retry
            </button>
          </div>
        `}

        ${!loading && !error && skills.length === 0 && hasLoaded && html`
          <div class="text-center py-20">
            <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <h3 class="text-xl font-semibold text-gray-400 mb-2">No Skills Tracked Yet</h3>
            <p class="text-gray-500 max-w-md mx-auto">
              Skills are recorded when Claude Code invokes Skill, Agent, or Task tools during sessions.
            </p>
          </div>
        `}

        ${!loading && !error && skills.length > 0 && html`
          <div>
            <!-- Table header -->
            <div class="hidden sm:flex items-center gap-4 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              <div class="flex-1">Skill / Agent</div>
              <div class="flex-shrink-0 w-16">Type</div>
              <div class="flex-shrink-0 w-12 text-right">Uses</div>
              <div class="flex-shrink-0 w-28 text-right">Last Used</div>
              <div class="flex-shrink-0 w-4"></div>
            </div>
            <div class="space-y-2">
              ${skills.map((s) => this.renderSkillRow(s))}
            </div>
          </div>
        `}
      </div>
    `;
  }

  renderDetailView() {
    const { selectedSkill, detailLessons, detailLoading, detailError } = this.state;

    if (!selectedSkill) return null;

    return html`
      <div>
        <!-- Back button -->
        <button
          class="flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6 transition-colors"
          onClick=${this.handleBack}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          All Skills
        </button>

        <!-- Skill heading -->
        <div class="bg-gray-800 rounded-lg p-6 mb-6">
          <div class="flex items-center gap-3 mb-4">
            <h2 class="text-xl font-bold text-white">${selectedSkill.skill}</h2>
            ${this.renderToolTypeBadge(selectedSkill.tool_name)}
          </div>

          <!-- Stats row -->
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <div class="text-xs text-gray-500 uppercase tracking-wide mb-1">Invocations</div>
              <div class="text-2xl font-bold text-white">${selectedSkill.invocation_count}</div>
            </div>
            <div>
              <div class="text-xs text-gray-500 uppercase tracking-wide mb-1">First Used</div>
              <div class="text-sm text-gray-300">
                ${selectedSkill.first_used ? formatRelativeTime(selectedSkill.first_used) : 'unknown'}
              </div>
            </div>
            <div>
              <div class="text-xs text-gray-500 uppercase tracking-wide mb-1">Last Used</div>
              <div class="text-sm text-gray-300">
                ${selectedSkill.last_used ? formatRelativeTime(selectedSkill.last_used) : 'unknown'}
              </div>
            </div>
          </div>
        </div>

        <!-- Lessons section -->
        <div>
          <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
            Attributed Lessons
          </h3>

          ${detailLoading && html`
            <div class="text-center py-10">
              <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <div class="text-gray-500 mt-3 text-sm">Loading lessons...</div>
            </div>
          `}

          ${!detailLoading && detailError && html`
            <div class="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-3 text-sm text-red-300">
              Failed to load lessons: ${detailError}
            </div>
          `}

          ${!detailLoading && !detailError && detailLessons.length === 0 && html`
            <div class="bg-gray-800 rounded-lg px-4 py-8 text-center text-gray-500 text-sm">
              No attributed lessons for this skill.
              Lessons are captured from errors and failures during sessions where this skill was active.
            </div>
          `}

          ${!detailLoading && !detailError && detailLessons.length > 0 && html`
            <div class="space-y-3">
              ${detailLessons.map((lesson, i) => html`
                <div key=${i} class="bg-gray-800 rounded-lg px-4 py-3">
                  <div class="flex items-center gap-2 flex-wrap mb-2">
                    ${this.renderLessonTypeBadge(lesson.lesson_type)}
                    <span class="text-xs text-gray-500">
                      ${formatRelativeTime(lesson.created_at)}
                    </span>
                  </div>
                  <div class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                    ${lesson.content}
                  </div>
                </div>
              `)}
            </div>
          `}
        </div>
      </div>
    `;
  }

  render() {
    const { selectedSkill } = this.state;


    return html`
      <div>
        ${selectedSkill ? this.renderDetailView() : this.renderListView()}
      </div>
    `;
  }
}
