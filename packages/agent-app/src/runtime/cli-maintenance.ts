/**
 * PRO-11: provider CLI maintenance. Detects when a newer Codex / Claude Code / OpenCode CLI is published,
 * installs it as a Muster-managed copy only while no chat is running (a request made during a run is
 * deferred and applied once the last run settles), and rolls a managed install back to the previous
 * version, or to the user's own install. Externally installed CLIs are never modified.
 *
 * Layout: <root>/<tool>/<version>/ is an npm prefix; <root>/state.json records current/previous/pending.
 * A managed version is activated by pointing MUSTER_<TOOL>_COMMAND at its binary for this process.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CliStatus, CliTool, CliUpdateResult } from '../shared/domains/providers-protocol.ts';
import { cliSpawn, locateCli } from './adapters/shared.ts';

export const CLI_TOOLS: Record<CliTool, { label: string; pkg: string; bin: string; envVar: string; defaultPath: (home: string) => string }> = {
  codex: { label: 'Codex CLI', pkg: '@openai/codex', bin: 'codex', envVar: 'MUSTER_CODEX_COMMAND', defaultPath: home => join(home, '.local/bin/codex') },
  claude: { label: 'Claude Code', pkg: '@anthropic-ai/claude-code', bin: 'claude', envVar: 'MUSTER_CLAUDE_COMMAND', defaultPath: home => join(home, '.claude/local/claude') },
  opencode: { label: 'OpenCode', pkg: 'opencode-ai', bin: 'opencode', envVar: 'MUSTER_OPENCODE_COMMAND', defaultPath: home => join(home, '.opencode/bin/opencode') },
};
export const isCliTool = (value: unknown): value is CliTool => typeof value === 'string' && Object.hasOwn(CLI_TOOLS, value);
const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
/** The first semver-looking token in a `--version` line or registry answer. */
export function extractVersion(text: string | null | undefined): string | null {
  const match = text ? VERSION.exec(text) : null;
  return match ? match[0] : null;
}
/** Numeric semver comparison; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  if (x[4] === y[4]) return 0;
  return !x[4] ? 1 : !y[4] ? -1 : x[4] < y[4] ? -1 : 1;
}

/** #721: the Codex build for this machine, as published in @openai/codex's per-platform packages. */
export function codexTarget(platform: string = process.platform, arch: string = process.arch): { suffix: string; triple: string; exe: string } | null {
  const triple = ({ 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl', 'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc' } as Record<string, string>)[`${platform}-${arch}`];
  return triple ? { suffix: `${platform}-${arch}`, triple, exe: platform === 'win32' ? 'codex.exe' : 'codex' } : null;
}
const registryUrl = (env: NodeJS.ProcessEnv) => (env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const registryPath = (pkg: string) => pkg.replace('/', '%2f');
/** The system tar (bsdtar on macOS and Windows 10+, GNU tar on Linux); found without PATH so a bare environment still has it. */
const systemTar = (env: NodeJS.ProcessEnv) => process.platform === 'win32' ? join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : ['/usr/bin/tar', '/bin/tar'].find(existsSync) ?? 'tar';

interface ToolState { current: string | null; previous: string | null; pending: { version: string; requestedAt: string } | null; latest: string | null; checkedAt: string | null; lastError?: string }
type State = Partial<Record<CliTool, ToolState>>;
const EMPTY: ToolState = { current: null, previous: null, pending: null, latest: null, checkedAt: null };

export interface CliMaintenanceDeps {
  root: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Chats with a run in flight; updates wait until this is zero. */
  activeSessions(): number;
  /** Published version of an npm package. The default asks the registry directly. */
  latestVersion?(pkg: string): Promise<string>;
  /** Installs pkg@version under prefix. The default downloads Codex's native build from the registry and runs `npm install --prefix` for the others. */
  install?(pkg: string, version: string, prefix: string): Promise<void>;
  /** `--version` of a binary; null when it cannot run. */
  version?(path: string): Promise<string | null>;
  /** Called after a managed version becomes (in)active, so provider lists re-read their executables. */
  onActivate?(tool: CliTool): void;
  onChange?(status: CliStatus): void;
  now?(): number;
  fetch?: typeof fetch;
}

const run = (file: string, args: string[], timeout: number): Promise<string> => new Promise((resolve, reject) => {
  execFile(cliSpawn(file, args).command, cliSpawn(file, args).args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', env: cliSpawn(file, []).env, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400))) : resolve(stdout));
});

export function createCliMaintenance(deps: CliMaintenanceDeps) {
  const env = deps.env ?? process.env, home = deps.home ?? homedir(), now = deps.now ?? Date.now;
  const http = deps.fetch ?? globalThis.fetch;
  const registryJson = async (path: string): Promise<Record<string, unknown>> => {
    const response = await http(`${registryUrl(env)}/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`The registry answered ${response.status} for ${decodeURIComponent(path)}.`);
    return await response.json() as Record<string, unknown>;
  };
  // Read straight from the registry, so a machine without npm (or Node) can still check and install.
  const latestVersion = deps.latestVersion ?? (async (pkg: string) => { const version = extractVersion(String((await registryJson(`${registryPath(pkg)}/latest`)).version ?? '')); if (!version) throw new Error('The registry did not report a version.'); return version; });
  /** #721: Codex's own native build for this machine, verified against the registry's checksum. Needs neither npm nor Node. */
  async function installCodex(version: string, prefix: string) {
    const target = codexTarget();
    if (!target) throw new Error(`Codex has no build for ${process.platform}-${process.arch}.`);
    const meta = await registryJson(`${registryPath('@openai/codex')}/${encodeURIComponent(`${version}-${target.suffix}`)}`);
    const dist = (meta.dist ?? {}) as { tarball?: unknown; integrity?: unknown };
    const integrity = typeof dist.integrity === 'string' ? /^sha512-(.+)$/.exec(dist.integrity)?.[1] : undefined;
    if (typeof dist.tarball !== 'string' || !integrity) throw new Error('The registry did not list a download with a checksum.');
    const response = await http(dist.tarball, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}.`);
    const archive = join(prefix, 'codex.tgz'), hash = createHash('sha512');
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), async function* (chunks) { for await (const chunk of chunks) { hash.update(chunk as Buffer); yield chunk; } }, createWriteStream(archive, { mode: 0o600 }));
    if (hash.digest('base64') !== integrity) throw new Error('The download failed its checksum.');
    const destination = join(prefix, 'node_modules', '@openai', `codex-${target.suffix}`);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    await run(systemTar(env), ['-xzf', archive, '-C', destination, '--strip-components=1'], 5 * 60_000);
    rmSync(archive, { force: true });
  }
  const install = deps.install ?? (async (pkg: string, version: string, prefix: string) => {
    if (pkg === CLI_TOOLS.codex.pkg) return installCodex(version, prefix);
    await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${pkg}@${version}`], 10 * 60_000);
  });
  const readVersion = deps.version ?? (async (path: string) => { try { return (await run(path, ['--version'], 5_000)).trim().split('\n')[0]!.slice(0, 120) || null; } catch { return null; } });
  const stateFile = join(deps.root, 'state.json');
  const original = new Map<CliTool, string | undefined>((Object.keys(CLI_TOOLS) as CliTool[]).map(tool => [tool, env[CLI_TOOLS[tool].envVar]]));
  const busy = new Set<CliTool>();

  let state: State = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) as State; } catch { state = {}; }
  const tool = (name: CliTool): ToolState => ({ ...EMPTY, ...state[name] });
  const save = (name: CliTool, next: ToolState) => {
    state = { ...state, [name]: next };
    mkdirSync(deps.root, { recursive: true, mode: 0o700 });
    const temp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, stateFile);
  };
  const prefix = (name: CliTool, version: string) => join(deps.root, name, version);
  const binary = (name: CliTool, version: string) => {
    // Codex runs as its native binary (from Muster's download, or the platform package npm installed), not through the Node wrapper.
    const target = name === 'codex' ? codexTarget() : null;
    const native = target && join(prefix(name, version), 'node_modules', '@openai', `codex-${target.suffix}`, 'vendor', target.triple, 'bin', target.exe);
    return native && existsSync(native) ? native : join(prefix(name, version), 'node_modules', '.bin', CLI_TOOLS[name].bin);
  };
  const activate = (name: CliTool) => {
    const current = tool(name).current, variable = CLI_TOOLS[name].envVar;
    if (current && existsSync(binary(name, current))) env[variable] = binary(name, current);
    else if (original.get(name) === undefined) delete env[variable]; else env[variable] = original.get(name);
    deps.onActivate?.(name);
  };
  const externalPath = (name: CliTool): string | null => {
    const configured = original.get(name);
    if (configured) return existsSync(configured) ? configured : null;
    // The user's own install anywhere Muster can see it (PATH, version managers, a desktop app bundle), not only the default path.
    return locateCli(CLI_TOOLS[name].bin, env, home, [CLI_TOOLS[name].defaultPath(home)]) ?? null;
  };

  async function status(name: CliTool): Promise<CliStatus> {
    const t = tool(name), managedPath = t.current ? binary(name, t.current) : null;
    const path = managedPath && existsSync(managedPath) ? managedPath : externalPath(name);
    const installedVersion = path ? extractVersion(await readVersion(path)) : null;
    const versions = [t.current, t.previous].filter((v): v is string => !!v && existsSync(binary(name, v)));
    return {
      tool: name, label: CLI_TOOLS[name].label, package: CLI_TOOLS[name].pkg,
      installed: { path, version: installedVersion, managed: path !== null && path === managedPath },
      latest: t.latest, checkedAt: t.checkedAt,
      updateAvailable: !!(t.latest && (!installedVersion || compareVersions(t.latest, installedVersion) > 0)),
      managed: { current: t.current, previous: t.previous, versions },
      pending: t.pending, activeSessions: deps.activeSessions(), busy: busy.has(name),
      canRollback: !!t.current,
      rollbackTarget: t.previous ? `${CLI_TOOLS[name].label} ${t.previous} (managed)` : t.current ? externalPath(name) ? 'your own install' : 'no managed install' : null,
      ...(t.lastError ? { lastError: t.lastError } : {}),
    };
  }
  const changed = async (name: CliTool) => { const next = await status(name); deps.onChange?.(next); return next; };

  async function check(name: CliTool): Promise<CliStatus> {
    try { const latest = await latestVersion(CLI_TOOLS[name].pkg); save(name, { ...tool(name), latest, checkedAt: new Date(now()).toISOString(), lastError: undefined }); }
    catch (error) { save(name, { ...tool(name), checkedAt: new Date(now()).toISOString(), lastError: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` }); }
    return changed(name);
  }

  async function apply(name: CliTool, version: string): Promise<CliUpdateResult> {
    if (busy.has(name)) throw new Error(`${CLI_TOOLS[name].label} is already being updated.`);
    busy.add(name);
    const t = tool(name), dir = prefix(name, version), fresh = !existsSync(binary(name, version));
    try {
      if (fresh) { mkdirSync(dir, { recursive: true, mode: 0o700 }); await install(CLI_TOOLS[name].pkg, version, dir); }
      const reported = extractVersion(await readVersion(binary(name, version)));
      if (!existsSync(binary(name, version)) || !reported) throw new Error('The installed CLI did not run (`--version` failed).');
      const previous = t.current && t.current !== version ? t.current : t.previous;
      // Keep only the version being replaced for rollback; older managed copies are removed.
      for (const stale of [t.previous].filter((v): v is string => !!v && v !== version && v !== previous)) rmSync(prefix(name, stale), { recursive: true, force: true });
      save(name, { ...t, current: version, previous: previous ?? null, pending: null, lastError: undefined });
      activate(name);
      return { outcome: 'updated', status: await changed(name) };
    } catch (error) {
      if (fresh) rmSync(dir, { recursive: true, force: true });
      save(name, { ...tool(name), pending: null, lastError: `Update to ${version} failed; nothing changed. ${error instanceof Error ? error.message : String(error)}` });
      return { outcome: 'failed', status: await changed(name) };
    } finally { busy.delete(name); }
  }

  /** Installs `version` (default: the latest published) now, or defers it until no chat is running. */
  async function update(name: CliTool, version?: string): Promise<CliUpdateResult> {
    let target = version;
    if (!target) { const checked = await check(name); target = checked.latest ?? undefined; }
    if (!target || !extractVersion(target)) throw new Error('No published version is known yet. Check for updates first.');
    target = extractVersion(target)!;
    if (deps.activeSessions() > 0) {
      save(name, { ...tool(name), pending: { version: target, requestedAt: new Date(now()).toISOString() } });
      return { outcome: 'deferred', status: await changed(name) };
    }
    return apply(name, target);
  }

  /** Back to the previous managed version, or (with none) to the user's own install. Refused while a chat runs. */
  async function rollback(name: CliTool): Promise<CliStatus> {
    const t = tool(name);
    if (!t.current) throw new Error(`${CLI_TOOLS[name].label} is not a Muster-managed install; nothing to roll back.`);
    if (deps.activeSessions() > 0) throw new Error('Wait for running chats to finish before rolling back the CLI.');
    if (busy.has(name)) throw new Error(`${CLI_TOOLS[name].label} is being updated.`);
    if (t.previous && existsSync(binary(name, t.previous))) save(name, { ...t, current: t.previous, previous: t.current, pending: null, lastError: undefined });
    else save(name, { ...t, current: null, previous: t.current, pending: null, lastError: undefined });
    activate(name);
    return changed(name);
  }

  async function cancel(name: CliTool): Promise<CliStatus> { save(name, { ...tool(name), pending: null }); return changed(name); }

  /** Applies deferred updates once nothing is running. Safe to call after every settled run. */
  async function idle(): Promise<void> {
    if (deps.activeSessions() > 0) return;
    for (const name of Object.keys(CLI_TOOLS) as CliTool[]) {
      const pending = tool(name).pending;
      if (pending && !busy.has(name)) await apply(name, pending.version);
    }
  }

  for (const name of Object.keys(CLI_TOOLS) as CliTool[]) if (tool(name).current) activate(name);
  return { status, check, update, rollback, cancel, idle, binary };
}
export type CliMaintenance = ReturnType<typeof createCliMaintenance>;
