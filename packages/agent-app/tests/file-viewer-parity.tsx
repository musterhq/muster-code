// Right-pane file viewer parity with Codex: single "View source" toggle, floating document copy,
// "Open ⌄" in an installed app, clickable breadcrumbs and real favicons on browser tabs.
// Never pass DOM nodes to assert.equal/deepEqual (util.inspect of linkedom graphs allocates GBs).
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
const persisted = new Map<string, string>();
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, MutationObserver: window.MutationObserver, localStorage: {getItem: (key: string) => persisted.get(key) ?? null, setItem: (key: string, value: string) => void persisted.set(key, value)}, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class {observe() {} unobserve() {} disconnect() {}}, getComputedStyle: () => ({})});
window.HTMLElement.prototype.getBoundingClientRect = () => ({height: 500, width: 800, top: 0, left: 0, bottom: 500, right: 800});
window.HTMLElement.prototype.scrollIntoView = () => {};

const listeners = new Set<(event: any) => void>();
const emit = (event: any) => { for (const listener of listeners) listener(event); };
const calls: Array<{command: string; input: any}> = [];
const guide = '# Blog Archive\n\n**Purpose:** Capability-led narratives\n\n## Editorial Position\n\n- one\n- two\n\n| Date | Engine |\n| --- | --- |\n| 05 Feb | MongoDB |';
const browserState = (owner: string, favicon?: string) => ({owner, profileId: 'personal', revision: 1, url: 'https://example.com/', title: 'Example', loading: false, canGoBack: false, canGoForward: false, visible: true, ...(favicon ? {favicon} : {})});
window.muster = {
  subscribe(listener: any) { listeners.add(listener); return () => listeners.delete(listener); },
  async invoke(command: string, input: any) {
    calls.push({command, input});
    if (command === 'files.read') return {path: input.path, text: input.path.endsWith('.md') ? guide : input.path.endsWith('.json') ? '{"compilerOptions": {"strict": true}}\n' : 'export const a = 1;\n', truncated: false};
    if (command === 'files.openWith.apps') return {apps: [{id: 'vscode', name: 'VS Code', icon: 'data:image/png;base64,iVBORw0KGgo='}, {id: 'cursor', name: 'Cursor'}, {id: 'finder', name: 'Finder'}]};
    if (command === 'files.openWith' || command === 'clipboard.write') return;
    if (command === 'files.annotations.list') return [];
    if (command === 'files.list') return [];
    if (command.startsWith('browser.')) return browserState(input.owner);
    return undefined;
  },
};

const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {Workspace} = await import('../src/renderer/components/Workspace');
const store = await import('../src/renderer/store');
const errors: unknown[] = [];
const root = createRoot(document.getElementById('root')!, {onUncaughtError: error => errors.push(error)});
root.render(<Workspace/>);
const until = async (check: () => boolean, label: string) => { for (let i = 0; i < 80 && !check(); i++) await delay(10); assert.ok(check(), label); };

// Markdown opens rendered, with document typography hooks and a floating copy button.
await store.openFile('folder', 'output/content/ARCHIVE.md');
await until(() => !!document.querySelector('.file-markdown h1'), 'markdown renders as a document');
assert.ok(document.querySelector('.file-markdown table'), 'tables render');
const copyDoc = document.querySelector<HTMLButtonElement>('.file-markdown-copy');
assert.ok(copyDoc, 'a floating copy button sits on the rendered document');
copyDoc!.click(); await delay(10);
assert.equal(calls.filter(call => call.command === 'clipboard.write').at(-1)?.input.text, guide, 'the floating copy copies the Markdown source');

// One toggle, as in Codex: "View source" while rendered, "View preview" while raw.
const toggle = () => document.querySelector<HTMLButtonElement>('.file-view-switch .file-view-toggle');
assert.equal(document.querySelectorAll('.file-view-switch button').length, 1, 'a single view toggle, not a segmented control');
assert.equal(toggle()?.getAttribute('aria-label'), 'View source');
assert.equal(toggle()?.textContent, 'View source', 'one label, as in Codex: "View source" is real text with a single space');
toggle()!.click();
await until(() => !!document.querySelector('.code-table'), 'View source shows the highlighted raw file');
assert.ok(!document.querySelector('.file-markdown'), 'the rendered document is replaced');
assert.equal(toggle()?.getAttribute('aria-label'), 'View preview');
toggle()!.click();
await until(() => !!document.querySelector('.file-markdown h1'), 'the toggle returns to the rendered document');

// No second tree squeezes the viewer (Codex model: the Files tab is the tree; files open in their own tabs).
assert.ok(!document.querySelector('.file-navigator, .file-tree-toggle'), 'the file viewer has no embedded navigator column');
// Breadcrumb folders reveal that folder in the Files tab.
const crumb = Array.from(document.querySelectorAll<HTMLButtonElement>('.file-breadcrumbs button.crumb')).find(button => button.textContent === 'content');
assert.ok(crumb, 'intermediate folders are clickable breadcrumb segments');
crumb!.click();
await until(() => store.getState().activeTabId === 'files:folder', 'a breadcrumb opens the Files tab');
const {isExpanded} = await import('../src/renderer/resourceViewState');
assert.ok(isExpanded('folder', 'output') && isExpanded('folder', 'output/content'), 'every ancestor of the clicked folder is expanded');
await store.openFile('folder', 'output/content/ARCHIVE.md');
await until(() => !!document.querySelector('.file-markdown h1'), 'returning to the file tab shows the document again');

// "Open ⌄": the primary button uses the best installed app and its real icon; the choice is remembered per file type.
await until(() => document.querySelector('.open-in-primary')?.getAttribute('aria-label') === 'Open in VS Code', 'the default app is the first installed match');
assert.equal(document.querySelector('.open-in-primary img')?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=', 'the app icon is shown on the button');
document.querySelector<HTMLButtonElement>('.open-in-primary')!.click(); await delay(10);
assert.deepEqual(calls.filter(call => call.command === 'files.openWith').at(-1)?.input, {folderId: 'folder', path: 'output/content/ARCHIVE.md', app: 'vscode'});
assert.equal(persisted.get('muster.openWith.markdown'), 'vscode');
assert.equal(calls.filter(call => call.command === 'files.openWith.apps').length, 1, 'installed apps are looked up once per file kind');
persisted.set('muster.openWith.code', 'cursor');
await store.openFile('folder', 'src/a.ts');
await until(() => document.querySelector('.open-in-primary')?.getAttribute('aria-label') === 'Open in Cursor', 'a remembered app becomes the default for that file type');
assert.ok(!document.querySelector('.file-view-switch'), 'plain source files have no rendered view to toggle');
// Config files open as highlighted source with line numbers; the JSON tree is opt-in.
await store.openFile('folder', 'tsconfig.json');
await until(() => !!document.querySelector('.code-table'), 'JSON opens as syntax-highlighted source, like Codex');
assert.ok(!document.querySelector('[aria-label="JSON structure"]'), 'the structured tree is not the default');
assert.equal(toggle()?.textContent, 'View tree', 'the tree view is one click away');
toggle()!.click();
await until(() => !!document.querySelector('[aria-label="JSON structure"]'), 'View tree shows the structure');
toggle()!.click();
await until(() => !!document.querySelector('.code-table'), 'View source returns to the highlighted file');
assert.ok(document.querySelector('.file-copy-path'), 'the copy menu stays available for source files');

// Browser tabs show the page favicon when browser state carries an inline image, and never a remote URL.
store.openBrowserTab('https://example.com/');
const browserTab = store.getState().tabs.find(tab => tab.kind === 'browser')!;
await delay(20);
emit({type: 'browserState', state: browserState(browserTab.id, 'data:image/png;base64,AAAA')});
await until(() => document.querySelector('img.workspace-tab-favicon')?.getAttribute('src') === 'data:image/png;base64,AAAA', 'the favicon replaces the globe glyph');
emit({type: 'browserState', state: browserState(browserTab.id, 'https://tracker.invalid/favicon.ico')});
await until(() => !document.querySelector('img.workspace-tab-favicon'), 'remote favicon URLs are ignored');
emit({type: 'browserState', state: browserState(browserTab.id, 'data:image/png;base64,BBBB')});
await until(() => !!document.querySelector('img.workspace-tab-favicon'), 'favicon returns');
emit({type: 'browserClosed', owner: browserTab.id});
await until(() => !document.querySelector('img.workspace-tab-favicon'), 'a closed surface drops its favicon');

assert.equal(errors.length, 0, errors.map(String).join('\n'));
root.unmount();
console.log('file-viewer-parity: ok');
process.exit(0);
