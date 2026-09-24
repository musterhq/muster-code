import {promises as fs} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve as resolvePath} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createOpenWith} from '../../main/open-with.ts';
import {resolveInside} from '../paths.ts';
import {cancelContentSearch, quickOpen, readFileFull, searchContent, writeFile} from '../files.ts';
import type {ExternalFileInfo, FileRunAction} from '../../shared/domains/files-protocol.ts';
import type {DomainContext, DomainModule} from './types.ts';

const text = (value: unknown, label: string, max = 4096) => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Choose ${label}.`);
  return value;
};
const optionalText = (value: unknown, label: string, max = 4096) => value === undefined ? undefined : text(value, label, max);

function runActionsPath(dataDir: string, folderId: string): string {
  // folderId already comes from context.folderFor's validated key space, but stay defensive about path characters.
  return join(dataDir, 'file-run-actions', `${folderId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

async function readRunActions(dataDir: string, folderId: string): Promise<FileRunAction[]> {
  try {
    const raw = await fs.readFile(runActionsPath(dataDir, folderId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FileRunAction => item && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.command === 'string').slice(0, 50);
  } catch { return []; }
}

async function writeRunActions(dataDir: string, folderId: string, actions: FileRunAction[]): Promise<void> {
  const path = runActionsPath(dataDir, folderId);
  await fs.mkdir(join(dataDir, 'file-run-actions'), {recursive: true});
  const cleaned = actions.slice(0, 50).map(a => ({id: text(a.id, 'an action id', 128), label: text(a.label, 'an action name', 128), command: text(a.command, 'a command', 4096)}));
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(cleaned), 'utf8');
  await fs.rename(tmp, path);
}

/** TRN-12: an absolute (or ~/) path from a transcript reference, normalized. Relative paths have no anchor outside a folder. */
export function externalPath(value: unknown, home = homedir()): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Choose a file.');
  let raw = value;
  if (raw.startsWith('file://')) { try { raw = fileURLToPath(raw); } catch { throw new Error('Choose a file.'); } }
  if (raw === '~' || raw.startsWith('~/')) raw = join(home, raw.slice(2));
  if (!isAbsolute(raw)) throw new Error('Only absolute paths can be opened outside the chat\'s folders.');
  return resolvePath(raw);
}
export async function externalInfo(value: unknown, home = homedir()): Promise<ExternalFileInfo> {
  const path = externalPath(value, home);
  const stat = await fs.stat(path).catch(() => undefined);
  const kind = stat?.isDirectory() ? 'directory' as const : stat?.isFile() ? 'file' as const : undefined;
  return {path, name: basename(path) || path, exists: !!kind, ...(kind ? {kind} : {}), folderPath: kind === 'directory' ? path : dirname(path)};
}

/** Files domain. Handlers are keyed by the command names in shared/domains/files-protocol.ts. */
export function createFilesDomain(context: DomainContext, openWith = createOpenWith()): DomainModule {
  return {handlers: {
    'files.openWith.apps': async input => ({apps: await openWith.apps(text(input.path, 'a file'))}),
    'files.openWith': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      // Symlink and `..` escapes are rejected before any app sees the path.
      await openWith.open(await resolveInside(folder.path, text(input.path, 'a file')), text(input.app, 'an app', 64));
    },
    'files.openFolderWith.apps': async () => ({apps: await openWith.folderApps()}),
    'files.openFolderWith': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      await openWith.openFolder(folder.path, text(input.app, 'an app', 64));
    },
    'files.write': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      return writeFile(folder.path, text(input.path, 'a file'), typeof input.text === 'string' ? input.text : (() => { throw new Error('Provide text to save.'); })(), optionalText(input.expectedRevision, 'a revision', 64));
    },
    'files.readFull': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      return readFileFull(folder.path, text(input.path, 'a file'));
    },
    'files.searchContent': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      return searchContent(folder.path, '', text(input.query, 'a search', 512), {
        regex: input.regex === true, caseSensitive: input.caseSensitive === true,
        glob: optionalText(input.glob, 'a glob', 512), requestId: optionalText(input.requestId, 'a request id', 128),
      });
    },
    'files.searchContent.cancel': async input => { cancelContentSearch(text(input.requestId, 'a request id', 128)); },
    'files.quickOpen': async input => {
      const folder = context.folderFor(text(input.folderId, 'a folder', 128));
      return {results: await quickOpen(folder.path, typeof input.query === 'string' ? input.query.slice(0, 256) : '')};
    },
    'files.external.inspect': input => externalInfo(input.path),
    'files.external.reveal': async input => {
      const info = await externalInfo(input.path);
      if (!info.exists) throw new Error(`${info.name} no longer exists.`);
      await openWith.open(info.path, 'finder');
    },
    'files.external.openWith': async input => {
      const info = await externalInfo(input.path), app = text(input.app, 'an app', 64);
      if (!info.exists) throw new Error(`${info.name} no longer exists.`);
      // Directories (and .app bundles) are only revealed, never launched.
      if (info.kind !== 'file' && app !== 'finder') throw new Error('Only files can be opened in another app. Reveal the folder instead.');
      await openWith.open(info.path, app);
    },
    'files.runActions.list': async input => ({actions: await readRunActions(context.dataDir, text(input.folderId, 'a folder', 128))}),
    'files.runActions.set': async input => {
      const folderId = text(input.folderId, 'a folder', 128);
      context.folderFor(folderId);
      if (!Array.isArray(input.actions)) throw new Error('Provide a list of actions.');
      await writeRunActions(context.dataDir, folderId, input.actions as FileRunAction[]);
    },
  }};
}
