/**
 * Shared harness for the Wave 2 work-layer tests: the real agent service on a fresh data dir with real SQLite, a real git
 * repository and a scripted provider. Replies come from rules keyed on the prompt, so a test says what the agent answers.
 * Not a test file itself (the test glob is tests/*.test.ts).
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';
import { workClock } from '../src/runtime/domains/work.ts';
import { automationTiming } from '../src/runtime/domains/automations.ts';
import { setGitHubTransport, type GitHubRequest, type GitHubResponse } from '../src/runtime/github.ts';
import { FakeClock, until, wait } from './wave1-harness.ts';

export { FakeClock, until, wait };
export interface Rule { re: RegExp; reply: string | ((input: ProviderInput, turn: number) => string); touch?: string; delayMs?: number; fail?: string }
export interface Call { chatId: string; cwd: string; prompt: string; text: string; turn: number; permission: string }
export interface Wave2Options { fakeClock?: boolean }

export async function wave2(t: TestContext, opts: Wave2Options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-wave2-'));
  const repo = join(dataDir, 'oss-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 'founder@example.com']); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Founder']);
  await writeFile(join(repo, 'README.md'), '# oss\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
  const clock = opts.fakeClock ? new FakeClock() : undefined;
  if (clock) { workClock.now = clock.now; workClock.timers = { set: clock.set, clear: clock.clear }; }
  const calls: Call[] = [], turns = new Map<string, number>(), rules: Rule[] = [];
  const sayWhen = (re: RegExp, reply: Rule['reply'], more: Partial<Rule> = {}) => { rules.unshift({ re, reply, ...more }); };
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    stop: async () => true, dispose() {},
    async run(input: ProviderInput) {
      const turn = (turns.get(input.chat.id) ?? 0) + 1; turns.set(input.chat.id, turn);
      const text = `${input.developerInstructions ?? ''}\n${input.prompt}`;
      calls.push({ chatId: input.chat.id, cwd: input.cwd, prompt: input.prompt, text, turn, permission: input.chat.permissionMode ?? '' });
      input.onTurnAccepted?.({ threadId: `thr-${input.chat.id}`, turnId: `turn-${turn}`, dispatchState: 'dispatched' });
      input.onEvent('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1200 * turn, cachedInputTokens: 0, outputTokens: 300 * turn, reasoningOutputTokens: 0 }, last: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0 } } });
      const rule = rules.find(r => r.re.test(text));
      if (rule?.delayMs) await wait(rule.delayMs);
      if (rule?.fail) return { status: 'failed' as const, finalMessage: '', errorMessage: rule.fail, dispatchState: 'dispatched' as const };
      if (rule?.touch) { await writeFile(join(input.cwd, rule.touch), 'x\n'); const item = { id: `f-${turn}`, type: 'fileChange', status: 'completed', changes: [{ path: rule.touch, kind: { type: 'add' } }] }; input.onEvent('item/started', { item: { ...item, status: 'inProgress' } }); input.onEvent('item/completed', { item }); }
      const reply = rule ? (typeof rule.reply === 'function' ? rule.reply(input, turn) : rule.reply) : 'Done.';
      return { status: 'completed' as const, finalMessage: reply, dispatchState: 'dispatched' as const };
    },
  };
  const events: Record<string, unknown>[] = [];
  const s = createAgentService({ dataDir, provider, onEvent: e => { events.push(e as unknown as Record<string, unknown>); } });
  t.after(async () => { await s.dispose(); if (clock) { workClock.now = undefined; workClock.timers = undefined; } automationTiming.secrets = undefined; automationTiming.webhookPort = 47831; setGitHubTransport(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = await s.invoke('folder.add', { path: repo });
  const project = await s.invoke('project.create', { name: 'OSSMANAGER', goal: 'Ship the release', folderIds: [folder.id] });
  const member = (name: string, extra: Record<string, unknown> = {}) => s.invoke('project.members.add', { projectId: project.id, name, kind: 'agent', role: 'agent', title: name, runner: { providerId: 'scripted', model: 'scripted-model' }, ...extra });
  const work = () => s.invoke('project.work', { projectId: project.id, activityLimit: 200 });
  const task = async (id: string) => (await work()).tasks.items.find(i => i.id === id)!;
  const addTask = (title: string, owner: { kind: 'user' | 'agent'; id: string }, more: Record<string, unknown> = {}) => s.invoke('project.tasks.add', { projectId: project.id, title, acceptance: '', dependencies: [], owner, ...more });
  const start = async (id: string) => s.invoke('project.tasks.dispatch', { projectId: project.id, id, revision: (await task(id)).revision });
  const settled = (id: string, ...states: string[]) => until(async () => { const st = (await task(id))?.state; return st && !['running', 'needs-input'].includes(st) && (!states.length || states.includes(st)) ? st : false; }, `task ${id} to settle`);
  const eventsOf = (type: string) => events.filter(e => e.type === type);
  /** A GitHub mock: a local HTTP server standing in for api.github.com, reached through the same transport seam the app's own tests use. */
  const github = async (handler: (req: GitHubRequest) => { status?: number; body: unknown } | undefined) => {
    const requests: GitHubRequest[] = [];
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '/').slice(1);
      const out = handler({ method: (req.method ?? 'GET') as GitHubRequest['method'], path }) ?? { status: 404, body: { message: 'Not Found' } };
      requests.push({ method: (req.method ?? 'GET') as GitHubRequest['method'], path });
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    setGitHubTransport(async (_cwd, req): Promise<GitHubResponse> => {
      const r = await fetch(`http://127.0.0.1:${port}/${req.path}`, { method: req.method });
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.json().catch(() => null) };
    });
    t.after(() => { server.close(); server.closeAllConnections?.(); });
    return { requests, port };
  };
  return { s, repo, folder, project, member, work, task, addTask, start, settled, calls, rules, sayWhen, clock, dataDir, events, eventsOf, github, until, wait };
}
export type Wave2 = Awaited<ReturnType<typeof wave2>>;
