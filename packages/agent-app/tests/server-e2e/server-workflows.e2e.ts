/**
 * The app's Muster Server client against a real Muster Server (#804). Each server is packages/server's own build, started as a process
 * on a temp data dir and seeded through its CLI and HTTP API (real-server.ts). The client is the app's runtime code, unchanged: the
 * `musterServer.*` domain signs in, the `paperclip.*` workspace domain reads projects and tasks, creates tasks and holds the live socket.
 * Requests use the real global fetch and WebSocket; nothing in the network path is faked. Two stand-ins remain, both outside that path:
 * the secret store's cipher (Electron safeStorage does not exist in plain Node) and the desktop's own local workspace (empty here).
 *
 * Run with `npm run test:server-e2e` in packages/agent-app (it builds the app and the server first).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createMusterServerDomain } from '../../src/runtime/domains/muster-server.ts';
import { createPaperclipDomain } from '../../src/runtime/domains/paperclip.ts';
import type { DomainContext, DomainModule } from '../../src/runtime/domains/types.ts';
import { SecretStore } from '../../src/runtime/secret-store.ts';
import type { WorkspaceSnapshot, WorkspaceTask } from '../../src/shared/domains/paperclip-protocol.ts';
import { clientLog, MEMBER, OWNER, RealServer } from './real-server.ts';

/** Stands in for Electron safeStorage only (encrypts in memory); the secret store around it is the app's own. */
const box = { isEncryptionAvailable: () => true, encryptString: (t: string) => Buffer.from(`enc:${Buffer.from(t).toString('base64')}`), decryptString: (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString() };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function eventually<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; last = value; } catch (e) { last = (e as Error).message; }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** One app profile: its own data dir, its secret store, and the runtime's server domains sharing one connection, as in the app. */
class AppClient {
  readonly dir = mkdtempSync(join(tmpdir(), 'muster-app-e2e-'));
  readonly events: Array<{ type: string; [k: string]: unknown }> = [];
  private readonly secrets = new SecretStore(this.dir, () => box);
  private readonly context = {
    dataDir: this.dir, db: (() => { const memory = new DatabaseSync(':memory:'); return () => memory; })(), store: { snapshot: () => ({ folders: [] }) }, hooks: {},
    emit: (e: { type: string }) => { this.events.push(e); },
    // The desktop's own workspace is empty in this profile: only the server's rows show.
    async invoke(command: string) { if (command === 'mailbox.list') return { messages: [], unacked: 0, pending: 0 }; if (command === 'project.list') return []; throw new Error(`not in this profile: ${command}`); },
  } as unknown as DomainContext;
  readonly server: DomainModule = createMusterServerDomain(this.context, { secrets: () => this.secrets });
  readonly work: DomainModule = createPaperclipDomain(this.context, { secrets: () => this.secrets });
  constructor(readonly label: string) {}
  async call<T>(command: string, input: Record<string, unknown> = {}): Promise<T> {
    const handler = this.server.handlers[command] ?? this.work.handlers[command];
    if (!handler) throw new Error(`no handler ${command}`);
    try { const value = await handler(input) as T; clientLog(this.label, command, 'ok'); return value; }
    catch (e) { clientLog(this.label, command, 'error', (e as Error).message); throw e; }
  }
  snapshot(refresh = true) { return this.call<WorkspaceSnapshot>('paperclip.snapshot', { refresh }); }
  async signIn(server: RealServer, who = MEMBER) {
    return this.call<{ connected: boolean; url: string; user: { username: string; role: string } }>('musterServer.connect', { url: server.baseUrl, method: 'password', username: who.username, password: who.password });
  }
  async dispose() { await this.call('paperclip.watch', { visible: false }).catch(() => {}); await this.work.dispose?.(); await this.server.dispose?.(); rmSync(this.dir, { recursive: true, force: true }); }
}

const serverTasks = (s: WorkspaceSnapshot, projectId: string): WorkspaceTask[] => s.tasks.filter(t => t.source === 'paperclip' && t.projectId === projectId);

describe('the app client against a real Muster Server', () => {
  let server: RealServer;
  const clients: AppClient[] = [];
  const app = (label: string) => { const c = new AppClient(label); clients.push(c); return c; };
  before(async () => { server = await RealServer.launch('primary', 'Acme Support', 'Support desk'); });
  after(async () => { for (const c of clients) await c.dispose().catch(() => {}); await server?.dispose(); });

  // Spec: MUS-SPEC-13-804A (docs/spec/clauses/13-muster-server.md#mus-spec-13-804a)
  test('signs in with a password and lists and opens the seeded project on a real server', async () => {
    const a = app('member');
    await assert.rejects(a.signIn(server, { ...MEMBER, password: 'not-the-password-1' }), /password/i, 'a wrong password is refused by the server');
    assert.equal((await a.call<{ connected: boolean }>('musterServer.status')).connected, false);
    const view = await a.signIn(server);
    assert.deepEqual([view.connected, view.url, view.user.username, view.user.role], [true, server.baseUrl, MEMBER.username, 'member']);
    // Settings › Integrations lists the server's projects this person can open.
    const { projects } = await a.call<{ projects: Array<{ id: string; name: string; openUrl: string }> }>('musterServer.projects');
    assert.deepEqual(projects.map(p => [p.id, p.name]), [[server.seeded!.projectId, 'Support desk']]);
    assert.equal(projects[0]!.openUrl, `${server.baseUrl}/?project=${encodeURIComponent(server.seeded!.projectId)}`);
    // Projects screen: the server's project shows under the org name its owner set, and opens with its (empty) task list.
    const snap = await a.snapshot();
    const project = snap.projects.find(p => p.id === server.seeded!.projectId);
    assert.ok(project, 'the seeded project is in the workspace snapshot');
    assert.equal(project.source, 'paperclip');
    assert.equal((project as { org?: string }).org, 'Acme Support');
    assert.equal(snap.paperclip?.company?.name, 'Acme Support');
    assert.deepEqual(serverTasks(snap, project.id), []);
    // The owner's private chat or another project never leaks into a member's view.
    assert.equal(snap.projects.filter(p => p.source === 'paperclip').length, 1);
  });

  // Spec: MUS-SPEC-13-804B (docs/spec/clauses/13-muster-server.md#mus-spec-13-804b)
  test('creates a task in a server project and sees it appear, and sees a task someone else made arrive live', async () => {
    const a = app('member');
    await a.signIn(server);
    await a.snapshot();
    const created = await a.call<WorkspaceTask>('paperclip.task.create', { title: 'Reply to order 1042', description: 'The customer says it never arrived.', projectId: server.seeded!.projectId, assigneeId: null, priority: 'high' });
    assert.equal(created.source, 'paperclip');
    assert.equal(created.title, 'Reply to order 1042');
    const listed = serverTasks(await a.snapshot(), server.seeded!.projectId);
    assert.ok(listed.some(t => t.id === created.id && t.title === 'Reply to order 1042'), 'the new task is in the project list');
    const detail = await a.call<{ task: { id: string; title: string }; description: string }>('paperclip.task', { id: created.id });
    assert.equal(detail.task.title, 'Reply to order 1042');
    assert.match(detail.description, /never arrived/);
    // Live: with the Projects screen visible the app holds the server's /events socket; a task the owner creates elsewhere arrives without a reload.
    const watch = await a.call<{ live: string }>('paperclip.watch', { visible: true });
    assert.ok(['socket', 'poll'].includes(watch.live));
    await eventually('the live socket', async () => (await a.call<{ live: string }>('paperclip.config.get')).live === 'socket');
    const before = a.events.length;
    const made = await server.cli(['tasks', 'create', '--project', server.seeded!.projectId, '--title', 'Check the refund queue', '--acceptance', 'Queue is empty']);
    assert.equal(made.code, 0, made.stderr || made.stdout);
    await eventually('a workspace change event', async () => a.events.slice(before).some(e => e.type === 'projectsWorkspaceChanged'));
    const after_ = serverTasks(await a.snapshot(), server.seeded!.projectId);
    assert.ok(after_.some(t => t.title === 'Check the refund queue'), 'the owner’s task shows in the member’s list');
  });

  // Spec: MUS-SPEC-13-804C (docs/spec/clauses/13-muster-server.md#mus-spec-13-804c)
  test('handles the server going away and coming back: the error is shown, then reads, the live socket and the sign-in resume', async () => {
    const a = app('member');
    await a.signIn(server);
    const task = await a.call<WorkspaceTask>('paperclip.task.create', { title: 'Survives a restart', description: '', projectId: server.seeded!.projectId, assigneeId: null });
    assert.ok(serverTasks(await a.snapshot(), server.seeded!.projectId).some(t => t.id === task.id));
    await a.call('paperclip.watch', { visible: true });
    await eventually('the live socket', async () => (await a.call<{ live: string }>('paperclip.config.get')).live === 'socket');

    await server.kill();
    try {
      // The socket drop is noticed and the screens are told.
      await eventually('the socket drop', async () => (await a.call<{ live: string }>('paperclip.config.get')).live !== 'socket');
      const down = await a.snapshot();
      assert.ok(down.paperclip, 'the link is still there while the server is away');
      assert.match(down.paperclip.stale ?? '', /not reachable|timed out|reach/i, 'the snapshot says the server cannot be reached');
      assert.equal(down.paperclip.cached, true);
      assert.ok(serverTasks(down, server.seeded!.projectId).some(t => t.id === task.id), 'the last read stays on screen while the server is away');
      await assert.rejects(a.call('paperclip.task.create', { title: 'While away', description: '', projectId: server.seeded!.projectId, assigneeId: null }), /not reachable|reach/i);
      assert.equal((await a.call<{ connected: boolean }>('musterServer.status')).connected, true, 'a server that is away does not sign you out');
    } finally { await server.start(); }
    // No new sign-in: the stored token still works, the data survived the restart, and the live socket comes back by itself.
    const back = await eventually('reads after the restart', async () => { const s = await a.snapshot(); return !s.paperclip?.stale && s; });
    assert.ok(serverTasks(back, server.seeded!.projectId).some(t => t.id === task.id), 'the task made before the restart is still there');
    await eventually('the live socket after the restart', async () => (await a.call<{ live: string }>('paperclip.config.get')).live === 'socket', 30_000);
    const again = await a.call<WorkspaceTask>('paperclip.task.create', { title: 'After the restart', description: '', projectId: server.seeded!.projectId, assigneeId: null });
    assert.ok(serverTasks(await a.snapshot(), server.seeded!.projectId).some(t => t.id === again.id));
  });

  // Spec: MUS-SPEC-13-804D (docs/spec/clauses/13-muster-server.md#mus-spec-13-804d)
  test('two servers at once: two app profiles, each signed in to its own server, see only their own server’s work', async () => {
    const second = await RealServer.launch('secondary', 'Globex Labs', 'Lab notebook');
    try {
      assert.notEqual(second.port, server.port);
      const a = app('member@primary'), b = app('owner@secondary');
      await Promise.all([a.signIn(server), b.signIn(second, OWNER)]);
      const [ta, tb] = await Promise.all([
        a.call<WorkspaceTask>('paperclip.task.create', { title: 'Primary only', description: '', projectId: server.seeded!.projectId, assigneeId: null }),
        b.call<WorkspaceTask>('paperclip.task.create', { title: 'Secondary only', description: '', projectId: second.seeded!.projectId, assigneeId: null }),
      ]);
      const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
      assert.equal(sa.paperclip?.company?.name, 'Acme Support');
      assert.equal(sb.paperclip?.company?.name, 'Globex Labs');
      assert.ok(sa.tasks.some(t => t.id === ta.id) && !sa.tasks.some(t => t.id === tb.id));
      assert.ok(sb.tasks.some(t => t.id === tb.id) && !sb.tasks.some(t => t.id === ta.id));
      assert.deepEqual(sb.projects.filter(p => p.source === 'paperclip').map(p => p.name), ['Lab notebook']);
      // One server going away leaves the other untouched.
      await second.kill();
      const still = await a.snapshot();
      assert.ok(!still.paperclip?.stale && still.tasks.some(t => t.id === ta.id));
    } finally { await second.dispose(); }
  });

  // TODO(#803): one app profile with both servers in its Settings list, their projects side by side. Today's client holds one
  // connection per profile (runtime/server/connection.ts); write this against the multi-server list when #803 (feat/803-multi-server) lands.
  test('two servers at once in one profile’s Settings list (#803)', { todo: 'needs the multi-server Settings list from #803' }, () => {});
});
