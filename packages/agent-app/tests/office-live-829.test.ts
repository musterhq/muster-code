/** #829 part 3, runtime: office previews refresh by themselves. A watched file settles into one refresh after its last
 *  change, refreshes of a file never overlap, an unchanged file never refreshes (so a render cannot loop), and an
 *  office_render result re-renders with the LibreOffice already there. The folder watch, the converter and the
 *  rasterizer are fakes: no LibreOffice runs and nothing is downloaded. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {OfficeFileWatch, type DirWatch} from '../src/runtime/office-live.ts';
import {officeRuntimeTesting} from '../src/runtime/domains/office.ts';
import {DOMAIN_FACTORIES} from '../src/runtime/domains/index.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {setOfficeRuntime} from '../src/runtime/document-preview.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';

async function directory(t: TestContext, prefix = 'muster-office-live-'): Promise<string> {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
  t.after(() => fs.rm(path, {recursive: true, force: true}));
  return path;
}
async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await delay(5); }
}
/** A folder watch that reports what the test says, and records whether it is open. */
function fakeWatch() {
  const opened: {dir: string; closed: boolean; report(name: string | null): void}[] = [];
  const watch: DirWatch = (dir, onEvent) => {
    const handle = {dir, closed: false, report: (name: string | null) => { if (!handle.closed) onEvent(name); }, close() { handle.closed = true; }};
    opened.push(handle);
    return handle;
  };
  const report = (dir: string, name: string | null) => { for (const handle of opened) if (handle.dir === dir) handle.report(name); };
  return {opened, watch, report};
}
/** A later mtime than the last write, so a same-size rewrite is seen even on a coarse clock. */
async function write(file: string, text: string): Promise<void> {
  const before = await fs.stat(file).then(stat => stat.mtimeMs, () => 0);
  await fs.writeFile(file, text);
  const stamp = new Date(Math.max(Date.now(), before + 2000));
  await fs.utimes(file, stamp, stamp);
}

// Spec: MUS-SPEC-21-829M (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829m)
test('a file change settles into one refresh, one at a time, and an unchanged file never refreshes', async t => {
  const dir = await directory(t), file = join(dir, 'report.docx'), other = join(dir, 'notes.xlsx'), third = join(dir, 'deck.pptx');
  await fs.writeFile(file, 'v1'); await fs.writeFile(other, 'o1'); await fs.writeFile(third, 't1');
  const {opened, watch, report} = fakeWatch();
  const calls: string[][] = [];
  let running = 0, most = 0, hold: PromiseWithResolvers<void> | null = null;
  const live = new OfficeFileWatch({watch, debounceMs: 40, maxFiles: 2, async onChange(changed, ids) {
    assert.equal(changed, file);
    calls.push([...ids].sort()); running++; most = Math.max(most, running);
    try { if (hold) await hold.promise; } finally { running--; }
  }});
  t.after(() => live.dispose());

  await live.add('a', file); await live.add('b', file);
  assert.equal(opened.length, 1, 'one watch for two previews of one file');
  assert.equal(opened[0]!.dir, dirname(file), 'the folder is watched, so a save that replaces the file is seen');

  // A burst: Word writes several times and touches its lock file.
  await write(file, 'v2');
  for (let i = 0; i < 3; i++) { report(dir, 'report.docx'); await delay(10); }
  report(dir, '~$report.docx');
  await delay(20);
  assert.equal(calls.length, 0, 'nothing before the debounce after the last change');
  await until(() => calls.length === 1, 'the settled refresh');
  await delay(80);
  assert.deepEqual(calls, [['a', 'b']], 'exactly one refresh for the burst, naming both previews');

  // A render (or anything) that rewrites the same bytes does not refresh: no loop.
  await write(file, 'v2'); report(dir, 'report.docx');
  report(dir, 'notes.xlsx');
  await delay(120);
  assert.equal(calls.length, 1, 'same content and other files are ignored');

  // One at a time: a change while a refresh runs gives exactly one more, after it.
  hold = Promise.withResolvers<void>();
  await write(file, 'v3'); report(dir, 'report.docx');
  await until(() => running === 1, 'the slow refresh');
  await write(file, 'v4'); report(dir, 'report.docx');
  await delay(60); await write(file, 'v5'); report(dir, 'report.docx');
  await delay(120);
  assert.equal(calls.length, 2, 'no second refresh while one runs');
  const release = hold; hold = null; release.resolve();
  await until(() => calls.length === 3, 'the follow-up refresh');
  await delay(120);
  assert.equal(calls.length, 3, 'exactly one follow-up');
  assert.equal(most, 1, 'refreshes of one file never overlap');

  // Mid-save the file can be missing; the refresh waits for it to come back.
  await fs.rm(file); report(dir, 'report.docx');
  await delay(120);
  assert.equal(calls.length, 3, 'a missing file does not refresh');
  await write(file, 'v6'); report(dir, null);
  await until(() => calls.length === 4, 'the refresh after the file is back');

  // Bounded.
  await live.add('c', other);
  await assert.rejects(live.add('d', third), /live previews/i, 'a file beyond the cap is refused');

  live.remove('a');
  assert.equal(opened[0]!.closed, false, 'still watched for b');
  live.remove('b');
  assert.equal(opened[0]!.closed, true, 'the last preview leaving closes the watch');
  await write(file, 'v7'); report(dir, 'report.docx');
  await delay(120);
  assert.equal(calls.length, 4, 'nothing after the watch closed');

  // A preview mounted after an unseen change refreshes at once.
  live.remove('c');
  await live.add('e', file, 0);
  await until(() => calls.length === 5, 'the catch-up refresh');
  assert.deepEqual(calls.at(-1), ['e']);
  await live.add('f', file, Date.now() + 60_000);
  await delay(120);
  assert.equal(calls.length, 5, 'a file older than since is not refreshed');
  live.dispose();
  assert.ok(opened.every(handle => handle.closed), 'dispose closes every watch');
});

// Spec: MUS-SPEC-21-829N (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829n)
test('an office_render preview re-renders a changed file with the installed LibreOffice and keeps the last pages when a render fails', async t => {
  const dataDir = await directory(t), folder = await directory(t, 'muster-office-live-folder-'), db = new DatabaseSync(':memory:');
  const file = join(folder, 'report.docx');
  await fs.writeFile(file, 'v1');
  const soffice = join(dataDir, 'soffice');
  await fs.writeFile(soffice, '#!/bin/sh\nexit 1\n', {mode: 0o755});
  let downloads = 0, renders = 0, failNext = false;
  const {opened, watch, report} = fakeWatch();
  const fetch = async () => { downloads++; throw new Error('no network in tests'); };
  officeRuntimeTesting.options = {candidates: [soffice], env: {}, build: null, fetch};
  officeRuntimeTesting.render = {
    run: async (_soffice, args) => { const out = args[args.indexOf('--outdir') + 1]!; await fs.writeFile(join(out, 'doc.pdf'), '%PDF-1.4 fake'); },
    rasterize: async (_pdf, {maxPages}) => {
      renders++;
      if (failNext) { failNext = false; throw new Error('The converted file is not a valid PDF.'); }
      return {pageCount: 5, pages: Array.from({length: Math.min(5, maxPages)}, (_, index) => Buffer.from(`render-${renders}-page-${index + 1}`))};
    },
  };
  officeRuntimeTesting.live = {watch, debounceMs: 30};
  t.after(() => { officeRuntimeTesting.options = undefined; officeRuntimeTesting.render = undefined; officeRuntimeTesting.live = undefined; setOfficeRuntime(null); db.close(); });
  const events: AgentEvent[] = [];
  const context = (dir: string) => ({dataDir: dir, db: () => db, hooks: createDomainHooks().hooks, emit: (event: AgentEvent) => events.push(event),
    store: {chat: (id: string) => id === 'chat-1' ? {id, folderId: 'folder-1', mode: 'agent'} : undefined},
    folderFor: (id: string) => { if (id !== 'folder-1') throw new Error('Unknown folder.'); return {id, path: folder, name: 'Folder'}; }} as unknown as DomainContext);
  const domain = DOMAIN_FACTORIES.office(context(dataDir));
  let disposed = false;
  t.after(() => { if (!disposed) domain.dispose?.(); });
  const h = domain.handlers as Record<string, (input: unknown) => Promise<unknown>>;
  type Live = {type: 'officeLiveChanged'; id: string; phase: string; version: number; error?: string; updatedAt?: string};
  const changes = (id: string) => events.filter((event): event is AgentEvent & Live => event.type === 'officeLiveChanged' && (event as unknown as Live).id === id) as unknown as Live[];
  const pages = async (id: string) => (await h['office.live.pages']!({id}) as {pages: string[]}).pages.map(url => Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64').toString());
  const renderId = 'render:item-1';
  const source = {kind: 'render', chatId: 'chat-1', path: 'report.docx', pages: 2};

  const watched = await h['office.live.watch']!({id: renderId, source, since: Date.now() + 60_000}) as {phase: string; version: number};
  assert.equal(watched.version, 0);
  assert.equal(renders, 0, 'watching renders nothing by itself');
  assert.deepEqual(await pages(renderId), [], 'no refreshed pages yet: the row keeps its own');

  await write(file, 'v2'); report(folder, 'report.docx');
  await until(() => changes(renderId).some(event => event.phase === 'updated'), 'the first refresh');
  assert.deepEqual(changes(renderId).map(event => [event.phase, event.version]), [['rendering', 0], ['updated', 1]]);
  assert.deepEqual(await pages(renderId), ['render-1-page-1', 'render-1-page-2'], 'as many pages as the row showed');

  failNext = true;
  await write(file, 'v3'); report(folder, 'report.docx');
  await until(() => changes(renderId).some(event => event.phase === 'failed'), 'the failed refresh');
  assert.match(changes(renderId).at(-1)!.error ?? '', /not a valid PDF/);
  assert.deepEqual(await pages(renderId), ['render-1-page-1', 'render-1-page-2'], 'a failed render keeps the last pages');

  // Off screen: no watch. Back on screen after an unseen change: re-rendered at once.
  await h['office.live.unwatch']!({id: renderId});
  assert.ok(opened.every(handle => handle.closed), 'unwatching closes the folder watch');
  const before = Date.now() - 1;
  await write(file, 'v4');
  await h['office.live.watch']!({id: renderId, source, since: before});
  await until(() => changes(renderId).filter(event => event.phase === 'updated').length === 2, 'the catch-up refresh');
  assert.deepEqual(await pages(renderId), ['render-3-page-1', 'render-3-page-2']);

  // The file viewer's preview only hears about the change; it reads the file itself.
  const fileId = 'file:folder-1:report.docx';
  await h['office.live.watch']!({id: fileId, source: {kind: 'file', folderId: 'folder-1', path: 'report.docx'}, since: Date.now() + 60_000});
  const rendersBefore = renders;
  await write(file, 'v5'); report(folder, 'report.docx');
  await until(() => changes(fileId).some(event => event.phase === 'updated'), 'the file preview update');
  await until(() => changes(renderId).filter(event => event.phase === 'updated').length === 3, 'the shared render');
  assert.equal(renders, rendersBefore + 1, 'one render for the change, none for the file viewer');

  await assert.rejects(h['office.live.watch']!({id: 'render:x', source: {...source, chatId: 'nope'}}), /chat/i);
  await assert.rejects(h['office.live.watch']!({id: 'file:x', source: {kind: 'file', folderId: 'folder-1', path: '../outside.docx'}}), /outside|escapes/i);
  await assert.rejects(h['office.live.watch']!({id: 'render:y', source: {...source, path: 'notes.txt'}}), /Cannot|supported/i);

  const liveDir = join(dataDir, 'office-renders', 'live');
  assert.ok((await fs.readdir(liveDir)).length > 0, 'refreshed pages are kept under the renders folder');
  domain.dispose?.(); disposed = true; setOfficeRuntime(null);
  await until(() => opened.every(handle => handle.closed), 'every watch closed');
  await fs.access(liveDir).then(() => assert.fail('refreshed pages removed on dispose'), () => undefined);

  // No LibreOffice at all: the refresh says so and nothing is downloaded.
  officeRuntimeTesting.options = {candidates: [], env: {}, build: null, fetch};
  const bare = DOMAIN_FACTORIES.office(context(await directory(t, 'muster-office-live-bare-')));
  t.after(() => bare.dispose?.());
  const b = bare.handlers as Record<string, (input: unknown) => Promise<unknown>>;
  await b['office.live.watch']!({id: 'render:item-2', source, since: 0});
  await until(() => changes('render:item-2').some(event => event.phase === 'failed'), 'the refresh without LibreOffice');
  assert.match(changes('render:item-2').at(-1)!.error ?? '', /LibreOffice/);
  assert.equal(downloads, 0, 'a refresh never downloads LibreOffice');
});
