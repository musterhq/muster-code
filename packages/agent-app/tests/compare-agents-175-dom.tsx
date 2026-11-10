/** #175: the compare view (runs side by side, one file's diff across runs, Use this one) and the Send to several picker. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
const saved = new Map<string, string>();
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, navigator: {userAgent: 'node', platform: 'MacIntel'},
  localStorage: {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key)},
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: (id: number) => clearTimeout(id)});

const file = (path: string, adds: number, dels: number) => ({path, status: 'M', adds, dels, beforeHash: 'b', afterHash: 'a', revision: `${path}:${adds}`});
const run = (chatId: string, model: string, extra: Record<string, unknown>) => ({chatId, title: `Write the answer · ${model}`, status: 'completed', archived: false, providerId: 'alpha', model, branch: `muster/compare-${model}`, folderId: `f-${chatId}`,
  durationMs: 65_000, tokens: 1200, costUsd: null, reply: `${model} reply`, files: [], adds: 0, dels: 0, truncated: false, tests: [], ci: null, hasWork: true, ...extra});
const comparison = {id: 'cmp1', folderId: 'repo', sourceChatId: 'src', baseBranch: 'main', baseSha: 'a'.repeat(40), prompt: 'Write the answer', createdAt: '2026-11-10T10:00:00.000Z', state: 'ready', winnerChatId: null,
  runs: [{chatId: 'c1', folderId: 'f-c1', branch: 'muster/compare-fast', worktreePath: '/wt/fast', providerId: 'alpha', model: 'fast', startedAt: null, settledAt: null}, {chatId: 'c2', folderId: 'f-c2', branch: 'muster/compare-deep', worktreePath: '/wt/deep', providerId: 'alpha', model: 'deep', startedAt: null, settledAt: null}]};
const detail = {comparison, runs: [
  run('c1', 'fast', {files: [file('answer.txt', 1, 1)], adds: 1, dels: 1, tests: [{command: 'npm test', status: 'passed', exitCode: 0}]}),
  run('c2', 'deep', {files: [file('answer.txt', 1, 1), file('notes.md', 1, 0)], adds: 2, dels: 1, tests: [{command: 'pnpm test', status: 'failed', exitCode: 1}]}),
]};
const calls: {command: string; input: any}[] = [];
(window as any).muster = {subscribe: () => () => {}, invoke: async (command: string, input: any) => {
  calls.push({command, input});
  if (command === 'compare.get') return detail;
  if (command === 'compare.list') return [comparison];
  if (command === 'compare.fileDiff') return {path: input.path, status: 'M', before: 'start\n', after: input.chatId === 'c1' ? 'fast\n' : 'deep\n', truncated: false, size: {before: 6, after: 5}, beforeHash: 'b', afterHash: 'a', revision: 'r', label: 'vs main'};
  if (command === 'compare.pick') return {status: 'merged', comparison: {...comparison, state: 'merged', winnerChatId: input.chatId}};
  if (command === 'compare.start') return {...comparison, id: 'cmp2'};
  return undefined;
}};

const React = await import('react'), {createRoot} = await import('react-dom/client'), {flushSync} = await import('react-dom');
const {CompareScreen} = await import('../src/renderer/components/CompareScreen');
const {CompareSendPicker} = await import('../src/renderer/components/CompareSendPicker');
const root = createRoot(document.getElementById('root')!);
const until = async (label: string, test: () => boolean) => { for (let i = 0; i < 200; i++) { if (test()) return; await delay(5); } throw new Error(`timed out: ${label}`); };
const click = (element: Element | null | undefined) => { assert.ok(element, 'element to click'); (element as HTMLElement).dispatchEvent(new window.MouseEvent('click', {bubbles: true})); };
const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttonNamed = (name: RegExp, scope: ParentNode = document) => Array.from(scope.querySelectorAll('button')).find(button => name.test(text(button)) || name.test(button.getAttribute('aria-label') ?? ''));

// Spec: MUS-SPEC-08-175H (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175h)
await check('the compare view shows each run side by side and the diff of one file across runs', async () => {
  flushSync(() => root.render(<CompareScreen id="cmp1"/>));
  await until('columns', () => document.querySelectorAll('[data-compare-run]').length === 2);
  const [fast, deep] = Array.from(document.querySelectorAll('[data-compare-run]'));
  assert.match(text(fast), /fast/); assert.match(text(fast), /Completed/i); assert.match(text(fast), /1m 5s/); assert.match(text(fast), /1,200 tokens/);
  assert.match(text(fast), /fast reply/); assert.match(text(fast), /npm test.*passed/i);
  assert.match(text(deep), /deep reply/); assert.match(text(deep), /pnpm test.*failed/i);
  assert.deepEqual(Array.from(deep!.querySelectorAll('[data-compare-file]')).map(row => row.getAttribute('data-compare-file')), ['answer.txt', 'notes.md']);
  assert.match(text(deep!.querySelector('[data-compare-file="notes.md"]')), /\+1/);
  // Selecting a file shows its diff for every run that changed it.
  click(fast!.querySelector('[data-compare-file="answer.txt"]'));
  await until('diffs', () => document.querySelectorAll('[data-compare-diff] .fde-code').length > 0 && document.querySelectorAll('[data-compare-diff]').length === 2);
  const diffs = Array.from(document.querySelectorAll('[data-compare-diff]'));
  assert.deepEqual(diffs.map(element => element.getAttribute('data-compare-diff')), ['c1', 'c2']);
  assert.ok(Array.from(diffs[0]!.querySelectorAll('.is-add .fde-code')).some(code => code.textContent === 'fast'));
  assert.ok(Array.from(diffs[1]!.querySelectorAll('.is-add .fde-code')).some(code => code.textContent === 'deep'));
  assert.deepEqual(calls.filter(call => call.command === 'compare.fileDiff').map(call => [call.input.chatId, call.input.path]), [['c1', 'answer.txt'], ['c2', 'answer.txt']]);
  // Use this one asks first, names the branches and offers to keep the other run's branch.
  click(buttonNamed(/Use this one/, fast!));
  await until('confirm', () => !!document.querySelector('[data-compare-confirm]'));
  const confirm = document.querySelector('[data-compare-confirm]')!;
  assert.match(text(confirm), /muster\/compare-fast/); assert.match(text(confirm), /main/);
  const keep = confirm.querySelector<HTMLInputElement>('input[data-keep="c2"]');
  assert.ok(keep, 'a Keep branch choice for the other run');
  assert.equal(keep!.checked, true, 'on by default for a run with work');
  assert.equal(calls.some(call => call.command === 'compare.pick'), false, 'nothing merges before the confirm');
  click(buttonNamed(/^Merge/, confirm));
  await until('pick', () => calls.some(call => call.command === 'compare.pick'));
  assert.deepEqual(calls.find(call => call.command === 'compare.pick')!.input, {id: 'cmp1', chatId: 'c1', others: {c2: 'keep'}});
});

// Spec: MUS-SPEC-08-175I (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175i)
await check('send to several picks two to four models and starts one comparison', async () => {
  calls.length = 0;
  let done: unknown = null;
  const providers = [
    {id: 'alpha', name: 'Alpha', available: true, identityMasked: '', models: [{id: 'fast', name: 'Fast'}, {id: 'deep', name: 'Deep'}]},
    {id: 'beta', name: 'Beta', available: true, identityMasked: '', models: [{id: 'wise', name: 'Wise'}, {id: 'slow', name: 'Slow'}, {id: 'odd', name: 'Odd'}]},
    {id: 'gone', name: 'Gone', available: false, identityMasked: '', models: [{id: 'x', name: 'X'}]},
  ];
  flushSync(() => root.render(<CompareSendPicker chatId="src" text="Write the answer" attachmentIds={['att1']} providers={providers as never} onDone={value => { done = value; }} onCancel={() => {}}/>));
  await until('picker', () => document.querySelectorAll('input[data-target]').length > 0);
  const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[data-target]'));
  assert.deepEqual(boxes().map(box => box.getAttribute('data-target')), ['alpha/fast', 'alpha/deep', 'beta/wise', 'beta/slow', 'beta/odd'], 'only runnable models');
  const send = () => buttonNamed(/^Send to/)!;
  assert.equal(send().disabled, true, 'off until two are picked');
  click(boxes()[0]); await delay(5);
  assert.equal(send().disabled, true);
  click(boxes()[2]); await delay(5);
  assert.equal(send().disabled, false);
  assert.match(text(send()), /2/);
  click(boxes()[1]); click(boxes()[3]); await delay(5);
  assert.equal(boxes()[4]!.disabled, true, 'no more than four');
  click(boxes()[1]); click(boxes()[3]); await delay(5);
  click(send());
  await until('start', () => calls.some(call => call.command === 'compare.start'));
  const input = calls.find(call => call.command === 'compare.start')!.input;
  assert.equal(input.chatId, 'src'); assert.equal(input.text, 'Write the answer'); assert.deepEqual(input.attachmentIds, ['att1']);
  assert.deepEqual(input.targets, [{providerId: 'alpha', model: 'fast'}, {providerId: 'beta', model: 'wise'}]);
  assert.equal(typeof input.requestId, 'string');
  await until('done', () => done !== null);
});
root.unmount();
process.exit(0);
