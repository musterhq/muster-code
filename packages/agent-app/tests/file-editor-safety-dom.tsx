// The in-pane file editor must never rewrite a file it did not read faithfully, and must keep text typed while a save is in flight.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput = null;
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, MutationObserver: window.MutationObserver, localStorage: {getItem: () => null, setItem() {}}, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class {observe() {} unobserve() {} disconnect() {}}, getComputedStyle: () => ({})});
window.HTMLElement.prototype.getBoundingClientRect = () => ({height: 500, width: 800, top: 0, left: 0, bottom: 500, right: 800});

let readFull: any = {path: 'a.txt', text: 'hello', truncated: false, revision: 'r1', encodingWarning: false};
const writes: any[] = [];
let releaseWrite: (() => void) | undefined;
window.muster = {
  subscribe: () => () => {},
  async invoke(command: string, input: any) {
    if (command === 'files.readFull') return readFull;
    if (command === 'files.write') { writes.push(input); await new Promise<void>(resolve => { releaseWrite = resolve; }); return {conflict: false, revision: 'r2'}; }
    return undefined;
  },
};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {FileEditor} = await import('../src/renderer/components/FileTab');
const errors: unknown[] = [];
const root = createRoot(document.getElementById('root')!, {onUncaughtError: error => errors.push(error)});
const until = async (check: () => boolean, label: string) => { for (let i = 0; i < 100 && !check(); i++) await delay(10); assert.ok(check(), label); };
const mount = async (path: string) => { root.render(<FileEditor key={path} folderId="f" path={path} tabId={path} onSaved={() => {}}/>); await delay(0); };
const area = () => document.querySelector<HTMLTextAreaElement>('textarea.file-editor-textarea');

// 1. A file with bytes that are not valid UTF-8 would be rewritten with replacement characters on save.
readFull = {path: 'latin1.txt', text: 'caf�', truncated: false, revision: 'r1', encodingWarning: true};
await mount('latin1.txt');
await until(() => !!document.querySelector('.file-editor, .resource-state-error'), 'editor settles');
assert.ok(!area(), 'a file that is not valid UTF-8 is not offered for editing');
assert.ok(!document.querySelector('.file-editor-status button'), 'no Save button for it');

// 2. A file past the full-read limit is cut short in memory; saving would truncate it on disk.
readFull = {path: 'big.txt', text: 'first 10 MB', truncated: true, revision: 'r1', encodingWarning: false};
await mount('big.txt');
await until(() => !!document.querySelector('.file-editor, .resource-state-error'), 'editor settles');
assert.ok(!area(), 'a file larger than the full-read limit is not offered for editing');

// 3. Text typed while a save is in flight survives the save.
readFull = {path: 'a.txt', text: 'hello', truncated: false, revision: 'r1', encodingWarning: false};
await mount('a.txt');
await until(() => !!area(), 'editor opens for a normal file');
const type = async (value: string) => { const el = area()!; let proto = Object.getPrototypeOf(el), descriptor; while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto); descriptor!.set!.call(el, value); el.dispatchEvent(new window.Event('input', {bubbles: true})); await delay(35); };
await type('hello world');
await until(() => !document.querySelector<HTMLButtonElement>('.file-editor-status button')!.disabled, 'dirty enables Save');
document.querySelector<HTMLButtonElement>('.file-editor-status button')!.click();
await until(() => writes.length === 1, 'save started');
assert.equal(writes[0].text, 'hello world');
await type('hello world, and more');
releaseWrite!();
await until(() => !document.querySelector('.file-editor-status')!.textContent!.includes('Saving'), 'save finished');
assert.equal(area()!.value, 'hello world, and more', 'keystrokes typed during the save are kept');
assert.match(document.querySelector('.file-editor-status')!.textContent!, /Unsaved changes/, 'and still count as unsaved');
assert.deepEqual(errors, []);
process.exit(0);
