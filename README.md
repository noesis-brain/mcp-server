# Noesis — Markdown Notes Manager for Claude Code (MCP Server)

[![npm version](https://img.shields.io/npm/v/@noesis-brain/mcp-server.svg)](https://www.npmjs.com/package/@noesis-brain/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blue)](https://modelcontextprotocol.io/)

Official [Model Context Protocol](https://modelcontextprotocol.io/) server for [Noesis](https://noesisbrain.com), the markdown notes manager for Claude Code. Search, sync, and manage your `.md` knowledge base via 19 AI-powered tools — turn your notes into a first-class context source for every prompt.

## What This Is

Noesis is a personal knowledge management system: you write markdown notes locally, sync them to the cloud, and chat with them through AI assistants. This MCP server is the bridge between [Claude Code](https://claude.com/claude-code) (or any MCP-compatible client) and your Noesis knowledge base.

Once installed and configured, you can ask Claude things like:
- *"Find my notes about authentication architecture"*
- *"Show me the version history of `~/Noesis/projects/server-redesign.md`"*
- *"Sync my local notes with Noesis cloud and resolve any conflicts"*
- *"Generate AI metadata for the 12 notes I edited this week"*

The server is a thin HTTP client to the Noesis cloud API — your data lives in your Noesis account, not in this server.

## Prerequisites

- **Node.js 18+**
- A **Noesis account** at [noesisbrain.com](https://noesisbrain.com) (free tier works)
- **[Claude Code](https://claude.com/claude-code)** (or another MCP-compatible client like Claude Desktop)

## Quick Start

### 1. Generate your Noesis API token

1. Sign in at [https://noesisbrain.com](https://noesisbrain.com)
2. Go to **Settings → API Tokens**
3. Click **Generate Token**, copy the value (it looks like `noe_...`)

### 2. Install the MCP server

**Recommended: via npm (global install):**

```bash
npm install -g @noesis-brain/mcp-server
```

**Alternative: clone and build:**

```bash
git clone https://github.com/noesis-brain/mcp-server.git
cd mcp-server
npm install
npm run build
```

### 3. Register with Claude Code

```bash
claude mcp add noesis --scope user \
  --env NOESIS_API_TOKEN="noe_your_token_here" \
  --env NOESIS_API_URL="https://noesisbrain.com" \
  --env GEMINI_API_KEY="optional_for_semantic_search" \
  -- noesis-mcp
```

If you cloned and built locally instead of installing via npm, replace `-- noesis-mcp` with `-- node /path/to/mcp-server/dist/index.js`.

### 4. Restart Claude Code

The MCP server loads at session start, so restart the Claude Code CLI (`Ctrl+C` then `claude` again, or restart the IDE extension).

You're done. Try `"List my recent Noesis notes"` in Claude Code to verify.

## Optional: CLAUDE.md conventions & skills

`noesis-mcp setup` installs Noesis's CLAUDE.md conventions (how Claude reads, writes, and
syncs your notes) plus a set of Noesis slash-command skills into `~/.claude/commands/`:

- `/noesis-sync` — pull web-UI edits, push local changes, resolve conflicts inline.
- `/noesis-refine-note` — polish a note's metadata and structure (single note or a scoped batch).
- `/noesis-create-study-note` — research a URL or topic and author a structured study note.
- `/noesis-skim-read` — generate Skim-Read key parts yourself (no in-app AI) and persist them.
- `/noesis-find-related` — discover related notes for a note (relations, similar, graph) or a codebase (tech/domain/concept search).
- `/noesis-investigate` — enrich a prompt that spans codebases and notes into a consolidated context brief before you dig in.
- `/noesis-manage-news` — manage your Daily News preferences (sources, topics, language, limits) in natural language.
- `/noesis-capture` — mirror a live Claude Code session into a Noesis note that updates in the cloud in real time.

It's idempotent — re-run any time to upgrade in place; your own content outside the markers is
preserved.

```bash
noesis-mcp setup            # install/upgrade conventions + skills (prompts for opt-in rules)
noesis-mcp setup --dry-run  # preview only; writes nothing
```

### Opt-in rule: "Restructure notes on sync"

During `setup`, you're asked whether to install one **optional, off-by-default** rule. When
enabled, syncing a note that has grown by accretion — bolt-on sections, duplicated passages, a
chronological patch-log — makes Claude first restructure it into one coherent narrative led by
the root cause (preserving diagrams, inventories, and snippets) instead of pushing the sprawl
as-is. Because it rewrites note **body** text on sync (broader than `/noesis-refine-note`, which
only touches metadata and headings), it stays opt-in.

Answer `y` at the prompt to enable it, or drive it non-interactively:

```bash
noesis-mcp setup --with-restructure-rule   # install the optional rule (no prompt)
noesis-mcp setup --no-restructure-rule     # remove / skip it (no prompt)
```

In non-interactive shells (CI, piped input) the prompt is skipped and your current choice is
left untouched unless one of the flags above is passed.

### Opt-in feature: `/noesis-capture` session-capture auto-cleanup

The `/noesis-capture` skill mirrors a live Claude Code session into a Noesis note via a
zero-token background watcher. `setup` also offers an **optional, off-by-default** `SessionEnd`
hook that auto-stops a capture's watchers when the controller session ends (otherwise you run
`/noesis-capture stop` yourself). Because it adds a hook to `~/.claude/settings.json` that runs
on every session exit (a fast, fail-safe no-op unless you're capturing), it stays opt-in:

```bash
noesis-mcp setup --with-capture   # install the SessionEnd auto-cleanup hook (no prompt)
noesis-mcp setup --no-capture     # remove / skip it (no prompt)
```

The `/noesis-capture` skill itself is always installed; only the hook is gated.

## Configuration

| Environment variable | Required | Description |
|---|---|---|
| `NOESIS_API_TOKEN` | Yes | Your token from `noesisbrain.com → Settings → API Tokens`. Format: `noe_...`. |
| `NOESIS_API_URL` | Yes | The Noesis API origin. Production: `https://noesisbrain.com`. Local dev: `http://localhost:5555`. |
| `GEMINI_API_KEY` | No | Google Gemini API key for semantic-search features. Without it, semantic search falls back to keyword search. Get a key at [aistudio.google.com](https://aistudio.google.com/). |

API tokens expire after 90 days. Generate a fresh one and update the env block to renew.

## Features

The server exposes 19 MCP tools, grouped by domain:

### Notes — search + retrieval

- `search_notes` — keyword search across all your notes (BM25-ranked)
- `search_semantic` — vector-similarity search (requires `GEMINI_API_KEY`)
- `get_note` — fetch a note by file path or ID (full content + metadata)
- `list_notes` — list notes with filters (root, recency, catalog, signal markers like favorite / pinned)
- `list_notes_needing_enhancement` — find notes where AI-generated metadata is missing or stale
- `list_edited_online_notes` — find notes edited via the Noesis web UI's Quick Fix that haven't been pulled back to local disk
- `find_similar_notes` — semantic-similarity neighbors of a given note
- `get_bookmark_context` — read the paragraphs surrounding a `#bm=` bookmark URL

### Notes — write + management

- `sync_notes` — bidirectional sync between local disk and Noesis cloud, with conflict resolution
- `enhance_note_metadata` — regenerate AI title / description / keywords for a note
- `move_note` — move a note's file path
- `trash_note` — soft-delete (recoverable)
- `set_note_catalogs` — assign catalog tags
- `set_note_related_codes` — link a note to codebases via the codebase registry
- `update_relations` — auto-detect and update inter-note relations
- `update_signals` — set favorite / pinned / importance / quality scores
- `rate_importance`, `rate_quality` — AI-assisted scoring

### Roots + codebases

- `list_roots` — list watched directories
- `add_root` — register a new directory to watch
- `list_codebases`, `create_codebase`, `get_codebase`, `update_codebase`, `delete_codebase`, `find_or_create_codebase` — manage the codebase registry (file-path-to-project mappings for `related_codes`)
- `search_by_related_code` — find all notes linked to a given codebase

### Catalogs + relations

- `list_catalogs` — list user-defined catalog tags
- `get_relation_graph` — return the note-to-note relation graph

### Navis (AI agents)

- `list_navis`, `create_navi`, `get_navi`, `update_navi`, `delete_navi`, `duplicate_navi`, `search_navis` — manage custom AI personas
- `get_chat_session` — retrieve a Navi chat conversation by ID

### Chat + history

- `analyze_knowledge_base` — generate a summary report of your note collection
- `generate_embeddings` — backfill vector embeddings for notes that lack them

### News + bookmarks

- `add_news_source`, `get_news_preferences`, `update_news_preferences` — configure the Noesis Daily News tool's feeds
- `sync_status` — get sync state across all watched roots

Full tool schemas (parameters, return types) are available via Claude Code's MCP discovery (`/mcp` then click the noesis server).

## Usage Examples

After installation, try these in Claude Code:

```
"Search my Noesis notes for 'OAuth flow'"
"Show me notes I edited online via Quick Fix but haven't pulled to disk yet"
"What does the bookmark at https://noesisbrain.com/notes/2312#bm=384e924d look like?"
"Sync the notes under C:/Users/me/Noesis/projects/"
"Enhance the metadata for any notes touched today"
"Find notes semantically similar to the one I just opened"
```

## Development

### Build

```bash
npm install
npm run build
```

### Watch mode

```bash
npm run dev
```

### Architecture

```
src/
├── index.ts                    # Entry point + MCP server init
├── api/NoesisClient.ts         # HTTP client for Noesis cloud API
├── tools/
│   ├── index.ts                # MCP tool registrations (19 tools)
│   ├── navis.ts                # Navi management tools
│   └── SyncStateManager.ts     # Bidirectional sync state tracking
├── services/embedding.ts       # Gemini embedding helper for semantic search
├── cli/setup.ts                # `noesis-mcp setup` subcommand
├── types/index.ts              # Shared TypeScript types
└── utils/suggestPath.ts        # Path-completion helpers

scripts/
├── noesis-sync.mjs                  # Standalone sync script (zero deps, Node 18+)
├── noesis-capture-watcher.mjs       # Live session-capture watcher (tails a transcript, renders + pushes)
└── noesis-capture-session-end.mjs   # Optional SessionEnd hook that auto-stops captures

skill-templates/                # Claude Code skill templates (noesis-sync, -refine-note, -create-study-note,
                                #   -skim-read, -find-related, -investigate, -manage-news, -capture)
templates/                      # CLAUDE.md convention blocks
```

The server is a thin client — almost all logic lives behind the Noesis cloud API. This makes the server safe to run in untrusted environments (no DB access, no file writes outside the user's notes folder).

## Troubleshooting

### "No API token provided"

Your `NOESIS_API_TOKEN` env var isn't being passed to the MCP server. Re-run the `claude mcp add` command from Quick Start step 3 with the `--env NOESIS_API_TOKEN=noe_...` flag. Restart Claude Code.

### "fetch failed"

Usually means `NOESIS_API_URL` is wrong or unreachable. Confirm `https://noesisbrain.com` loads in your browser. If you're on a local Noesis instance, set `NOESIS_API_URL=http://localhost:5555` instead.

### Token expired

Noesis API tokens expire 90 days after creation. Generate a fresh token at `noesisbrain.com → Settings → API Tokens`, then update the env var. Old token rows on the web UI show "Expired" status.

### `noesis-mcp` command not found after `npm install -g`

The npm global bin directory isn't on your `PATH`. Run `npm bin -g` to find the path, then add it to your shell config (`~/.bashrc` / `~/.zshrc` / Windows Environment Variables).

### MCP tool calls work but no semantic search

Set `GEMINI_API_KEY` in the env block. Without it, `search_semantic` silently falls back to keyword search.

## Contributing

Bug reports and pull requests welcome. For major changes, open an issue first to discuss what you'd like to change.

This server is the public-facing component of [Noesis](https://noesisbrain.com); the main app stays closed-source. PRs that change the MCP protocol contract (tool signatures, response shapes) need coordination with the backend — flag them in the issue first.

## License

[MIT](LICENSE) — Copyright (c) 2026 Noesis
