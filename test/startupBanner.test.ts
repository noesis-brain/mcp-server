import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { startupBanner, agentVersion } from '../src/agent/runner.js';

/**
 * Pins the fix for "which version is this daemon actually running?" — with no
 * indicator in the startup banner, confirming a restart picked up a new npm publish
 * required digging into npx's cache directory by hand. Read package.json directly
 * (not agentVersion() itself) so this test would fail if agentVersion() ever drifted
 * from the real installed version, rather than just echoing whatever it returns.
 */
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const realVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;

describe('startupBanner — surfaces the running version', () => {
  it('includes the real package version', () => {
    expect(agentVersion()).toBe(realVersion);
    expect(startupBanner({ apiBaseUrl: 'https://noesisbrain.com', apiToken: 't', concurrency: 1, fake: false }))
      .toContain(`v${realVersion}`);
  });

  it('includes concurrency and the target URL', () => {
    const banner = startupBanner({ apiBaseUrl: 'http://localhost:5589', apiToken: 't', concurrency: 2, fake: false });
    expect(banner).toContain('concurrency=2');
    expect(banner).toContain('→ http://localhost:5589');
  });

  it('flags FAKE mode when set, and omits it otherwise', () => {
    const fake = startupBanner({ apiBaseUrl: 'x', apiToken: 't', concurrency: 1, fake: true });
    const real = startupBanner({ apiBaseUrl: 'x', apiToken: 't', concurrency: 1, fake: false });
    expect(fake).toContain('FAKE mode');
    expect(real).not.toContain('FAKE mode');
  });
});
