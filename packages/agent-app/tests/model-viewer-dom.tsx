/** 3D model viewer: states, controls, failure paths and teardown through the real component (linkedom, fake GL renderer, in-process parser). Bundled by scripts/test-renderer.mjs. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver, ResizeObserver: class {observe() {} disconnect() {}},
  CustomEvent: window.CustomEvent, Event: window.Event, KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent, self: globalThis, ProgressEvent: class extends window.Event {}});
const styles = () => ({getPropertyValue: () => '', direction: 'ltr', position: 'static', overflow: 'visible', display: 'block', animationName: 'none', transitionProperty: 'none', transitionDuration: '0s', animationDuration: '0s'});
Object.assign(globalThis, {getComputedStyle: styles, requestAnimationFrame: (cb: any) => setTimeout(() => cb(performance.now()), 0), cancelAnimationFrame: clearTimeout});
(window as any).getComputedStyle = styles;
window.HTMLElement.prototype.getBoundingClientRect = () => ({x: 0, y: 0, width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400});

const model = await import('./fixtures/model-fixtures.ts');
const calls: Array<{command: string; input: any}> = [];
let files = new Map<string, Uint8Array>();
let failRead: string | null = null;
(window as any).muster = {subscribe: () => () => {}, async invoke(command: string, input: any) {
  calls.push({command, input});
  if (command === 'files.modelChunk' || command === 'attachments.modelChunk') {
    if (failRead) throw new Error(failRead);
    const key = command === 'files.modelChunk' ? input.path : `attachment:${input.id}`;
    const bytes = files.get(key);
    if (!bytes) throw new Error('ENOENT: no such file or directory');
    return {size: bytes.length, offset: input.offset, bytes: bytes.slice(input.offset, input.offset + input.length)};
  }
  if (command === 'files.read' || command === 'attachments.read') return {path: 'x', text: 'o Cube\nv 0 0 0\n', truncated: false};
  return undefined;
}};

const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {ModelViewer} = await import('../src/renderer/components/ModelViewer');
const {parseModel} = await import('../src/renderer/three-engine/model/parse');
const {transferablesOf} = await import('../src/renderer/three-engine/model/serialize');

const root = document.getElementById('root')!;
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
async function waitFor<T>(read: () => T | null | false | undefined, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${root.innerHTML.slice(0, 600)}`); await delay(15); }
}
const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
const state = () => q('.rich-block')?.getAttribute('data-status');

// A fake WebGL renderer and a Worker that parses in-process, so the whole pipeline runs without a GPU or threads.
const live = {renderers: 0, disposed: 0, lost: 0, renders: 0, workers: 0, terminated: 0};
const fakeRenderer = (canvas: HTMLCanvasElement) => { live.renderers++; return {domElement: canvas, setPixelRatio() {}, setSize() {}, render() { live.renders++; }, dispose() { live.disposed++; }, forceContextLoss() { live.lost++; }}; };
class FakeWorker {
  onmessage: ((e: any) => void) | null = null; onerror: ((e: any) => void) | null = null; dead = false;
  constructor() { live.workers++; }
  postMessage(message: any) {
    if (message.type !== 'parse') return;
    void parseModel({format: message.format, path: message.path, bytes: message.bytes}, async () => null).then(
      payload => { if (!this.dead) this.onmessage?.({data: {type: 'done', id: message.id, payload}}); },
      error => { if (!this.dead) this.onmessage?.({data: {type: 'error', id: message.id, message: error.message, code: error.code ?? 'corrupt'}}); });
  }
  terminate() { this.dead = true; live.terminated++; }
}
void transferablesOf;
const hooks = {engine: {createRenderer: fakeRenderer as any, theme: {background: 0x141414, model: 0x9a9a9a, accent: 0x91abc2, text: 0xe8e8e8, dark: true}}, createWorker: () => new FakeWorker() as unknown as Worker};
const mount = (props: Record<string, unknown>) => { const r = createRoot(root); r.render(<ModelViewer hooks={hooks} {...(props as any)}/>); return r; };
const file = (path: string, extra: Record<string, unknown> = {}) => ({source: {kind: 'file', folderId: 'f1', path}, ...extra});

// 1. No WebGL at all (linkedom has no canvas context): an honest error card with the exits, never a blank pane.
{
  const r = createRoot(root);
  r.render(<ModelViewer source={{kind: 'file', folderId: 'f1', path: 'models/a.glb'}}/>);
  await waitFor(() => state() === 'error', 'the no-WebGL error');
  assert.match(text(q('.resource-state-error')), /3D preview isn't available here/);
  assert.match(text(q('.resource-state-error')), /Reveal in|Copy path/);
  assert.equal(q('.resource-state-actions button')?.textContent?.includes('Try again'), false, 'retrying cannot fix missing WebGL');
  r.unmount();
}

// 2. Loading, ready, controls, info, wireframe, full screen, export affordance, teardown.
files.set('models/cube.glb', model.cubeGlb());
{
  const before = {...live};
  const r = mount(file('models/cube.glb', {variant: 'tab'}));
  await waitFor(() => state() === 'loading' || state() === 'ready', 'loading');
  await waitFor(() => state() === 'ready', 'ready');
  assert.equal(q('.rich-block')?.getAttribute('aria-label'), '3D model · GLB: cube.glb');
  assert.match(text(q('.rich-head')), /cube\.glb.*3D model · GLB/);
  assert.ok(q('canvas'), 'the canvas is mounted');
  assert.equal(q('canvas')?.getAttribute('aria-label'), '3D model: cube.glb');
  assert.ok(q('canvas')?.getAttribute('tabindex') === '0', 'keyboard reachable');
  const toolbar = q('.model-toolbar')!;
  assert.equal(toolbar.getAttribute('role'), 'toolbar');
  for (const label of ['Reset view', 'Wireframe', 'Save image of this view', 'Model info']) assert.ok(toolbar.querySelector(`[aria-label="${label}"]`), label);
  assert.deepEqual([...toolbar.querySelectorAll('.model-chip')].map(el => el.textContent), ['Front', '3/4 view', 'Top', 'Right']);
  assert.equal(q('.model-info'), null, 'info starts closed');
  (q('[aria-label="Model info"]') as HTMLElement).click();
  await waitFor(() => q('.model-info'), 'info panel');
  assert.match(text(q('.model-info')), /Vertices\s*24/); assert.match(text(q('.model-info')), /Triangles\s*12/); assert.match(text(q('.model-info')), /Size\s*1\.00 × 1\.00 × 1\.00/);
  assert.match(text(q('.model-info')), /FormatGLB · 2 KiB/);
  const wire = q('[aria-label="Wireframe"]') as HTMLElement;
  assert.equal(wire.getAttribute('aria-pressed'), 'false');
  wire.click();
  await waitFor(() => (q('[aria-label="Wireframe"]') as HTMLElement).getAttribute('aria-pressed') === 'true', 'wireframe on');
  const rendersBefore = live.renders;
  (q('.model-chip') as HTMLElement).click(); // Front
  await waitFor(() => live.renders > rendersBefore, 'a render after choosing a camera angle');
  (q('[aria-label="Full screen"]') as HTMLElement).click();
  await waitFor(() => q('.rich-block')?.getAttribute('data-fullscreen') === 'true', 'full screen');
  assert.ok(q('[aria-label="Exit full screen"]'));
  (q('[aria-label="Exit full screen"]') as HTMLElement).click();
  await waitFor(() => q('[aria-label="Full screen"]')?.getAttribute('aria-pressed') === 'false', 'exit full screen');
  assert.equal(calls.filter(c => c.command === 'files.modelChunk').length, 1, 'one chunked read for a small file');
  r.unmount();
  await waitFor(() => live.disposed === before.disposed + 1, 'engine disposal on unmount');
  assert.equal(live.lost, before.lost + 1, 'the GL context is released');
  assert.equal(live.workers, before.workers + 1); assert.equal(live.terminated, before.terminated + 1, 'the parse worker is terminated');
}

// 3. A failed read shows the plain-English card; Try again recovers.
{
  failRead = 'EACCES: permission denied';
  const r = mount(file('models/cube.glb'));
  await waitFor(() => state() === 'error', 'read error');
  assert.match(text(q('.resource-state-error')), /Couldn't open this 3D model/);
  assert.match(text(q('.resource-state-error')), /could not read this resource/);
  assert.equal(q('.rich-block > .rich-sr[role="status"]')?.textContent, 'Couldn’t render this model.', 'announced to assistive tech');
  failRead = null;
  const retry = [...root.querySelectorAll('.resource-state-actions button')].find(b => b.textContent === 'Try again') as HTMLElement;
  assert.ok(retry, 'Try again is offered');
  retry.click();
  await waitFor(() => state() === 'ready', 'recovery after Try again');
  // The announcement follows the state on the next commit; a loaded runner can see the state first.
  await waitFor(() => q('.rich-block > .rich-sr[role="status"]')?.textContent === '3D model · GLB ready: cube.glb', 'the ready announcement');
  r.unmount();
}

// 4. Corrupt, empty, unsupported and oversize files each say what is wrong.
files.set('models/cut.glb', model.cubeGlb().slice(0, 80));
files.set('models/empty.glb', new Uint8Array(0));
files.set('models/nope.glb', new TextEncoder().encode('this is not a glb'));
for (const [path, pattern] of [['models/cut.glb', /cut off|too short/], ['models/empty.glb', /empty/], ['models/nope.glb', /too short|not a GLB/], ['models/missing.glb', /no longer available/]] as const) {
  const r = mount(file(path));
  await waitFor(() => state() === 'error', `${path} error`);
  assert.match(text(q('.resource-state-error')), pattern, path);
  r.unmount();
  await delay(5);
}

// 5. Unmounting while the file is still being read leaves nothing behind (no engine, no worker, no late state update).
{
  const before = {...live};
  const slow = (window as any).muster.invoke;
  (window as any).muster.invoke = async (command: string, input: any) => { await delay(60); return slow(command, input); };
  const r = mount(file('models/cube.glb'));
  await waitFor(() => q('canvas'), 'engine created while loading');
  r.unmount();
  await delay(200);
  assert.equal(live.disposed - before.disposed, 1);
  assert.equal(live.workers, before.workers, 'the worker was never started for a read that was cancelled');
  (window as any).muster.invoke = slow;
}

// 6. A chat attachment reads through attachments.modelChunk, with no folder or companion access.
files.set('attachment:att1', model.stlBinary());
{
  calls.length = 0;
  const r = mount({source: {kind: 'attachment', chatId: 'c1', id: 'att1', name: 'part.stl'}});
  await waitFor(() => state() === 'ready', 'attachment ready');
  assert.ok(calls.every(c => c.command !== 'files.modelChunk'));
  assert.equal(calls[0]!.command, 'attachments.modelChunk');
  assert.equal(calls[0]!.input.chatId, 'c1');
  assert.match(q('.rich-head')?.textContent ?? '', /part\.stl/);
  assert.equal(root.querySelector('.model-chip[aria-pressed]'), null, 'binary STL has no source view');
  r.unmount();
}

// 7. OBJ and glTF can still be read as text.
files.set('models/cube.obj', new TextEncoder().encode(model.objCube(false)));
{
  const r = mount(file('models/cube.obj'));
  await waitFor(() => state() === 'ready', 'obj ready');
  const toggle = q('.model-chip[aria-pressed]') as HTMLElement;
  assert.ok(toggle, 'a Source toggle exists for text formats');
  toggle.click();
  await waitFor(() => q('.model-source'), 'source view');
  assert.ok(calls.some(c => c.command === 'files.read'));
  assert.equal(q('.model-stage')?.hasAttribute('hidden'), true, 'the canvas is hidden, not destroyed');
  r.unmount();
}
console.log('model-viewer-dom: ok');
process.exit(0);
