/**
 * Cross-platform default-path suggestion helper.
 *
 * NOTE: a near-identical copy lives in src/frontend/src/utils/osPlatform.ts.
 * The two files are in separate npm packages with no shared util layer; if you
 * change one, change the other.
 *
 * Used by the MCP `add_root` tool when the user supplies a path for one OS and
 * we want to pre-fill the other side. Only emits a non-empty suggestion when
 * the input is recognizably home-relative — otherwise returns '' so the caller
 * leaves the other slot empty rather than guessing wrong.
 */

export type OsKey = 'win32' | 'darwin' | 'linux';

export function suggestOtherOsPath(inputPath: string, sourceOs: OsKey): string {
  if (typeof inputPath !== 'string') return '';
  const trimmed = inputPath.trim().replace(/[/\\]+$/, '');
  if (!trimmed) return '';

  if (sourceOs === 'win32') {
    // Only suggest if under %USERPROFILE% (the C:\Users\<x>\... convention).
    const m = trimmed.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/](.+)$/i);
    if (!m) return '';
    const subpath = m[1].replace(/\\/g, '/');
    return '~/' + subpath;
  }

  if (sourceOs === 'darwin' || sourceOs === 'linux') {
    let subpath: string | null = null;
    if (trimmed.startsWith('~/')) {
      subpath = trimmed.slice(2);
    } else {
      const mac = trimmed.match(/^\/Users\/[^/]+\/(.+)$/);
      if (mac) {
        subpath = mac[1];
      } else {
        const lin = trimmed.match(/^\/home\/[^/]+\/(.+)$/);
        if (lin) subpath = lin[1];
      }
    }
    if (!subpath) return '';
    // %USERNAME% is a template token — caller must expand on first use.
    // Leaving it literal signals "this is a guess, edit it" instead of
    // silently inserting the wrong username.
    return 'C:\\Users\\%USERNAME%\\' + subpath.replace(/\//g, '\\');
  }

  return '';
}
