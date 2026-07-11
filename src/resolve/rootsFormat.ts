import { rootLocalBase, type ResolverContext, type OsKey } from './noteRef.js';

/**
 * Pure renderer for the `list_roots` tool output (single-vault, M3).
 *
 * Shows the vault (with its per-OS tilde paths AND this machine's resolved
 * absolute base), any other still-active roots, and the archived roots as the
 * legacy-path translation table — old absolute paths under an archived root
 * keep resolving via get_note/sync_notes, translated into the vault subfolder
 * shown here.
 */
export function formatRootsList(ctx: ResolverContext): string {
  if (ctx.roots.length === 0) {
    return 'No root directories configured. A vault (~/Noesis) is designated automatically on first use.';
  }

  const OS_LABELS: Array<[OsKey, string]> = [
    ['win32', 'Windows'],
    ['darwin', 'macOS  '],
    ['linux', 'Linux  '],
  ];

  const active = ctx.roots.filter((r) => !r.archived_at);
  const archived = ctx.roots.filter((r) => r.archived_at);

  const lines: string[] = [];
  let anyMissing = false;

  active.forEach((root, index) => {
    const isVault = ctx.vaultRootId != null && root.id === ctx.vaultRootId;
    lines.push(`${index + 1}. **${root.name}**${isVault ? '  ← YOUR VAULT' : ''}`);
    for (const [key, label] of OS_LABELS) {
      const v = root.local_paths?.[key];
      const marker = key === ctx.clientOs ? '  [active]' : '';
      if (v) {
        lines.push(`   ${label}: ${v}${marker}`);
      } else if (key === ctx.clientOs) {
        lines.push(`   ${label}: (not configured for this OS)${marker}`);
        anyMissing = true;
      }
    }
    const resolved = rootLocalBase(ctx, root.id);
    if (resolved) {
      lines.push(`   On this machine: ${resolved}`);
    }
    lines.push('');
  });

  let text = `Watched directories (${active.length}):\n\n${lines.join('\n').trimEnd()}`;

  if (archived.length > 0) {
    const rows = archived.map((r) => {
      const oldPaths = OS_LABELS.map(([key]) => r.local_paths?.[key])
        .filter((v): v is string => !!v)
        .join(' | ');
      const target = r.vault_subfolder ? `→ vault: ${r.vault_subfolder}/` : '→ (notes trashed at migration)';
      return `- ${r.name}: ${oldPaths} ${target}`;
    });
    text +=
      `\n\nArchived roots — legacy path translation (${archived.length}):\n` +
      rows.join('\n') +
      `\n\nOld paths under these roots still work: get_note/sync_notes translate them into the vault automatically.`;
  }

  if (anyMissing) {
    text += `\n\nTip: an ACTIVE root missing a path for this OS (${ctx.clientOs}) can't sync on this machine — add the path in the Noesis Dashboard.`;
  }

  return text;
}
