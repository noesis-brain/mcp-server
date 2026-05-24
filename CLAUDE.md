# MCP Server Build Rules

`dist/` is the live artifact. Claude Code runs `node dist/index.js` via `.mcp.json` --
source changes under `src/` have zero effect until `dist/` is rebuilt.

## After any edit to `src/**`

Run from this directory:

```
npm run build
```

This compiles TypeScript into `dist/`. A PostToolUse hook in `.claude/settings.json`
does this automatically when Claude edits files under `src/`, but if you edit manually
you must build yourself.

## Rebuilding is not enough

Claude Code caches the running `node dist/index.js` process. After a rebuild, the old
process is still serving stale code. You must:

1. Open the MCP panel: `/mcp`
2. Restart the `noesis` server

Or restart Claude Code entirely. Claude cannot do this step itself -- it requires human
action. Until you restart, changes will not take effect and errors may appear as opaque
`fetch failed` messages.
