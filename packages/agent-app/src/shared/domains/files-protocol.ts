/** Files domain contract. Add commands here; the allowlist and service dispatch pick them up. */

/** What a file is, for choosing the apps that can open it. */
export type OpenWithKind = 'code' | 'markdown' | 'text' | 'data' | 'delimited' | 'html' | 'pdf' | 'image' | 'doc' | 'sheet' | 'slides' | 'media' | 'other';
/** An installed, allowlisted app. `icon` is a small PNG data URL when macOS exposes one. */
export interface OpenWithApp {id: string; name: string; icon?: string}

/** A single content-search hit: `text` is the matched line, truncated to 500 characters. */
export interface FileContentMatch { path: string; line: number; text: string }
/** A saved per-folder command (Run / Test / Dev, or a custom name) for the Processes/Terminal tab. */
export interface FileRunAction { id: string; label: string; command: string }

export interface FilesCommands {
  /** Installed apps that can open `path`, best first; Finder (reveal) is always last on macOS. */
  'files.openWith.apps': {input: {path: string}; output: {apps: OpenWithApp[]}};
  /** Opens a workspace file in one allowlisted app; `finder` reveals it instead. */
  'files.openWith': {input: {folderId: string; path: string; app: string}; output: void};
  /** W6-D/USER-31: installed editors that can open a whole folder, then Finder (macOS only). */
  'files.openFolderWith.apps': {input: Record<string, never> | undefined; output: {apps: OpenWithApp[]}};
  /** Opens a registered folder in one of those apps; `finder` shows it in Finder. */
  'files.openFolderWith': {input: {folderId: string; app: string}; output: void};
  /** Atomic write via a temp file and rename; refused (`conflict: true`) when `expectedRevision` no longer matches the file on disk. */
  'files.write': {input: {folderId: string; path: string; text: string; expectedRevision?: string}; output: {conflict: true} | {conflict: false; revision: string}};
  /** Full-file read up to 10MB, for "Load full file" on a preview truncated by the normal 512KB/4MB caps. */
  'files.readFull': {input: {folderId: string; path: string}; output: {path: string; text: string; truncated: boolean; revision: string; encodingWarning: boolean}};
  /** Bounded content search (ripgrep when present, a JS walk otherwise); cancellable by `requestId`. */
  'files.searchContent': {input: {folderId: string; query: string; regex?: boolean; caseSensitive?: boolean; glob?: string; requestId?: string}; output: {matches: FileContentMatch[]; truncated: boolean}};
  /** Cancels an in-flight `files.searchContent` call started with the same `requestId`. */
  'files.searchContent.cancel': {input: {requestId: string}; output: void};
  /** fzf-like scoring over a cached file list (excludes node_modules, .git, dist, build) for Cmd+P quick open. */
  'files.quickOpen': {input: {folderId: string; query: string}; output: {results: Array<{path: string; score: number}>}};
  /** This folder's saved Run/Test/Dev actions, in the order they were saved. */
  'files.runActions.list': {input: {folderId: string}; output: {actions: FileRunAction[]}};
  /** Replaces this folder's saved run actions. */
  'files.runActions.set': {input: {folderId: string; actions: FileRunAction[]}; output: void};
  /** TRN-12: a transcript reference outside the conversation's folders (absolute or ~/ path). Never reads content. */
  'files.external.inspect': {input: {path: string}; output: ExternalFileInfo};
  /** Shows an outside reference in Finder. */
  'files.external.reveal': {input: {path: string}; output: void};
  /** Opens an outside file in one allowlisted app (same catalog as files.openWith); never executes it. */
  'files.external.openWith': {input: {path: string; app: string}; output: void};
}
/** `folderPath` is what "Add folder" would add: the directory itself, or the file's parent. */
export interface ExternalFileInfo {path: string; name: string; exists: boolean; kind?: 'file' | 'directory'; folderPath: string}
export type FilesEvent = never;
export const FILES_COMMANDS = {'files.openWith.apps': true, 'files.openWith': true, 'files.openFolderWith.apps': true, 'files.openFolderWith': true, 'files.write': true, 'files.readFull': true, 'files.searchContent': true, 'files.searchContent.cancel': true, 'files.quickOpen': true, 'files.runActions.list': true, 'files.runActions.set': true, 'files.external.inspect': true, 'files.external.reveal': true, 'files.external.openWith': true} as const satisfies Record<keyof FilesCommands, true>;

const group = (kind: OpenWithKind, list: string) => list.split(' ').map(extension => [extension, kind] as const);
const KINDS = new Map<string, OpenWithKind>([
  ...group('markdown', 'md markdown mdx'),
  ...group('text', 'txt log text rst'),
  ...group('data', 'json jsonc yaml yml toml xml ini plist'),
  ...group('delimited', 'csv tsv'),
  ...group('html', 'html htm xhtml'),
  ...group('pdf', 'pdf'),
  ...group('image', 'png jpg jpeg gif webp heic heif tif tiff bmp svg ico'),
  ...group('doc', 'doc docx rtf odt pages'),
  ...group('sheet', 'xls xlsx xlsm xlsb ods numbers'),
  ...group('slides', 'ppt pptx odp key'),
  ...group('media', 'mp3 wav m4a aac flac ogg mp4 mov m4v webm mkv avi'),
  ...group('other', 'zip gz tgz tar dmg pkg app exe bin dylib so a o class jar wasm sqlite db'),
]);

/** Extensionless files and unknown extensions are treated as source code. */
export function openWithKind(path: string): OpenWithKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? KINDS.get(name.slice(dot + 1).toLowerCase()) ?? 'code' : 'code';
}
