/**
 * LessonsView Component
 *
 * Browsable view of error/failure lessons captured from sessions.
 * refs #129
 */

import { html, Component } from '/vendor/preact-htm.js';
import {
  formatRelativeTime,
  parseTags,
  getImportanceBadge,
  getLessonTypeLabel,
  getLessonTypeColor,
  escapeHtml,
} from './utils.js';

/**
 * Get badge color for tool type (mirrors ObservationSearch.js).
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

const LESSON_TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'error', label: 'Error' },
  { value: 'build_failure', label: 'Build Failure' },
  { value: 'test_failure', label: 'Test Failure' },
  { value: 'permission_denied', label: 'Permission Denied' },
];

const DAYS_OPTIONS = [
  { value: undefined, label: 'All time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];

/**
 * LessonsView Component
 */
export class LessonsView extends Component {
  constructor(props) {
    super(props);
    this.state = {
      query: '',
      lessonType: '',
      days: undefined,
      lessons: [],
      total: 0,
      loading: false,
      error: null,
      expandedLesson: null,
      hasLoaded: false,
    };

    this.debounceTimer = null;
  }

  componentDidMount() {
    if (this.props.projectRequired && !this.props.project) return;
    this.loadLessons();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.project !== this.props.project) {
      if (this.props.projectRequired && !this.props.project) return;
      this.loadLessons();
    }
  }

  handleQueryChange = (e) => {
    const query = e.target.value;
    this.setState({ query });

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.loadLessons();
    }, 300);
  };

  handleLessonTypeChange = (e) => {
    this.setState({ lessonType: e.target.value }, () => this.loadLessons());
  };

  handleDaysChange = (e) => {
    const val = e.target.value;
    const days = val ? Number(val) : undefined;
    this.setState({ days }, () => this.loadLessons());
  };

  async loadLessons() {
    const { query, lessonType, days } = this.state;
    const { project } = this.props;

    this.setState({ loading: true, error: null });

    try {
      const params = new URLSearchParams({ limit: 20 });
      if (query.trim()) params.append('q', query.trim());
      if (project) params.append('project', project);
      if (lessonType) params.append('lesson_type', lessonType);
      if (days) params.append('days', String(days));

      const response = await apiFetch(`/api/lessons?${params}`);
      if (!response.ok) throw new Error('Failed to load lessons');

      const data = await response.json();
      this.setState({
        lessons: data.lessons,
        total: data.total,
        loading: false,
        hasLoaded: true,
      });
    } catch (error) {
      console.error('Failed to load lessons:', error);
      this.setState({ error: error.message, loading: false, hasLoaded: true });
    }
  }

  handleLessonClick = (id) => {
    const { expandedLesson } = this.state;
    this.setState({ expandedLesson: expandedLesson === id ? null : id });
  };

  renderLessonCard(lesson) {
    const { expandedLesson } = this.state;
    const isExpanded = expandedLesson === lesson.id;
    const tags = parseTags(lesson.tags);
    const { label: impLabel, colorClass: impColor } = getImportanceBadge(
      lesson.importance,
      lesson.importance_score
    );
    const typeColor = getLessonTypeColor(lesson.lesson_type);
    const typeLabel = getLessonTypeLabel(lesson.lesson_type);

    return html`
      <div class="bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-750 transition-colors">
        <div
          class="px-4 py-3 cursor-pointer"
          onClick=${() => this.handleLessonClick(lesson.id)}
        >
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-2 flex-wrap">
              <!-- Lesson type badge -->
              <span class="px-2 py-0.5 text-xs font-semibold rounded ${typeColor}">
                ${typeLabel}
              </span>
              <!-- Importance badge -->
              ${impLabel ? html`
                <span class="px-2 py-0.5 text-xs font-semibold rounded ${impColor}">
                  ${impLabel}
                </span>
              ` : null}
              <!-- Timestamp -->
              <span class="text-xs text-gray-500">
                ${formatRelativeTime(lesson.created_at)}
              </span>
              <!-- Branch -->
              ${lesson.branch ? html`
                <span class="px-2 py-0.5 text-xs rounded bg-gray-600/50 text-gray-400">
                  &#x2387; ${lesson.branch}
                </span>
              ` : null}
              <!-- Tags -->
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

          <!-- Summary preview -->
          <div class="mt-2 text-sm text-gray-300 line-clamp-2">
            ${lesson.summary}
          </div>
        </div>

        <!-- Expanded detail -->
        ${isExpanded && html`
          <div class="border-t border-gray-700 bg-gray-850 px-4 py-3 space-y-3">
            <!-- Full summary -->
            <div>
              <h5 class="text-xs font-semibold text-gray-400 mb-1">Summary</h5>
              <div class="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
                ${lesson.summary}
              </div>
            </div>

            <!-- Files touched -->
            ${lesson.files_touched && lesson.files_touched.length > 0 ? html`
              <div>
                <h5 class="text-xs font-semibold text-gray-400 mb-1">Files Touched</h5>
                <div class="space-y-1">
                  ${lesson.files_touched.slice(0, 5).map((f) => html`
                    <div class="text-xs font-mono text-gray-300">${f}</div>
                  `)}
                  ${lesson.files_touched.length > 5 ? html`
                    <div class="text-xs text-gray-500">+${lesson.files_touched.length - 5} more</div>
                  ` : null}
                </div>
              </div>
            ` : null}

            <!-- Tool name -->
            ${lesson.tool_name ? html`
              <div>
                <h5 class="text-xs font-semibold text-gray-400 mb-1">Tool</h5>
                <span class="px-2 py-1 text-xs font-mono font-semibold rounded ${getToolColor(lesson.tool_name)}">
                  ${lesson.tool_name}
                </span>
              </div>
            ` : null}

            <!-- Project and session -->
            <div class="flex flex-wrap gap-4 pt-1 border-t border-gray-700">
              ${lesson.project ? html`
                <div class="text-xs text-gray-500 font-mono">${lesson.project}</div>
              ` : null}
              ${lesson.session_id ? html`
                <div class="text-xs text-gray-600 font-mono">
                  session: ${lesson.session_id.slice(0, 8)}
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
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <h3 class="text-xl font-semibold text-gray-400 mb-2">No Lessons Found</h3>
        <p class="text-gray-500">
          ${query.trim()
            ? `No lessons matching "${escapeHtml(query)}"`
            : 'Lessons are captured from errors and failures during sessions'}
        </p>
      </div>
    `;
  }

  render() {
    const { lessons, total, loading, error, query, lessonType, days } = this.state;

    if (this.props.projectRequired && !this.props.project) {
      return html`
        <div class="text-center py-16 text-gray-500">Select a project above to view lessons.</div>
      `;
    }

    return html`
      <div>
        <!-- Clarification note -->
        <div class="bg-gray-800/50 border border-gray-700 rounded-lg px-4 py-3 mb-4 text-sm text-gray-400">
          These are <span class="text-gray-300 font-medium">error lessons</span> — automatically captured from failed tool calls (Bash errors, build failures, permission denials). They are stored in the database.
          For per-skill experience notes that inject before a skill loads, see <span class="text-gray-300 font-mono text-xs">context_skill_lessons</span> and the <span class="text-gray-300 font-mono text-xs">.lessons.md</span> sidecar files described in the setup guide.
        </div>
        <!-- Controls -->
        <div class="bg-gray-800 rounded-lg p-4 mb-6">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <!-- Search -->
            <div>
              <label for="lessons-search" class="block text-sm font-medium text-gray-400 mb-2">
                Search Lessons
              </label>
              <div class="relative">
                <input
                  id="lessons-search"
                  type="text"
                  class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2 pr-10
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Filter lessons..."
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

            <!-- Lesson type filter -->
            <div>
              <label for="lesson-type-filter" class="block text-sm font-medium text-gray-400 mb-2">
                Lesson Type
              </label>
              <div class="relative">
                <select
                  id="lesson-type-filter"
                  class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  onChange=${this.handleLessonTypeChange}
                  value=${lessonType}
                >
                  ${LESSON_TYPE_OPTIONS.map((opt) => html`
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

            <!-- Time range filter -->
            <div>
              <label for="lessons-days-filter" class="block text-sm font-medium text-gray-400 mb-2">
                Time Range
              </label>
              <div class="relative">
                <select
                  id="lessons-days-filter"
                  class="w-full bg-gray-700 text-white border border-gray-600 rounded px-4 py-2
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  onChange=${this.handleDaysChange}
                  value=${days !== undefined ? String(days) : ''}
                >
                  ${DAYS_OPTIONS.map((opt) => html`
                    <option value=${opt.value !== undefined ? String(opt.value) : ''}>${opt.label}</option>
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
            <div class="text-gray-500 mt-4">Loading lessons...</div>
          </div>
        `}

        ${error && html`
          <div class="text-center py-20">
            <div class="text-red-500 text-lg mb-4">Error Loading Lessons</div>
            <div class="text-gray-500">${error}</div>
            <button
              class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              onClick=${() => this.loadLessons()}
            >
              Retry
            </button>
          </div>
        `}

        ${!loading && !error && lessons.length === 0 && this.renderEmptyState()}

        ${!loading && !error && lessons.length > 0 && html`
          <div>
            <div class="flex items-center justify-between mb-4">
              <div class="text-sm text-gray-400">
                ${total} lesson${total !== 1 ? 's' : ''}
              </div>
            </div>
            <div class="space-y-2">
              ${lessons.map((l) => this.renderLessonCard(l))}
            </div>
          </div>
        `}
      </div>
    `;
  }
}
