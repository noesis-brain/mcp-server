#!/usr/bin/env node
/**
 * noesis-sync.mjs — Standalone sync script for Noesis cloud API.
 * Zero dependencies (Node.js 18+ built-ins only).
 *
 * Usage:
 *   node noesis-sync.mjs                        # auto-detect from CWD
 *   node noesis-sync.mjs --files a.md b.md      # sync specific files
 *   node noesis-sync.mjs --root my-notes         # sync a named root
 *   node noesis-sync.mjs --dry-run               # preview only
 *
 * Credentials: reads from ~/.claude/.mcp.json → mcpServers.noesis.env
 * or env vars NOESIS_API_TOKEN / NOESIS_API_URL.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, relative, join, sep } from 'node:path';
import { homedir } from 'node:os';

// ── Path helpers ────────────────────────────────────────────────────

/**
 * Tilde-expand `~/Noesis/...` against this machine's home directory.
 * Cloud-flow roots store `~` in the DB because the cloud doesn't know each
 * machine's $HOME — we expand here at sync time. No-op for already-
 * absolute paths.
 */
function expandHome(p) {
  if (!p) return '';
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ── Config ──────────────────────────────────────────────────────────

function loadCredentials() {
  // Env vars take priority
  let token = process.env.NOESIS_API_TOKEN;
  let url = process.env.NOESIS_API_URL;

  if (token && url) return { token, url };

  // Fall back to ~/.claude/.mcp.json
  const mcpPath = join(homedir(), '.claude', '.mcp.json');
  if (!existsSync(mcpPath)) {
    console.error(`ERROR: No credentials. Set NOESIS_API_TOKEN + NOESIS_API_URL or configure ${mcpPath}`);
    process.exit(1);
  }
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  const env = mcp?.mcpServers?.noesis?.env;
  if (!env?.NOESIS_API_TOKEN || !env?.NOESIS_API_URL) {
    console.error('ERROR: mcpServers.noesis.env missing NOESIS_API_TOKEN or NOESIS_API_URL in', mcpPath);
    process.exit(1);
  }
  return { token: env.NOESIS_API_TOKEN, url: env.NOESIS_API_URL };
}

// ── HTTP helpers ────────────────────────────────────────────────────

async function api(method, path, body, { token, url }) {
  const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`API ${method} ${path} → ${res.status}: ${err.error || res.statusText}`);
  }
  return res.json();
}

// ── Hashing (matches NoesisClient.computeHash) ─────────────────────

function computeHash(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ── Git/root detection (mirrors tools/index.ts) ─────────────────────

function findGitRoot(startPath) {
  let current = resolve(startPath);
  while (current !== dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    current = dirname(current);
  }
  return null;
}

function detectRootFromCwd() {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) return null;
  return { rootPath: dirname(gitRoot), projectName: basename(gitRoot) };
}

function detectProjectForFile(filePath, rootPath) {
  const rel = relative(rootPath, filePath);
  const parts = rel.split(sep).filter(Boolean);
  // Walk up from file to find .git
  let current = resolve(filePath);
  while (current !== resolve(rootPath) && current !== dirname(current)) {
    current = dirname(current);
    if (existsSync(join(current, '.git'))) return basename(current);
  }
  return parts[0] || basename(dirname(filePath));
}

// ── Path normalization ───────────────────────────────────────────────

/**
 * Normalize a file path: forward slashes + lowercase drive letter on Windows.
 */
function normalizePath(p) {
  let normalized = p.replace(/\\/g, '/');
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

// ── File scanning ───────────────────────────────────────────────────

function scanMarkdownFiles(rootPath) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && e.name !== '.noesis' && e.name !== '.claude-notes') continue;
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        walk(full);
      } else if (e.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  walk(rootPath);
  return files;
}

// ── Parse YAML frontmatter ──────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const keyMatch = lines[i].match(/^(\w[\w-]*):\s*(.*)/);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1];
    const inline = keyMatch[2].trim();

    // Block scalar: >-, >, |-, |
    if (/^[>|]-?$/.test(inline)) {
      const parts = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      meta[key] = parts.join(inline.startsWith('>') ? ' ' : '\n');
      continue;
    }

    // Array: key with no inline value, followed by "  - item" lines
    if (inline === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, '').trim());
        j++;
      }
      if (items.length > 0) {
        meta[key] = items;
        i = j;
        continue;
      }
    }

    // Simple key: value
    if (inline) {
      meta[key] = inline.replace(/^["']|["']$/g, '');
    }
    i++;
  }
  return meta;
}

// ── Main sync logic ─────────────────────────────────────────────────

async function syncFiles(filePaths, { creds, dryRun, force, rootFilter }) {
  // Get roots
  const { roots } = await api('GET', '/api/mcp/roots?forSync=true', null, creds);
  let targetRoots = roots;

  // Auto-detect or create root if none match
  const detected = detectRootFromCwd();

  if (rootFilter) {
    targetRoots = roots.filter(r => r.name.toLowerCase().includes(rootFilter.toLowerCase()));
    if (targetRoots.length === 0) {
      console.error(`No root matching "${rootFilter}". Available: ${roots.map(r => r.name).join(', ')}`);
      process.exit(1);
    }
  }

  // If syncing specific files, resolve their roots
  if (filePaths.length > 0) {
    return await syncSpecificFiles(filePaths, targetRoots, detected, creds, dryRun, force);
  }

  // Full root sync — auto-detect from CWD
  if (!rootFilter && detected) {
    const match = targetRoots.find(r =>
      resolve(r.path).toLowerCase() === resolve(detected.rootPath).toLowerCase()
    );
    if (match) {
      targetRoots = [match];
    } else if (!dryRun) {
      // Auto-create root
      console.log(`Creating new root: ${basename(detected.rootPath)} → ${detected.rootPath}`);
      const { root } = await api('POST', '/api/mcp/roots', {
        name: basename(detected.rootPath),
        path: detected.rootPath,
      }, creds);
      targetRoots = [{ ...root, last_scanned_at: null }];
    } else {
      console.log(`[dry-run] Would create root: ${detected.rootPath}`);
      return;
    }
  }

  if (targetRoots.length === 0) {
    console.error('No roots to sync. Run from a git repo or specify --root.');
    process.exit(1);
  }

  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0;

  for (const root of targetRoots) {
    // Tilde-expand cloud-flow paths (~/Noesis/...) once at the top of the
    // loop so all downstream uses see the absolute on-disk path.
    const rootPath = expandHome(root.path);
    if (!rootPath) {
      console.log(`\nSkipping root '${root.name}': no path configured for this OS`);
      continue;
    }
    console.log(`\nSyncing root: ${root.name} (${rootPath})`);

    const mdFiles = scanMarkdownFiles(rootPath);
    console.log(`  Found ${mdFiles.length} markdown files`);

    // Get existing hashes from cloud
    const { hashes } = await api('GET', `/api/mcp/roots/${root.id}/hashes`, null, creds);

    let added = 0, updated = 0, skipped = 0;

    for (const filePath of mdFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const hash = computeHash(content);
      const stats = statSync(filePath);
      const relativePath = normalizePath(relative(rootPath, filePath));
      const existingHash = hashes[relativePath];

      if (existingHash === hash && !force) { skipped++; continue; }
      const action = existingHash ? 'update' : 'create';

      if (dryRun) {
        console.log(`  [dry-run] Would ${action}: ${relativePath}`);
        action === 'create' ? added++ : updated++;
        continue;
      }

      const project = detectProjectForFile(filePath, rootPath);
      const metadata = parseFrontmatter(content);

      await api('POST', '/api/mcp/notes/upsert', {
        file: {
          path: normalizePath(filePath),
          relativePath,
          content,
          hash,
          mtime: stats.mtime,
          size: stats.size,
          rootId: root.id,
          rootName: root.name,
          project,
        },
        metadata,
        force,
      }, creds);

      console.log(`  ${action === 'create' ? '+' : '~'} ${relativePath}`);
      action === 'create' ? added++ : updated++;
    }

    console.log(`  Done: +${added} ~${updated} =${skipped}`);
    totalAdded += added; totalUpdated += updated; totalSkipped += skipped;

    if (!dryRun && (added > 0 || updated > 0)) {
      await api('POST', '/api/mcp/sync/log', {
        rootId: root.id,
        filesScanned: mdFiles.length,
        filesAdded: added,
        filesUpdated: updated,
        filesDeleted: 0,
        source: 'noesis-sync-script',
      }, creds);
    }
  }

  console.log(`\nTotal: +${totalAdded} ~${totalUpdated} =${totalSkipped}`);
}

async function syncSpecificFiles(filePaths, roots, detected, creds, dryRun, force) {
  let added = 0, updated = 0, errors = 0;
  const affectedRoots = new Map();

  for (const filePath of filePaths) {
    const absPath = normalizePath(resolve(filePath));

    if (!absPath.endsWith('.md')) {
      console.error(`  SKIP (not .md): ${filePath}`);
      errors++; continue;
    }
    if (!existsSync(absPath)) {
      console.error(`  SKIP (not found): ${filePath}`);
      errors++; continue;
    }

    // Find matching root (case-insensitive path comparison for Windows)
    let matchingRoot = roots.find(r => absPath.startsWith(normalizePath(resolve(r.path))));

    if (!matchingRoot && detected) {
      // Try auto-creating root from CWD detection
      const existingByPath = roots.find(r =>
        normalizePath(resolve(r.path)) === normalizePath(resolve(detected.rootPath))
      );
      if (existingByPath) {
        matchingRoot = existingByPath;
      } else if (!dryRun) {
        console.log(`Creating root: ${basename(detected.rootPath)} → ${detected.rootPath}`);
        const { root } = await api('POST', '/api/mcp/roots', {
          name: basename(detected.rootPath),
          path: normalizePath(detected.rootPath),
        }, creds);
        matchingRoot = root;
        roots.push(root);
      }
    }

    if (!matchingRoot) {
      console.error(`  SKIP (no root): ${filePath}`);
      errors++; continue;
    }

    const content = readFileSync(absPath, 'utf-8');
    const hash = computeHash(content);
    const stats = statSync(absPath);
    const relativePath = normalizePath(relative(matchingRoot.path, absPath));
    const project = detectProjectForFile(absPath, matchingRoot.path);
    const metadata = parseFrontmatter(content);

    if (dryRun) {
      console.log(`  [dry-run] Would sync: ${relativePath} → root "${matchingRoot.name}"`);
      added++; continue;
    }

    const result = await api('POST', '/api/mcp/notes/upsert', {
      file: {
        path: absPath,
        relativePath,
        content,
        hash,
        mtime: stats.mtime,
        size: stats.size,
        rootId: matchingRoot.id,
        rootName: matchingRoot.name,
        project,
      },
      metadata,
      force,
    }, creds);

    const action = result.action || 'synced';
    console.log(`  ${action}: ${relativePath}`);
    action === 'created' ? added++ : updated++;

    // Track for sync log
    if (!affectedRoots.has(matchingRoot.id)) {
      affectedRoots.set(matchingRoot.id, { root: matchingRoot, added: 0, updated: 0, scanned: 0 });
    }
    const rInfo = affectedRoots.get(matchingRoot.id);
    rInfo.scanned++;
    action === 'created' ? rInfo.added++ : rInfo.updated++;
  }

  // Log sync for each affected root
  if (!dryRun) {
    for (const [rootId, info] of affectedRoots) {
      if (info.added > 0 || info.updated > 0) {
        await api('POST', '/api/mcp/sync/log', {
          rootId,
          filesScanned: info.scanned,
          filesAdded: info.added,
          filesUpdated: info.updated,
          filesDeleted: 0,
          source: 'noesis-sync-script',
        }, creds);
      }
    }
  }

  console.log(`\nDone: +${added} ~${updated}${errors ? ` errors:${errors}` : ''}`);
}

// ── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const filesIdx = args.indexOf('--files');
const rootIdx = args.indexOf('--root');

let files = [];
let rootFilter = null;

if (filesIdx !== -1) {
  // Collect all args after --files until next flag or end
  for (let i = filesIdx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    files.push(args[i]);
  }
}

if (rootIdx !== -1 && args[rootIdx + 1]) {
  rootFilter = args[rootIdx + 1];
}

// Positional arg that isn't a flag — treat as root name or file
if (files.length === 0 && !rootFilter) {
  for (const a of args) {
    if (a.startsWith('--')) continue;
    if (a.endsWith('.md')) files.push(a);
    else rootFilter = a;
  }
}

const creds = loadCredentials();
console.log(`Noesis sync → ${creds.url}`);
if (dryRun) console.log('[DRY RUN MODE]');
if (force) console.log('[FORCE MODE]');

syncFiles(files, { creds, dryRun, force, rootFilter }).catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
