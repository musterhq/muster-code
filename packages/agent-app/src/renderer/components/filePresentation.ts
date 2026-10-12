import {cleanIpcError} from './resourceErrors.ts';
export type FilePresentation = 'markdown' | 'json' | 'csv' | 'tsv' | 'image' | 'text' | 'document' | 'workbook' | 'html' | 'media' | 'quicklook' | 'binary';

/** Turn host/bridge failures into actionable, non-leaky viewer copy. */
export function friendlyFileError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|cannot find the path|realpath/i.test(raw)) {
    return 'This workspace folder is no longer available. Reopen the folder, then retry this resource.';
  }
  if (/EACCES|EPERM|permission denied|not permitted/i.test(raw)) {
    return 'Muster could not read this resource with the current access. Reopen it with an allowed workspace.';
  }
  return cleanIpcError(raw) || 'The resource could not be opened.';
}

/** document-preview.ts prefixes this when no soffice binary exists; viewers fall back to Quick Look. */
export const LIBREOFFICE_MISSING = 'LibreOffice not installed';
export const isLibreOfficeMissing = (error: unknown) => (error instanceof Error ? error.message : String(error)).includes(LIBREOFFICE_MISSING);
/** files.read refuses NUL-bearing content with this prefix. */
export const isBinaryReadError = (error: unknown) => /Binary file \(no text preview\)/.test(error instanceof Error ? error.message : String(error));

const extensionOf = (path: string) => {
  const name = path.split('/').pop() ?? '';
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
};
const set = (value: string) => new Set(value.split(' '));
const IMAGE = set('png jpg jpeg gif webp svg bmp avif');
const QUICK_LOOK = set('xlsb numbers key pages heic heif tif tiff');
const DOCUMENT = set('pdf doc docx ppt pptx xls odt odp ods');
const AUDIO = set('mp3 m4a aac wav ogg oga opus flac');
const VIDEO = set('mp4 m4v mov webm ogv');
const BINARY = set('zip gz tgz bz2 xz 7z rar tar dmg iso pkg exe dll so dylib bin o a class jar war wasm pyc woff woff2 ttf otf eot sqlite sqlite3 db psd sketch fig ai eps ico icns');

/** One dispatch point; viewers share navigation, scope, refresh and failure UI. */
export function filePresentation(path: string): FilePresentation {
  const extension = extensionOf(path);
  if (extension === 'xlsx' || extension === 'xlsm') return 'workbook';
  if (DOCUMENT.has(extension)) return 'document';
  if (QUICK_LOOK.has(extension)) return 'quicklook';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown';
  if (extension === 'json' || extension === 'geojson') return 'json';
  if (extension === 'csv' || extension === 'tsv') return extension;
  if (extension === 'html' || extension === 'htm') return 'html';
  if (IMAGE.has(extension)) return 'image';
  if (AUDIO.has(extension) || VIDEO.has(extension)) return 'media';
  if (BINARY.has(extension)) return 'binary';
  return 'text';
}

export type FileIconKind = 'folder' | 'markdown' | 'json' | 'typescript' | 'javascript' | 'css' | 'html' | 'image' | 'pdf' | 'sheet' | 'doc' | 'slides' | 'archive' | 'lock' | 'audio' | 'video'
  | 'python' | 'ruby' | 'go' | 'rust' | 'jvm' | 'swift' | 'c' | 'csharp' | 'php' | 'shell' | 'sql' | 'config' | 'env' | 'docker' | 'build' | 'git' | 'license' | 'notebook' | 'code' | 'text' | 'file';
/** Visual tone per icon; resolved to existing :root tokens in file-type-icon.css. */
export type FileIconTone = 'accent' | 'ok' | 'warn' | 'danger' | 'violet' | 'orange' | 'dim';
const ICONS: Array<[FileIconKind, FileIconTone, Set<string>]> = [
  ['markdown', 'accent', set('md mdx markdown')],
  ['json', 'warn', set('json jsonc json5 geojson')],
  ['typescript', 'accent', set('ts tsx mts cts')],
  ['javascript', 'warn', set('js jsx mjs cjs')],
  ['css', 'violet', set('css scss sass less styl')],
  ['html', 'orange', set('html htm xml svelte vue astro')],
  ['image', 'violet', set('png jpg jpeg gif webp svg bmp avif heic heif tif tiff ico icns')],
  ['pdf', 'danger', set('pdf')],
  ['sheet', 'ok', set('csv tsv xls xlsx xlsm xlsb ods numbers')],
  ['doc', 'accent', set('doc docx odt rtf pages')],
  ['slides', 'orange', set('ppt pptx odp key')],
  ['archive', 'dim', set('zip gz tgz bz2 xz 7z rar tar dmg iso pkg jar war')],
  ['audio', 'violet', AUDIO],
  ['video', 'violet', VIDEO],
  ['python', 'accent', set('py pyi pyw pyx')],
  ['notebook', 'orange', set('ipynb')],
  ['ruby', 'danger', set('rb erb rake gemspec')],
  ['go', 'accent', set('go mod sum')],
  ['rust', 'orange', set('rs')],
  ['jvm', 'danger', set('java kt kts scala groovy gradle clj')],
  ['swift', 'orange', set('swift m mm')],
  ['c', 'accent', set('c h cc cpp cxx hpp hh ino')],
  ['csharp', 'violet', set('cs fs vb')],
  ['php', 'violet', set('php')],
  ['shell', 'ok', set('sh bash zsh fish ps1 bat cmd')],
  ['sql', 'warn', set('sql psql prisma')],
  ['config', 'dim', set('yaml yml toml ini cfg conf properties plist editorconfig')],
  ['env', 'warn', set('env')],
  ['code', 'dim', set('graphql gql lua dart ex exs erl hs zig tf tfvars hcl proto r jl nim ml elm vue svelte')],
  ['text', 'dim', set('txt rst log env')],
];
/** Files known by name rather than extension. */
const NAMED_FILES = new Map<string, {kind: FileIconKind; tone: FileIconTone}>([
  ...['dockerfile', 'containerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map(name => [name, {kind: 'docker', tone: 'accent'}] as const),
  ...['makefile', 'justfile', 'rakefile', 'gemfile', 'procfile', 'brewfile', 'caddyfile', 'cmakelists.txt', 'build.gradle', 'pom.xml'].map(name => [name, {kind: 'build', tone: 'dim'}] as const),
  ...['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep'].map(name => [name, {kind: 'git', tone: 'orange'}] as const),
  ...['license', 'license.md', 'license.txt', 'copying', 'notice'].map(name => [name, {kind: 'license', tone: 'dim'}] as const),
]);
const LOCK_FILES = set('package-lock.json pnpm-lock.yaml yarn.lock bun.lockb cargo.lock gemfile.lock poetry.lock composer.lock uv.lock');

/** Per-extension icon identity shared by the file tree, search results and resource tabs. */
export function fileIcon(path: string): {kind: FileIconKind; tone: FileIconTone} {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (LOCK_FILES.has(name) || name.endsWith('.lock')) return {kind: 'lock', tone: 'dim'};
  const named = NAMED_FILES.get(name) ?? (name.startsWith('dockerfile') ? NAMED_FILES.get('dockerfile') : name.startsWith('.env') ? {kind: 'env', tone: 'warn'} as const : undefined);
  if (named) return named;
  const extension = extensionOf(name);
  for (const [kind, tone, extensions] of ICONS) if (extensions.has(extension)) return {kind, tone};
  return {kind: 'file', tone: 'dim'};
}

/** Git reports numstat '-' for binary content; review.ts folds that to 0/0. Mark known binary types with no line counts. */
export function isBinaryChange(change: {path: string; adds?: number; dels?: number; binary?: boolean}): boolean {
  if (change.binary !== undefined) return change.binary;
  if (change.adds || change.dels) return false;
  const kind = filePresentation(change.path);
  return kind === 'image' && extensionOf(change.path) !== 'svg' || ['document', 'workbook', 'quicklook', 'media', 'binary'].includes(kind);
}

/** Breadcrumb collapse: keep the first directory, the parent and the filename; the rest fold into an ellipsis. */
export function breadcrumbSegments(path: string): {head: string[]; middle: string[]; tail: string[]} {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return {head: parts, middle: [], tail: []};
  return {head: parts.slice(0, 1), middle: parts.slice(1, -2), tail: parts.slice(-2)};
}

export function parseDelimited(text: string, separator: ',' | '\t'): {rows: string[][]; limited: boolean} {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false, closed = false, cells = 0;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const cell = () => { row.push(value); cells++; value = ''; closed = false; if (row.length > 100) throw new Error('Preview supports up to 100 columns. Open source to inspect this file.'); };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i+1] === '"') {value += '"'; i++;}
      else if (character === '"') {quoted = false; closed = true;}
      else value += character;
    } else if (character === separator) cell();
    else if (character === '\n' || character === '\r') {
      cell(); rows.push(row); row = [];
      if (character === '\r' && text[i+1] === '\n') i++;
      if ((rows.length >= 2000 || cells >= 20000) && i < text.length-1) return {rows, limited: true};
    } else if (character === '"' && value === '' && !closed) quoted = true;
    else {
      if (closed || character === '"') throw new Error('Malformed quoted field. Open source to inspect this file.');
      value += character;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field. Open source to inspect this file.');
  if (value || row.length || closed) {cell(); rows.push(row);}
  return {rows, limited: false};
}

/** Conservative display typing for plain-text tables. Preserve identifiers such as 0017 as text. */
export function delimitedCellType(value:string):'text'|'number'|'date'|'boolean'|'error' {
  if (/^(?:true|false)$/i.test(value)) return 'boolean';
  if (/^#[A-Z0-9/?!]+!?$/i.test(value)) return 'error';
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value))) return 'date';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) return 'number';
  return 'text';
}
