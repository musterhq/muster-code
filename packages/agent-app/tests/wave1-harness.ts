/**
 * Shared harness for the Wave 1 governance tests: the real agent service on a fresh data dir with real SQLite, a real git
 * repository and real worktrees, and a scripted provider whose behaviour is chosen by markers in the task prompt. Not a test
 * file itself (the test glob is tests/*.test.ts).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';
import { governanceClock } from '../src/runtime/domains/project-governance.ts';
import { SecretStore } from '../src/runtime/secret-store.ts';

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, label: string, ms = 12_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v as T; await wait(30); }
  throw new Error(`timed out waiting for ${label}`);
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

/** Timers and a clock you advance by hand. */
export class FakeClock {
  t = Date.now();
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  set = (fn: () => void, ms: number) => { const id = this.next++; this.timers.set(id, { at: this.t + Math.max(0, ms), fn }); return id; };
  clear = (h: unknown) => { this.timers.delete(h as number); };
  get pending() { return this.timers.size; }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due[1].at); this.timers.delete(due[0]);
      due[1].fn(); await flush();
    }
    this.t = end; await flush();
  }
}

export interface Call { chatId: string; cwd: string; prompt: string; text: string; turn: number; overrides: Record<string, unknown>; permission: string }
export interface Wave1Options { fakeClock?: boolean; secrets?: boolean; runner?: 'scripted' }

const SAY = /W1-SAY<<<([\s\S]*?)>>>/;
const fakeBox = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`ENC:${s}`), decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, '') };

export async function wave1(t: TestContext, opts: Wave1Options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-wave1-'));
  const repo = join(dataDir, 'oss-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 'founder@example.com']); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Founder']);
  await writeFile(join(repo, 'README.md'), '# oss\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
  const clock = opts.fakeClock ? new FakeClock() : undefined;
  if (clock) { governanceClock.now = clock.now; governanceClock.timers = { set: clock.set, clear: clock.clear }; }
  const secrets = opts.secrets ? new SecretStore(dataDir, () => fakeBox) : undefined;
  if (secrets) governanceClock.secrets = () => secrets;
  const calls: Call[] = [], turns = new Map<string, number>(), behaviour = new Map<string, string>(), stopped = new Set<string>(), slow = new Map<string, () => void>(), reviewCount = new Map<string, number>();
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    stop: async chatId => { stopped.add(chatId); slow.get(chatId)?.(); return true; }, dispose() {},
    async run(input: ProviderInput) {
      const turn = (turns.get(input.chat.id) ?? 0) + 1; turns.set(input.chat.id, turn);
      const text = `${input.developerInstructions ?? ''}\n${input.prompt}`;
      if (!behaviour.has(input.chat.id)) behaviour.set(input.chat.id, text);
      const first = behaviour.get(input.chat.id)!;
      calls.push({ chatId: input.chat.id, cwd: input.cwd, prompt: input.prompt, text, turn, overrides: { ...(input.configOverrides ?? {}) }, permission: input.chat.permissionMode ?? '' });
      input.onTurnAccepted?.({ threadId: `thr-${input.chat.id}`, turnId: `turn-${turn}`, dispatchState: 'dispatched' });
      input.onEvent('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1200 * turn, cachedInputTokens: 0, outputTokens: 300 * turn, reasoningOutputTokens: 0 }, last: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0 } } });
      const done = (finalMessage: string) => ({ status: 'completed' as const, finalMessage, dispatchState: 'dispatched' as const });
      const touch = async (name: string, body: string) => {
        await writeFile(join(input.cwd, name), body);
        const item = { id: `f-${turn}-${name}`, type: 'fileChange', status: 'completed', changes: [{ path: name, kind: { type: 'add' } }] };
        input.onEvent('item/started', { item: { ...item, status: 'inProgress' } }); input.onEvent('item/completed', { item });
      };
      // Reviewer and watchdog chats (read-only, verdict in a fenced block).
      if (/reviewing work/.test(input.prompt)) {
        const title = /Task: (.*)/.exec(input.prompt)?.[1] ?? '', n = reviewCount.get(title) ?? 0; reviewCount.set(title, n + 1);
        if (/W1-REVIEW-NONE/.test(input.prompt)) return done('I looked at it but have no verdict.');
        if (/W1-REVIEW-ALWAYS-CHANGES/.test(input.prompt) || (/W1-REVIEW-CHANGES-ONCE/.test(input.prompt) && n === 0)) return done('```muster-review\n{"decision":"request_changes","note":"Add a test for the empty case."}\n```');
        return done('```muster-review\n{"decision":"approve","note":"Checked the acceptance criteria."}\n```');
      }
      if (/watchdog for this project/.test(input.prompt)) {
        if (/W1-WD-NONE/.test(input.prompt)) return done('Not sure.');
        const verdict = /W1-WD-ACCEPT/.test(input.prompt) ? 'accept' : 'reopen';
        return done('```muster-watchdog\n' + JSON.stringify({ verdict, note: 'Verified independently.' }) + '\n```');
      }
      if (/W1-SLOW/.test(first)) {
        await new Promise<void>(r => { const timer = setTimeout(r, 20_000); slow.set(input.chat.id, () => { clearTimeout(timer); r(); }); });
        slow.delete(input.chat.id);
        return stopped.has(input.chat.id) ? { status: 'failed', finalMessage: '', errorMessage: 'stopped', failure: { kind: 'aborted' }, dispatchState: 'dispatched' } : done('slow done');
      }
      if (/W1-FAIL-ALWAYS/.test(first)) return { status: 'failed', finalMessage: '', errorMessage: 'rate_limited: 429 try later', dispatchState: 'dispatched' };
      if (/W1-FAIL-PERMANENT/.test(first)) return { status: 'failed', finalMessage: '', errorMessage: 'the model refused the request', dispatchState: 'dispatched' };
      if (/W1-FAIL-LIMIT/.test(first)) return { status: 'failed', finalMessage: '', errorMessage: 'You hit your usage limit. Resets in 3 hours.', dispatchState: 'dispatched' };
      if (/W1-TRANSIENT/.test(first) && turn === 1) return { status: 'failed', finalMessage: '', errorMessage: 'rate_limited: 429 try later', dispatchState: 'dispatched' };
      if (/W1-EMPTY-ALWAYS/.test(first)) return done('');
      if (/W1-EMPTY2/.test(first) && turn <= 2) return done('');
      if (/W1-PLAN/.test(first) && turn === 1) return done('Plan: first I will read the code, then I will add the note file.');
      if (/W1-SILENT/.test(first)) { await touch('SILENT.md', 'quiet\n'); return done(''); }
      if (/W1-NOCOMMENT/.test(first)) { if (turn === 1) { await touch('NOCOMMENT.md', 'work\n'); return done(''); } return done('Added the note file; nothing else is left.'); }
      if (/W1-COMMIT-ENV/.test(first) || /W1-COMMIT-CFG/.test(first)) {
        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k];
        // ENV: the identity as git's own variables; CFG: only the GIT_CONFIG_* variables (how a tool that reads config would see it).
        for (const [k, v] of Object.entries(input.configOverrides ?? {})) { const m = /^shell_environment_policy\.set\.(.+)$/.exec(k); if (m && typeof v === 'string' && (/W1-COMMIT-ENV/.test(first) ? /^GIT_(AUTHOR|COMMITTER)_/.test(m[1]!) : /^GIT_CONFIG_/.test(m[1]!))) env[m[1]!] = v; }
        await touch('COMMITTED.md', 'x\n');
        execFileSync('git', ['-C', input.cwd, 'add', '-A'], { env }); execFileSync('git', ['-C', input.cwd, 'commit', '-qm', 'agent commit'], { env });
        return done('Committed.');
      }
      if (/W1-APPROVE:/.test(first)) {
        const command = /Project task: W1-APPROVE:([^\n]*)/.exec(first)?.[1]?.trim() ?? 'echo hi';
        const decision = await input.onRequest('item/commandExecution/requestApproval', { itemId: `a-${input.chat.id}-${turn}`, command, cwd: input.cwd, reason: 'scripted' });
        await touch('APPROVE.md', JSON.stringify(decision));
        return done(`Decision: ${JSON.stringify(decision)}`);
      }
      if (/W1-ECHO/.test(first)) {
        const lent = Object.entries(input.configOverrides ?? {}).filter(([k]) => k.startsWith('shell_environment_policy.set.NPM')).map(([, v]) => String(v)).join(' ');
        const item = { id: `echo-${turn}`, type: 'commandExecution', command: 'env', status: 'completed', aggregatedOutput: `NPM_TOKEN=${lent}\nHOME=/x`, exitCode: 0 };
        input.onEvent('item/started', { item: { ...item, status: 'inProgress', aggregatedOutput: undefined } }); input.onEvent('item/completed', { item });
        return done(`The token is ${lent}`);
      }
      if (/W1-ENV/.test(first)) { await touch('ENV.md', 'env\n'); return done('Ran with env.'); }
      const say = SAY.exec(first)?.[1];
      await touch(`NOTE-${turn}.md`, 'edited\n');
      return done(say ?? 'Wrote the note file.');
    },
  };
  const s = createAgentService({ dataDir, provider, onEvent() {} });
  t.after(async () => { for (const r of slow.values()) r(); await s.dispose(); if (clock) { governanceClock.now = undefined; governanceClock.timers = undefined; } governanceClock.secrets = undefined; secrets?.close?.(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = await s.invoke('folder.add', { path: repo });
  const project = await s.invoke('project.create', { name: 'OSSMANAGER', goal: '', folderIds: [folder.id] });
  const member = (name: string, extra: Record<string, unknown> = {}) => s.invoke('project.members.add', { projectId: project.id, name, kind: 'agent', role: 'agent', title: name, runner: { providerId: 'scripted', model: 'scripted-model' }, ...extra });
  const work = () => s.invoke('project.work', { projectId: project.id, activityLimit: 200 });
  const task = async (taskId: string) => (await work()).tasks.items.find(i => i.id === taskId)!;
  const state = async (taskId: string) => (await task(taskId))?.state;
  const addTask = (title: string, owner: { kind: 'user' | 'agent'; id: string }, more: Record<string, unknown> = {}) => s.invoke('project.tasks.add', { projectId: project.id, title, acceptance: '', dependencies: [], owner, ...more });
  const start = async (taskId: string) => { const cur = await task(taskId); return s.invoke('project.tasks.dispatch', { projectId: project.id, id: taskId, revision: cur.revision }); };
  const settled = async (taskId: string, ...states: string[]) => until(async () => { const st = await state(taskId); return st && !['running', 'needs-input'].includes(st) && (!states.length || states.includes(st)) ? st : false; }, `task ${taskId} to settle${states.length ? ` as ${states.join('/')}` : ''}`);
  const activity = async (kind?: string) => (await work()).activity.items.filter(a => !kind || a.kind === kind);
  const gov = () => s.invoke('project.gov.state', { projectId: project.id });
  const idle = (ms = 150) => wait(ms);
  return { s, repo, folder, project, member, work, task, state, addTask, start, settled, activity, gov, calls, clock, dataDir, secrets, until, wait, idle, assert };
}
export type Wave1 = Awaited<ReturnType<typeof wave1>>;
