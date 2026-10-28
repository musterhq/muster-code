/** #781: the REAL transcript (ChatView's Timeline, TurnFileChanges, ToolCard, FileChangeView) opens every edit of a file
 *  the chat edited again as the whole file. Stored rows go through the store's read path (a shell `apply_patch` row is
 *  recovered as an edit there); only the bridge is faked. Run via scripts/test-renderer.mjs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
import {AgentStore} from '../src/runtime/store.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
window.innerWidth = 1000; window.innerHeight = 4000; (window.document as any).oninput = null;
(window as any).getSelection = () => ({anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0});
const saved = new Map<string, string>();
const storage = {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); }};
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver, localStorage: storage, sessionStorage: storage, requestAnimationFrame: (cb: any) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class {observe() {} unobserve() {} disconnect() {}}});
const styles = () => ({getPropertyValue: () => '', direction: 'ltr', position: 'static', overflow: 'visible', display: 'block', animationName: 'none', transitionProperty: 'none', transitionDuration: '0s', animationDuration: '0s'});
Object.assign(globalThis, {getComputedStyle: styles}); window.getComputedStyle = styles;
// linkedom does no layout: a tall viewport and 70px rows keep every row of the short chat mounted.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {get() { return 4000; }});
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {get() { return Number.parseFloat(this.querySelector('.timeline-inner')?.style.height || '4000'); }});
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {get() { return this.classList.contains('timeline-row') ? 70 : 4000; }});
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {get() { return 800; }});
window.HTMLElement.prototype.getBoundingClientRect = function () { return {height: this.classList.contains('timeline-row') ? 70 : 4000, width: 800, top: 0, left: 0, bottom: 4000, right: 800}; };
window.HTMLElement.prototype.getClientRects = function () { return [(this as any).getBoundingClientRect()]; };
window.HTMLElement.prototype.scrollTo = function ({top}: any) { this.scrollTop = Math.max(0, top); };
window.HTMLElement.prototype.scrollIntoView = function () {};

// The file as it is now (after turn 2): a = 2, b = 2, c = 3. Turn 1 made a, b, c = 2 from 1 in three edits; turn 2 made c = 3.
const filler = Array.from({length: 20}, (_, i) => `// filler ${i + 1}`);
const now = ['// header', 'const a = 2;', 'const b = 2;', 'const c = 3;', ...filler, 'const d = 1;', '// footer'];
const nowText = now.join('\n') + '\n';
const shell = (cwd: string, patch: string) => ({type: 'commandExecution', cwd, command: `/bin/zsh -lc "apply_patch <<'PATCH'\n${patch}\nPATCH"`, exitCode: 0, aggregatedOutput: 'Success. Updated the following files:\nM app.ts\n'});
const native = (cwd: string, diff: string) => ({type: 'fileChange', cwd, changes: [{path: cwd + '/app.ts', kind: {type: 'update'}, diff}]});
const dir = await realpath(await mkdtemp(join(tmpdir(), 'muster-transcript-781-')));
await mkdir(join(dir, 'repo'));
const store = new AgentStore(dir);
const repo = store.addFolder(join(dir, 'repo'), 'Repo');
/** One two-turn chat: the same four edits whatever the chat's folder is. */
function seed(folderId: string | undefined, cwd: string) {
  const chat = store.createChat({model: 'fixture', mode: 'agent', ...(folderId ? {folderId} : {})});
  const add = (kind: 'user' | 'assistant' | 'tool', text: string, data?: Record<string, unknown>) => store.appendItem(chat.id, kind, text, kind === 'tool' ? 'completed' : undefined, data);
  add('user', 'make the constants 2');
  const first = add('tool', 'apply_patch', shell(cwd, '*** Begin Patch\n*** Update File: app.ts\n@@\n const a = 1;\n-const b = 1;\n+const b = 2;\n const c = 1;\n*** End Patch'));
  add('tool', 'app.ts', native(cwd, '@@ -1,4 +1,4 @@\n // header\n-const a = 1;\n+const a = 2;\n const b = 2;\n const c = 1;'));
  add('tool', 'apply_patch', shell(cwd, '*** Begin Patch\n*** Update File: app.ts\n@@\n const b = 2;\n-const c = 1;\n+const c = 2;\n // filler 1\n*** End Patch'));
  add('assistant', 'Set a, b and c to 2.');
  add('user', 'now make c 3');
  add('tool', 'app.ts', native(cwd, '@@ -3,3 +3,3 @@\n const b = 2;\n-const c = 2;\n+const c = 3;\n // filler 1'));
  add('assistant', 'c is 3.');
  return {chat, first, items: store.timeline(chat.id)};
}
const scratch = seed(undefined, '/scratch');
const folder = seed(repo.id, repo.path);
// The store's read path recovered both shell rows as edits.
for (const {items} of [scratch, folder]) assert.deepEqual(items.filter(item => item.kind === 'tool').map(item => item.data?.type), ['fileChange', 'fileChange', 'fileChange', 'fileChange']);
const chats = [scratch, folder].map(({chat}, index) => ({id: chat.id, title: `Chat ${index}`, folderId: index ? repo.id : null, pinned: false, archived: false, draft: '', status: 'completed', updatedAt: '', model: 'm', mode: 'agent'}));
const snapshot = {version: 1, chats, folders: [{id: repo.id, name: 'Repo', path: repo.path}], projects: [], activeChatId: chats[0].id};
const calls: {command: string; input: any}[] = [];
window.muster = {subscribe() { return () => {}; }, async invoke(command: string, input: any) {
  calls.push({command, input});
  if (command === 'app.snapshot') return snapshot;
  if (command === 'settings.get') return {values: {}};
  if (command === 'files.chatEdit' || command === 'files.read') return {path: input.path, text: nowText, truncated: false};
  if (command === 'review.baselines' || command === 'review.marks' || command === 'checkout.leases') return [];
  return undefined;
}};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const appStore = await import('../src/renderer/store');
const {Timeline} = await import('../src/renderer/components/ChatView');
await appStore.boot(); await delay(30);
const errors: unknown[] = [];
const host = document.getElementById('root')!;
const root = createRoot(host, {onUncaughtError: (error: unknown) => errors.push(error)});
const until = async (ok: () => unknown, label: string) => { for (let i = 0; i < 200 && !ok(); i++) await delay(10); assert.ok(ok(), label); };
const texts = (selector: string, scope: Element = host) => Array.from(scope.querySelectorAll(selector)).map(el => el.textContent);
const click = (el: Element) => (el as HTMLElement).click();

async function mount({chat, items}: typeof scratch) {
  root.render(<Timeline key={chat.id} chatId={chat.id} items={items}/>);
  await until(() => host.querySelectorAll('.turn-files').length === 2, 'both turns list their edited files');
  assert.deepEqual(errors, []);
}
/** The whole file in the opened editor: nothing folded away, no snippet note. */
function assertWhole(scope: Element, context: string[], dels: string[], adds: string[], label: string) {
  assert.deepEqual(texts('.fde-gap,.fde-note', scope), [], `${label}: no folded or snippet-only rows`);
  assert.deepEqual(texts('.is-context .fde-code', scope), context, `${label}: every unchanged line, in order`);
  assert.deepEqual(texts('.is-del .fde-code', scope), dels, `${label}: removed lines in place`);
  assert.deepEqual(texts('.is-add .fde-code', scope), adds, `${label}: added lines in place`);
}
const turnOneContext = ['// header', ...filler, 'const d = 1;', '// footer'];

/** Both chat kinds drive the same transcript; only the read the editor makes differs. */
async function transcriptWorkflow(source: typeof scratch, reads: 'chat' | 'folder', command: 'files.chatEdit' | 'files.read') {
  {
    calls.length = 0;
    await mount(source);
    const sections = Array.from(host.querySelectorAll('.turn-files'));
    // Turn 1: the Edited row stays visible outside the folded work group, and its pill ends the turn.
    const turnOne = sections[0];
    const row = turnOne.querySelector('.edited-file-row')!;
    assert.ok(row && !row.closest('.is-folded'), 'turn 1 keeps its Edited row outside the folded work');
    assert.equal(texts('.tool-row-state', row)[0], 'Edited');
    const pill = turnOne.querySelector('.turn-files-pill')!;
    assert.match(pill.textContent ?? '', /^1 file changed/, 'turn 1 ends with the N files changed pill, got '+JSON.stringify(pill.textContent));
    click(row.querySelector('.tool-row-hit')!);
    await until(() => row.querySelector('.fde-code'), 'the Edited row opens the editor');
    await until(() => !row.querySelector('.fde-note'), 'the whole file replaced the snippet while it loaded');
    // The whole of turn 1's edits, with turn 2's later change undone: c is 1 -> 2, not 3.
    assertWhole(row, turnOneContext, ['const a = 1;', 'const b = 1;', 'const c = 1;'], ['const a = 2;', 'const b = 2;', 'const c = 2;'], 'turn 1 Edited row');
    assert.equal(texts('.is-context .fde-num', row).at(-1), '26', 'real line numbers to the last line');
    assert.equal(calls.some(call => call.command === command), true, `read through ${command}`);
    assert.equal(calls.some(call => call.command === (command === 'files.chatEdit' ? 'files.read' : 'files.chatEdit')), false, 'one kind of read per chat kind');
    if (reads === 'chat') assert.equal(calls.find(call => call.command === command)!.input.chatId, source.chat.id);
    else assert.deepEqual(calls.find(call => call.command === command)!.input, {folderId: repo.id, path: 'app.ts'});
    // The FIRST of the three edits, opened from the folded work group: the file as that one edit left it.
    click(host.querySelector('.turn-worked')!);
    await until(() => host.querySelector('.activity-summary'), 'the turn’s activity group shows');
    click(host.querySelector('.activity-summary')!);
    await until(() => host.querySelectorAll('.tool-row-card:not(.edited-file-row)').length >= 3, 'turn 1 work unfolds to its three edit rows');
    const edits = Array.from(host.querySelectorAll('.tool-row-card')).filter(el => !el.classList.contains('edited-file-row') && /Edited|app\.ts/.test(el.textContent ?? ''));
    const firstEdit = edits[0];
    click(firstEdit.querySelector('.tool-row-hit')!);
    await until(() => firstEdit.querySelector('.fde-code'), 'the first edit opens the editor');
    await until(() => !firstEdit.querySelector('.fde-note'), 'the first edit shows the whole file, not a snippet');
    assertWhole(firstEdit, ['// header', 'const a = 1;', 'const c = 1;', ...filler, 'const d = 1;', '// footer'], ['const b = 1;'], ['const b = 2;'], 'first edit');
    assert.equal(texts('.fde-code', firstEdit).length, 27, 'the first edit lists every line of the file once, plus its removed line');
    assert.deepEqual(errors, []);
    root.render(<div/>); await delay(20);
  }
}

// Spec: MUS-SPEC-08-781J (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781j)
// Protected: complete inline diff
await check('a scratch chat: every edit of a file edited again in a later turn opens as the whole file in the transcript', () => transcriptWorkflow(scratch, 'chat', 'files.chatEdit'));
// Spec: MUS-SPEC-08-781L (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781l)
// Protected: complete inline diff
await check('a folder chat: every edit of a file edited again in a later turn opens as the whole file in the transcript', () => transcriptWorkflow(folder, 'folder', 'files.read'));

// Spec: MUS-SPEC-08-781M (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781m)
// Protected: complete inline diff
await check('the Changes popover opens the latest turn’s file as the whole file too', async () => {
  const {TurnChanges} = await import('../src/renderer/components/TurnChanges');
  calls.length = 0;
  root.render(<TurnChanges key="popover" items={scratch.items} inline/>);
  await until(() => host.querySelector('.changes-pill'), 'the pill shows');
  click(host.querySelector('.changes-pill')!);
  await until(() => host.querySelector('.turn-change-preview .fde-code'), 'the preview opens the editor');
  await until(() => !host.querySelector('.turn-change-preview .fde-note'), 'the whole file replaced the snippet');
  const preview = host.querySelector('.turn-change-preview')!;
  assert.deepEqual(texts('.fde-gap,.fde-note', preview), []);
  assert.deepEqual(texts('.is-del .fde-code', preview), ['const c = 2;']);
  assert.deepEqual(texts('.is-add .fde-code', preview), ['const c = 3;']);
  assert.equal(texts('.fde-code', preview).length, 27, 'every line of the file, plus the removed line');
  assert.deepEqual(errors, []);
  root.render(<div/>); await delay(20);
});
root.unmount();
await rm(dir, {recursive: true, force: true});
store.close();
process.exit(0);
