Search observations in context-manager.

Usage: /ctx-search <query>

The user will provide a search query as an argument. Run this command with their query:
```bash
node __homedir__/Projects/Personal/claude-context-manager/dist/cli.js search "<query>" --project "$PWD"
```

Display the matching observations with their summaries and timestamps.

If no query is provided, ask the user what they want to search for.
