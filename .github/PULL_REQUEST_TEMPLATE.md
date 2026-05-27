## Summary

<!-- One or two sentences describing what this changes and why. -->

## Related issue

<!-- Every PR must reference an issue. Use the correct keyword:
     "fixes #N" closes the issue on merge.
     "refs #N" leaves it open (partial work only). -->

fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature or MCP tool
- [ ] Refactor (no behavior change)
- [ ] Documentation only
- [ ] Build / CI / config

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] E2E tests pass (`make test-e2e`) — required if hooks, storage, MCP tools, or HTTP server changed
- [ ] Issue referenced in every commit with `fixes #N` or `refs #N`
- [ ] No prompt content logged anywhere, even at debug level
- [ ] No `old_string`, `new_string`, or `content` fields stored from Edit/Write results
- [ ] I have read CONTRIBUTING.md
