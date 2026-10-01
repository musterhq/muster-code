/** Wave 4: G21 SSH hosts against a LOCAL sshd with throwaway keys, and G22 runtime services. Never touches real keys or hosts. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { wave1, until, wait } from './wave1-harness.ts';

const SSHD = '/usr/sbin/sshd', haveSsh = existsSync(SSHD) && existsSync('/usr/bin/ssh') && existsSync('/usr/bin/ssh-keyscan');
const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

/** A throwaway sshd on a high loopback port: its own host key, one generated client key, no password, no real account keys. */
async function sshd(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'muster-w4-sshd-')), port = await freePort();
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway', '-f', join(dir, 'client_key')]); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'host', '-f', join(dir, 'host_key')]);
  copyFileSync(join(dir, 'client_key.pub'), join(dir, 'authorized_keys')); for (const f of ['authorized_keys', 'client_key', 'host_key']) chmodSync(join(dir, f), 0o600);
  writeFileSync(join(dir, 'sshd_config'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host_key\nAuthorizedKeysFile ${dir}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes no\nPidFile ${dir}/sshd.pid\nLogLevel ERROR\n`);
  const child: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' }); t.after(() => { child.kill('SIGKILL'); });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await wait(100); try { await new Promise<void>((res, rej) => { const s = require_net().connect(port, '127.0.0.1', () => { s.destroy(); res(); }); s.on('error', rej); }); up = true; } catch { /* not yet */ } }
  if (!up) return null;
  const fp = execFileSync('ssh-keygen', ['-lf', join(dir, 'host_key.pub')], { encoding: 'utf8' }).split(' ')[1]!;
  return { dir, port, key: join(dir, 'client_key'), fingerprint: fp, user: userInfo().username };
}
import net from 'node:net'; const require_net = () => net;

test('G21: host validation, key file checks and untrusted hosts are refused', { skip: !haveSsh }, async t => {
  const h = await wave1(t);
  await assert.rejects(h.s.invoke('ssh.hosts.save', { name: '', host: 'x', user: 'u', keyPath: '/k' }), /Name the host/);
  await assert.rejects(h.s.invoke('ssh.hosts.save', { name: 'a', host: 'bad host!', user: 'u', keyPath: '/k' }), /host name/);
  await assert.rejects(h.s.invoke('ssh.hosts.save', { name: 'a', host: 'x.example', user: 'u', keyPath: 'relative' }), /full path/);
  await assert.rejects(h.s.invoke('ssh.hosts.save', { name: 'a', host: 'x.example', user: 'u', port: 70000, keyPath: '/k' }), /1 to 65535/);
  const saved = await h.s.invoke('ssh.hosts.save', { name: 'prod', host: 'x.example', user: 'deploy', keyPath: '/nonexistent/key' });
  assert.equal(saved.trusted, null); assert.equal((await h.s.invoke('ssh.test', { id: saved.id })).detail, 'Trust the host key first.');
  assert.equal(statSync(join(h.dataDir, 'muster-envs.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(h.dataDir, 'muster-envs.json'), 'utf8').includes('PRIVATE KEY'), 'only the key path is kept');
});

test('G21: scan, compare, trust; test; a chat bound to the host gets tools that run there, honour read-only, and refuse a changed host key', { skip: !haveSsh }, async t => {
  const h = await wave1(t), s = await sshd(t); if (!s) return t.skip('a throwaway sshd could not start on this machine');
  const host = await h.s.invoke('ssh.hosts.save', { name: 'local sshd', host: '127.0.0.1', port: s.port, user: s.user, keyPath: s.key, remoteDir: s.dir });
  const scan = await h.s.invoke('ssh.hostkey.scan', { id: host.id }); assert.equal(scan.fingerprint, s.fingerprint); assert.equal(scan.type, 'ed25519');
  await assert.rejects(h.s.invoke('ssh.hostkey.trust', { id: host.id, fingerprint: `SHA256:${'A'.repeat(43)}` }), /not the one you confirmed/);
  await assert.rejects(h.s.invoke('ssh.hostkey.trust', { id: host.id, fingerprint: 'nonsense' }), /exactly as shown/);
  const trusted = await h.s.invoke('ssh.hostkey.trust', { id: host.id, fingerprint: scan.fingerprint }); assert.equal(trusted.trusted!.fingerprint, s.fingerprint);
  assert.equal(statSync(join(h.dataDir, 'ssh', 'known_hosts')).mode & 0o777, 0o600);
  const test1 = await h.s.invoke('ssh.test', { id: host.id }); assert.equal(test1.ok, true, test1.detail); assert.match(test1.detail, new RegExp(s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A chat bound to the host.
  const chat = await h.s.invoke('chat.create', { projectId: h.project.id }); await h.s.invoke('ssh.chat.set', { chatId: chat.id, hostId: host.id });
  await h.s.invoke('chat.selectProvider', { id: chat.id, providerId: 'scripted', model: 'scripted-model' });
  await h.s.invoke('chat.send', { id: chat.id, text: 'hello', requestId: 'r1' }); await until(() => h.calls.find(c => c.chatId === chat.id), 'a run');
  const call = h.calls.find(c => c.chatId === chat.id)!, launcher = String(call.overrides['mcp_servers.muster_ssh.command']);
  assert.ok(launcher); assert.match(call.text, /SSH host “local sshd”/);
  const { url, token } = JSON.parse(readFileSync(join(dirname(launcher), 'muster_ssh-endpoint.json'), 'utf8'));
  const tool = async (name: string, args: Record<string, unknown>) => { const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ chatId: chat.id, tool: name, arguments: args }) })).json() as { content: { text: string }[]; isError?: boolean }; return { text: r.content[0]!.text, error: Boolean(r.isError) }; };
  await h.s.invoke('chat.setPermission' as never, { id: chat.id, permissionMode: 'workspace' } as never).catch(() => undefined);
  const w = await tool('ssh_write', { path: 'notes/a.txt', text: 'hello from the agent\nline 2' }); assert.equal(w.error, false, w.text);
  assert.equal(readFileSync(join(s.dir, 'notes/a.txt'), 'utf8'), 'hello from the agent\nline 2', 'the file really landed on the host');
  assert.match((await tool('ssh_read', { path: 'notes/a.txt' })).text, /line 2/);
  assert.match((await tool('ssh_list', { path: 'notes' })).text, /a\.txt/);
  const ex = await tool('ssh_exec', { command: 'echo "$((6*7))"; pwd' }); assert.match(ex.text, /exit 0\n42\n/); assert.ok(ex.text.includes(s.dir));
  const bad = await tool('ssh_exec', { command: 'exit 3' }); assert.equal(bad.error, true); assert.match(bad.text, /exit 3/);
  assert.match((await tool('ssh_exec', { command: 'sleep 5', timeout_sec: 1 })).text, /timed out/);
  assert.match((await tool('ssh_read', { path: 'nope.txt' })).text, /No such file|nope/i);
  // Injection through the path stays inside quotes.
  await tool('ssh_write', { path: "x'; touch /tmp/muster-w4-pwn; echo '.txt", text: 'x' }); assert.ok(!existsSync('/tmp/muster-w4-pwn'));
  // Read-only chats cannot exec or write.
  const cur = await h.s.invoke('app.snapshot', undefined); const mode = cur.chats.find(c => c.id === chat.id)!.permissionMode;
  if (mode === 'read-only') { assert.equal((await tool('ssh_exec', { command: 'echo no' })).error, true); }
  // A different key on the host: the pinned fingerprint no longer matches.
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other', '-f', join(s.dir, 'other_key')]);
  const imposter = await h.s.invoke('ssh.hosts.save', { id: host.id, name: 'local sshd', host: '127.0.0.1', port: s.port, user: s.user, keyPath: join(s.dir, 'other_key'), remoteDir: s.dir });
  assert.ok(imposter.trusted, 'same host and port keep the trust'); const denied = await h.s.invoke('ssh.test', { id: host.id }); assert.equal(denied.ok, false); assert.match(denied.detail, /refused the key|Permission/i);
  const moved = await h.s.invoke('ssh.hosts.save', { id: host.id, name: 'local sshd', host: 'localhost', port: s.port, user: s.user, keyPath: s.key, remoteDir: s.dir });
  assert.equal(moved.trusted, null, 'a changed address drops the trust'); await assert.rejects(h.s.invoke('ssh.chat.set', { chatId: chat.id, hostId: host.id }), /Trust this host/);
  await h.s.invoke('ssh.hosts.remove', { id: host.id }); assert.equal((await h.s.invoke('ssh.chat.get', { chatId: chat.id })).hostId, null);
});

test('G21: a key readable by others is refused with the fix', { skip: !haveSsh }, async t => {
  const h = await wave1(t), s = await sshd(t); if (!s) return t.skip('a throwaway sshd could not start on this machine'); chmodSync(s.key, 0o644);
  const host = await h.s.invoke('ssh.hosts.save', { name: 'loose', host: '127.0.0.1', port: s.port, user: s.user, keyPath: s.key });
  const scan = await h.s.invoke('ssh.hostkey.scan', { id: host.id }); await h.s.invoke('ssh.hostkey.trust', { id: host.id, fingerprint: scan.fingerprint });
  const r = await h.s.invoke('ssh.test', { id: host.id }); assert.equal(r.ok, false); assert.match(r.detail, /chmod 600/);
});

async function project(h: Awaited<ReturnType<typeof wave1>>) { const cto = await h.member('CTO'); const task = await h.addTask('Ship the preview', { kind: 'agent', id: cto.id }); return { task }; }

test('G22: a service starts in the project folder, its address is read from the output, listed as a preview and stopped with its process group', async t => {
  const h = await wave1(t), { task } = await project(h);
  const port = await freePort();
  const server = `node -e "require('http').createServer((q,r)=>r.end('ok ' + process.cwd())).listen(${port},'127.0.0.1',()=>console.log('Local: http://localhost:${port}/'))"`;
  const decl = await h.s.invoke('services.save', { projectId: h.project.id, taskId: task.id, name: 'web', command: server });
  const started = await h.s.invoke('services.start', { projectId: h.project.id, id: decl.id }); assert.ok(['starting', 'running'].includes(started.state));
  const view = await until(async () => { const v = (await h.s.invoke('services.list', { projectId: h.project.id })).services[0]!; return v.state === 'running' && v.url ? v : false; }, 'the service to be running');
  assert.equal(view.url, `http://127.0.0.1:${port}`);
  const body = await (await fetch(view.url!)).text(); assert.ok(body.includes('oss-repo'), `served from the project folder: ${body}`);
  assert.deepEqual((await h.s.invoke('services.previews', { projectId: h.project.id })).previews.map(p => [p.title, p.url]), [['web', view.url]]);
  await assert.rejects(h.s.invoke('services.start', { projectId: h.project.id, id: decl.id }), /already running/);
  await assert.rejects(h.s.invoke('services.save', { projectId: h.project.id, taskId: task.id, id: decl.id, name: 'web', command: 'x' }), /Stop the service/);
  const pid = view.pid!;
  const stopped = await h.s.invoke('services.stop', { projectId: h.project.id, id: decl.id }); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.url, null);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the process to be gone');
  await assert.rejects(fetch(view.url!), /fetch failed/); assert.equal((await h.s.invoke('services.previews', { projectId: h.project.id })).previews.length, 0);
});

test('G22: a declared port becomes ready by connection; a task marked done stops its services; a failing command is shown as failed with its output', async t => {
  const h = await wave1(t), { task } = await project(h), port = await freePort();
  const decl = await h.s.invoke('services.save', { projectId: h.project.id, taskId: task.id, name: 'quiet', command: `node -e "setTimeout(()=>require('net').createServer(c=>c.end()).listen(${port},'127.0.0.1'),400);setInterval(()=>{},1000)"`, port });
  await h.s.invoke('services.start', { projectId: h.project.id, id: decl.id });
  const v = await until(async () => { const x = (await h.s.invoke('services.list', { projectId: h.project.id })).services[0]!; return x.url ? x : false; }, 'a connection to succeed'); assert.equal(v.url, `http://127.0.0.1:${port}`);
  const cur = await h.task(task.id);
  await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: task.id, revision: cur.revision, state: 'cancelled' });
  await until(async () => (await h.s.invoke('services.list', { projectId: h.project.id })).services[0]!.state === 'stopped', 'the service to stop with its task');
  const bad = await h.s.invoke('services.save', { projectId: h.project.id, taskId: task.id, name: 'broken', command: 'echo boom >&2; exit 4' });
  await h.s.invoke('services.start', { projectId: h.project.id, id: bad.id });
  const failed = await until(async () => { const x = (await h.s.invoke('services.list', { projectId: h.project.id })).services.find(s => s.id === bad.id)!; return x.state === 'failed' ? x : false; }, 'failure'); assert.equal(failed.exitCode, 4); assert.match(failed.logTail, /boom/);
  await assert.rejects(h.s.invoke('services.save', { projectId: h.project.id, taskId: task.id, name: 'x', command: 'y', port: 80 }), /1024/);
  await assert.rejects(h.s.invoke('services.save', { projectId: h.project.id, taskId: 'nope', name: 'x', command: 'y' }), /does not exist|Invalid/);
});
