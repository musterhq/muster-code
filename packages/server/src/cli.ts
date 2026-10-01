/**
 * muster-server CLI. Human output by default, --json for scripts. Exit codes: 0 ok, 1 error, 2 usage, 3 not running (status/stop).
 *
 * Admin commands go to the running server over loopback with the local CLI token (<data-dir>/keys/cli.token, 0600, minted by `init`),
 * so they share the live runtime (Roster mirror, connector restarts). When the server is stopped they run directly on the data directory.
 */
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { publicUser } from './auth/accounts.ts';
import { defaultConfig, DEFAULT_PORT, isLoopback, paths, readConfig, resolveDataDir, validateBind, writeConfig, type ServerConfig } from './config.ts';
import { verifyLedger } from './cost.ts';
import { parseDuration } from './auth/tokens.ts';
import { PolicyError } from './policy.ts';
import { dispatch, type RpcContext } from './rpc.ts';
import { resolveRuntimeDir } from './runtime-host.ts';
import { MusterServer, resolveRendererDir, resolveWebDir } from './server.ts';
import { runAgentClient } from './cli-agent.ts';
import { runWork, WORK_GROUPS } from './cli-work.ts';
import type { UserRecord } from './store/types.ts';
import { VERSION } from './version.ts';

export class UsageError extends Error {}
export interface Parsed { cmd: string[]; flags: Map<string, string[]>; bools: Set<string> }
const BOOL_FLAGS = new Set(['version', 'json', 'detach', 'dry-run', 'trust-proxy', 'help', 'password-stdin', 'yes', 'disable']);

export function parseArgs(argv: string[]): Parsed {
  const cmd: string[] = [], flags = new Map<string, string[]>(), bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') { bools.add('help'); continue; }
    if (!a.startsWith('--')) { cmd.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOL_FLAGS.has(name) && inline === undefined) { bools.add(name); continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { cmd, flags, bools };
}
export const flag = (p: Parsed, name: string) => p.flags.get(name)?.at(-1);
export const flagList = (p: Parsed, name: string) => (p.flags.get(name) ?? []).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean);

const HELP = `muster-server ${VERSION} — self-hosted Muster: the desktop app's agents, projects and Ledger, served to your team.

Usage: muster-server <command> [options]          (--json on any command for machine output)

Setup and lifecycle
  init        Create the data directory, secret key and owner account
              [--data-dir DIR] [--username NAME] [--name "Full Name"] [--password-stdin]
              [--host H] [--port N] [--allowed-host HOST]... [--public-url URL] [--tls-cert F --tls-key F] [--trust-proxy]
  start       Run the server in the foreground (use --detach to background it)
              [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--data-dir DIR] [--allowed-host HOST]... [--tls-cert F --tls-key F]
              [--public-url URL] [--trust-proxy] [--detach]
  stop        Stop a running server
  status      Version, URL, uptime, memory, people, sessions and connector health
  doctor      Check the install: Node, permissions, key, database, bundles, bind safety, TLS, connectors, audit chains
  backup      Copy the server and runtime databases [--to DIR]

People and access
  invite      Create a single-use invite link  [--role owner|admin|member|viewer] [--expires 7d] [--note TEXT]
  users list | role <user> <role> | revoke <user> | restore <user> | reset-password <user> [--password-stdin]
        grant <user> --project <id> [--role owner|editor|viewer] | ungrant <user> --project <id>
  token create [--user U] [--name N] [--ttl 90d|never] | list | revoke <id>

Connectors (several instances per type)
  connectors list | types
  connectors add <slack|telegram|mattermost|…> --name NAME [--mode M] [--scope org|project|user] [--project ID]
             [--config key=value]... [--secret name=env:VAR | name=file:PATH | name=stdin]...
  connectors test <name> | enable <name> | disable <name> | remove <name> | events <name>
  connectors route <name> --project ID [--match "channel=#support,mention=true"] [--agent ID] [--mode reply|task] [--priority N]
  connectors unroute <rule-id> | link <name> <external-user-id> <user>
  connectors import-gateway <path/to/.muster/gateway.json> [--dry-run]

Work (the running server; your token's role and project grants apply, as in the app)
  projects list | show <project>
  tasks list|show|create|state|assign|start|comment   --project P  [--state S] [--assignee NAME] [--title T --acceptance A --assignee NAME --priority 0-3 --start]
        tasks state <task> <state> [--reason R] | assign <task> <agent> | start <task> | comment <task> <text…>
  roster list|add|pause|resume|remove  --project P   (add: --name N [--title T] [--reports-to NAME] [--runner provider/model] [--instructions-file F])
  approvals list|approve|decline|comment|revise  --project P [<id> …]
  ledger [--limit N] [--since 2026-09-01]
  org teams | export --project P --out F.zip | import <F.zip>|--team KEY [--project P|--name NEW] [--collision skip|rename|replace] [--dry-run] | preview | pending | activate
  backups list | run | restore <id> | settings [--enabled true|false] [--every HOURS] [--keep N]

Remote agents (G28)
  agents invite --project P --name NAME [--title T] [--expires 24h] | list | revoke <id>
  agent join <server-url> --invite TOKEN [--out FILE]      (on the agent's machine; saves a 0600 credentials file)
  agent me | tasks | task <task> | comment <task> <text…> | state <task> <implemented|blocked|review> [--comment C] | doc <task> <key> --file F | wait [--timeout 25]

Reports
  cost report [--since 30d|2026-09-01] [--by user|project|model]
  audit verify | audit list [--limit N]

Environment: MUSTER_SERVER_DATA_DIR (default ~/.muster-server), MUSTER_SERVER_SECRET_KEY (instead of keys/secret.key).
Docs: https://github.com/musterhq/muster-code/blob/main/docs/server.md`;

// ------------------------------------------------------------------ output
let JSON_MODE = false;
export const jsonMode = () => JSON_MODE;
export const out = (human: string, data: unknown) => { process.stdout.write(JSON_MODE ? JSON.stringify(data, null, 2) + '\n' : human.endsWith('\n') ? human : human + '\n'); };
export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (!rows.length) return '(none)';
  const cell = (v: unknown) => v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const widths = columns.map(c => Math.min(48, Math.max(c.length, ...rows.map(r => cell(r[c]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.length > widths[i]! ? v.slice(0, widths[i]! - 1) + '…' : v.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(columns.map(c => c.toUpperCase())), ...rows.map(r => line(columns.map(c => cell(r[c]))))].join('\n');
}
const since = (text: string | undefined): string | null => {
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) { const d = new Date(text); if (Number.isNaN(+d)) throw new UsageError(`Invalid date "${text}".`); return d.toISOString(); }
  return new Date(Date.now() - parseDuration(text, 0)).toISOString();
};

// ------------------------------------------------------------------ input helpers
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Expected the value on standard input.');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError('No terminal to prompt on. Pass --password-stdin and pipe the password.');
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void });
    write._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}
async function password(p: Parsed, label: string, confirm = true): Promise<string> {
  if (p.bools.has('password-stdin')) return readStdin();
  if (process.env.MUSTER_SERVER_OWNER_PASSWORD) return process.env.MUSTER_SERVER_OWNER_PASSWORD;
  const first = await promptHidden(`${label}: `);
  if (confirm && (await promptHidden('Repeat it: ')) !== first) throw new UsageError('The passwords did not match.');
  return first;
}
async function secretValue(spec: string): Promise<[string, string]> {
  const m = /^([A-Za-z][A-Za-z0-9_]*)=(env:|file:|stdin$)(.*)$/.exec(spec);
  if (!m) throw new UsageError(`--secret ${spec.split('=')[0]}=… must be env:VAR, file:PATH or stdin (secret values are never taken from the command line).`);
  const [, name, kind, rest] = m;
  if (kind === 'env:') { const v = process.env[rest!]; if (!v) throw new UsageError(`Environment variable ${rest} is empty.`); return [name!, v]; }
  if (kind === 'file:') { if (!existsSync(rest!)) throw new UsageError(`No file ${rest}.`); return [name!, readFileSync(rest!, 'utf8').trim()]; }
  return [name!, (await readStdin()).trim()];
}

// ------------------------------------------------------------------ server process
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
function runningPid(dataDir: string): number | null {
  const file = paths(dataDir).pid;
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}
function statusFile(dataDir: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(join(dataDir, 'server.status.json'), 'utf8')); } catch { return null; }
}
export function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    // Loopback only: the CLI already holds the data directory, so a self-signed certificate on 127.0.0.1 is accepted.
    const req = lib.request(u, { method: init.method ?? 'GET', headers: { host: 'localhost', ...init.headers }, timeout: 120_000, ...(u.protocol === 'https:' ? { rejectUnauthorized: !isLoopback(u.hostname) } : {}) }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    if (init.body) req.write(init.body);
    req.end();
  });
}
async function liveUrl(dataDir: string): Promise<string | null> {
  if (!runningPid(dataDir)) return null;
  const url = statusFile(dataDir)?.url;
  if (typeof url !== 'string') return null;
  try { const r = await request(`${url}/healthz`, {}); return r.status === 200 ? url : null; } catch { return null; }
}

// ------------------------------------------------------------------ command execution (online or offline)
export interface Exec { call(command: string, input?: Record<string, unknown>): Promise<unknown>; close(): Promise<void>; online: boolean; dataDir: string; actor: UserRecord | null }
async function executor(dataDir: string): Promise<Exec> {
  const p = paths(dataDir);
  if (!existsSync(p.config)) throw new Error(`No Muster Server at ${dataDir}. Run: muster-server init${dataDir !== resolveDataDir() ? ` --data-dir ${dataDir}` : ''}`);
  const url = await liveUrl(dataDir);
  const tokenFile = join(p.dir, 'keys', 'cli.token');
  if (url && existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    return { online: true, dataDir, actor: null, close: async () => undefined, call: async (command, input = {}) => {
      const r = await request(`${url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, input }) });
      let j: { ok?: boolean; value?: unknown; error?: string };
      try { j = JSON.parse(r.body); } catch { throw new Error(`Server answered HTTP ${r.status}.`); }
      if (r.status === 401) throw new Error('The local CLI token was rejected (revoked?). Run: muster-server token create --name local-cli, then save it to keys/cli.token.');
      if (!j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j.value;
    } };
  }
  const server = new MusterServer({ dataDir, config: readConfig(p)!, noRuntime: true, log: () => undefined });
  await server.open(false);
  const owner = (await server.store.listUsers()).find(u => u.role === 'owner' && u.status === 'active') ?? null;
  if (!owner) throw new Error('This server has no active owner. Run: muster-server init');
  const ctx: RpcContext = { store: server.store, accounts: server.accounts, audit: server.audit, runtime: null, registry: server.registry, agents: server.agents, runtimeDir: p.runtime,
    version: VERSION, startedAt: Date.now(), inviteUrl: token => `${baseUrl(readConfig(p)!)}/invite/${token}`, bumpAccess: () => undefined,
    status: async () => ({ running: false }) };
  return { online: false, dataDir, actor: owner, close: () => server.store.close(), call: (command, input = {}) => dispatch(ctx, { user: owner, via: 'token' }, command, input) };
}
const baseUrl = (c: ServerConfig) => (c.publicUrl ?? `${c.tlsCert ? 'https' : 'http'}://${c.host === '0.0.0.0' || c.host === '::' ? (c.allowedHosts[0] ?? '127.0.0.1') : c.host.includes(':') ? `[${c.host}]` : c.host}:${c.port}`).replace(/\/+$/, '');

// ------------------------------------------------------------------ commands
function configFromFlags(base: ServerConfig, p: Parsed): ServerConfig {
  const c = { ...base };
  if (flag(p, 'host')) c.host = flag(p, 'host')!;
  if (flag(p, 'port')) { c.port = Number(flag(p, 'port')); if (!Number.isInteger(c.port)) throw new UsageError('--port must be a number.'); }
  if (p.flags.has('allowed-host')) c.allowedHosts = flagList(p, 'allowed-host');
  if (flag(p, 'tls-cert')) c.tlsCert = flag(p, 'tls-cert')!;
  if (flag(p, 'tls-key')) c.tlsKey = flag(p, 'tls-key')!;
  if (flag(p, 'public-url')) { const u = flag(p, 'public-url')!; if (!/^https?:\/\/[^/]+/.test(u)) throw new UsageError('--public-url must be an http(s) URL.'); c.publicUrl = u.replace(/\/+$/, ''); }
  if (p.bools.has('trust-proxy')) c.trustProxy = true;
  return c;
}

async function cmdInit(p: Parsed, dataDir: string) {
  const pt = paths(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* best effort */ }
  const existing = readConfig(pt);
  const config = configFromFlags(existing ?? defaultConfig(), p);
  const warnings = validateBind(config);
  writeConfig(pt, config);
  const server = new MusterServer({ dataDir, config, noRuntime: true, log: () => undefined });
  await server.open(true);
  try {
    if (await server.store.countUsers() > 0) {
      out(`Already initialized at ${dataDir}. Settings saved. Start it with: muster-server start${dataDir !== resolveDataDir() ? ` --data-dir ${dataDir}` : ''}`, { ok: true, initialized: false, dataDir, config });
      return;
    }
    const username = flag(p, 'username') ?? (process.env.USER ?? 'owner').toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? 'owner';
    const pw = await password(p, `Password for ${username} (10+ characters)`);
    const owner = await server.accounts.initOwner({ username, password: pw, displayName: flag(p, 'name') });
    const { token } = await server.accounts.createToken(owner, { name: 'local-cli', ttl: 'never' });
    const tokenFile = join(dataDir, 'keys', 'cli.token');
    writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    out([`Muster Server initialized at ${dataDir}`, `  owner      ${owner.username}`, `  key        ${pt.key} (0600; back it up: secrets are unreadable without it)`,
      `  cli token  ${tokenFile} (0600)`, `  listen     ${baseUrl(config)}`, ...warnings.map(w => `  warning    ${w}`), '', `Next: muster-server start${dataDir !== resolveDataDir() ? ` --data-dir ${dataDir}` : ''}`].join('\n'),
    { ok: true, initialized: true, dataDir, owner: publicUser(owner), url: baseUrl(config), warnings });
  } finally { await server.store.close(); }
}

async function cmdStart(p: Parsed, dataDir: string) {
  const pt = paths(dataDir);
  const base = readConfig(pt);
  if (!base) throw new Error(`No Muster Server at ${dataDir}. Run: muster-server init`);
  const config = configFromFlags(base, p);
  validateBind(config);
  const existing = runningPid(dataDir);
  if (existing) throw new Error(`Already running (pid ${existing}). Stop it first: muster-server stop`);
  if (JSON.stringify(config) !== JSON.stringify(base)) writeConfig(pt, config);
  if (p.bools.has('detach')) {
    mkdirSync(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
    const fd = openSync(pt.log, 'a', 0o600);
    const args = [...process.execArgv, process.argv[1]!, 'start', '--data-dir', dataDir];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref(); closeSync(fd);
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 200));
      const url = await liveUrl(dataDir);
      if (url) { out(`Muster Server running at ${url} (pid ${child.pid}). Logs: ${pt.log}`, { ok: true, pid: child.pid, url, log: pt.log }); return; }
      if (child.exitCode !== null) break;
    }
    throw new Error(`The server did not come up. See ${pt.log}`);
  }
  const server = new MusterServer({ dataDir, config });
  const url = await server.start();
  if (JSON_MODE) out('', { ok: true, pid: process.pid, url });
  else process.stdout.write(`Muster Server ${VERSION} running at ${url}${config.publicUrl ? ` (public ${config.publicUrl})` : ''}. Ctrl-C to stop.\n`);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return; stopping = true;
    process.stdout.write(`Stopping (${signal})…\n`);
    const force = setTimeout(() => process.exit(1), 15_000); force.unref();
    await server.stop(); process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGHUP', () => void server.reload().catch(e => server.log(`reload failed: ${(e as Error).message}`)));
  await new Promise(() => undefined);
}

async function cmdStop(dataDir: string) {
  const pid = runningPid(dataDir);
  if (!pid) { out('Muster Server is not running.', { ok: true, running: false }); process.exitCode = 3; return; }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 75; i++) { await new Promise(r => setTimeout(r, 200)); if (!pidAlive(pid)) { out(`Stopped (pid ${pid}).`, { ok: true, stopped: pid }); return; } }
  process.kill(pid, 'SIGKILL');
  out(`Did not stop in 15 s; killed pid ${pid}.`, { ok: true, killed: pid });
}

async function cmdStatus(dataDir: string) {
  const pid = runningPid(dataDir);
  const url = pid ? await liveUrl(dataDir) : null;
  const s = statusFile(dataDir);
  if (!pid || !url) {
    out(`Muster Server is not running${existsSync(paths(dataDir).config) ? ` (data ${dataDir})` : ` and not initialized at ${dataDir}`}.`, { ok: true, running: false, dataDir });
    process.exitCode = 3; return;
  }
  const connectors = (s?.connectors as Array<Record<string, unknown>>) ?? [];
  out([`Muster Server ${s?.version ?? '?'} — running`, `  url        ${url}${s?.publicUrl ? `  (public ${s.publicUrl})` : ''}`, `  pid        ${pid}   uptime ${s?.uptimeSec ?? '?'} s   memory ${s?.rssMb ?? '?'} MB RSS`,
    `  people     ${(s?.users as { active?: number })?.active ?? '?'} active   sessions ${s?.sessions ?? '?'}   open streams ${s?.openStreams ?? '?'}`, `  store      ${s?.store ?? '?'}   data ${dataDir}   tls ${s?.tls ? 'on' : 'off'}`,
    '', 'Connectors', table(connectors.map(c => ({ ...c, lastError: c.state === 'ok' ? null : c.lastError })), ['name', 'type', 'enabled', 'state', 'reconnects', 'lastError'])].join('\n'), { ok: true, running: true, ...s, url });
}

interface Check { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }
async function cmdDoctor(dataDir: string) {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major === 24 ? 'ok' : 'fail', `Node ${process.versions.node}${major === 24 ? '' : ' (Muster Server needs Node 24: node:sqlite and the runtime bundle target it)'}`);
  const pt = paths(dataDir);
  const config = readConfig(pt);
  if (!config) add('data dir', 'fail', `${dataDir} is not initialized. Run: muster-server init`);
  else {
    const mode = statSync(dataDir).mode & 0o777;
    add('data dir', mode & 0o077 ? 'warn' : 'ok', `${dataDir} mode ${mode.toString(8)}${mode & 0o077 ? ' (others can read it; chmod 700)' : ''}`);
    try {
      const keyMode = process.env.MUSTER_SERVER_SECRET_KEY ? null : statSync(pt.key).mode & 0o777;
      add('secret key', keyMode !== null && keyMode & 0o077 ? 'fail' : 'ok', process.env.MUSTER_SERVER_SECRET_KEY ? 'from MUSTER_SERVER_SECRET_KEY' : `${pt.key} mode ${keyMode!.toString(8)}`);
    } catch { add('secret key', 'fail', `missing ${pt.key}; connector and provider secrets cannot be read`); }
    try {
      const db = new DatabaseSync(pt.db, { readOnly: true });
      const integrity = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
      const owners = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='owner' AND status='active'").get() as { c: number }).c;
      db.close();
      add('database', integrity === 'ok' ? 'ok' : 'fail', `${pt.db}: ${integrity}`);
      add('owner', owners > 0 ? 'ok' : 'fail', `${owners} active owner${owners === 1 ? '' : 's'}`);
    } catch (e) { add('database', 'fail', (e as Error).message); }
    try { const w = validateBind(config); add('bind', w.length ? 'warn' : 'ok', w.join(' ') || `${config.host}:${config.port}${config.allowedHosts.length ? ` allowed ${config.allowedHosts.join(', ')}` : ''}`); }
    catch (e) { add('bind', 'fail', (e as Error).message); }
    if (config.tlsCert) {
      try { readFileSync(config.tlsCert); readFileSync(config.tlsKey!); add('tls', 'ok', `${config.tlsCert}`); } catch (e) { add('tls', 'fail', (e as Error).message); }
    } else add('tls', isLoopback(config.host) ? 'ok' : 'warn', isLoopback(config.host) ? 'off (loopback; terminate TLS in your reverse proxy)' : 'off');
    const pid = runningPid(dataDir);
    if (!pid) {
      const free = await new Promise<boolean>(r => { const s = createServer(); s.once('error', () => r(false)); s.listen(config.port, config.host === '0.0.0.0' ? '0.0.0.0' : config.host, () => s.close(() => r(true))); });
      add('port', free ? 'ok' : 'fail', free ? `${config.port} is free` : `${config.port} is in use by another process`);
    } else add('port', 'ok', `in use by this server (pid ${pid})`);
  }
  try { const r = resolveRuntimeDir(); add('runtime bundle', 'ok', r); add('web UI bundle', 'ok', resolveRendererDir(r)); } catch (e) { add('runtime bundle', 'fail', (e as Error).message); }
  try { add('server web assets', 'ok', resolveWebDir()); } catch (e) { add('server web assets', 'fail', (e as Error).message); }
  if (config) {
    try {
      const exec = await executor(dataDir);
      try {
        const audit = await exec.call('server.audit.verify') as { ok: boolean; entries: number; brokenAt: number | null };
        add('audit chain', audit.ok ? 'ok' : 'fail', audit.ok ? `${audit.entries} entries verified` : `broken at entry ${audit.brokenAt}`);
        const connectors = await exec.call('server.connectors.list') as Array<{ name: string; type: string; available: boolean; enabled: boolean; secrets: Record<string, boolean>; health: { state: string; lastError: string | null } | null }>;
        for (const c of connectors) {
          const missing = Object.entries(c.secrets).filter(([n, ok]) => !ok && n !== 'webhookSecret').map(([n]) => n);
          const state = c.health?.state ?? 'unknown';
          add(`connector ${c.name}`, !c.available ? 'warn' : missing.length || state === 'unauth' || state === 'down' ? 'fail' : state === 'ok' || state === 'disabled' || !exec.online ? 'ok' : 'warn',
            !c.available ? `${c.type}: coming soon` : missing.length ? `missing secrets: ${missing.join(', ')}` : `${c.type} ${c.enabled ? state : 'disabled'}${c.health?.lastError ? ` (${c.health.lastError})` : ''}`);
        }
      } finally { await exec.close(); }
    } catch (e) { add('audit chain', 'fail', (e as Error).message); }
    const ledger = verifyLedger(pt.runtime);
    add('turn ledger', ledger.ok ? 'ok' : 'fail', ledger.ok ? `${ledger.entries} entries verified` : `broken at entry ${ledger.brokenAt}`);
  }
  const failed = checks.filter(c => c.status === 'fail').length;
  out([...checks.map(c => `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`), '', failed ? `${failed} check${failed === 1 ? '' : 's'} failed.` : 'All checks passed.'].join('\n'), { ok: failed === 0, checks });
  if (failed) process.exitCode = 1;
}

async function cmdBackup(p: Parsed, dataDir: string) {
  const pt = paths(dataDir);
  if (!existsSync(pt.config)) throw new Error(`No Muster Server at ${dataDir}.`);
  const dest = flag(p, 'to') ?? join(dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(join(dest, 'runtime'), { recursive: true, mode: 0o700 });
  const files: string[] = [];
  // SQLite files: VACUUM INTO writes a consistent copy even while the server runs. JSON state is copied as is.
  const copyDb = (src: string, target: string) => {
    const db = new DatabaseSync(src, { readOnly: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); db.close(); chmodSync(target, 0o600); files.push(target);
  };
  const copyFile = (src: string, target: string) => { writeFileSync(target, readFileSync(src), { mode: 0o600 }); files.push(target); };
  copyDb(pt.db, join(dest, 'server.sqlite'));
  copyFile(pt.config, join(dest, 'server.json'));
  if (existsSync(pt.runtime)) for (const name of readdirSync(pt.runtime)) {
    const src = join(pt.runtime, name);
    if (!statSync(src).isFile()) continue;
    if (name.endsWith('.sqlite')) copyDb(src, join(dest, 'runtime', name));
    else if (name.endsWith('.json')) copyFile(src, join(dest, 'runtime', name));
  }
  out([`Backup written to ${dest} (${files.length} files)`, '', 'The secret key is NOT included. Back up keys/secret.key separately (or keep MUSTER_SERVER_SECRET_KEY in your secret manager).'].join('\n'), { ok: true, dir: dest, files });
}

async function cmdAdmin(p: Parsed, dataDir: string) {
  const [group, sub, ...rest] = p.cmd;
  const exec = await executor(dataDir);
  try {
    const call = exec.call;
    const users = async () => call('server.users.list') as Promise<Array<Record<string, unknown> & { id: string; username: string }>>;
    const userId = async (name: string | undefined) => { if (!name) throw new UsageError('Name the user (username or id).'); const u = (await users()).find(x => x.id === name || x.username === name.toLowerCase()); if (!u) throw new Error(`No user "${name}".`); return u.id; };
    const connectorArg = () => { if (!rest[0]) throw new UsageError('Name the connector.'); return rest[0]; };
    switch (group) {
      case 'invite': {
        const r = await call('server.invites.create', { role: flag(p, 'role') ?? 'member', expires: flag(p, 'expires') ?? '7d', note: flag(p, 'note') }) as { url: string; invite: { role: string; expiresAt: string } };
        return out(`Invite (${r.invite.role}, single use, expires ${r.invite.expiresAt}):\n${r.url}`, r);
      }
      case 'users': {
        if (!sub || sub === 'list') { const list = await users(); return out(table(list.map(u => ({ ...u, projects: (u.projects as unknown[]).length })), ['username', 'displayName', 'role', 'status', 'activeSessions', 'projects', 'lastLoginAt']), list); }
        if (sub === 'role') { if (!rest[1]) throw new UsageError('Usage: users role <user> <owner|admin|member|viewer>'); const u = await call('server.users.role', { userId: await userId(rest[0]), role: rest[1] }) as { username: string; role: string }; return out(`${u.username} is now ${u.role}.`, u); }
        if (sub === 'revoke') { const r = await call('server.users.revoke', { userId: await userId(rest[0]) }) as { sessions: number; tokens: number }; return out(`Revoked ${rest[0]}: ${r.sessions} session(s) and ${r.tokens} token(s) ended immediately.`, r); }
        if (sub === 'restore') { const u = await call('server.users.restore', { userId: await userId(rest[0]) }); return out(`Restored ${rest[0]}.`, u); }
        if (sub === 'grant') { const project = flag(p, 'project'); if (!project) throw new UsageError('--project is required.'); if (!exec.online) throw new Error('Start the server first: granting project access also adds the person to the project Roster.'); await call('server.access.set', { userId: await userId(rest[0]), projectId: project, role: flag(p, 'role') ?? 'editor' }); return out(`${rest[0]} can now ${flag(p, 'role') === 'viewer' ? 'view' : 'work in'} project ${project}.`, { ok: true }); }
        if (sub === 'ungrant') { const project = flag(p, 'project'); if (!project) throw new UsageError('--project is required.'); await call('server.access.remove', { userId: await userId(rest[0]), projectId: project }); return out(`Removed ${rest[0]} from project ${project}.`, { ok: true }); }
        if (sub === 'reset-password') {
          if (exec.online) throw new Error('Stop the server to reset a password from the CLI (or have the person change it under Settings › Server).');
          const s = new MusterServer({ dataDir, config: readConfig(paths(dataDir))!, noRuntime: true, log: () => undefined });
          await s.open(false);
          try { const u = await s.accounts.findUser(rest[0] ?? ''); await s.accounts.resetPassword(u.id, await password(p, `New password for ${u.username}`), 'cli'); return out(`Password reset for ${u.username}; their sessions were ended.`, { ok: true }); }
          finally { await s.store.close(); }
        }
        throw new UsageError(`Unknown: users ${sub}`);
      }
      case 'token': {
        if (sub === 'create') { const r = await call('server.tokens.create', { userId: flag(p, 'user') ? await userId(flag(p, 'user')) : undefined, name: flag(p, 'name') ?? 'cli', ttl: flag(p, 'ttl') ?? '90d' }) as { token: string; record: { expiresAt: string | null } };
          return out(`${r.token}\n\nShown once. Expires ${r.record.expiresAt ?? 'never'}. Use it as: Authorization: Bearer <token>`, r); }
        if (!sub || sub === 'list') { const list = await call('server.tokens.list', { all: true }) as Array<Record<string, unknown>>; return out(table(list, ['id', 'prefix', 'name', 'userId', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt']), list); }
        if (sub === 'revoke') { if (!rest[0]) throw new UsageError('Usage: token revoke <id|prefix>'); await call('server.tokens.revoke', { id: rest[0] }); return out(`Revoked token ${rest[0]}.`, { ok: true }); }
        throw new UsageError(`Unknown: token ${sub}`);
      }
      case 'connectors': {
        if (!sub || sub === 'list') {
          const list = await call('server.connectors.list') as Array<Record<string, unknown> & { health: { state: string } | null; rules: unknown[] }>;
          return out(table(list.map(c => ({ ...c, state: c.health?.state ?? (c.enabled ? 'unknown' : 'disabled'), routes: c.rules.length })), ['name', 'type', 'mode', 'scope', 'enabled', 'state', 'routes', 'id']), list);
        }
        if (sub === 'types') { const t = await call('server.connectors.types') as Array<Record<string, unknown>>; return out(table(t, ['type', 'label', 'status', 'modes', 'note']), t); }
        if (sub === 'add') {
          const type = rest[0]; const name = flag(p, 'name');
          if (!type || !name) throw new UsageError('Usage: connectors add <type> --name NAME [--mode M] [--secret name=env:VAR]…');
          const secrets: Record<string, string> = {};
          for (const spec of p.flags.get('secret') ?? []) { const [k, v] = await secretValue(spec); secrets[k] = v; }
          const config: Record<string, unknown> = {};
          for (const kv of p.flags.get('config') ?? []) { const [k, ...v] = kv.split('='); const val = v.join('='); config[k!] = val === 'true' ? true : val === 'false' ? false : /^\d+$/.test(val) ? Number(val) : val; }
          const c = await call('server.connectors.add', { type, name, mode: flag(p, 'mode'), scope: flag(p, 'scope'), projectId: flag(p, 'project'), config, secrets }) as { name: string; id: string; health: { state: string; lastError: string | null } | null; webhookPath: string | null };
          return out([`Added ${type} connector "${c.name}" (${c.id}).`, `  state ${c.health?.state ?? 'starting'}${c.health?.lastError ? ` — ${c.health.lastError}` : ''}`, ...(c.webhookPath ? [`  webhook ${c.webhookPath}`] : []),
            `Next: muster-server connectors route ${c.name} --project <project-id> [--match "channel=#support"]`].join('\n'), c);
        }
        if (sub === 'test') { const r = await call('server.connectors.test', { id: connectorArg() }) as { ok: boolean; detail: string; latencyMs: number }; if (!r.ok) process.exitCode = 1; return out(`${r.ok ? 'ok' : 'FAILED'}: ${r.detail} (${r.latencyMs} ms)`, r); }
        if (sub === 'enable' || sub === 'disable') { const c = await call('server.connectors.enable', { id: connectorArg(), enabled: sub === 'enable' }); return out(`${sub === 'enable' ? 'Enabled' : 'Disabled'} ${rest[0]}.`, c); }
        if (sub === 'remove') { await call('server.connectors.remove', { id: connectorArg() }); return out(`Removed ${rest[0]} and its stored secrets.`, { ok: true }); }
        if (sub === 'route') {
          const project = flag(p, 'project'); if (!project) throw new UsageError('--project is required.');
          const r = await call('server.connectors.route', { id: connectorArg(), projectId: project, match: flag(p, 'match') ?? '', agentId: flag(p, 'agent'), mode: flag(p, 'mode') ?? 'reply', priority: flag(p, 'priority') ? Number(flag(p, 'priority')) : undefined }) as { id: string; priority: number };
          return out(`Route ${r.id} (priority ${r.priority}) → project ${project}${flag(p, 'agent') ? `, agent ${flag(p, 'agent')}` : ''}, mode ${flag(p, 'mode') ?? 'reply'}.`, r);
        }
        if (sub === 'unroute') { if (!rest[0]) throw new UsageError('Usage: connectors unroute <rule-id>'); await call('server.connectors.unroute', { ruleId: rest[0] }); return out(`Removed route ${rest[0]}.`, { ok: true }); }
        if (sub === 'link') { if (rest.length < 3) throw new UsageError('Usage: connectors link <name> <external-user-id> <user>'); await call('server.connectors.link', { id: rest[0], externalId: rest[1], userId: rest[2] }); return out(`Linked ${rest[1]} on ${rest[0]} to ${rest[2]}.`, { ok: true }); }
        if (sub === 'events') { const ev = await call('server.connectors.events', { id: rest[0], limit: Number(flag(p, 'limit') ?? 50) }) as Array<Record<string, unknown>>; return out(table(ev, ['ts', 'direction', 'status', 'conversation', 'externalId', 'chatId', 'detail']), ev); }
        if (sub === 'import-gateway') {
          if (!rest[0]) throw new UsageError('Usage: connectors import-gateway <path/to/gateway.json> [--dry-run]');
          if (!existsSync(rest[0])) throw new Error(`No file ${rest[0]}.`);
          // Read here, send the parsed config: the server never reads arbitrary paths on behalf of a client.
          if (exec.online) throw new Error('Run import-gateway while the server is stopped (it reads a local file), then start it.');
          const s = new MusterServer({ dataDir, config: readConfig(paths(dataDir))!, noRuntime: true, log: () => undefined });
          await s.open(false);
          try {
            const owner = (await s.store.listUsers()).find(u => u.role === 'owner' && u.status === 'active')!;
            const r = await s.registry.importGateway(owner, rest[0], { dryRun: p.bools.has('dry-run') });
            return out(table(r, ['type', 'name', 'status', 'detail']), r);
          } finally { await s.registry.stopAll(); await s.store.close(); }
        }
        throw new UsageError(`Unknown: connectors ${sub}`);
      }
      case 'cost': {
        if (sub && sub !== 'report') throw new UsageError('Usage: cost report [--since 30d] [--by user|project|model]');
        const by = flag(p, 'by') ?? 'user';
        if (!['user', 'project', 'model'].includes(by)) throw new UsageError('--by must be user, project or model.');
        const r = await call('server.cost', { since: since(flag(p, 'since') ?? '30d'), by }) as { lines: Array<Record<string, unknown>>; totals: Record<string, unknown>; unattributed: number; ledger: { ok: boolean; entries: number } };
        const money = (v: unknown) => `$${Number(v).toFixed(4)}`;
        const rows = [...r.lines, { ...r.totals, label: 'TOTAL' }].map(l => ({ [by]: l.label, turns: l.turns, input: l.inputTokens, cached: l.cachedTokens, output: l.outputTokens, cost: money(l.costUsd), unpriced: l.unpricedTurns, last: l.lastAt }));
        return out(`${table(rows, [by, 'turns', 'input', 'cached', 'output', 'cost', 'unpriced', 'last'])}\n\nLedger chain ${r.ledger.ok ? 'verified' : 'BROKEN'} (${r.ledger.entries} entries). Unpriced turns ran on models without a price (set one under Settings › Models).`, r);
      }
      case 'audit': {
        if (!sub || sub === 'verify') {
          const a = await call('server.audit.verify') as { ok: boolean; entries: number; brokenAt: number | null; head: string };
          const l = verifyLedger(paths(dataDir).runtime);
          if (!a.ok || !l.ok) process.exitCode = 1;
          return out([`Server audit chain: ${a.ok ? 'ok' : `BROKEN at entry ${a.brokenAt}`} (${a.entries} entries, head ${a.head.slice(0, 16)}…)`, `Turn ledger chain:  ${l.ok ? 'ok' : `BROKEN at entry ${l.brokenAt}`} (${l.entries} entries, head ${l.head.slice(0, 16)}…)`].join('\n'), { ok: a.ok && l.ok, audit: a, ledger: l });
        }
        if (sub === 'list') { const rows = await call('server.audit.list', { limit: Number(flag(p, 'limit') ?? 50) }) as Array<Record<string, unknown>>; return out(table(rows, ['seq', 'at', 'actor', 'action', 'target', 'detail']), rows); }
        throw new UsageError(`Unknown: audit ${sub}`);
      }
    }
    throw new UsageError(`Unknown command "${group}". Run muster-server --help.`);
  } finally { await exec.close(); }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let p: Parsed;
  try { p = parseArgs(argv); } catch (e) { process.stderr.write(`muster-server: ${(e as Error).message}\n`); process.exitCode = 2; return; }
  JSON_MODE = p.bools.has('json');
  const [command] = p.cmd;
  if (command === 'version' || p.bools.has('version')) { out(VERSION, { version: VERSION }); return; }
  if (!command || p.bools.has('help') || command === 'help') { process.stdout.write(HELP + '\n'); return; }
  const dataDir = resolveDataDir(flag(p, 'data-dir'));
  try {
    if (command === 'init') return await cmdInit(p, dataDir);
    if (command === 'start') return await cmdStart(p, dataDir);
    if (command === 'stop') return await cmdStop(dataDir);
    if (command === 'status') return await cmdStatus(dataDir);
    if (command === 'doctor') return await cmdDoctor(dataDir);
    if (command === 'backup') return await cmdBackup(p, dataDir);
    if (['invite', 'users', 'token', 'connectors', 'cost', 'audit'].includes(command)) return await cmdAdmin(p, dataDir);
    if (command === 'agent') return await runAgentClient(p);
    if (WORK_GROUPS.includes(command)) { const exec = await executor(dataDir); try { return await runWork(p, exec); } finally { await exec.close(); } }
    throw new UsageError(`Unknown command "${command}". Run muster-server --help.`);
  } catch (e) {
    const usage = e instanceof UsageError;
    const message = e instanceof PolicyError || e instanceof Error ? e.message : String(e);
    if (JSON_MODE) process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
    else process.stderr.write(`muster-server: ${message}\n`);
    process.exitCode = usage ? 2 : 1;
  }
}

