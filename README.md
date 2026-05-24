# Noesis MCP Server

[![npm version](https://img.shields.io/npm/v/@noesis-brain/mcp-server.svg)](https://www.npmjs.com/package/@noesis-brain/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blue)](https://modelcontextprotocol.io/)

Official [Model Context Protocol](https://modelcontextprotocol.io/) server for [Noesis](https://noesisbrain.com) — bring your personal knowledge base into Claude Code. Search, sync, and manage your markdown notes via 19 AI-powered tools.

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
└── noesis-sync.mjs             # Standalone sync script (zero deps, Node 18+)

skill-templates/                # Claude Code skill templates
templates/                      # Markdown templates injected into notes
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
