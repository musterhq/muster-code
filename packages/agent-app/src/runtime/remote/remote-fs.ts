/**
 * #147: files in a folder on an SSH host. Each operation is a short POSIX sh script (below, in full) run as
 * `/bin/sh -c '<script>' muster '<folder>' '<arg>'…`: user text only ever arrives as a single-quoted positional argument,
 * never inside the script. Paths are checked here (relative, no `..`, no control characters) and again on the host, where
 * `cd -P`/`pwd -P` resolve links and anything that lands outside the folder is refused. Reads and writes refuse links.
 */
import { posix } from 'node:path';
import type { FileEntry } from '../../shared/protocol.ts';
import { DEFAULT_HIDDEN_NAMES, scoreQuickOpen } from '../files.ts';
import type { RemoteHub } from './hub.ts';
import type { RemoteHost } from '../../shared/domains/remote-protocol.ts';

/** Shared by every script: $1 is the folder; `at` sets D (the real parent folder), B (the name) and P for a relative path. */
const PRELUDE = `set -u
fail() { printf '%s\\n' "$2" >&2; exit "$1"; }
R=$(cd -P -- "$1" 2>/dev/null && pwd -P) || fail 70 "The folder is no longer on the host."
inside() { case "$1/" in "$R"/*) return 0;; *) return 1;; esac; }
at() { case "$1" in */*) _d=\${1%/*};; *) _d=.;; esac; B=\${1##*/}
  D=$(cd -P -- "$R/$_d" 2>/dev/null && pwd -P) || fail 72 "There is no folder $_d."
  inside "$D" || fail 71 "That path leads outside the folder."; P=$D/$B; }
dir() { D=$(cd -P -- "$R/$1" 2>/dev/null && pwd -P) || fail 72 "There is no folder $1."; inside "$D" || fail 71 "That path leads outside the folder."; }
`;
export const SCRIPTS = {
  list: `${PRELUDE}dir "$2"; cd -P -- "$D" || exit 72
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then
    if [ -d "$f" ]; then t=$(cd -P -- "$f" 2>/dev/null && pwd -P) && inside "$t" && printf 'd/%s\\0' "$f"
    elif [ -f "$f" ]; then l=$(readlink -- "$f") && case "$l" in */*) t=$(cd -P -- "\${l%/*}" 2>/dev/null && pwd -P);; *) t=$D;; esac && inside "$t" && printf 'f/%s\\0' "$f"; fi
  elif [ -d "$f" ]; then printf 'd/%s\\0' "$f"
  elif [ -f "$f" ]; then printf 'f/%s\\0' "$f"; fi
done; exit 0`,
  read: `${PRELUDE}at "$2"
[ -L "$P" ] && fail 73 "$2 is a link. Open the file it points to instead."
[ -f "$P" ] || fail 74 "Not a file: $2"
c=$(cksum < "$P") || exit 75; printf '%s\\n' "$c"; head -c "$3" < "$P"`,
  write: `${PRELUDE}at "$2"
[ -L "$P" ] && fail 73 "$2 is a link. Muster does not write through links."
[ -d "$P" ] && fail 74 "$2 is a folder."
if [ -n "$3" ]; then if [ -e "$P" ]; then cur=$(cksum < "$P"); else cur=missing; fi
  [ "$cur" = "$3" ] || { cat > /dev/null; printf 'CONFLICT\\n'; exit 0; }; fi
T="$D/.$B.muster-$$"
if [ -f "$P" ]; then cp -p -- "$P" "$T" || fail 76 "Could not save $2."; fi
cat > "$T" || { rm -f -- "$T"; fail 76 "Could not save $2."; }
mv -f -- "$T" "$P" || { rm -f -- "$T"; fail 76 "Could not save $2."; }
printf 'OK %s\\n' "$(cksum < "$P")"`,
  create: `${PRELUDE}at "$2"
{ [ -e "$P" ] || [ -L "$P" ]; } && fail 77 "$2 already exists."
if [ "$3" = directory ]; then mkdir -- "$P" || fail 76 "Could not create $2."; else (set -C; : > "$P") || fail 76 "Could not create $2."; fi`,
  move: `${PRELUDE}at "$2"; S=$P; { [ -e "$S" ] || [ -L "$S" ]; } || fail 74 "$2 no longer exists."
at "$3"; { [ -e "$P" ] || [ -L "$P" ]; } && fail 77 "$3 already exists."
mv -- "$S" "$P" || fail 76 "Could not move $2."`,
  trash: `${PRELUDE}at "$2"; { [ -e "$P" ] || [ -L "$P" ]; } || fail 74 "$2 no longer exists."
T=\${XDG_DATA_HOME:-$HOME/.local/share}/Trash; mkdir -p -- "$T/files" "$T/info" || fail 76 "There is no Trash folder on the host."
n="$B.$(date +%s)$$"
mv -- "$P" "$T/files/$n" || fail 76 "Could not move $2 to the Trash."
printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' "$P" "$(date +%Y-%m-%dT%H:%M:%S)" > "$T/info/$n.trashinfo"; exit 0`,
  walk: `${PRELUDE}dir "$2"; cd -P -- "$D" || exit 72
find . -name .git -prune -o -type f -print 2>/dev/null | head -n 20000; exit 0`,
  grep: `${PRELUDE}cd -P -- "$R" || exit 70; shift
grep -rnI "$@" 2>/dev/null | head -n 2001; exit 0`,
  resolve: `set -u; p=$1; case "$p" in "~") p=$HOME;; "~/"*) p=$HOME/\${p#"~/"};; esac
cd -P -- "$p" 2>/dev/null && pwd -P || { printf 'There is no folder %s on the host.\\n' "$1" >&2; exit 72; }`,
} as const;

const LIMIT = 512 * 1024, TABLE_LIMIT = 4 * 1024 * 1024, FULL_LIMIT = 10 * 1024 * 1024;

/** A path relative to the folder, normalized; '' for the folder itself. Anything that could leave the folder is refused here first. */
export function relPath(value: unknown, allowRoot = false): string {
  if (value === undefined && allowRoot) return '';
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Choose a file.');
  if (/[\0\n\r]/.test(value)) throw new Error('That path is not valid.');
  if (value.startsWith('/') || value.startsWith('~')) throw new Error('That path is outside the folder.');
  const n = posix.normalize(value || '.').replace(/\/+$/, '');
  if (n === '..' || n.startsWith('../')) throw new Error('That path is outside the folder.');
  if (n === '.' || n === '') { if (allowRoot) return ''; throw new Error('Choose a file.'); }
  return n;
}
const revisionOf = (cksum: string) => { const [crc, size] = cksum.trim().split(/\s+/); return `c${crc}-${size}`; };
const cksumOf = (revision: string) => { const m = /^c(\d+)-(\d+)$/.exec(revision); if (!m) throw new Error('Reload the file before saving.'); return `${m[1]} ${m[2]}`; };
const invalidUtf8 = (b: Buffer) => { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return false; } catch { return true; } };
function trimPartial(b: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, b.length); back++) { const byte = b[b.length - back]!; if ((byte & 0xc0) === 0x80) continue; const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1; return need > back ? b.subarray(0, b.length - back) : b; }
  return b;
}

export class RemoteFiles {
  constructor(private hub: RemoteHub) {}
  private async run(h: RemoteHost, script: keyof typeof SCRIPTS, argv: string[], opts: { stdin?: string; maxBytes?: number; timeoutMs?: number } = {}) {
    const r = await this.hub.exec(h, SCRIPTS[script], argv, opts);
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `The host could not do that (exit ${r.code}).`);
    return r.stdout;
  }
  async list(h: RemoteHost, root: string, relInput: unknown, showHidden: boolean): Promise<FileEntry[]> {
    const rel = relPath(relInput ?? '', true), out = (await this.run(h, 'list', [root, rel || '.'])).toString('utf8');
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const entries = out.split('\0').filter(Boolean).map(row => ({ kind: row[0] === 'd' ? 'directory' as const : 'file' as const, name: row.slice(2) }))
      .filter(e => (showHidden || !DEFAULT_HIDDEN_NAMES.has(e.name)) && !/^~\$.+\.(?:docx?|xlsx?|pptx?)$/i.test(e.name))
      .map(e => ({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: e.kind }));
    entries.sort((a, b) => a.kind === b.kind ? collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1) : a.kind === 'directory' ? -1 : 1);
    return entries.slice(0, 2000);
  }
  async read(h: RemoteHost, root: string, relInput: unknown, full = false) {
    const rel = relPath(relInput), limit = full ? FULL_LIMIT : /\.(csv|tsv)$/i.test(rel) ? TABLE_LIMIT : LIMIT;
    const out = await this.run(h, 'read', [root, rel, String(limit + 1)], { maxBytes: limit + 4096 });
    const nl = out.indexOf(10), head = out.subarray(0, nl).toString('utf8'), body = out.subarray(nl + 1);
    const size = Number(head.trim().split(/\s+/)[1] ?? 0), truncated = size > limit;
    let shown = body.subarray(0, Math.min(body.length, limit)); if (truncated) shown = trimPartial(shown);
    if (shown.subarray(0, 8192).includes(0)) throw new Error(`Binary file (no text preview): ${rel}`);
    return { path: rel, text: shown.toString('utf8'), truncated, revision: revisionOf(head), encodingWarning: invalidUtf8(shown) };
  }
  async write(h: RemoteHost, root: string, relInput: unknown, text: unknown, expected?: string): Promise<{ conflict: true } | { conflict: false; revision: string }> {
    const rel = relPath(relInput); if (typeof text !== 'string') throw new Error('Provide text to save.');
    const out = (await this.run(h, 'write', [root, rel, expected === undefined ? '' : cksumOf(expected)], { stdin: text, timeoutMs: 60_000 })).toString('utf8').trim();
    if (out === 'CONFLICT') return { conflict: true };
    if (!out.startsWith('OK ')) throw new Error(`Could not save ${rel}.`);
    return { conflict: false, revision: revisionOf(out.slice(3)) };
  }
  async create(h: RemoteHost, root: string, relInput: unknown, kind: unknown) {
    if (kind !== 'file' && kind !== 'directory') throw new Error('Invalid file type.');
    await this.run(h, 'create', [root, relPath(relInput), kind]);
  }
  async move(h: RemoteHost, root: string, from: unknown, to: unknown) { await this.run(h, 'move', [root, relPath(from), relPath(to)]); }
  async trash(h: RemoteHost, root: string, relInput: unknown) { await this.run(h, 'trash', [root, relPath(relInput)]); }
  private async walk(h: RemoteHost, root: string, rel: string): Promise<string[]> {
    const out = (await this.run(h, 'walk', [root, rel || '.'], { timeoutMs: 30_000 })).toString('utf8');
    return out.split('\n').filter(Boolean).map(p => p.replace(/^\.\//, '')).map(p => rel ? `${rel}/${p}` : p);
  }
  async search(h: RemoteHost, root: string, relInput: unknown, query: unknown) {
    if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('Enter a file name of 1–256 characters.');
    const rel = relPath(relInput ?? '', true), needle = query.trim().toLowerCase();
    const all = await this.walk(h, root, rel), hits = all.filter(p => p.toLowerCase().includes(needle)).sort();
    return { entries: hits.slice(0, 100).map(p => ({ name: posix.basename(p), path: p, kind: 'file' as const })), truncated: hits.length > 100 || all.length >= 20000 };
  }
  async quickOpen(h: RemoteHost, root: string, query: string) {
    const files = await this.walk(h, root, ''), needle = query.trim();
    if (!needle) return files.slice(0, 50).map(path => ({ path, score: 0 }));
    return files.flatMap(path => { const score = scoreQuickOpen(path, needle); return score === null ? [] : [{ path, score }]; }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 50);
  }
  async searchContent(h: RemoteHost, root: string, query: unknown, opts: { regex?: boolean; caseSensitive?: boolean; glob?: unknown }) {
    if (typeof query !== 'string' || !query || query.length > 512 || /[\0\n]/.test(query)) throw new Error('Choose a search.');
    const glob = typeof opts.glob === 'string' && opts.glob.trim() ? opts.glob.trim() : undefined;
    if (glob && (glob.length > 512 || /[\0\n]/.test(glob))) throw new Error('Choose a glob.');
    const args = [opts.regex ? '-E' : '-F', ...(opts.caseSensitive ? [] : ['-i']), '--exclude-dir=.git', ...(glob ? [`--include=${glob}`] : []), '-e', query, '--', '.'];
    const lines = (await this.run(h, 'grep', [root, ...args], { timeoutMs: 60_000 })).toString('utf8').split('\n').filter(Boolean);
    const matches = lines.slice(0, 500).flatMap(line => { const m = /^\.\/(.*?):(\d+):(.*)$/.exec(line); return m ? [{ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 500) }] : []; });
    return { matches, truncated: lines.length > 500 };
  }
  async resolveFolder(h: RemoteHost, path: unknown): Promise<string> {
    if (typeof path !== 'string' || !path.trim() || path.length > 1024 || /[\0\n\r]/.test(path)) throw new Error('Type the folder’s path on the host (for example ~/project).');
    const p = path.trim(); if (!(p === '~' || p.startsWith('~/') || p.startsWith('/'))) throw new Error('Type an absolute path or one that starts with ~/.');
    const r = await this.hub.exec(h, SCRIPTS.resolve, [p]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `There is no folder ${p} on the host.`);
    const real = r.stdout.toString('utf8').trim();
    if (!real.startsWith('/') || /[\0\n\r]/.test(real)) throw new Error('The host returned a folder path Muster cannot use.');
    return real;
  }
}
