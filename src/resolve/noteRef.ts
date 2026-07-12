/**
 * Unified note-reference resolution (single-vault refactor, M1).
 *
 * Pure logic — no network, no filesystem, no process state. Everything the
 * resolver needs arrives in a ResolverContext built by the caller (M2 wires
 * this to `GET /api/mcp/roots?includeArchived=1`, which since V3 returns the
 * archived translation entries plus `{vault_root_id, device_home_dirs}`).
 *
 * Accepted reference forms (the plan's reference grammar):
 *   - note URLs on any host:  https://noesisbrain.com/notes/2761[#bm=...]
 *   - noesis://note/2761[/optional-slug]
 *   - bare numeric ids: "2761"
 *   - absolute paths of ANY OS shape: /Users/me/Noesis/x.md,
 *     c:/Users/me/Noesis/x.md, C:\temp_cGit\.noesis\x.md
 *   - tilde / %USERPROFILE% forms: ~/Noesis/x.md, %USERPROFILE%\Noesis\x.md
 *   - LEGACY pre-migration absolute paths, translated through archived roots
 *     (vault_subfolder + '.noesis/'-collapse candidates, collapsed first)
 *
 * Fixes the pre-M1 footgun where a root with an empty current-OS path
 * resolved to process.cwd(): empty/missing slots never produce a comparable
 * form here, and local paths are composed (never path.resolve'd) from a
 * verified non-empty base.
 */

export type OsKey = 'win32' | 'darwin' | 'linux';

export interface ResolverRoot {
  id: number;
  name: string;
  local_paths: Record<string, string>;
  archived_at?: string | null;
  vault_subfolder?: string | null;
}

export interface ResolverContext {
  /** This machine's OS family (CLIENT_OS). */
  clientOs: OsKey;
  /** This machine's home directory (os.homedir()). */
  homeDir: string;
  /** The user's designated vault root id (V3 roots meta), if known. */
  vaultRootId: number | null;
  /** Per-OS home dirs of the user's machines (V3 roots meta), if known. */
  deviceHomeDirs: Record<string, string> | null;
  /** Active + archived roots (GET /roots?includeArchived=1). */
  roots: ResolverRoot[];
}

export type NoteRef = { kind: 'id'; id: number } | { kind: 'path'; path: string };

export interface ResolvedPathRef {
  /** Root to look candidates up under (the matched root, or the vault). */
  rootId: number;
  /** relative_path candidates, in lookup priority order. */
  candidates: string[];
  via: 'active-root' | 'legacy-translation';
  /** Set when the input matched an archived root. */
  archivedRootId?: number;
}

/** Forward slashes + lowercase drive letter (win32 canonical compare form). */
export function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

/** Shape-sniff which OS family a path belongs to (mirrors the backend). */
export function detectPathOsKey(p: string): OsKey {
  if (/^[A-Za-z]:[\\/]/.test(p)) return 'win32';
  if (p.startsWith('/Users/') || p.startsWith('~/')) return 'darwin';
  if (p.startsWith('/')) return 'linux';
  return 'win32';
}

/**
 * Parse an input string into a note reference. URLs and ids resolve by note
 * id (the caller fetches the note to learn its relative_path); everything
 * else is treated as a path.
 */
export function parseNoteReference(input: string): NoteRef {
  const s = input.trim();

  if (/^\d+$/.test(s)) return { kind: 'id', id: parseInt(s, 10) };

  const noesisScheme = s.match(/^noesis:\/\/note\/(\d+)(?:[/#?].*)?$/i);
  if (noesisScheme) return { kind: 'id', id: parseInt(noesisScheme[1], 10) };

  if (/^https?:\/\//i.test(s)) {
    // Anchored: the /notes/{id} segment must end the path (fragment/query
    // tolerated) — '/a/notes/12.png' is NOT a note reference.
    const urlNote = s.match(/\/notes\/(\d+)(?:[/#?].*)?$/i);
    if (urlNote) return { kind: 'id', id: parseInt(urlNote[1], 10) };
  }

  return { kind: 'path', path: s };
}

interface ComparableForm {
  cmp: string;
  orig: string;
}

function expandHomePrefix(p: string, home: string): string | null {
  if (p === '~' || p.startsWith('~/')) return home + p.slice(1);
  if (/^%USERPROFILE%/i.test(p)) return home + p.slice('%USERPROFILE%'.length);
  return null;
}

/**
 * Comparable spellings of one path under an OS family: the normalized raw
 * form plus one home-expanded form per known home dir for that family (this
 * machine's home when the family is the client OS, and the cloud-cached
 * device home). Empty inputs produce NO forms (the cwd-footgun fix).
 */
export function comparableForms(p: string | null | undefined, osKey: OsKey, homes: string[]): ComparableForm[] {
  const raw = (p ?? '').trim();
  if (!raw) return [];
  const base = normalizePath(raw);

  const variants = new Set<string>([base]);
  for (const home of homes) {
    const h = normalizePath(home).replace(/\/+$/, '');
    if (!h) continue;
    const expanded = expandHomePrefix(base, h);
    if (expanded) variants.add(expanded);
  }

  return [...variants].map((v) => {
    const trimmed = v.length > 1 ? v.replace(/\/+$/, '') : v;
    return { orig: trimmed, cmp: osKey === 'win32' ? trimmed.toLowerCase() : trimmed };
  });
}

function homesFor(ctx: ResolverContext, osKey: OsKey): string[] {
  const homes: string[] = [];
  if (osKey === ctx.clientOs && ctx.homeDir) homes.push(ctx.homeDir);
  const cloudHome = ctx.deviceHomeDirs?.[osKey];
  if (typeof cloudHome === 'string' && cloudHome.trim()) homes.push(cloudHome);
  return homes;
}

const NOESIS_SEG = '.noesis/';

/**
 * Resolve a path-form reference against the context's roots: longest-prefix
 * across active + archived roots on the sniffed OS family, tilde/home
 * expansion on both sides, legacy translation into the vault for archived
 * matches. Null when nothing matches (or an archived match has no
 * translation target).
 */
export function resolvePathReference(ctx: ResolverContext, inputPath: string): ResolvedPathRef | null {
  const osKey = detectPathOsKey(inputPath);
  const homes = homesFor(ctx, osKey);
  const inputForms = comparableForms(inputPath, osKey, homes);
  if (inputForms.length === 0) return null;

  let best: { root: ResolverRoot; rootLen: number; rel: string } | null = null;
  for (const root of ctx.roots) {
    for (const rootForm of comparableForms(root.local_paths?.[osKey], osKey, homes)) {
      for (const input of inputForms) {
        const isMatch = input.cmp === rootForm.cmp || input.cmp.startsWith(rootForm.cmp + '/');
        if (!isMatch) continue;
        if (!best || rootForm.cmp.length > best.rootLen) {
          const rel = input.orig.slice(rootForm.orig.length).replace(/^\//, '');
          best = { root, rootLen: rootForm.cmp.length, rel };
        }
      }
    }
  }
  if (!best) return null;

  const rel = best.rel;
  if (!best.root.archived_at) {
    return { rootId: best.root.id, candidates: [rel], via: 'active-root' };
  }

  const subfolder = best.root.vault_subfolder?.replace(/^\/+|\/+$/g, '');
  if (!subfolder || ctx.vaultRootId == null) return null;

  // F8: when the input EXPLICITLY names a `.noesis/` dot path, try the
  // UNCOLLAPSED candidate first. In a collapse-fallback pair (a different file
  // won the collapsed slot at migration, so this note kept its `.noesis/`
  // prefix), collapsed-first would wrongly return the native sibling; the
  // dot-path the caller typed is the one they mean. Harmless in the common
  // case: the uncollapsed candidate simply misses and falls to the collapsed.
  const candidates = rel.startsWith(NOESIS_SEG)
    ? [`${subfolder}/${rel}`, `${subfolder}/${rel.slice(NOESIS_SEG.length)}`]
    : [`${subfolder}/${rel}`];

  return { rootId: ctx.vaultRootId, candidates, via: 'legacy-translation', archivedRootId: best.root.id };
}

/**
 * The local base directory (this machine, CLIENT_OS) of a root — tilde-form
 * expanded against THIS machine's home dir — or null when the root has no
 * usable path on this OS (never a cwd-relative guess).
 */
export function rootLocalBase(ctx: ResolverContext, rootId: number): string | null {
  const root = ctx.roots.find((r) => r.id === rootId);
  const rawBase = root?.local_paths?.[ctx.clientOs]?.trim();
  if (!rawBase) return null;

  let base = normalizePath(rawBase);
  const home = normalizePath(ctx.homeDir ?? '').replace(/\/+$/, '');
  const expanded = home ? expandHomePrefix(base, home) : null;
  if (expanded) base = expanded;
  if (base.startsWith('~')) return null; // home unknown — refuse to guess
  // Any unexpanded %TOKEN% (e.g. a stored literal %USERNAME% template) would
  // otherwise mkdir a literal '%USERNAME%' directory on materialize.
  if (/%[^%/\\]+%/.test(base)) return null;

  return base.length > 1 ? base.replace(/\/+$/, '') : base;
}

/**
 * The local absolute path (this machine, CLIENT_OS) for a note of `rootId` at
 * `relativePath` — or null when that root has no usable path on this OS.
 */
export function localAbsFor(ctx: ResolverContext, rootId: number, relativePath: string): string | null {
  const base = rootLocalBase(ctx, rootId);
  if (!base) return null;
  const rel = relativePath.replace(/^\/+/, '');
  return `${base}/${rel}`;
}
