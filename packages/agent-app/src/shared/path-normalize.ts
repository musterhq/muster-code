/**
 * One definition of "the same folder" for every place that stores or compares a path (import, folder add, folderForCwd,
 * worktrees, the review baseline, the renderer). No `node:path` import, so the renderer can use it too.
 *
 * On Windows the same directory arrives in several spellings: `\\?\E:\Dev\app` (the extended-length form Codex records and
 * `fs.realpath` can return), `e:/dev/app`, `E:\Dev\app\`. They are one folder. `normalizeFsPath` gives the stored form
 * (extended prefix stripped, one separator, upper-case drive letter, no trailing separator); `pathKey` is the comparison
 * key (also case-insensitive on win32, where the filesystem is).
 */
export type PathPlatform = 'win32' | 'posix';

export function currentPathPlatform(): PathPlatform {
  return typeof process !== 'undefined' && process.platform === 'win32' ? 'win32' : 'posix';
}

/** True for a Windows-style path (`C:\x`, `\\server\share`, `\\?\C:\x`), whatever OS this runs on. */
export function looksLikeWindowsPath(input: string): boolean {
  return /^(?:[A-Za-z]:(?:[\\/]|$)|[\\/]{2}[^\\/])/.test(input);
}

function collapseDots(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out;
}

export function normalizeFsPath(input: string, platform: PathPlatform = currentPathPlatform()): string {
  if (!input) return input;
  if (platform === 'posix') {
    const absolute = input.startsWith('/');
    const body = collapseDots(input.split('/')).join('/');
    return absolute ? '/' + body : body || '.';
  }
  let text = input.replace(/\//g, '\\');
  // \\?\UNC\server\share -> \\server\share ; \\?\E:\x and \\.\E:\x -> E:\x
  if (/^\\\\[?.]\\UNC\\/i.test(text)) text = '\\\\' + text.slice(8);
  else if (/^\\\\[?.]\\/.test(text)) text = text.slice(4);
  const drive = /^([A-Za-z]):(?:\\|$)/.exec(text);
  if (drive) {
    const rest = collapseDots(text.slice(2).split('\\')).join('\\');
    return `${drive[1]!.toUpperCase()}:\\${rest}`;
  }
  if (text.startsWith('\\\\')) {
    const parts = collapseDots(text.slice(2).split('\\'));
    return parts.length ? '\\\\' + parts.join('\\') : '\\\\';
  }
  const rooted = text.startsWith('\\');
  const body = collapseDots(text.split('\\')).join('\\');
  return rooted ? '\\' + body : body || '.';
}

/** Comparison key: the normalised path, folded to lower case on win32. */
export function pathKey(input: string, platform: PathPlatform = currentPathPlatform()): string {
  const normal = normalizeFsPath(input, platform);
  return platform === 'win32' ? normal.toLowerCase() : normal;
}

export function samePath(a: string | undefined, b: string | undefined, platform: PathPlatform = currentPathPlatform()): boolean {
  return !!a && !!b && pathKey(a, platform) === pathKey(b, platform);
}

/** True when `child` is `root` or lies inside it. */
export function isInsidePath(root: string, child: string, platform: PathPlatform = currentPathPlatform()): boolean {
  const base = pathKey(root, platform), target = pathKey(child, platform);
  if (target === base) return true;
  const separator = platform === 'win32' ? '\\' : '/';
  const prefix = base.endsWith(separator) ? base : base + separator;
  return target.startsWith(prefix);
}
