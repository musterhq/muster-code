/**
 * R9 automatic provider detection. Muster re-probes which providers can run chats (and which models they offer)
 * at launch, when the window regains focus (`refresh`), and whenever one of the sign-in or profile files a CLI
 * writes changes: `codex login` rewriting ~/.codex/auth.json, Claude Code updating ~/.claude.json, OpenCode's
 * auth.json, a gateway profile or its model catalog. The watch is a stat poll of a fixed list of paths (mtime, size,
 * inode only): no file here is opened for its contents except the two Codex profile TOMLs, and only to find the
 * model catalog path they name. Credentials are never read; readiness comes from the regular provider list.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ProviderInfo } from '../shared/protocol.ts';
import type { ProvidersChange } from '../shared/domains/setup-protocol.ts';

/** Paths whose change can make a provider appear, disappear or list different models. */
export function watchedProviderPaths(options: { home?: string; env?: NodeJS.ProcessEnv; dataDir?: string } = {}): string[] {
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share'), config = env.XDG_CONFIG_HOME || join(home, '.config');
  const profiles = [join(codexHome, 'hybrow-gateway.config.toml'), join(codexHome, 'openai-direct.config.toml')];
  return [
    join(codexHome, 'auth.json'), join(codexHome, 'config.toml'), ...profiles, ...profiles.map(catalogPathIn).filter((path): path is string => !!path),
    join(claudeDir, '.credentials.json'), env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'),
    join(data, 'opencode', 'auth.json'), join(config, 'opencode', 'opencode.json'),
    join(home, '.omniroute'),
    // A CLI appearing (installed by the user or as a Muster-managed copy) makes its provider listable.
    join(home, '.local/bin/codex'), join(home, '.claude/local/claude'), join(home, '.opencode/bin/opencode'),
    '/opt/homebrew/bin/codex', '/opt/homebrew/bin/claude', '/opt/homebrew/bin/opencode', '/usr/local/bin/codex', '/usr/local/bin/claude', '/usr/local/bin/opencode',
    ...(options.dataDir ? [join(options.dataDir, 'managed-cli', 'state.json'), join(options.dataDir, 'provider-accounts.json')] : []),
  ];
}

/** The `model_catalog_json` path a Codex profile names (a plain path, not a secret), or undefined. */
export function catalogPathIn(profile: string): string | undefined {
  try {
    const info = statSync(profile);
    if (!info.isFile() || info.size > 256 * 1024) return undefined;
    const match = /^\s*model_catalog_json\s*=\s*"([^"\n]{1,1024})"/m.exec(readFileSync(profile, 'utf8'));
    return match && isAbsolute(match[1]!) ? match[1] : undefined;
  } catch { return undefined; }
}

/** mtime:size:inode per path; "-" when missing. Contents are never read. */
export function fingerprint(paths: readonly string[], stat: (path: string) => string = defaultStat): string {
  return paths.map(path => `${path}=${stat(path)}`).join('\n');
}
const defaultStat = (path: string) => { try { const s = statSync(path); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return '-'; } };

/** Ready providers and their model counts, as a stable string. */
export const readySignature = (providers: readonly ProviderInfo[]): string => providers.filter(p => p.available).map(p => `${p.id}:${p.models.length}`).sort().join('|');

/** Providers that became ready (or gained models) between two listings. */
export function newlyReady(before: readonly ProviderInfo[] | null, after: readonly ProviderInfo[]): ProvidersChange['connected'] {
  const was = new Map((before ?? []).filter(p => p.available).map(p => [p.id, p.models.length]));
  return after.filter(p => p.available && !was.has(p.id)).map(p => ({ id: p.id, name: p.name, models: p.models.length }));
}

export interface ProviderWatchOptions {
  list(): Promise<ProviderInfo[]>;
  paths(): string[];
  emit(change: ProvidersChange): void;
  /** Runs once per listing that changed readiness; used to pick a default model when exactly one provider is ready. */
  onReady?(providers: ProviderInfo[]): void | Promise<void>;
  /** Awaited before the first (launch) probe, e.g. the adapter catalog's first validation. */
  ready?(): Promise<void>;
  stat?(path: string): string;
  intervalMs?: number;
  /** Quiet time after a file change before re-probing: a sign-in writes several files in a burst. */
  debounceMs?: number;
}

export function createProviderWatch(options: ProviderWatchOptions) {
  const interval = options.intervalMs ?? 2_000, debounce = options.debounceMs ?? 600;
  let last: ProviderInfo[] | null = null, lastSignature: string | null = null, print = '', disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined, pending: ReturnType<typeof setTimeout> | undefined, probing: Promise<ProviderInfo[]> | null = null, again = false;

  async function probe(reason: ProvidersChange['reason']): Promise<ProviderInfo[]> {
    if (probing) { again = true; return probing; }
    probing = (async () => {
      let providers: ProviderInfo[];
      try { providers = await options.list(); } catch { return last ?? []; }
      if (disposed) return providers;
      const signature = readySignature(providers);
      const initial = last === null;
      if (initial || signature !== lastSignature) {
        const connected = initial ? [] : newlyReady(last, providers);
        last = providers; lastSignature = signature;
        options.emit({ providers, connected, reason: initial ? 'launch' : reason });
        try { await options.onReady?.(providers); } catch { /* a default-model write failing never breaks detection */ }
      } else last = providers;
      return providers;
    })();
    try { return await probing; }
    finally { probing = null; if (again && !disposed) { again = false; void probe(reason); } }
  }
  function poll(): void {
    if (disposed) return;
    let next: string;
    try { next = fingerprint(options.paths(), options.stat); } catch { return; }
    if (next === print) return;
    print = next;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = undefined; void probe('files'); }, debounce);
    pending.unref?.();
  }
  return {
    /** Launch probe, then the file watch. */
    async start(): Promise<void> {
      try { print = fingerprint(options.paths(), options.stat); } catch { print = ''; }
      await options.ready?.().catch(() => undefined);
      if (disposed) return;
      await probe('launch');
      if (disposed) return;
      timer = setInterval(poll, interval); timer.unref?.();
    },
    /** Focus/resume: re-probe now, without waiting for a file change. */
    refresh: () => probe('focus'),
    /** Test seam: one poll tick. */
    poll,
    current: () => last,
    dispose(): void { disposed = true; if (timer) clearInterval(timer); if (pending) clearTimeout(pending); },
  };
}
export type ProviderWatch = ReturnType<typeof createProviderWatch>;
