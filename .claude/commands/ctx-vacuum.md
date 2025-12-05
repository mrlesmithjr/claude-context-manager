Clean up old observations from context-manager.

Usage: /ctx-vacuum [days]

If a number of days is provided, delete observations older than that many days.
If no argument is provided, default to 30 days.

First show what will be deleted:
```bash
node ~/.claude/plugins/context-manager/dist/cli.js stats
```

Then confirm with the user before running:
```bash
node ~/.claude/plugins/context-manager/dist/cli.js vacuum --days <N>
```

Report how many observations were deleted.
