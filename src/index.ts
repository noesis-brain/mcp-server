#!/usr/bin/env node

/**
 * md-manager MCP Server
 *
 * This MCP server enables Claude Code CLI to interact with your
 * md-manager knowledge base through natural language.
 *
 * Usage:
 *   npx md-manager-mcp-server
 *
 * Environment variables:
 *   NOESIS_API_TOKEN - API token for Noesis backend authentication
 *   NOESIS_API_URL   - Base URL of Noesis backend (e.g., http://localhost:5555)
 *   GEMINI_API_KEY   - (Optional) Gemini API key for semantic search
 *
 * Add to .mcp.json (project root):
 *   {
 *     "mcpServers": {
 *       "md-manager": {
 *         "command": "node",
 *         "args": ["./md-manager-mcp-server/dist/index.js"],
 *         "env": {
 *           "NOESIS_API_TOKEN": "${NOESIS_API_TOKEN}",
 *           "NOESIS_API_URL": "${NOESIS_API_URL}"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { NoesisClient } from './api/NoesisClient.js';
import { registerTools } from './tools/index.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from dist/)
dotenv.config({ path: path.join(__dirname, '../../.env') });
// Also try loading from md-manager root (three levels up)
dotenv.config({ path: path.join(__dirname, '../../../.env') });

/**
 * Get required environment variables for API authentication
 */
function getApiConfig(): { apiToken: string; apiBaseUrl: string } {
  const apiToken = process.env.NOESIS_API_TOKEN;
  const apiBaseUrl = process.env.NOESIS_API_URL;

  if (!apiToken || !apiBaseUrl) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  ERROR: Missing required environment variables               ║');
    console.error('╟──────────────────────────────────────────────────────────────╢');
    console.error('║  NOESIS_API_TOKEN and NOESIS_API_URL are required.           ║');
    console.error('║                                                              ║');
    console.error('║  To generate a token:                                        ║');
    console.error('║  1. Open Noesis web UI                                       ║');
    console.error('║  2. Go to Settings > API Tokens                              ║');
    console.error('║  3. Generate a new token                                     ║');
    console.error('║  4. Add to your .env file:                                   ║');
    console.error('║                                                              ║');
    console.error('║     NOESIS_API_TOKEN=noe_your_token_here                     ║');
    console.error('║     NOESIS_API_URL=http://localhost:5555                     ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(1);
  }

  return { apiToken, apiBaseUrl };
}

/**
 * Get Gemini API key (optional, for semantic search)
 */
function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

async function main(): Promise<void> {
  // Subcommand routing: `noesis-mcp setup [...]` runs the setup CLI instead of the MCP server.
  const subcommand = process.argv[2];
  if (subcommand === 'setup' || subcommand === 'upgrade') {
    const { runSetup } = await import('./cli/setup.js');
    try {
      await runSetup(process.argv.slice(3));
    } catch (err) {
      console.error(`\nnoesis-mcp setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // Get API configuration
  const { apiToken, apiBaseUrl } = getApiConfig();
  const geminiApiKey = getGeminiApiKey();

  console.error(`md-manager MCP server connecting to Noesis API...`);
  console.error(`  API URL: ${apiBaseUrl}`);
  console.error(`  Token: ${apiToken.substring(0, 8)}...`);

  if (geminiApiKey) {
    console.error('  Gemini API key found - semantic search enabled');
  } else {
    console.error('  GEMINI_API_KEY not set - semantic search disabled');
  }

  // Initialize API client (replaces direct database access)
  const client = new NoesisClient(apiBaseUrl, apiToken);

  // Phase 50: fire-and-forget device-home report. Lets the web UI resolve
  // stored `~/Noesis/...` paths to this machine's absolute form for display.
  // Failures (offline, server down) just leave the cache as-is; next startup retries.
  client.reportDeviceHomeDir().catch((err) => {
    console.error(`[noesis-mcp] reportDeviceHomeDir failed (non-fatal): ${err?.message || err}`);
  });

  // Create MCP server
  const server = new McpServer({
    name: 'noesis',
    version: '0.4.0'  // Phase 8: API Token Authentication
  });

  // Register tools with API client
  registerTools(server, { client, geminiApiKey });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down md-manager MCP server...');
    await client.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('Shutting down md-manager MCP server...');
    await client.close();
    process.exit(0);
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('md-manager MCP server started (API mode)');
}

main().catch((error) => {
  console.error('Failed to start md-manager MCP server:', error);
  process.exit(1);
});
