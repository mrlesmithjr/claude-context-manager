/**
 * ImportPanel Component
 *
 * Allows users to upload a local context.db file and merge it into
 * the container's database via POST /api/import.
 */

import { html, Component } from '/vendor/preact-htm.js';

export class ImportPanel extends Component {
  constructor(props) {
    super(props);
    this.state = {
      status: 'idle',   // 'idle' | 'uploading' | 'success' | 'error'
      file: null,
      result: null,     // { imported: { observations, sessions, prompts, file_counts } }
      error: null,
      dragOver: false,
    };
    this.fileInputRef = { current: null };
  }

  handleDrop = (e) => {
    e.preventDefault();
    this.setState({ dragOver: false });
    const { status } = this.state;
    if (status === 'uploading') return; // ignore drops during active upload
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.endsWith('.db')) {
      this.setState({ status: 'error', error: 'Only .db files are accepted.', result: null });
      return;
    }
    this.setState({ file, status: 'idle', result: null, error: null });
  };

  handleDragOver = (e) => {
    e.preventDefault();
    this.setState({ dragOver: true });
  };

  handleDragLeave = () => this.setState({ dragOver: false });

  handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) this.setState({ file, status: 'idle', result: null, error: null });
  };

  handleImport = async () => {
    const { file } = this.state;
    if (!file) return;

    const MAX_BYTES = 500 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      this.setState({ status: 'error', error: 'File exceeds the 500 MB limit.' });
      return;
    }

    this.setState({ status: 'uploading', error: null });

    try {
      const formData = new FormData();
      formData.append('db', file);

      // Do NOT set Content-Type — browser sets it with the multipart boundary
      const response = await apiFetch('/api/import', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      this.setState({ status: 'success', result });
    } catch (err) {
      this.setState({ status: 'error', error: err.message || 'Upload failed' });
    }
  };

  handleReset = () => {
    this.setState({ status: 'idle', file: null, result: null, error: null });
  };

  formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  renderDropZone() {
    const { file, dragOver } = this.state;
    return html`
      <div
        class="${dragOver ? 'border-blue-400 bg-blue-900/20' : 'border-gray-600 hover:border-gray-500'}
               border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors"
        onClick=${() => this.fileInputRef.current?.click()}
      >
        <p class="text-gray-400 mb-3">Drag and drop context.db here, or click to browse</p>
        <p class="text-gray-500 text-sm">Accepts .db files up to 500 MB</p>
        <input
          type="file"
          accept=".db"
          class="hidden"
          ref=${(el) => { this.fileInputRef.current = el; }}
          onChange=${this.handleFileChange}
        />
      </div>
      ${file && html`
        <div class="mt-3 flex items-center justify-between">
          <span class="text-sm text-gray-300">
            Selected: <span class="font-medium">${file.name}</span>
            <span class="text-gray-500 ml-2">(${this.formatSize(file.size)})</span>
          </span>
          <button
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium
                   rounded transition-colors disabled:opacity-50"
            onClick=${this.handleImport}
          >
            Import
          </button>
        </div>
      `}
    `;
  }

  renderUploading() {
    return html`
      <div class="flex items-center gap-3 py-8 justify-center">
        <div class="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent"></div>
        <span class="text-gray-300">Importing...</span>
      </div>
    `;
  }

  renderSuccess() {
    const { result } = this.state;
    const { imported } = result;
    return html`
      <div class="space-y-4">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span class="text-green-400 font-medium">Import complete</span>
        </div>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="text-gray-400">Observations</div>
          <div class="font-semibold">${imported.observations.toLocaleString()}</div>
          <div class="text-gray-400">Sessions</div>
          <div class="font-semibold">${imported.sessions.toLocaleString()}</div>
          <div class="text-gray-400">Prompts</div>
          <div class="font-semibold">${imported.prompts.toLocaleString()}</div>
          <div class="text-gray-400">File encounter records</div>
          <div class="font-semibold">${imported.file_counts.toLocaleString()}</div>
        </div>
        <div class="bg-yellow-900/30 border border-yellow-700/50 rounded p-3 text-sm text-yellow-300">
          Run <code class="font-mono bg-gray-800 px-1 rounded">context_embed</code> in any Claude Code
          session to regenerate vector embeddings for semantic search.
        </div>
        <button
          class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          onClick=${this.handleReset}
        >
          Import another file
        </button>
      </div>
    `;
  }

  renderError() {
    const { error } = this.state;
    return html`
      <div class="space-y-4">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-red-400 font-medium">Import failed</span>
        </div>
        <p class="text-sm text-gray-400">${error}</p>
        <button
          class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          onClick=${this.handleReset}
        >
          Try again
        </button>
      </div>
    `;
  }

  render() {
    const { status } = this.state;

    // Drag handlers live on the outer container so a file can be dropped at
    // any point (including success/error states) to start a new import.
    // Drops during an active upload are blocked inside handleDrop.
    return html`
      <div
        class="max-w-2xl"
        onDrop=${this.handleDrop}
        onDragOver=${this.handleDragOver}
        onDragLeave=${this.handleDragLeave}
      >
        <div class="mb-6">
          <h2 class="text-lg font-semibold text-white mb-1">Import Context Database</h2>
          <p class="text-gray-400 text-sm">
            Upload your local <code class="font-mono bg-gray-800 px-1 rounded">~/.claude-context/context.db</code>
            to merge observations into this container's database.
            Existing records are not duplicated.
          </p>
        </div>

        ${status === 'idle' && this.renderDropZone()}
        ${status === 'uploading' && this.renderUploading()}
        ${status === 'success' && this.renderSuccess()}
        ${status === 'error' && this.renderError()}
      </div>
    `;
  }
}
