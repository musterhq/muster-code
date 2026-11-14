/**
 * #147 SSH workspaces, phase 2: agents run on the SSH host. The stand-in `ssh` (tests/fixtures/fake-ssh) runs the remote
 * commands under /bin/sh on this machine with a host PATH of its own, so a CLI is "installed on the host" only when a test
 * puts it in <host>/home/bin: the fake Claude Code (fake-ssh/fake-claude.cjs), the fake Codex app-server and the fake ACP
 * agent. Reverse forwards (`-O forward -R`) are real TCP relays on 127.0.0.1. HOME is a temp folder; no real host, no network.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentService } from '../src/runtime/service.ts';
import { createProviderAdapter, type CoreClient } from '../src/runtime/provider.ts';
import { claudeCodeAdapter } from '../src/runtime/adapters/claude-code.ts';
import { acpAdapter } from '../src/runtime/adapters/acp.ts';
import type { ProviderInstance } from '../src/runtime/provider-instances.ts';
import { RemoteHub } from '../src/runtime/remote/hub.ts';
import * as vendorCore from '../vendor/muster-core/packages/core/src/codex-app-server.ts';

/** Muster's private folder on the host (src/runtime/remote/remote-agent.ts). */
const REMOTE_DIR = '.muster-remote';
const FIXTURES = resolve(import.meta.dirname, 'fixtures'), FAKE = join(FIXTURES, 'fake-ssh');
process.env.PATH = `${FAKE}:${process.env.PATH}`;
const HOME = mkdtempSync(join(tmpdir(), 'muster-147b-home-'));
process.env.HOME = HOME;
mkdirSync(join(HOME, '.ssh'), { recursive: true });
writeFileSync(join(HOME, '.ssh', 'config'), 'Host devbox\n  HostName 10.0.0.5\n  User dev\n');
// A key Muster holds for Anthropic: it must never reach the host unless the person chose to pass it.
const MUSTER_KEY = `sk-ant-probe-${randomBytes(8).toString('hex')}`;
process.env.ANTHROPIC_API_KEY = MUSTER_KEY;

const keyLine = () => `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString('base64')}`;
const until = async <T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string, ms = 15_000): Promise<T> => {
  const start = Date.now(); for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`); await delay(25); }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
interface Logged { argv: string[]; kind: string; fresh?: boolean }
type Item = { kind: string; status: string; text: string; data?: Record<string, any> };

/** The host: state folder, its home with ~/project and ~/bin on the host PATH, and the CLIs a test installs there. */
function host(t: TestContext, install: Array<'claude' | 'codex' | 'acp'>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'muster-147b-host-')));
  const home = join(root, 'home'), bin = join(home, 'bin'), project = join(home, 'project');
  mkdirSync(bin, { recursive: true }); mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# project\n');
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']); execFileSync('git', ['-C', project, 'config', 'gc.auto', '0']);
  const hostKey = keyLine();
  writeFileSync(join(root, 'host_key'), hostKey); writeFileSync(join(root, 'user_known_hosts'), `10.0.0.5 ${hostKey}\n`);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ aliases: { devbox: { hostname: '10.0.0.5', port: 22, user: 'dev' } } }));
  // The host's own PATH: its ~/bin (with node, which the CLIs and the relay need) and the system folders.
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(root, 'host-path'), `${bin}:/usr/bin:/bin`);
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  if (install.includes('claude')) script('claude', `exec node ${JSON.stringify(join(FAKE, 'fake-claude.cjs'))} "$@"`);
  if (install.includes('codex')) script('codex', `FAKE_CODEX_LOG="$HOME/codex-log.jsonl" exec node ${JSON.stringify(join(FIXTURES, 'fake-codex-app-server.cjs'))} "$@"`);
  if (install.includes('acp')) script('fake-acp', `exec node ${JSON.stringify(join(FIXTURES, 'acp', 'fake-acp-agent.cjs'))} --log="$HOME/acp-log.jsonl" "$@"`);
  const jsonl = (file: string) => existsSync(join(home, file)) ? readFileSync(join(home, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>) : [];
  const sshLog = (): Logged[] => readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Logged);
  const kill = () => {
    for (const f of readdirSync(root).filter(n => /^(?:fwd|rev)-\d+\.pid$/.test(n))) { try { process.kill(Number(readFileSync(join(root, f), 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
    try { const pid = Number(readFileSync(join(home, 'hang.pid'), 'utf8')); if (pid > 1) process.kill(pid, 'SIGKILL'); } catch { /* none */ }
  };
  t.after(() => { kill(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, home, project, jsonl, sshLog };
}

/** The real agent service with Claude Code, Codex and an ACP agent as routes whose local binaries do not exist. */
async function rig(t: TestContext, install: Array<'claude' | 'codex' | 'acp'> = ['claude', 'codex', 'acp']) {
  const h = host(t, install);
  process.env.MUSTER_FAKE_SSH_ROOT = h.root;
  const dataDir = mkdtempSync(join(tmpdir(), 'muster-147b-data-'));
  const info = (id: string, name: string, driver: string, model: string, extra: Record<string, unknown> = {}) => ({ id, name, driver, available: true, identityMasked: 'x', bindingId: `b-${id}`, models: [{ id: model, name: model }], ...extra });
  const routes: ProviderInstance[] = [
    { info: info('claude-code', 'Claude Code', 'claude-code-cli', 'claude-code/default'), command: '', env: {}, sessionsRoot: '', adapter: claudeCodeAdapter({ binary: join(dataDir, 'no-local-claude'), killGraceMs: 500 }) },
    { info: info('codex', 'Codex', 'codex-app-server', 'gpt-test'), command: join(dataDir, 'no-local-codex'), env: { CODEX_HOME: join(dataDir, 'local-codex-home') }, sessionsRoot: '' },
    { info: info('acp_fake', 'Fake ACP', 'acp-agent', 'acp_fake/fast', { acp: { command: 'fake-acp', args: [] } }), command: '', env: {}, sessionsRoot: '',
      adapter: acpAdapter({ agent: { id: 'acp_fake', name: 'Fake ACP', command: join(dataDir, 'no-local-acp'), args: [] }, killGraceMs: 500 }) },
    { info: info('http-route', 'Some API', 'openai-chat-completions', 'api-model'), command: '', env: {}, sessionsRoot: '', adapter: { kind: 'http', async run() { throw new Error('an API route ran'); } } },
  ] as ProviderInstance[];
  const provider = createProviderAdapter({ instances: () => routes, core: vendorCore as unknown as CoreClient });
  const events: Record<string, unknown>[] = [];
  const s = createAgentService({ dataDir, provider, askUserTools: true, onEvent(event: unknown) { events.push(event as Record<string, unknown>); } });
  t.after(async () => { await s.dispose(); provider.dispose(); vendorCore.clearCodexAppServerSessions(); rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const invoke = (command: string, input: unknown) => s.invoke(command as never, input as never) as Promise<any>;
  const saved = await invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
  assert.equal((await invoke('remote.hosts.connect', { id: saved.id })).state, 'connected');
  const folder = await invoke('remote.folder.add', { hostId: saved.id, path: '~/project' });
  const chatFor = async (providerId: string, model: string, permissionMode = 'workspace') => {
    const chat = await invoke('chat.create', { folderId: folder.id });
    await invoke('chat.selectProvider', { id: chat.id, providerId, model });
    await invoke('chat.setPermissionMode', { id: chat.id, permissionMode, ...(permissionMode === 'full' ? { acknowledgeFullAccess: true } : {}) });
    return chat.id as string;
  };
  const items = async (chatId: string): Promise<Item[]> => invoke('chat.select', { id: chatId });
  const status = async (chatId: string) => (await invoke('app.snapshot', undefined)).chats.find((c: { id: string }) => c.id === chatId);
  const send = (chatId: string, text: string) => invoke('chat.send', { id: chatId, text, requestId: randomUUID() });
  const settled = (chatId: string) => until(async () => { const c = await status(chatId); return c && c.status !== 'running' && c.status !== 'stopping' ? c : null; }, 'the run settling');
  const said = (chatId: string, match: RegExp) => until(async () => (await items(chatId)).find(i => i.kind === 'assistant' && match.test(i.text)), `an answer matching ${match}`)
    .catch(async error => { throw new Error(`${(error as Error).message}; chat: ${JSON.stringify((await items(chatId)).map(i => [i.kind, i.status, i.text.slice(0, 200)]))}`); });
  return { ...h, s, invoke, events, host: saved, folder, chatFor, items, status, send, settled, said, dataDir };
}

// Spec: MUS-SPEC-02-147B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-147b)
test('Claude Code in a folder on an SSH host runs there, streams into the chat and resumes its session', async t => {
  const r = await rig(t, ['claude']);
  const chatId = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(chatId, 'say hello');
  await r.said(chatId, new RegExp(`hello from ${r.project.replace(/[/.]/g, '\\$&')}`));
  assert.equal((await r.settled(chatId)).status, 'completed');
  const first = r.jsonl('claude-log.jsonl').find(l => l.argv)!;
  assert.equal(first.cwd, r.project, 'the CLI runs in the folder on the host');
  assert.ok(first.argv.includes('stream-json') && first.argv.includes('--session-id'), first.argv.join(' '));
  assert.equal(first.anthropicKey, null, 'Muster’s Anthropic key stays on this computer by default');
  const notice = (await r.items(chatId)).find(i => i.kind === 'notice' && i.data?.kind === 'remote-run');
  assert.match(notice?.text ?? '', /Runs on devbox in .*project, with the host’s own sign-in/);
  const sessions = r.sshLog().filter(l => l.kind === 'exec' && l.argv.includes('-T'));
  assert.equal(sessions.length, 1, 'one ssh session for the CLI');
  assert.ok(sessions[0]!.argv.some(a => a.startsWith('ControlPath=')) && !sessions[0]!.fresh, 'over the shared connection');
  // The next message continues the same Claude Code session on the host.
  await r.send(chatId, 'and again');
  await until(() => r.jsonl('claude-log.jsonl').filter(l => l.argv).length === 2, 'a second CLI run');
  const second = r.jsonl('claude-log.jsonl').filter(l => l.argv)[1]!;
  assert.equal(second.argv[second.argv.indexOf('--resume') + 1], first.argv[first.argv.indexOf('--session-id') + 1], 'resumed the session');
  await r.settled(chatId);
  assert.deepEqual(readdirSync(join(r.home, REMOTE_DIR)).filter(n => n.endsWith('.pid')), [], 'no process-group file is left once the CLI ends');
});

// Spec: MUS-SPEC-02-147C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-147c)
test('a message sent mid-run reaches the CLI on the host, and Stop ends its process there', async t => {
  const r = await rig(t, ['claude']);
  const chatId = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(chatId, 'WAIT');
  await r.said(chatId, /waiting for more/);
  const steered = await r.invoke('chat.steer', { id: chatId, text: 'PINEAPPLE', requestId: randomUUID() });
  assert.equal(steered.steered, true, JSON.stringify(steered));
  await r.said(chatId, /steered: PINEAPPLE/);
  assert.equal((await r.settled(chatId)).status, 'completed');
  await r.send(chatId, 'HANG');
  const pid = await until(() => existsSync(join(r.home, 'hang.pid')) && Number(readFileSync(join(r.home, 'hang.pid'), 'utf8')), 'the CLI to start working');
  assert.ok(alive(pid));
  await r.invoke('chat.stop', { id: chatId });
  const after = await r.settled(chatId);
  assert.equal(after.status, 'interrupted');
  await until(() => !alive(pid), 'the CLI on the host to end', 10_000);
  assert.ok(r.sshLog().some(l => l.kind === 'exec' && l.argv.some(a => a.includes('kill -s')) ), 'Stop signalled the process group on the host');
});

// Spec: MUS-SPEC-05-147A (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-147a)
test('approvals on the host go through Muster: Auto settles a safe command, Workspace shows a card', async t => {
  const r = await rig(t, ['claude']);
  const auto = await r.chatFor('claude-code', 'claude-code/default', 'auto');
  await r.send(auto, 'APPROVE');
  await r.said(auto, /permission: allow/);
  await r.settled(auto);
  assert.equal((await r.items(auto)).some(i => i.kind === 'approval'), false, 'Auto asked nobody for git status');
  assert.ok(r.jsonl('claude-log.jsonl').find(l => l.argv)!.argv.includes('--permission-prompt-tool=stdio'));
  const workspace = await r.chatFor('claude-code', 'claude-code/default', 'workspace');
  await r.send(workspace, 'APPROVE');
  const card = await until(async () => (await r.items(workspace)).find(i => i.kind === 'approval' && i.status === 'pending'), 'the approval card');
  assert.match(JSON.stringify(card), /git status/);
  await r.invoke('chat.stop', { id: workspace });
  await r.settled(workspace);
  // Full access is Claude Code's bypass on the host: still the host user's own rights, nothing more.
  const full = await r.chatFor('claude-code', 'claude-code/default', 'full');
  await r.send(full, 'hello');
  await r.settled(full);
  const fullRun = r.jsonl('claude-log.jsonl').filter(l => l.argv).pop()!;
  assert.equal(fullRun.argv[fullRun.argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

// Spec: MUS-SPEC-14-147A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-147a)
test('Muster’s tools reach the CLI on the host through the reverse-forwarded relay', async t => {
  const r = await rig(t, ['claude']);
  const chatId = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(chatId, 'TOOLS');
  await r.said(chatId, /servers: .*muster_ask=ask_user\+request_secret/);
  // ask_user ran in Muster on this computer: its question card is in the chat.
  await until(async () => (await r.items(chatId)).find(i => i.kind === 'question' && /Which database should the host use/.test(i.text)), 'the ask_user card');
  const log = r.jsonl('claude-log.jsonl'), run = log.find(l => l.argv)!, config = log.find(l => l.mcpConfig)!.mcpConfig;
  assert.ok(Object.keys(config.mcpServers).includes('muster_ask'), Object.keys(config.mcpServers).join());
  for (const name of Object.keys(config.mcpServers)) assert.equal(config.mcpServers[name].command, join(r.home, REMOTE_DIR, 'relay'), `${name} is the relay`);
  const spec = config.mcpServers.muster_ask;
  assert.equal(spec.command, join(r.home, REMOTE_DIR, 'relay')); assert.deepEqual(spec.args, ['muster_ask']);
  assert.match(spec.env.MUSTER_RELAY_PORT, /^\d+$/);
  assert.equal(spec.env.MUSTER_RELAY_TOKEN, undefined, 'no token on the command line');
  assert.equal(spec.env.MUSTER_CHAT_TOKEN, undefined, 'the chat token stays on this computer');
  assert.equal(run.relayToken, 'set', 'the token arrived in the CLI’s environment');
  assert.ok(!JSON.stringify(run.argv).match(/[0-9a-f]{64}/), 'no 64-hex token in argv');
  const reverse = r.sshLog().find(l => l.kind === 'control:forward' && l.argv.includes('-R'))!;
  assert.match(reverse.argv[reverse.argv.indexOf('-R') + 1]!, /^127\.0\.0\.1:0:127\.0\.0\.1:\d+$/, 'the host side binds loopback only');
  await r.settled(chatId);
});

// Spec: MUS-SPEC-03-147A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-147a)
test('a CLI missing on the host, an API route and a signed-out CLI each say what to do, and nothing runs here', async t => {
  const r = await rig(t, ['claude']);
  const acp = await r.chatFor('acp_fake', 'acp_fake/fast');
  await assert.rejects(r.send(acp, 'hi'), /Fake ACP is not installed on devbox\. Install .* on the host yourself.*never installs/);
  const api = await r.chatFor('http-route', 'api-model');
  await assert.rejects(r.send(api, 'hi'), /can’t run on the SSH host devbox: only Claude Code, Codex and ACP agents/);
  const claude = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(claude, 'AUTH');
  const failed = await r.settled(claude);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Claude Code on devbox is not signed in\. Sign in on the host \(run `claude` once/);
  assert.equal(failed.recovery.retryable, true);
});

// Spec: MUS-SPEC-03-147B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-147b)
test('the host signs in itself by default; a key Muster holds goes only when chosen, as a variable, never on disk', async t => {
  const r = await rig(t, ['claude']);
  assert.equal((await r.invoke('remote.hosts.list', {})).hosts[0].agentCredentials, undefined, 'the default is the host’s own login');
  const chatId = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(chatId, 'one'); await r.settled(chatId);
  assert.equal(r.jsonl('claude-log.jsonl').filter(l => l.argv)[0]!.anthropicKey, null);
  await assert.rejects(r.invoke('remote.hosts.agentCredentials', { id: r.host.id, credentials: 'everything' }), /Choose/);
  const saved = await r.invoke('remote.hosts.agentCredentials', { id: r.host.id, credentials: 'muster' });
  assert.equal(saved.agentCredentials, 'muster');
  await r.send(chatId, 'two'); await r.settled(chatId);
  assert.equal(r.jsonl('claude-log.jsonl').filter(l => l.argv)[1]!.anthropicKey, 'set', 'passed for this run');
  // The chat says where this run's sign-in comes from: never "the host's own sign-in" while Muster passes the person's key.
  const notices = (await r.items(chatId)).filter(i => i.kind === 'notice' && i.data?.kind === 'remote-run').map(i => i.text);
  assert.match(notices.at(-1) ?? '', /Runs on devbox in .*project, with your Anthropic API key from this computer/, notices.join(' | '));
  for (const l of r.sshLog()) assert.ok(!l.argv.join(' ').includes(MUSTER_KEY), 'never on an ssh command line');
  // grep exits 1 when no file holds the key. The fake CLI's own log records only whether the variable was set.
  let files = '';
  try { files = execFileSync('grep', ['-rl', MUSTER_KEY, r.root], { encoding: 'utf8' }); } catch (error) { assert.equal((error as { status?: number }).status, 1); }
  assert.equal(files, '', 'never written on the host');
  await r.invoke('remote.hosts.agentCredentials', { id: r.host.id, credentials: 'host' });
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await r.invoke('remote.hosts.agentCredentials', { id: r.host.id, credentials: 'muster' });
    await assert.rejects(r.send(chatId, 'three'), /Muster has no ANTHROPIC_API_KEY to pass/);
  } finally { process.env.ANTHROPIC_API_KEY = MUSTER_KEY; }
});

// Spec: MUS-SPEC-03-147C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-147c)
test('Codex and an ACP agent run on the host too, with the host’s own config and files', async t => {
  const r = await rig(t, ['codex', 'acp']);
  const acp = await r.chatFor('acp_fake', 'acp_fake/fast');
  await r.send(acp, 'STREAM');
  await r.said(acp, /Hello from ACP\./);
  await r.settled(acp);
  const acpLog = r.jsonl('acp-log.jsonl');
  assert.deepEqual(acpLog.find(m => m.method === 'initialize')!.params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false }, 'the agent reads and writes its files on the host itself');
  assert.equal(acpLog.find(m => m.method === 'session/new')!.params.cwd, r.project);
  const codex = await r.chatFor('codex', 'gpt-test');
  await r.send(codex, 'hello codex');
  await until(() => r.jsonl('codex-log.jsonl').find(l => l.method === 'turn/start'), 'the Codex turn on the host');
  await r.settled(codex);
  const codexLog = r.jsonl('codex-log.jsonl'), start = codexLog.find(l => l.method === 'thread/start')!;
  assert.equal(start.params.cwd, r.project);
  assert.equal(codexLog.find(l => l.argv)!.argv[0], 'app-server');
  const ask = start.params.config?.mcp_servers?.muster_ask;
  assert.equal(ask?.command, join(r.home, REMOTE_DIR, 'relay'));
  assert.match(ask?.env?.MUSTER_RELAY_TOKEN ?? '', /^[0-9a-f]{64}$/, 'the token goes over the CLI’s stdin, in the thread config');
  assert.ok(!JSON.stringify(codexLog.find(l => l.argv)!.argv).includes(ask.env.MUSTER_RELAY_TOKEN), 'never in argv');
  assert.equal(start.params.config?.shell_environment_policy?.set?.SUDO_ASKPASS, undefined, 'no path on this computer goes to the host');
});

// Spec: MUS-SPEC-02-147D (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-147d)
test('a dropped connection interrupts the run with a sentence, and the next run ends what was left on the host', async t => {
  const r = await rig(t, ['claude']);
  const chatId = await r.chatFor('claude-code', 'claude-code/default');
  await r.send(chatId, 'HANG');
  const pid = await until(() => existsSync(join(r.home, 'hang.pid')) && Number(readFileSync(join(r.home, 'hang.pid'), 'utf8')), 'the CLI to start working');
  rmSync(join(r.root, 'master')); writeFileSync(join(r.root, 'down'), '');
  const after = await r.settled(chatId);
  assert.equal(after.status, 'interrupted');
  assert.match(after.error, /connection to devbox dropped while Claude Code was working there/);
  assert.ok(alive(pid), 'a CLI without a terminal outlives the dropped connection');
  rmSync(join(r.root, 'down'));
  rmSync(join(r.home, 'hang.pid'));
  await r.send(chatId, 'hello again');
  await r.said(chatId, /hello from/);
  await until(() => !alive(pid), 'the leftover CLI to be ended', 5_000);
  await r.settled(chatId);
});

// Spec: MUS-SPEC-19-147B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-147b)
test('the relay wants a live run token, binds loopback, writes no secret on the host and leaves local-only tools out', async t => {
  const h = host(t, ['claude']);
  process.env.MUSTER_FAKE_SSH_ROOT = h.root;
  const { RemoteAgents, remoteCli } = await import('../src/runtime/remote/remote-agent.ts'), { ToolRelay } = await import('../src/runtime/remote/tool-relay.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'muster-147b-relay-'));
  const hub = new RemoteHub(dataDir, () => undefined), relay = new ToolRelay(), agents = new RemoteAgents(hub, relay);
  t.after(async () => { relay.dispose(); await hub.dispose(); rmSync(dataDir, { recursive: true, force: true }); });
  const saved = hub.saveHost({ source: 'config', host: 'devbox' });
  const cli = remoteCli({ driver: 'claude-code-cli', name: 'Claude Code' })!;
  const prepared = await agents.prepare({ host: saved, root: h.project, chatId: 'chat-1', cli, tokenInEnv: true });
  const dir = join(h.home, REMOTE_DIR);
  assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(join(dir, 'relay')).mode & 0o777, 0o700);
  const echo = join(dataDir, 'echo.cjs'); writeFileSync(echo, "process.stdin.on('data', d => process.stdout.write('echo:' + d));");
  const tools = prepared.tools({
    'mcp_servers.muster_ask.command': process.execPath, 'mcp_servers.muster_ask.args': [echo], 'mcp_servers.muster_ask.env.MUSTER_CHAT_TOKEN': 'chat-secret',
    'mcp_servers.muster_computer.command': '/local/computer', 'mcp_servers.muster_terminal.command': '/local/terminal', 'shell_environment_policy.set.SUDO_ASKPASS': '/local/askpass', 'shell_environment_policy.set.GIT_AUTHOR_NAME': 'Agent',
  }, 'chat-1');
  assert.deepEqual(tools.dropped.sort(), ['muster_computer', 'muster_terminal']);
  assert.equal(tools.overrides['mcp_servers.muster_computer.command'], undefined);
  assert.equal(tools.overrides['shell_environment_policy.set.SUDO_ASKPASS'], undefined); assert.equal(tools.overrides['shell_environment_policy.set.GIT_AUTHOR_NAME'], 'Agent');
  assert.equal(tools.overrides['mcp_servers.muster_ask.env.MUSTER_CHAT_TOKEN'], undefined, 'the chat token stays here');
  const token = tools.overrides['secret.mcp_servers.muster_ask.env.MUSTER_RELAY_TOKEN'] as string, port = Number(tools.overrides['mcp_servers.muster_ask.env.MUSTER_RELAY_PORT']);
  const talk = (hello: string, at = port) => new Promise<string>(done => {
    const socket = connect(at, '127.0.0.1', () => socket.write(`${hello}\nping\n`)); let got = '';
    socket.on('data', d => { got += d; if (got.includes('ping')) socket.end(); }); socket.on('close', () => done(got)); socket.on('error', () => done(got));
    setTimeout(() => socket.destroy(), 3000);
  });
  assert.equal(await talk(`MUSTER-RELAY 1 ${'0'.repeat(64)} muster_ask`), '', 'a wrong token starts nothing');
  assert.equal(await talk(`MUSTER-RELAY 1 ${token} muster_computer`), '', 'a server the run does not have starts nothing');
  assert.equal(await talk(`MUSTER-RELAY 1 ${token} muster_ask`), 'echo:ping\n', 'the run’s own server answers');
  // Through the host: the relay script there reaches the same server with the token from its environment only.
  // Asynchronous: the relay's listener lives in this process.
  const { stdout: viaHost } = await promisify(execFile)('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(h.root, 'user_known_hosts')}`, '--', 'devbox', `printf 'ping\\n' | MUSTER_RELAY_PORT=${port} MUSTER_RELAY_TOKEN=${token} ${join(dir, 'relay')} muster_ask`], { encoding: 'utf8', env: process.env, timeout: 10_000 });
  assert.equal(viaHost, 'echo:ping\n');
  for (const name of readdirSync(dir)) assert.ok(!readFileSync(join(dir, name), 'utf8').includes(token), `${name} holds no token`);
  tools.close();
  assert.equal(relay.openRuns, 0);
  assert.equal(await talk(`MUSTER-RELAY 1 ${token} muster_ask`), '', 'the token dies with the run');
  prepared.dispose();
});
