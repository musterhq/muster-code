import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, symlink, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOpenWith, type OpenWithHost} from '../src/main/open-with.ts';
import {createFilesDomain} from '../src/runtime/domains/files.ts';
import {openWithKind, FILES_COMMANDS} from '../src/shared/domains/files-protocol.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

function fakeHost(installed: string[], platform: NodeJS.Platform = 'darwin') {
  const runs: Array<[string, string[]]> = [];
  const host: OpenWithHost = {
    platform, home: '/Users/me', tmp: '/tmp',
    run: async (file, args) => { runs.push([file, args]); if (file.endsWith('plutil')) return args.at(-1)!.includes('Code') ? 'Code' : ''; return ''; },
    isDirectory: async path => installed.includes(path),
    readFile: async () => Buffer.from('png'),
    remove: async () => {},
  };
  return {host, runs};
}

test('file kinds pick the right app families', () => {
  assert.equal(openWithKind('docs/FILE.md'), 'markdown');
  assert.equal(openWithKind('Report.DOCX'), 'doc');
  assert.equal(openWithKind('a/b/deck.pptx'), 'slides');
  assert.equal(openWithKind('paper.pdf'), 'pdf');
  assert.equal(openWithKind('Makefile'), 'code');
  assert.equal(openWithKind('.env'), 'code');
  assert.equal(openWithKind('data.csv'), 'delimited');
  assert.deepEqual(Object.keys(FILES_COMMANDS).sort(), ['files.external.inspect', 'files.external.openWith', 'files.external.reveal', 'files.openFolderWith', 'files.openFolderWith.apps', 'files.openWith', 'files.openWith.apps', 'files.quickOpen', 'files.readFull', 'files.runActions.list', 'files.runActions.set', 'files.searchContent', 'files.searchContent.cancel', 'files.write']);
});

test('only installed allowlisted apps are offered, best first, Finder last', async () => {
  const {host} = fakeHost(['/Applications/Visual Studio Code.app', '/Applications/Cursor.app', '/System/Applications/Preview.app', '/Applications/Microsoft Word.app']);
  const openWith = createOpenWith(host);
  const md = await openWith.apps('notes/FILE.md');
  assert.deepEqual(md.map(app => app.id), ['cursor', 'vscode', 'finder']);
  assert.match(md[1].icon ?? '', /^data:image\/png;base64,/, 'the app icon is a data URL the renderer CSP allows');
  assert.equal(md[0].icon, undefined, 'apps without an .icns keep the generic glyph');
  assert.deepEqual((await openWith.apps('Brief.docx')).map(app => app.id), ['word', 'finder']);
  assert.deepEqual((await openWith.apps('paper.pdf')).map(app => app.id), ['preview', 'finder']);
  assert.deepEqual(await createOpenWith(fakeHost([], 'linux').host).apps('a.md'), []);
});

test('open launches the bundle with an argument array and refuses anything else', async () => {
  const {host, runs} = fakeHost(['/Applications/Visual Studio Code.app']);
  const openWith = createOpenWith(host);
  await openWith.open('/work/src/a.ts', 'vscode');
  assert.deepEqual(runs.at(-1), ['/usr/bin/open', ['-a', '/Applications/Visual Studio Code.app', '/work/src/a.ts']]);
  await openWith.open('/work/src/a.ts', 'finder');
  assert.deepEqual(runs.at(-1), ['/usr/bin/open', ['-R', '/work/src/a.ts']]);
  await assert.rejects(openWith.open('/work/a.ts', 'terminal'), /not supported/);
  await assert.rejects(openWith.open('/work/a.ts', 'cursor'), /not installed/);
  await assert.rejects(openWith.open('/work/a.docx', 'vscode'), /cannot open/);
});

test('the files domain confines paths to the chosen folder', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-with-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'open-with-outside-')));
  t.after(() => Promise.all([rm(root, {recursive: true, force: true}), rm(outside, {recursive: true, force: true})]));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/a.md'), '# A');
  await writeFile(join(outside, 'secret.md'), 'x');
  await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
  const opened: Array<[string, string]> = [];
  const context = {folderFor: (id: string) => { if (id !== 'f') throw new Error('Folder does not exist.'); return {id, path: root}; }} as unknown as DomainContext;
  const {handlers} = createFilesDomain(context, {apps: async () => [], folderApps: async () => [], openFolder: async () => {}, open: async (path, app) => { opened.push([path, app]); }});
  await handlers['files.openWith']({folderId: 'f', path: 'docs/a.md', app: 'vscode'});
  assert.deepEqual(opened, [[join(root, 'docs/a.md'), 'vscode']]);
  await assert.rejects(async () => handlers['files.openWith']({folderId: 'f', path: '../x.md', app: 'vscode'}), /escapes/);
  await assert.rejects(async () => handlers['files.openWith']({folderId: 'f', path: 'link.md', app: 'vscode'}), /outside/);
  await assert.rejects(async () => handlers['files.openWith']({folderId: 'f', path: '', app: 'vscode'}), /Choose a file/);
  await assert.rejects(async () => handlers['files.openWith']({folderId: 'g', path: 'docs/a.md', app: 'vscode'}), /does not exist/);
  assert.equal(opened.length, 1);
});
