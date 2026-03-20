/**
 * Slash command definitions for context-manager.
 *
 * Shared between install.js (dev setup) and SessionStart hook (auto-provision).
 * All paths use portable globs that resolve at runtime via the plugin cache.
 */

const CLI_PATH = '~/.claude/plugins/cache/mrlesmithjr/context-manager/*/scripts/index.js';
const WEB_PATH = '~/.claude/plugins/cache/mrlesmithjr/context-manager/*/scripts/web/index.cjs';

export const SLASH_COMMANDS: Record<string, string> = {
  'ctx-list.md': `List recent observations captured by context-manager for the current project.

Run this command and display the results:
\`\`\`bash
node ${CLI_PATH} list --project "$PWD" --limit 20
\`\`\`

Format the output as a readable list showing the observation summaries, tools used, and timestamps.
`,

  'ctx-stats.md': `Show context-manager statistics for the current project.

Run this command and display the results:
\`\`\`bash
node ${CLI_PATH} stats --project "$PWD"
\`\`\`

Summarize the output showing: total observations, sessions, tokens, and date range.
`,

  'ctx-search.md': `Search observations in context-manager.

Usage: /ctx-search <query>

The user will provide a search query as an argument. Run this command with their query:
\`\`\`bash
node ${CLI_PATH} search "<query>" --project "$PWD"
\`\`\`

Display the matching observations with their summaries and timestamps.

If no query is provided, ask the user what they want to search for.
`,

  'ctx-vacuum.md': `Clean up old observations and orphaned sessions from context-manager.

Usage: /ctx-vacuum [days]

If a number of days is provided, delete observations older than that many days.
If no argument is provided, run orphan cleanup and database optimization only.

First show current stats:
\`\`\`bash
node ${CLI_PATH} stats
\`\`\`

Then confirm with the user before running:
\`\`\`bash
node ${CLI_PATH} vacuum --days <N>
\`\`\`

Or without --days to just clean up orphaned sessions and optimize:
\`\`\`bash
node ${CLI_PATH} vacuum
\`\`\`

Report how many observations and orphaned sessions were deleted.
`,

  'ctx-export.md': `Export high-importance observations to auto-memory topic file.

Run this command and display the results:
\`\`\`bash
node ${CLI_PATH} export --project "$PWD"
\`\`\`

Show the number of observations exported and the target file path.

To preview without writing, use --dry-run:
\`\`\`bash
node ${CLI_PATH} export --project "$PWD" --dry-run
\`\`\`
`,

  'ctx-web.md': `Start the context-manager web dashboard.

This command starts the web dashboard server and opens it in your browser.

First check if the server is already running:
\`\`\`bash
curl -s http://localhost:3847/api/health 2>/dev/null | head -c 100
\`\`\`

If the health check returns JSON with "status":"ok", the server is already running.
Just tell the user: "Web dashboard is already running at http://localhost:3847"

If the health check fails (empty response or connection refused), start the server:
\`\`\`bash
node ${WEB_PATH} > /dev/null 2>&1 &
sleep 2
\`\`\`

Then open the browser (macOS):
\`\`\`bash
open http://localhost:3847
\`\`\`

Tell the user:
- Web dashboard started at http://localhost:3847
- The server runs in the background
- To stop it: \`pkill -f "scripts/web/index.cjs"\` or close the terminal

Features available:
- Sessions: Browse all Claude Code sessions
- Search: Full-text search across observations
- Analytics: Token usage charts and statistics
`
};
