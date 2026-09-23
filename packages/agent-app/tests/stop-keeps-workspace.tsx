/**
 * F44 end to end: the real runtime and the real renderer store. Stopping a running chat must leave its
 * resource pane (Terminal + Browser tabs, visibility) and its context meter exactly as they were.
 */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service';
import type {ProviderAdapter} from '../src/runtime/provider';
import type {AgentEvent} from '../src/shared/protocol';

const root = await mkdtemp(join(tmpdir(), 'muster-stop-e2e-'));
const folder = join(root, 'todo'); await mkdir(folder);
const listeners = new Set<(event: AgentEvent) => void>();
let stopRun: (() => void) | undefined;
const provider: ProviderAdapter = {
  info: () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: []}],
  dispose() {},
  async stop() { stopRun?.(); return true; },
  async run(input) {
    input.onEvent('thread/tokenUsage/updated', {tokenUsage: {last: {totalTokens: 120_000}, modelContextWindow: 200_000}});
    await new Promise<void>(resolve => { stopRun = resolve; });
    // What an interrupted turn reports: the aborted request's (zero) usage.
    input.onEvent('turn/completed', {turn: {status: 'interrupted', tokenUsage: {last: {totalTokens: 0}}}});
    return {status: 'failed', finalMessage: '', recovery: {kind: 'cancelled', retryable: false, reason: 'Stopped.'}};
  },
};
const service = createAgentService({dataDir: join(root, 'state'), provider, onEvent: event => { for (const listener of listeners) listener(event); }});
const saved = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key)},
  window: {setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, innerWidth: 1400, muster: {
    subscribe(listener: (event: AgentEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    invoke: async (command: string, input: unknown) => command.startsWith('browser.') ? undefined : (service.invoke as (c: string, i: unknown) => Promise<unknown>)(command, input),
  }},
});
const until = async (label: string, check: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(10); } };
let failed = false;
try {
  const added = await service.invoke('folder.add', {path: folder});
  const store = await import('../src/renderer/store');
  await store.boot();
  const chat = await service.invoke('chat.create', {folderId: added.id});
  await store.selectChat(chat.id);
  store.openProcessesTab(chat.id, 'Terminal');
  store.openBrowserTab('http://localhost:5174/');
  const before = store.getState().tabs.map(tab => tab.kind);
  assert.deepEqual(before, ['processes', 'browser']);
  assert.equal(store.getState().resourcesHidden, false);
  await service.invoke('chat.send', {id: chat.id, text: 'run the dev server', requestId: 'stop-1'});
  await until('context telemetry arrives', () => store.getState().contextTelemetry[chat.id]?.usedTokens === 120_000);
  await store.stopChat(chat.id);
  await until('chat settles after stop', () => { const status = store.getState().snapshot?.chats.find(c => c.id === chat.id)?.status; return status !== 'running' && status !== 'stopping'; });
  await sleep(100);
  assert.deepEqual(store.getState().tabs.map(tab => tab.kind), before, 'Stop keeps the Terminal and Browser tabs');
  assert.equal(store.getState().resourcesHidden, false, 'Stop never collapses the resource pane');
  assert.equal(store.getState().contextTelemetry[chat.id]?.usedTokens, 120_000, 'Stop never resets the context meter');
  console.log('PASS: stopping a run keeps its resource tabs, pane visibility and context meter');
} catch (error) {
  failed = true; console.error(error instanceof Error ? error.stack : error);
} finally {
  await service.dispose(); await rm(root, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
