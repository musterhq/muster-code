import {fileIcon} from './components/filePresentation.ts';

/**
 * F59: lockfiles and generated output (package-lock.json +4,274) used to dominate every change pill.
 * Codex de-emphasises them; Muster counts them separately, with the same wording in every pill:
 * the headline "+a −d" covers authored files, and a muted "· 1 lockfile +4,274" follows it.
 */
const GENERATED_NAMES = new Set(['npm-shrinkwrap.json', 'go.sum', 'package.resolved', 'packages.lock.json', 'gradle.lockfile', 'deno.lock', 'bun.lock', 'pipfile.lock', 'flake.lock', 'pubspec.lock', 'mix.lock']);
const GENERATED_SUFFIX = /\.(min\.js|min\.css|map|tsbuildinfo|snap|pb\.go|g\.dart|freezed\.dart)$|_pb2\.py$|\.generated\.[a-z]+$/i;

export function isLockFile(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  return fileIcon(path).kind === 'lock' || GENERATED_NAMES.has(name) && /lock|\.sum$|resolved/.test(name);
}
export function isGeneratedFile(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  return isLockFile(path) || GENERATED_NAMES.has(name) || GENERATED_SUFFIX.test(name);
}

export interface GeneratedTotals { files: number; adds: number; dels: number; paths: string[]; lockOnly: boolean }
export interface SplitTotals { files: number; adds: number; dels: number; generated: GeneratedTotals }

/** Every file still counts in `files`; `adds`/`dels` are authored changes only. */
export function splitChangeTotals(entries: readonly {path: string; adds: number; dels: number}[]): SplitTotals {
  const generated: GeneratedTotals = {files: 0, adds: 0, dels: 0, paths: [], lockOnly: true};
  let adds = 0, dels = 0;
  for (const entry of entries) {
    if (isGeneratedFile(entry.path)) {
      generated.files++; generated.adds += entry.adds; generated.dels += entry.dels; generated.paths.push(entry.path);
      if (!isLockFile(entry.path)) generated.lockOnly = false;
    } else { adds += entry.adds; dels += entry.dels; }
  }
  if (!generated.files) generated.lockOnly = false;
  return {files: entries.length, adds, dels, generated};
}

const count = (value: number) => Math.max(0, Math.round(value)).toLocaleString('en-US');
/** The one wording every pill uses for the separated part, or undefined when there is none. */
export function generatedNote(generated: GeneratedTotals): {label: string; stats: string; title: string} | undefined {
  if (!generated.files || generated.adds + generated.dels === 0) return undefined;
  const noun = generated.lockOnly ? (generated.files === 1 ? 'lockfile' : 'lockfiles') : 'generated';
  const names = generated.paths.map(path => path.split(/[\\/]/).pop()).slice(0, 4).join(', ') + (generated.paths.length > 4 ? '…' : '');
  const stats = `+${count(generated.adds)}${generated.dels ? ` −${count(generated.dels)}` : ''}`;
  return {label: `${generated.files} ${noun}`, stats, title: `${names}: ${stats}. Lockfiles and generated files are counted separately from your code changes.`};
}
