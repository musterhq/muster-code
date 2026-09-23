import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {dirname} from 'node:path';
import {resolveInside} from './paths.ts';
import {capGitBytes, gitRepository, gitStatus, runGit, serial} from './git-local.ts';
import {hasConflictMarkers} from '../shared/conflict-markers.ts';
import type {GitLocalStatus} from '../shared/protocol.ts';
import type {GitConflictEntry, GitConflictFile, GitConflictState, GitOperation} from '../shared/domains/git-protocol.ts';

/** Merge-conflict resolution without a terminal (GIT-13): detect the in-progress operation, read the three stages, write the resolution, continue or abort. */

const SIDE_BYTES = 512 * 1024;
const STATUS_TEXT: Record<string, string> = {
  UU: 'Both modified', AA: 'Both added', DD: 'Both deleted', AU: 'Added by us', UA: 'Added by them', DU: 'Deleted by us', UD: 'Deleted by them',
};
/** `--continue` would open the commit-message editor; `true` accepts git's prepared message. */
const NO_EDITOR = {GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true'};

function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.startsWith('-')) throw new Error('Choose a conflicted file.');
  return value;
}

const exists = (path: string) => fs.stat(path).then(() => true, () => false);

/** Which command is in progress, from the marker files git leaves in .git (worktree-aware via --git-path). */
async function operationIn(real: string): Promise<GitOperation | null> {
  const paths = (await runGit(real, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD'])).trimEnd().split('\n');
  const [mergeHead = '', rebaseMerge = '', rebaseApply = '', cherryPick = '', revert = ''] = paths;
  if (rebaseMerge && await exists(rebaseMerge)) return 'rebase';
  if (rebaseApply && await exists(rebaseApply)) return 'rebase';
  if (mergeHead && await exists(mergeHead)) return 'merge';
  if (cherryPick && await exists(cherryPick)) return 'cherry-pick';
  if (revert && await exists(revert)) return 'revert';
  return null;
}

async function unmergedEntries(real: string): Promise<GitConflictEntry[]> {
  const raw = await runGit(real, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const fields = raw.split('\0');
  const files: GitConflictEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field || field.startsWith('## ')) continue;
    const status = field.slice(0, 2), path = field.slice(3);
    if (/[RC]/.test(status)) index++;
    if (!(status in STATUS_TEXT)) continue;
    files.push({path, status, description: STATUS_TEXT[status], resolved: false});
  }
  return files;
}

async function shortName(real: string, ref: string): Promise<string> {
  const named = (await runGit(real, ['name-rev', '--name-only', '--no-undefined', '--refs=refs/heads/*', '--refs=refs/remotes/*', '--refs=refs/tags/*', ref]).catch(() => '')).trim();
  if (named && !named.includes('~') && !named.includes('^')) return named.replace(/^(remotes|tags)\//, '');
  return (await runGit(real, ['rev-parse', '--short', ref]).catch(() => '')).trim() || ref;
}

/** The current operation and every unmerged path. `currentLabel`/`incomingLabel` name the two sides the way git's markers do
 *  (a rebase replays the branch's commits on top of the upstream, so "current" is the upstream side there). */
export async function conflictState(root: string): Promise<GitConflictState> {
  const real = await gitRepository(root);
  const operation = await operationIn(real);
  const files = await unmergedEntries(real);
  const branch = (await runGit(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  let currentLabel = branch || 'HEAD', incomingLabel = 'incoming', incomingSubject: string | null = null;
  const subjectOf = async (ref: string) => capGitBytes((await runGit(real, ['log', '-1', '--format=%s', ref]).catch(() => '')).trim(), 200) || null;
  if (operation === 'merge') { incomingLabel = await shortName(real, 'MERGE_HEAD'); incomingSubject = await subjectOf('MERGE_HEAD'); }
  else if (operation === 'cherry-pick') { incomingLabel = await shortName(real, 'CHERRY_PICK_HEAD'); incomingSubject = await subjectOf('CHERRY_PICK_HEAD'); }
  else if (operation === 'revert') { incomingLabel = `revert of ${await shortName(real, 'REVERT_HEAD')}`; incomingSubject = await subjectOf('REVERT_HEAD'); }
  else if (operation === 'rebase') {
    const headName = (await runGit(real, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge/head-name']).catch(() => '')).trim();
    const rebasing = headName ? (await fs.readFile(headName, 'utf8').catch(() => '')).trim().replace(/^refs\/heads\//, '') : '';
    currentLabel = (await shortName(real, 'HEAD').catch(() => 'HEAD'));
    incomingLabel = rebasing ? `${rebasing} (replaying)` : await shortName(real, 'REBASE_HEAD');
    incomingSubject = await subjectOf('REBASE_HEAD');
  } else if (files.length) {
    // GIT-06: unmerged files with no operation in progress come from a branch switch that merged the
    // carried local changes (`switch -m`): the branch is "current", the uncommitted edits are "incoming".
    incomingLabel = 'your carried changes';
  }
  return {operation, currentLabel, incomingLabel, incomingSubject, files, canContinue: !!operation && files.length === 0};
}

async function stage(real: string, index: 1 | 2 | 3, path: string): Promise<string | null> {
  const present = await runGit(real, ['cat-file', '-e', `:${index}:${path}`]).then(() => true, () => false);
  if (!present) return null;
  return runGit(real, ['show', `:${index}:${path}`], 30000);
}

const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** The base/ours/theirs stages and the working file. `revision` guards the later write against an edit made elsewhere meanwhile. */
export async function conflictFile(root: string, value: unknown): Promise<GitConflictFile> {
  const real = await gitRepository(root);
  const path = relativePath(value);
  const entry = (await unmergedEntries(real)).find(file => file.path === path);
  if (!entry) throw new Error('This file has no conflict to resolve. Refresh the repository status.');
  const absolute = await resolveInside(real, path);
  const [base, ours, theirs] = await Promise.all([stage(real, 1, path), stage(real, 2, path), stage(real, 3, path)]);
  const working = await fs.readFile(absolute, 'utf8').catch(() => '');
  const truncated = [base, ours, theirs, working].some(side => side !== null && Buffer.byteLength(side) > SIDE_BYTES);
  const cap = (side: string | null) => side === null ? null : capGitBytes(side, SIDE_BYTES);
  return {path, status: entry.status, base: cap(base), ours: cap(ours), theirs: cap(theirs), working: truncated ? capGitBytes(working, SIDE_BYTES) : working, revision: revisionOf(working), truncated};
}

/** Writes the user's resolution over the working file, refusing when the file moved on since it was read; `markResolved` stages it too. */
export async function writeConflict(root: string, input: {path: unknown; content: unknown; revision: unknown; markResolved?: boolean}): Promise<GitConflictState> {
  const real = await gitRepository(root);
  const path = relativePath(input.path);
  if (typeof input.content !== 'string' || input.content.includes('\0') || Buffer.byteLength(input.content) > 8 * 1024 * 1024) throw new Error('The resolved file must be text under 8 MB.');
  if (typeof input.revision !== 'string' || !input.revision) throw new Error('Reload the conflict before saving it.');
  const content = input.content;
  return serial(real, async () => {
    const entry = (await unmergedEntries(real)).find(file => file.path === path);
    if (!entry) throw new Error('This file is no longer conflicted. Refresh the repository status.');
    const absolute = await resolveInside(real, path);
    const current = await fs.readFile(absolute, 'utf8').catch(() => '');
    if (revisionOf(current) !== input.revision) throw new Error('The file changed on disk since you opened it. Reload the conflict and resolve it again.');
    // conflictFile sent a clipped copy of a file this large: writing the resolution back would drop its tail.
    if (Buffer.byteLength(current) > SIDE_BYTES) throw new Error('This file is too large to resolve in the app. Resolve it in an editor, then mark it resolved.');
    if (input.markResolved && hasConflictMarkers(content)) throw new Error('Resolve every conflict block before marking the file resolved.');
    await fs.mkdir(dirname(absolute), {recursive: true});
    await fs.writeFile(absolute, content, 'utf8');
    if (input.markResolved) await runGit(real, ['add', '--', path]);
    return conflictState(real);
  });
}

/** `git add` of already-edited files (a resolution made in an editor). Files that still carry markers are refused. */
export async function markResolved(root: string, paths: unknown): Promise<GitConflictState> {
  const real = await gitRepository(root);
  if (!Array.isArray(paths) || !paths.length || paths.length > 500) throw new Error('Choose the resolved files.');
  const list = paths.map(relativePath);
  return serial(real, async () => {
    const unmerged = new Set((await unmergedEntries(real)).map(file => file.path));
    for (const path of list) {
      if (!unmerged.has(path)) throw new Error(`${path} is not conflicted.`);
      const absolute = await resolveInside(real, path);
      // Only a file that is really gone resolves as a removal; any other read failure (a directory, permissions) is an error.
      const text = await fs.readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw new Error(`${path} could not be read: ${error.code ?? error.message}`); });
      if (text !== null && hasConflictMarkers(text)) throw new Error(`${path} still has conflict markers.`);
      // A file deleted on disk during a delete/modify conflict resolves as a removal.
      await (text === null ? runGit(real, ['rm', '--cached', '--quiet', '--', path]) : runGit(real, ['add', '--', path]));
    }
    return conflictState(real);
  });
}

/** Continue (every conflict staged; the default message is kept, no editor) or abort the in-progress operation. */
export async function continueOperation(root: string, action: unknown): Promise<{state: GitConflictState; status: GitLocalStatus}> {
  const real = await gitRepository(root);
  if (action !== 'continue' && action !== 'abort') throw new Error('Choose Continue or Abort.');
  await serial(real, async () => {
    const operation = await operationIn(real);
    if (!operation) throw new Error('No merge, rebase, cherry-pick or revert is in progress.');
    if (action === 'continue') {
      const remaining = await unmergedEntries(real);
      if (remaining.length) throw new Error(`Resolve and mark ${remaining.length === 1 ? 'the remaining file' : `all ${remaining.length} files`} before continuing.`);
    }
    await runGit(real, [operation, `--${action}`], 120000, NO_EDITOR);
  });
  return {state: await conflictState(real), status: await gitStatus(real)};
}
