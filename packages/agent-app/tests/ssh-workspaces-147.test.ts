/**
 * #147 SSH workspaces, phase 1: hosts, remote folders, files, git, terminals and port forwards through a stand-in `ssh`
 * (tests/fixtures/fake-ssh) on PATH. The "host" is this machine: remote commands run under /bin/sh in a temp folder, and
 * HOME is a temp folder too, so the user's real ~/.ssh is never read and no real host is ever contacted.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter } from '../src/runtime/provider.ts';
import { TerminalSessions } from '../src/runtime/terminal-sessions.ts';
import type { ProcessEvent } from '../src/shared/process-protocol.ts';

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-ssh');
process.env.PATH = `${FAKE}:${process.env.PATH}`;
const HOME = mkdtempSync(join(tmpdir(), 'muster-147-home-'));
process.env.HOME = HOME;
mkdirSync(join(HOME, '.ssh'), { recursive: true });

const keyLine = () => `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString('base64')}`;
const fingerprint = (line: string) => `SHA256:${createHash('sha256').update(Buffer.from(line.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`;
const until = async <T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string, ms = 8000): Promise<T> => {
  const start = Date.now(); for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`); await delay(20); }
};

interface Logged { argv: string[]; kind: string; fresh?: boolean; tty?: boolean; refused?: string }
/** A fake host (state folder + "remote" home with ~/project) and the real agent service, with its events captured. */
async function setup(t: TestContext, opts: { known?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'muster-147-host-'))), dataDir = mkdtempSync(join(tmpdir(), 'muster-147-data-'));
  process.env.MUSTER_FAKE_SSH_ROOT = root;
  const hostKey = keyLine(); writeFileSync(join(root, 'host_key'), hostKey);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ aliases: { devbox: { hostname: '10.0.0.5', port: 22, user: 'dev' } } }));
  writeFileSync(join(root, 'user_known_hosts'), opts.known ? `10.0.0.5 ${hostKey}\n` : '');
  writeFileSync(join(HOME, '.ssh', 'config'), 'Host devbox\n  HostName 10.0.0.5\n  User dev\n  Port 22\n\nHost *.corp\n  User x\n\nHost gpu-1 gpu-2\n  HostName gpu.internal\n');
  const project = join(root, 'home', 'project'); mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# project\nhello world\n'); writeFileSync(join(project, 'src', 'app.ts'), 'export const x = 1;\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'Dev'); git('add', '.'); git('commit', '-qm', 'init');
  const events: Record<string, unknown>[] = [], calls: string[] = [];
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    stop: async () => true, dispose() {},
    async run(input) { calls.push(input.chat.id); return { status: 'completed' as const, finalMessage: 'ok', dispatchState: 'dispatched' as const }; },
  } as ProviderAdapter;
  const s = createAgentService({ dataDir, provider, onEvent(event: unknown) { events.push(event as Record<string, unknown>); } });
  t.after(async () => {
    await s.dispose();
    for (const f of readdirSync(root).filter(n => /^fwd-\d+\.pid$/.test(n))) { try { process.kill(Number(readFileSync(join(root, f), 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
    rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
  });
  const log = (): Logged[] => readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Logged);
  const invoke = (command: string, input: unknown) => s.invoke(command as never, input as never) as Promise<any>;
  /** A trusted, connected config host with ~/project added as a folder. */
  const connected = async () => {
    const host = await invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
    const first = await invoke('remote.hosts.connect', { id: host.id });
    if (first.state === 'hostkey-unknown') await invoke('remote.hosts.trust', { id: host.id, fingerprint: first.hostKey.fingerprint });
    const folder = await invoke('remote.folder.add', { hostId: host.id, path: '~/project' });
    return { host, folder };
  };
  return { s, invoke, root, dataDir, project, hostKey, events, calls, log, connected, git };
}

// Spec: MUS-SPEC-15-147A (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147a)
test('lists ~/.ssh/config hosts, adds one, and refuses a host that could be read as an ssh option', async t => {
  const h = await setup(t);
  const before = await h.invoke('remote.hosts.config', {});
  assert.deepEqual(before.entries.map((e: { alias: string }) => e.alias), ['devbox', 'gpu-1', 'gpu-2']);
  assert.deepEqual(before.entries[0], { alias: 'devbox', hostName: '10.0.0.5', user: 'dev', port: 22, added: false });
  assert.equal(before.entries[1].hostName, 'gpu.internal');
  const saved = await h.invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
  assert.equal(saved.name, 'devbox'); assert.equal(saved.trusted, null);
  assert.equal((await h.invoke('remote.hosts.config', {})).entries[0].added, true);
  await assert.rejects(h.invoke('remote.hosts.save', { source: 'manual', host: '-oProxyCommand=touch /tmp/muster-147-pwn' }), /host name/);
  await assert.rejects(h.invoke('remote.hosts.save', { source: 'manual', host: 'build.example.com', user: '-x' }), /user name/);
  await assert.rejects(h.invoke('remote.hosts.save', { source: 'config', host: 'nope' }), /not in your ~\/\.ssh\/config/);
  await assert.rejects(h.invoke('remote.hosts.save', { source: 'config', host: '-F' }), /not in your ~\/\.ssh\/config/);
  const manual = await h.invoke('remote.hosts.save', { source: 'manual', host: 'build.example.com', user: 'dev', port: 2200 });
  assert.equal(manual.name, 'dev@build.example.com:2200');
  const file = join(h.dataDir, 'remote-hosts.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!/PRIVATE KEY|BEGIN OPENSSH/.test(readFileSync(file, 'utf8')));
  assert.ok(!existsSync('/tmp/muster-147-pwn'));
});

// Spec: MUS-SPEC-15-147B (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147b)
test('first connect shows the host key fingerprint and trusts it only after confirmation', async t => {
  const h = await setup(t);
  const host = await h.invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
  const first = await h.invoke('remote.hosts.connect', { id: host.id });
  assert.equal(first.state, 'hostkey-unknown');
  assert.deepEqual(first.hostKey, { type: 'ed25519', fingerprint: fingerprint(h.hostKey) });
  assert.ok(!existsSync(join(h.dataDir, 'remote', 'known_hosts')) || !readFileSync(join(h.dataDir, 'remote', 'known_hosts'), 'utf8').trim(), 'nothing trusted yet');
  await assert.rejects(h.invoke('remote.folder.add', { hostId: host.id, path: '~/project' }), /host key/i);
  await assert.rejects(h.invoke('remote.hosts.trust', { id: host.id, fingerprint: `SHA256:${'A'.repeat(43)}` }), /not the one you saw/);
  const trusted = await h.invoke('remote.hosts.trust', { id: host.id, fingerprint: first.hostKey.fingerprint });
  assert.equal(trusted.state, 'connected', trusted.detail);
  assert.ok(readFileSync(join(h.dataDir, 'remote', 'known_hosts'), 'utf8').split('\n').includes(`10.0.0.5 ${h.hostKey}`), 'the scanned key is written to Muster’s known_hosts');
  assert.equal(readFileSync(join(h.root, 'user_known_hosts'), 'utf8'), '', 'the user’s own known_hosts is untouched');
  assert.equal((await h.invoke('remote.hosts.list', {})).hosts[0].trusted.fingerprint, first.hostKey.fingerprint);
  // The host now offers another key: reported as changed, never trusted with one click.
  await h.invoke('remote.hosts.disconnect', { id: host.id });
  const other = keyLine(); writeFileSync(join(h.root, 'host_key'), other);
  const changed = await h.invoke('remote.hosts.connect', { id: host.id });
  assert.equal(changed.state, 'hostkey-changed'); assert.match(changed.detail, /changed/i);
  await assert.rejects(h.invoke('remote.hosts.trust', { id: host.id, fingerprint: fingerprint(other) }), /changed/i);
});

// Spec: MUS-SPEC-15-147E (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147e)
test('a changed host key is refused after a disconnect or a restart, and a jump host is never scanned directly', async t => {
  const h = await setup(t);
  const host = await h.invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
  const first = await h.invoke('remote.hosts.connect', { id: host.id });
  assert.equal((await h.invoke('remote.hosts.trust', { id: host.id, fingerprint: first.hostKey.fingerprint })).state, 'connected');
  const knownFile = join(h.dataDir, 'remote', 'known_hosts'), oldKnown = readFileSync(knownFile, 'utf8');
  // The host now offers another key, and Muster no longer remembers having seen the warning.
  const other = keyLine(); writeFileSync(join(h.root, 'host_key'), other);
  const marker = h.log().length;
  await h.invoke('remote.hosts.disconnect', { id: host.id });
  assert.equal((await h.invoke('remote.hosts.list', {})).status[0].state, 'idle');
  await assert.rejects(h.invoke('remote.hosts.trust', { id: host.id, fingerprint: fingerprint(other) }), /changed/i);
  assert.equal(readFileSync(knownFile, 'utf8'), oldKnown, 'Muster’s known_hosts keeps the old key after a disconnect');
  // A restart on the same data folder: a fresh runtime with no state in memory.
  await h.s.dispose();
  const again = createAgentService({ dataDir: h.dataDir, provider: { info: () => [], stop: async () => true, dispose() {}, run: async () => ({ status: 'completed' as const, finalMessage: '', dispatchState: 'dispatched' as const }) } as unknown as ProviderAdapter, onEvent() {} });
  t.after(() => again.dispose());
  await assert.rejects(again.invoke('remote.hosts.trust' as never, { id: host.id, fingerprint: fingerprint(other) } as never), /changed/i);
  assert.equal(readFileSync(knownFile, 'utf8'), oldKnown, 'Muster’s known_hosts keeps the old key after a restart');
  assert.equal(((await again.invoke('remote.hosts.list' as never, {} as never)) as any).hosts[0].trusted.fingerprint, first.hostKey.fingerprint);
  for (const l of h.log().slice(marker).filter(l => l.kind === 'exec')) assert.ok(l.refused, `nothing ran on the host with the new key: ${l.argv.join(' ')}`);
  // A host behind a jump host: ssh-keyscan would reach some other machine by that name, so trust is refused, not scanned.
  writeFileSync(join(h.root, 'config.json'), JSON.stringify({ aliases: { devbox: { hostname: '10.0.0.5' }, jumpy: { hostname: '10.0.0.9', proxyjump: 'bastion' } } }));
  writeFileSync(join(HOME, '.ssh', 'config'), 'Host devbox\n  HostName 10.0.0.5\n\nHost jumpy\n  HostName 10.0.0.9\n  ProxyJump bastion\n');
  const jumpy = (await again.invoke('remote.hosts.save' as never, { source: 'config', host: 'jumpy' } as never)) as { id: string };
  assert.match(((await again.invoke('remote.hosts.connect' as never, { id: jumpy.id } as never)) as any).detail, /jump host/);
  const scans = h.log().filter(l => l.kind === 'keyscan').length;
  await assert.rejects(again.invoke('remote.hosts.trust' as never, { id: jumpy.id, fingerprint: fingerprint(other) } as never), /terminal/);
  assert.equal(h.log().filter(l => l.kind === 'keyscan').length, scans, 'ssh-keyscan never runs for a host behind a jump host');
  assert.ok(!readFileSync(knownFile, 'utf8').includes('10.0.0.9'));
});

// Spec: MUS-SPEC-15-147C (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147c)
test('a host that wants a passphrase or password asks for ssh-add and never prompts', async t => {
  const h = await setup(t, { known: true });
  writeFileSync(join(h.root, 'authfail'), '');
  const host = await h.invoke('remote.hosts.save', { source: 'config', host: 'devbox' });
  const status = await h.invoke('remote.hosts.connect', { id: host.id });
  assert.equal(status.state, 'auth'); assert.match(status.detail, /ssh-add/);
  const execs = h.log().filter(l => l.kind === 'exec');
  assert.ok(execs.length > 0);
  for (const l of execs) { assert.ok(l.argv.includes('BatchMode=yes'), l.argv.join(' ')); assert.ok(l.argv.includes('StrictHostKeyChecking=yes'), l.argv.join(' ')); }
});

// Spec: MUS-SPEC-07-147A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-147a)
test('a folder on an SSH host lists, reads, writes and searches its files through one connection', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  assert.equal(folder.path, `ssh://devbox${h.project}`); assert.equal(folder.name, 'project');
  const snap = await h.invoke('app.snapshot', undefined);
  assert.equal(snap.folders.find((f: { id: string }) => f.id === folder.id).missing, undefined);
  const list = await h.invoke('files.list', { folderId: folder.id });
  assert.deepEqual(list.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`), ['directory:src', 'file:README.md']);
  assert.deepEqual((await h.invoke('files.list', { folderId: folder.id, path: 'src' })).map((e: { path: string }) => e.path), ['src/app.ts']);
  const read = await h.invoke('files.read', { folderId: folder.id, path: 'README.md' });
  assert.equal(read.text, '# project\nhello world\n'); assert.equal(read.truncated, false); assert.ok(read.revision);
  assert.equal((await h.invoke('files.readFull', { folderId: folder.id, path: 'README.md' })).text, read.text);
  const saved = await h.invoke('files.write', { folderId: folder.id, path: 'README.md', text: '# project\nhello there\n', expectedRevision: read.revision });
  assert.equal(saved.conflict, false);
  assert.equal(readFileSync(join(h.project, 'README.md'), 'utf8'), '# project\nhello there\n');
  assert.deepEqual(await h.invoke('files.write', { folderId: folder.id, path: 'README.md', text: 'stale', expectedRevision: read.revision }), { conflict: true });
  await h.invoke('files.create', { folderId: folder.id, path: 'docs', kind: 'directory' });
  await h.invoke('files.create', { folderId: folder.id, path: 'docs/notes.md', kind: 'file' });
  assert.ok(statSync(join(h.project, 'docs', 'notes.md')).isFile());
  await h.invoke('files.move', { folderId: folder.id, from: 'docs/notes.md', to: 'docs/guide.md' });
  assert.ok(existsSync(join(h.project, 'docs', 'guide.md')) && !existsSync(join(h.project, 'docs', 'notes.md')));
  await h.invoke('files.trash', { folderId: folder.id, path: 'docs/guide.md' });
  assert.ok(!existsSync(join(h.project, 'docs', 'guide.md')));
  assert.ok(readdirSync(join(h.root, 'home', '.local', 'share', 'Trash', 'files')).some(n => n.startsWith('guide.md')), 'moved to the host’s Trash');
  assert.deepEqual((await h.invoke('files.search', { folderId: folder.id, query: 'readme' })).entries.map((e: { path: string }) => e.path), ['README.md']);
  assert.equal((await h.invoke('files.quickOpen', { folderId: folder.id, query: 'appts' })).results[0].path, 'src/app.ts');
  const found = await h.invoke('files.searchContent', { folderId: folder.id, query: 'hello' });
  assert.deepEqual(found.matches.map((m: { path: string; line: number }) => `${m.path}:${m.line}`), ['README.md:2']);
  const fresh = h.log().filter(l => l.kind === 'exec' && l.fresh);
  assert.equal(fresh.length, 1, 'one new connection; every later call reused it');
  for (const l of h.log().filter(l => l.kind === 'exec')) assert.ok(l.argv.some(a => a.startsWith('ControlPath=')), 'multiplexed');
});

// Spec: MUS-SPEC-07-147B (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-147b)
test('a dropped connection shows offline, fails fast and reconnects', async t => {
  const h = await setup(t, { known: true });
  const { host, folder } = await h.connected();
  rmSync(join(h.root, 'master')); writeFileSync(join(h.root, 'down'), '');
  const started = Date.now();
  await assert.rejects(h.invoke('files.list', { folderId: folder.id }), /could not reach/i);
  assert.ok(Date.now() - started < 5000, 'fails fast');
  await until(() => h.events.find(e => e.type === 'remoteChanged' && (e.status as { state?: string } | undefined)?.state === 'offline'), 'an offline event');
  assert.equal((await h.invoke('remote.hosts.list', {})).status.find((s: { hostId: string }) => s.hostId === host.id).state, 'offline');
  rmSync(join(h.root, 'down'));
  assert.equal((await h.invoke('files.list', { folderId: folder.id })).length, 2);
  assert.equal((await h.invoke('remote.hosts.list', {})).status.find((s: { hostId: string }) => s.hostId === host.id).state, 'connected');
});

// Spec: MUS-SPEC-08-147A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-147a)
test('git status, diff, stage and commit work in a folder on an SSH host', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  writeFileSync(join(h.project, 'README.md'), '# project\nhello git\n'); writeFileSync(join(h.project, 'new.txt'), 'new\n');
  const status = await h.invoke('git.status', { folderId: folder.id });
  assert.equal(status.branch, 'main'); assert.equal(status.stagedCount, 0);
  assert.deepEqual(status.files.map((f: { path: string; index: string; worktree: string }) => `${f.index}${f.worktree} ${f.path}`), [' M README.md', '?? new.txt']);
  const changes = await h.invoke('git.changes', { folderId: folder.id });
  assert.deepEqual(changes.map((c: { path: string }) => c.path).sort(), ['README.md', 'new.txt']);
  const diff = await h.invoke('git.diff', { folderId: folder.id, path: 'README.md' });
  assert.equal(diff.before, '# project\nhello world\n'); assert.equal(diff.after, '# project\nhello git\n');
  const staged = await h.invoke('git.mutate', { folderId: folder.id, operation: 'stage', revision: status.revision, paths: ['README.md'] });
  assert.equal(staged.stagedCount, 1);
  await assert.rejects(h.invoke('git.mutate', { folderId: folder.id, operation: 'stage', revision: status.revision, paths: ['new.txt'] }), /changed/);
  const message = `it's "done" $(touch ${join(h.root, 'PWNED')}) \`id\``;
  const after = await h.invoke('git.mutate', { folderId: folder.id, operation: 'commit', revision: staged.revision, message });
  assert.equal(after.stagedCount, 0);
  assert.equal(h.git('log', '-1', '--format=%B').trim(), message);
  assert.ok(!existsSync(join(h.root, 'PWNED')));
});

// Spec: MUS-SPEC-10-147A (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-147a)
test('a terminal in a folder on an SSH host opens a shell there', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  const chat = await h.invoke('chat.create', { folderId: folder.id });
  const events: ProcessEvent[] = [];
  const terminals = new TerminalSessions(join(h.dataDir, 'terminals.json'), async () => ({ cwd: folder.path }), e => events.push(e), undefined,
    { remote: async (path: string) => { assert.equal(path, folder.path); return h.invoke('remote.terminal.launch', { folderId: folder.id }); } });
  t.after(() => terminals.dispose());
  const info = await terminals.create({ chatId: chat.id, folderId: folder.id, cols: 80, rows: 24 });
  assert.equal(info.cwd, folder.path); assert.match(info.title, /devbox/);
  terminals.input({ id: info.id, data: 'pwd; echo marker-$((6*7)); exit\n' });
  const out = () => events.map(e => e.type === 'terminalData' && e.id === info.id ? e.data : '').join('');
  await until(() => out().includes('marker-42'), 'the remote shell output');
  assert.ok(out().includes(h.project), out());
  assert.ok(h.log().some(l => l.kind === 'exec' && l.tty), 'ssh asked for a TTY');
});

// Spec: MUS-SPEC-09-147A (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-147a)
test('a port on the SSH host opens on 127.0.0.1 through a forward', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  const server = createServer((_req, res) => { res.end('hello from the host'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const fwd = await h.invoke('remote.forward.open', { folderId: folder.id, port });
  assert.match(fwd.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.notEqual(fwd.localPort, port);
  assert.equal(await (await fetch(fwd.url)).text(), 'hello from the host');
  assert.deepEqual((await h.invoke('remote.forward.list', { folderId: folder.id })).forwards.map((f: { remotePort: number }) => f.remotePort), [port]);
  assert.deepEqual(await h.invoke('remote.forward.close', { folderId: folder.id, port }), { closed: true });
  await until(async () => { try { await fetch(fwd.url); return false; } catch { return true; } }, 'the forward to close');
  await assert.rejects(h.invoke('remote.forward.open', { folderId: folder.id, port: 0 }), /port/);
});

// Spec: MUS-SPEC-19-147A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-147a)
test('remote file paths stay inside the folder and are never run by the shell', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  const outside = join(h.root, 'home', 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(h.project, 'link.txt')); symlinkSync(outside, join(h.project, 'linkdir'));
  const id = folder.id;
  for (const path of ['../outside/secret.txt', '/etc/passwd', 'a\nb', 'link.txt', 'linkdir/secret.txt'])
    await assert.rejects(h.invoke('files.read', { folderId: id, path }), /outside|not allowed|link|Choose|not valid/i, path);
  await assert.rejects(h.invoke('files.write', { folderId: id, path: 'link.txt', text: 'owned' }), /link|outside/i);
  await assert.rejects(h.invoke('files.write', { folderId: id, path: 'linkdir/secret.txt', text: 'owned' }), /outside/i);
  await assert.rejects(h.invoke('files.write', { folderId: id, path: '../escape.txt', text: 'owned' }), /outside|not allowed/i);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n'); assert.ok(!existsSync(join(h.root, 'home', 'escape.txt')));
  // A file name cannot hold a slash, so each would-be command touches PWNED in whatever folder it ran from.
  const names = ["a'; touch PWNED; echo '.txt", '$(touch PWNED).txt', '`touch PWNED`.txt', '-rf'];
  for (const name of names) {
    await h.invoke('files.create', { folderId: id, path: name, kind: 'file' });
    await h.invoke('files.write', { folderId: id, path: name, text: 'literal' });
    assert.equal(readFileSync(join(h.project, name), 'utf8'), 'literal', name);
  }
  for (const where of [h.project, join(h.root, 'home'), h.root, process.cwd()]) assert.ok(!existsSync(join(where, 'PWNED')), `nothing ran in ${where}`);
  const listed = (await h.invoke('files.list', { folderId: id })).map((e: { name: string }) => e.name);
  for (const name of names) assert.ok(listed.includes(name), name);
  assert.ok(!listed.includes('link.txt'), 'a link that leads out of the folder is not listed');
});

// Spec: MUS-SPEC-02-147A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-147a)
test('a chat in a folder on an SSH host is refused instead of running on this computer', async t => {
  const h = await setup(t, { known: true });
  const { folder } = await h.connected();
  const chat = await h.invoke('chat.create', { folderId: folder.id });
  await h.invoke('chat.selectProvider', { id: chat.id, providerId: 'scripted', model: 'scripted-model' });
  await assert.rejects(h.invoke('chat.send', { id: chat.id, text: 'hello', requestId: 'r-147' }), /SSH host/);
  await delay(100);
  assert.deepEqual(h.calls, []);
});
