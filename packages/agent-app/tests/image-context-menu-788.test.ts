// #788: the native image menu main builds for a right-click on any chat image, with fakes for the runtime, Menu, clipboard and dialog.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MenuItemConstructorOptions} from 'electron';
import {createImageMenu, type ImageMenuHost, type ImageRef} from '../src/main/image-menu.ts';
import {createFilesDomain} from '../src/runtime/domains/files.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

type Pick = (template: MenuItemConstructorOptions[]) => MenuItemConstructorOptions | undefined;
function fakeHost(options: {exists?: boolean; pick?: Pick; savePath?: string | null; locate?: ImageMenuHost['locate']} = {}) {
  const log: string[] = [], menus: MenuItemConstructorOptions[][] = [], images: unknown[] = [], texts: string[] = [];
  const host: ImageMenuHost = {
    locate: options.locate ?? (async () => ({path: '/work/site/shot.png', name: 'shot.png', exists: options.exists ?? true})),
    apps: async path => { log.push(`apps:${path}`); return [{id: 'preview', name: 'Preview'}, {id: 'finder', name: 'Finder'}]; },
    openWith: async (path, app) => { log.push(`openWith:${app}:${path}`); },
    popup: async (build, x, y) => {
      log.push(`popup:${x},${y}`);
      let chosen: unknown = null;
      const template = build(command => { chosen = command; });
      menus.push(template);
      const item = options.pick?.(template);
      (item?.click as (() => void) | undefined)?.();
      return chosen as never;
    },
    clipboard: {writeImage: image => { images.push(image); }, writeText: text => { texts.push(text); }},
    imageFromPath: path => ({source: `path:${path}`, isEmpty: () => false}),
    imageFromDataURL: url => ({source: `data:${url.length}`, isEmpty: () => false}),
    reveal: path => { log.push(`reveal:${path}`); },
    saveDialog: async defaultPath => { log.push(`save-dialog:${defaultPath}`); return options.savePath === undefined ? '/Users/me/Desktop/shot.png' : options.savePath; },
    copyFile: async (from, to) => { log.push(`copy:${from}->${to}`); },
    downloads: '/Users/me/Downloads',
    fileManager: 'Finder',
  };
  return {host, log, menus, images, texts};
}
const label = (template: MenuItemConstructorOptions[], text: string) => template.find(item => item.label === text);
const labels = (template: MenuItemConstructorOptions[]) => template.map(item => item.type === 'separator' ? '-' : item.label);
const ref: ImageRef = {chatId: 'c1', path: '/work/site/shot.png', folderId: 'f1', folderPath: 'shot.png'};

// Spec: MUS-SPEC-21-788E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788e)
test('The image menu lists Copy image, Copy path, Reveal, Open with, Save as and Open in Canvas', async () => {
  const {host, menus, log} = fakeHost();
  assert.equal(await createImageMenu(host).contextMenu({image: ref, x: 12, y: 34, canvas: true}), null);
  const template = menus[0]!;
  assert.deepEqual(labels(template), ['Copy Image', 'Copy Path', '-', 'Reveal in Finder', 'Open With', 'Save As…', '-', 'Open in Canvas']);
  for (const item of template) if (item.type !== 'separator') assert.notEqual(item.enabled, false, `${item.label} is enabled`);
  const openWith = label(template, 'Open With')!.submenu as MenuItemConstructorOptions[];
  assert.deepEqual(openWith.map(item => item.label), ['Preview'], 'the image apps, Finder left to Reveal');
  assert.ok(log.includes('apps:/work/site/shot.png'), 'apps are listed for the resolved file');
  assert.ok(log.includes('popup:12,34'));
  // Without a canvas to open into, the item stays but is disabled.
  const second = fakeHost();
  await createImageMenu(second.host).contextMenu({image: ref, x: 0, y: 0});
  assert.equal(label(second.menus[0]!, 'Open in Canvas')!.enabled, false);
  // Open in Canvas is the renderer's to run.
  const canvas = fakeHost({pick: template => label(template, 'Open in Canvas')});
  assert.equal(await createImageMenu(canvas.host).contextMenu({image: ref, x: 0, y: 0, canvas: true}), 'canvas');
  await assert.rejects(createImageMenu(host).contextMenu({image: {chatId: 'c1'}, x: 0, y: 0} as never), /image/i, 'a request with no path is refused');
  await assert.rejects(createImageMenu(host).contextMenu({image: ref, x: Number.NaN, y: 0}), /image/i);
});

// Spec: MUS-SPEC-21-788F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788f)
test('Copy image puts the picture on the clipboard and Copy path the absolute path', async () => {
  const image = fakeHost({pick: template => label(template, 'Copy Image')});
  assert.equal(await createImageMenu(image.host).contextMenu({image: ref, x: 0, y: 0}), null);
  assert.deepEqual(image.images.map(item => (item as {source: string}).source), ['path:/work/site/shot.png'], 'the picture itself, from the file');
  const path = fakeHost({pick: template => label(template, 'Copy Path')});
  await createImageMenu(path.host).contextMenu({image: ref, x: 0, y: 0});
  assert.deepEqual(path.texts, ['/work/site/shot.png']);
  // Cmd+C in the viewer: the same copy, without a menu.
  const direct = fakeHost();
  assert.deepEqual(await createImageMenu(direct.host).copy({image: ref}), {copied: true});
  assert.equal(direct.images.length, 1);
  assert.deepEqual(await createImageMenu(direct.host).copy({image: ref, dataUrl: 'data:image/png;base64,AAAA'}), {copied: true});
  assert.equal(direct.images.length, 2, 'loaded pixels can be copied too');
  await assert.rejects(createImageMenu(direct.host).copy({image: ref, dataUrl: 'javascript:alert(1)'}), /image/i, 'only image data URLs');
});

// Spec: MUS-SPEC-21-788G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788g)
test('A missing file disables file actions with a reason and keeps Copy image', async () => {
  const {host, menus, images, log} = fakeHost({exists: false, pick: template => label(template, 'Copy Image')});
  assert.equal(await createImageMenu(host).contextMenu({image: ref, x: 0, y: 0, canvas: true}), 'copy-pixels', 'the chat copies the picture it loaded');
  assert.equal(images.length, 0, 'nothing read from a file that is gone');
  const template = menus[0]!;
  const reason = template[0]!;
  assert.equal(reason.enabled, false);
  assert.match(String(reason.label), /no longer on disk/i);
  for (const name of ['Reveal in Finder', 'Open With', 'Save As…', 'Open in Canvas']) assert.equal(label(template, name)!.enabled, false, `${name} is disabled`);
  for (const name of ['Copy Image', 'Copy Path']) assert.notEqual(label(template, name)!.enabled, false, `${name} stays enabled`);
  assert.equal(log.some(line => line.startsWith('apps:')), false, 'no app lookup for a missing file');
  const direct = fakeHost({exists: false});
  assert.deepEqual(await createImageMenu(direct.host).copy({image: ref}), {copied: false}, 'Cmd+C asks the chat for its pixels');
});

// Spec: MUS-SPEC-21-788H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788h)
test("Reveal and Open with use the path the runtime checked, never the renderer's", async () => {
  const reveal = fakeHost({pick: template => label(template, 'Reveal in Finder')});
  await createImageMenu(reveal.host).contextMenu({image: {...ref, path: '/elsewhere/other.png'}, x: 0, y: 0});
  assert.ok(reveal.log.includes('reveal:/work/site/shot.png'), 'reveals the located file');
  const open = fakeHost({pick: template => (label(template, 'Open With')!.submenu as MenuItemConstructorOptions[])[0]});
  await createImageMenu(open.host).contextMenu({image: ref, x: 0, y: 0});
  assert.ok(open.log.includes('openWith:preview:/work/site/shot.png'));
  const refused = fakeHost({locate: async () => { throw new Error('Path escapes folder root: ../secret.png'); }});
  await assert.rejects(createImageMenu(refused.host).contextMenu({image: {folderId: 'f1', folderPath: '../secret.png'}, x: 0, y: 0}), /escapes/);
  assert.equal(refused.menus.length, 0, 'no menu for a refused path');

  // The runtime gate: folder images stay inside the folder; other paths must be named by the chat.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'img-menu-788-')));
  try {
    await mkdir(join(root, 'site'));
    await writeFile(join(root, 'site', 'shot.png'), 'png');
    const outside = join(root, 'outside.png');
    await writeFile(outside, 'png');
    const named = new Set([outside, join(root, 'gone.png')]);
    const context = {folderFor: (id: string) => { if (id !== 'f1') throw new Error('Folder does not exist.'); return {id, path: join(root, 'site')}; }, store: {chatMentionsPath: (chatId: string, path: string) => chatId === 'c1' && named.has(path)}} as unknown as DomainContext;
    const locate = createFilesDomain(context).handlers['files.image.locate']! as (input: Record<string, unknown>) => Promise<unknown>;
    assert.deepEqual(await locate({folderId: 'f1', folderPath: 'shot.png'}), {path: join(root, 'site', 'shot.png'), name: 'shot.png', exists: true});
    await assert.rejects(locate({folderId: 'f1', folderPath: '../outside.png'}), /escapes/);
    assert.deepEqual(await locate({chatId: 'c1', path: outside}), {path: outside, name: 'outside.png', exists: true});
    assert.deepEqual(await locate({chatId: 'c1', path: join(root, 'gone.png')}), {path: join(root, 'gone.png'), name: 'gone.png', exists: false});
    await assert.rejects(locate({chatId: 'c1', path: '/etc/hosts'}), /not part of this chat/);
    await assert.rejects(locate({chatId: 'c2', path: outside}), /not part of this chat/);
    // A folder image whose folder read fails falls back to the chat gate, as the preview does.
    assert.deepEqual(await locate({folderId: 'gone', folderPath: 'outside.png', chatId: 'c1', path: outside}), {path: outside, name: 'outside.png', exists: true});
  } finally { await rm(root, {recursive: true, force: true}); }
});

// Spec: MUS-SPEC-21-788I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788i)
test('Save as copies the file to the place the user picks', async () => {
  const saved = fakeHost({pick: template => label(template, 'Save As…')});
  await createImageMenu(saved.host).contextMenu({image: ref, x: 0, y: 0});
  assert.ok(saved.log.includes('save-dialog:/Users/me/Downloads/shot.png'), 'suggests the image name in Downloads');
  assert.deepEqual(saved.log.filter(line => line.startsWith('copy:')), ['copy:/work/site/shot.png->/Users/me/Desktop/shot.png']);
  const cancelled = fakeHost({pick: template => label(template, 'Save As…'), savePath: null});
  await createImageMenu(cancelled.host).contextMenu({image: ref, x: 0, y: 0});
  assert.equal(cancelled.log.some(line => line.startsWith('copy:')), false, 'a cancelled save writes nothing');
});
