import type {ChangedFile} from '../../shared/protocol';

export type ChangeRow = {kind: 'file'; file: ChangedFile} | {kind: 'group'; dir: string; files: ChangedFile[]};

/** Below this many untracked files under one fully-untracked directory, they stay listed individually — a
 *  small new folder is normal and worth seeing file by file. At or above it the folder collapses to one row. */
export const UNTRACKED_GROUP_THRESHOLD = 8;

/** Directory names that are never real work: an untracked file anywhere under one always collapses into
 *  a row for that directory (at whatever depth it sits — `packages/x/node_modules` included). */
export const NOISE_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', '.next', 'target', '.venv', 'coverage']);

/** The directory an untracked file groups under, or undefined when it stays its own row. */
function groupDir(file: ChangedFile): {dir: string; noise: boolean} | undefined {
  if (file.status !== 'untracked') return undefined;
  const parts = file.path.split('/');
  for (let index = 0; index < parts.length - 1; index++) {
    if (NOISE_DIRS.has(parts[index])) return {dir: parts.slice(0, index + 1).join('/'), noise: true};
  }
  // git's `?? dir/` row: only files git itself folds into a fully-untracked directory are candidates.
  // Untracked files git reports one by one (a new file next to tracked ones) are never hidden.
  const root = file.untrackedRoot?.replace(/\/+$/, '');
  return root && file.path.startsWith(root + '/') ? {dir: root, noise: false} : undefined;
}

/**
 * Collapses untracked files into one row per fully-untracked directory. This list comes from a flat
 * per-file diff (every untracked file gets its own entry with its own +/- count), so without this the
 * pane can render hundreds of rows for one accidentally-untracked node_modules.
 *
 * - Known noise directories (node_modules, dist, build, .next, target, .venv, coverage) always collapse,
 *   at any depth.
 * - Otherwise files group at git's own `?? dir/` root (`untrackedRoot`, the deepest directory that is
 *   still wholly untracked — `src/feature/`, not `src/`), once there are `threshold` of them.
 * - Untracked files git reports individually, and every tracked change, are always their own rows.
 */
export function groupChanges(files: readonly ChangedFile[], threshold = UNTRACKED_GROUP_THRESHOLD): ChangeRow[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const group = groupDir(file);
    if (group) counts.set(group.dir, (counts.get(group.dir) ?? 0) + 1);
  }
  const rows: ChangeRow[] = [];
  const groups = new Map<string, ChangeRow & {kind: 'group'}>();
  for (const file of files) {
    const target = groupDir(file);
    if (target && (target.noise || (counts.get(target.dir) ?? 0) >= threshold)) {
      let group = groups.get(target.dir);
      if (!group) { group = {kind: 'group', dir: target.dir, files: []}; groups.set(target.dir, group); rows.push(group); }
      group.files.push(file);
    } else {
      rows.push({kind: 'file', file});
    }
  }
  return rows;
}
