/**
 * "Open in" for workspace files: a fixed allowlist of macOS apps, launched with
 * `open -a <bundle> <file>` (argument array, no shell). Finder reveals instead.
 * The caller resolves the file inside its folder first; this module never sees
 * renderer paths. Pure Node so the runtime service can host it.
 */
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWithKind, type OpenWithApp, type OpenWithKind} from '../shared/domains/files-protocol.ts';

interface CatalogApp {id: string; name: string; bundle: string; kinds: readonly OpenWithKind[]}
const EDITOR: readonly OpenWithKind[] = ['code', 'markdown', 'text', 'data', 'delimited', 'html'];
/** Order is preference: for a given kind, the first installed match is the default. */
export const OPEN_WITH_CATALOG: readonly CatalogApp[] = [
  {id: 'word', name: 'Microsoft Word', bundle: 'Microsoft Word', kinds: ['doc']},
  {id: 'pages', name: 'Pages', bundle: 'Pages', kinds: ['doc']},
  {id: 'excel', name: 'Microsoft Excel', bundle: 'Microsoft Excel', kinds: ['sheet', 'delimited']},
  {id: 'numbers', name: 'Numbers', bundle: 'Numbers', kinds: ['sheet', 'delimited']},
  {id: 'powerpoint', name: 'Microsoft PowerPoint', bundle: 'Microsoft PowerPoint', kinds: ['slides']},
  {id: 'keynote', name: 'Keynote', bundle: 'Keynote', kinds: ['slides']},
  {id: 'preview', name: 'Preview', bundle: 'Preview', kinds: ['pdf', 'image']},
  {id: 'cursor', name: 'Cursor', bundle: 'Cursor', kinds: EDITOR},
  {id: 'vscode', name: 'VS Code', bundle: 'Visual Studio Code', kinds: EDITOR},
  {id: 'windsurf', name: 'Windsurf', bundle: 'Windsurf', kinds: EDITOR},
  {id: 'zed', name: 'Zed', bundle: 'Zed', kinds: EDITOR},
  {id: 'sublime', name: 'Sublime Text', bundle: 'Sublime Text', kinds: EDITOR},
  {id: 'xcode', name: 'Xcode', bundle: 'Xcode', kinds: ['code', 'data']},
  {id: 'libreoffice', name: 'LibreOffice', bundle: 'LibreOffice', kinds: ['doc', 'sheet', 'slides', 'delimited']},
  {id: 'chrome', name: 'Google Chrome', bundle: 'Google Chrome', kinds: ['html', 'pdf']},
  {id: 'safari', name: 'Safari', bundle: 'Safari', kinds: ['html', 'pdf']},
  {id: 'quicktime', name: 'QuickTime Player', bundle: 'QuickTime Player', kinds: ['media']},
  {id: 'textedit', name: 'TextEdit', bundle: 'TextEdit', kinds: ['text', 'markdown', 'doc', 'html', 'code', 'data', 'delimited']},
];
const FINDER: OpenWithApp = {id: 'finder', name: 'Finder'};
/** Catalog apps that open a directory as a workspace. */
const FOLDER_APPS: readonly string[] = ['cursor', 'vscode', 'windsurf', 'zed', 'sublime', 'xcode'];
const FINDER_BUNDLE = '/System/Library/CoreServices/Finder.app';

export interface OpenWithHost {
  platform: NodeJS.Platform;
  home: string;
  /** Runs a binary with an argument array; rejects on non-zero exit. */
  run(file: string, args: string[]): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  readFile(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
  tmp: string;
}

const defaultHost = (): OpenWithHost => ({
  platform: process.platform,
  home: homedir(),
  run: (file, args) => new Promise((resolve, reject) => execFile(file, args, {timeout: 8000, maxBuffer: 256 * 1024}, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).toString().trim())) : resolve(stdout.toString()))),
  isDirectory: path => fs.stat(path).then(stat => stat.isDirectory(), () => false),
  readFile: path => fs.readFile(path),
  remove: path => fs.rm(path, {force: true}),
  tmp: tmpdir(),
});

export function createOpenWith(host: OpenWithHost = defaultHost()) {
  const roots = [join(host.home, 'Applications'), '/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', '/System/Volumes/Preboot/Cryptexes/App/System/Applications'];
  let installed: {at: number; value: Promise<Map<string, string>>} | undefined;
  const icons = new Map<string, Promise<string | undefined>>();
  /** Bundle paths of installed catalog apps, re-scanned at most once a minute. */
  const scan = () => {
    if (installed && Date.now() - installed.at < 60_000) return installed.value;
    const value = (async () => {
      const found = new Map<string, string>();
      await Promise.all(OPEN_WITH_CATALOG.map(async app => {
        for (const root of roots) {
          const bundle = join(root, `${app.bundle}.app`);
          if (await host.isDirectory(bundle)) { found.set(app.id, bundle); return; }
        }
      }));
      return found;
    })();
    installed = {at: Date.now(), value};
    return value;
  };
  /** The app's .icns converted to a 64px PNG by `sips`; asset-catalog-only apps have none. */
  const icon = (bundle: string) => {
    let pending = icons.get(bundle);
    if (!pending) {
      pending = (async () => {
        const out = join(host.tmp, `muster-app-icon-${process.pid}-${icons.size}.png`);
        try {
          let name = (await host.run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')])).trim();
          if (!name || name.includes('/')) return undefined;
          if (!name.endsWith('.icns')) name += '.icns';
          await host.run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', join(bundle, 'Contents/Resources', name), '--out', out]);
          const bytes = await host.readFile(out);
          return bytes.length > 0 && bytes.length < 96 * 1024 ? `data:image/png;base64,${bytes.toString('base64')}` : undefined;
        } catch { return undefined; }
        finally { await host.remove(out).catch(() => {}); }
      })();
      icons.set(bundle, pending);
    }
    return pending;
  };
  return {
    async apps(path: string): Promise<OpenWithApp[]> {
      if (host.platform !== 'darwin') return [];
      const kind = openWithKind(path), found = await scan();
      const matches = OPEN_WITH_CATALOG.filter(app => app.kinds.includes(kind) && found.has(app.id));
      const listed = await Promise.all(matches.map(async app => {const image = await icon(found.get(app.id)!); return image ? {id: app.id, name: app.name, icon: image} : {id: app.id, name: app.name};}));
      const finder = await icon(FINDER_BUNDLE);
      return [...listed, finder ? {...FINDER, icon: finder} : FINDER];
    },
    /** W6-D/USER-31: editors that open a whole folder (installed ones only, no icons, fast enough for a native menu), then Finder. */
    async folderApps(): Promise<OpenWithApp[]> {
      if (host.platform !== 'darwin') return [];
      const found = await scan();
      return [...OPEN_WITH_CATALOG.filter(app => FOLDER_APPS.includes(app.id) && found.has(app.id)).map(app => ({id: app.id, name: app.name})), FINDER];
    },
    /** Opens a registered folder (the caller passes its stored path) in an editor, or shows it in Finder. */
    async openFolder(absolute: string, app: string): Promise<void> {
      if (host.platform !== 'darwin') throw new Error('Open in another app is available on macOS.');
      if (!(await host.isDirectory(absolute))) throw new Error('That folder is missing.');
      if (app === FINDER.id) { await host.run('/usr/bin/open', [absolute]); return; }
      const entry = OPEN_WITH_CATALOG.find(item => item.id === app && FOLDER_APPS.includes(item.id));
      if (!entry) throw new Error('That app cannot open folders.');
      const bundle = (await scan()).get(entry.id);
      if (!bundle) throw new Error(`${entry.name} is not installed.`);
      await host.run('/usr/bin/open', ['-a', bundle, absolute]);
    },
    /** `absolute` must already be confined to the workspace folder by the caller. */
    async open(absolute: string, app: string): Promise<void> {
      if (host.platform !== 'darwin') throw new Error('Open in another app is available on macOS.');
      if (app === FINDER.id) { await host.run('/usr/bin/open', ['-R', absolute]); return; }
      const entry = OPEN_WITH_CATALOG.find(item => item.id === app);
      if (!entry) throw new Error('That app is not supported.');
      const bundle = (await scan()).get(entry.id);
      if (!bundle) throw new Error(`${entry.name} is not installed.`);
      if (!entry.kinds.includes(openWithKind(absolute))) throw new Error(`${entry.name} cannot open this kind of file.`);
      await host.run('/usr/bin/open', ['-a', bundle, absolute]);
    },
  };
}
