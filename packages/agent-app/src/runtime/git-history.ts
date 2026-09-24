import {promises as fs} from 'node:fs';
import {resolveInside} from './paths.ts';
import {capGitBytes, gitCommitish, gitRepository, runGit} from './git-local.ts';
import {GIT_EMPTY_TREE, type GitBlame, type GitBlameCommit, type GitCommit, type GitCommitDetail, type GitCompareResult, type GitHistoryFile, type GitLogPage, type GitRefDiff} from '../shared/domains/git-protocol.ts';

/** Commit history, arbitrary ref compares and per-file blame (GIT-11). Read-only: nothing here touches the index or working tree. */

const LOG_LIMIT = 100, FILE_LIMIT = 1000, SIDE_BYTES = 512 * 1024, BLAME_LINES = 20000;
const EMPTY_TREE = GIT_EMPTY_TREE;

function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.startsWith('-')) throw new Error('Choose a file in this repository.');
  return value;
}

/** A ref the user typed (branch, tag, sha, HEAD~3, …) resolved to a commit sha; never an option. */
async function refSha(real: string, value: unknown): Promise<string> {
  return gitCommitish(real, value);
}

function parseLog(raw: string, headSha: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\0');
    if (fields.length < 8 || !fields[0]) continue;
    const [sha, short, author, email, authoredAt, subject, parents, decorations] = fields;
    const refs = decorations.split(',').map(part => part.trim()).filter(Boolean).map(part => part.replace(/^HEAD -> /, '')).filter(part => part !== 'HEAD' || sha !== headSha);
    commits.push({sha, short, author, email, authoredAt, subject: capGitBytes(subject, 512), parents: parents.split(' ').filter(Boolean), refs: [...new Set(refs)], head: sha === headSha});
  }
  return commits;
}

const LOG_FORMAT = '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x1e';

/** Paged history of `ref` (default HEAD), optionally for one path (follows renames). */
export async function listCommits(root: string, input: {ref?: unknown; skip?: unknown; limit?: unknown; path?: unknown}): Promise<GitLogPage> {
  const real = await gitRepository(root);
  const skip = typeof input.skip === 'number' && Number.isInteger(input.skip) && input.skip >= 0 && input.skip <= 1_000_000 ? input.skip : 0;
  const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, LOG_LIMIT) : LOG_LIMIT;
  const ref = input.ref === undefined || input.ref === '' ? 'HEAD' : await refSha(real, input.ref);
  const path = input.path === undefined || input.path === '' ? undefined : relativePath(input.path);
  if (path) await resolveInside(real, path);
  const head = (await runGit(real, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (!head) return {commits: [], hasMore: false, skip};
  const raw = await runGit(real, ['log', LOG_FORMAT, '--decorate=short', `--skip=${skip}`, `-n`, String(limit + 1), ...(path ? ['--follow'] : []), '--end-of-options', ref, ...(path ? ['--', path] : [])], 30000);
  const commits = parseLog(raw, head);
  return {commits: commits.slice(0, limit), hasMore: commits.length > limit, skip};
}

/** Files changed between two trees: one `--name-status` pass for renames/kinds and one `--numstat` pass for counts. */
async function changedFiles(real: string, base: string, head: string): Promise<{files: GitHistoryFile[]; truncated: boolean}> {
  const [names, stats] = await Promise.all([
    runGit(real, ['diff', '--name-status', '-M', '-z', '--no-ext-diff', '--no-color', '--end-of-options', base, head, '--'], 60000),
    runGit(real, ['diff', '--numstat', '-M', '-z', '--no-ext-diff', '--no-color', '--end-of-options', base, head, '--'], 60000),
  ]);
  const counts = new Map<string, {adds: number | null; dels: number | null}>();
  // `adds\tdels\tpath\0`; a rename is `adds\tdels\t\0old\0new\0` (keyed by the new path).
  const statFields = stats.split('\0');
  for (let index = 0; index < statFields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(statFields[index]);
    if (!match) continue;
    const count = {adds: match[1] === '-' ? null : Number(match[1]), dels: match[2] === '-' ? null : Number(match[2])};
    if (match[3]) counts.set(match[3], count);
    else { const target = statFields[index + 2]; if (target !== undefined) counts.set(target, count); index += 2; }
  }
  const fields = names.split('\0');
  const files: GitHistoryFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const status = field[0], path = fields[++index];
    if (path === undefined) break;
    const renamed = status === 'R' || status === 'C';
    const finalPath = renamed ? fields[++index] : path;
    if (finalPath === undefined) break;
    const count = counts.get(finalPath) ?? {adds: null, dels: null};
    files.push({path: finalPath, ...(renamed ? {previousPath: path} : {}), status, adds: count.adds, dels: count.dels, binary: count.adds === null && count.dels === null});
    if (files.length >= FILE_LIMIT) return {files, truncated: true};
  }
  return {files, truncated: false};
}

/** One commit: metadata, its full message body and the files it changed against its first parent. */
export async function commitDetail(root: string, value: unknown): Promise<GitCommitDetail> {
  const real = await gitRepository(root);
  const sha = await refSha(real, value);
  const head = (await runGit(real, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  const [raw, body] = await Promise.all([
    runGit(real, ['log', LOG_FORMAT, '--decorate=short', '-n', '1', '--end-of-options', sha]),
    runGit(real, ['log', '--format=%B', '-n', '1', '--end-of-options', sha]),
  ]);
  const commit = parseLog(raw, head)[0];
  if (!commit) throw new Error('That commit could not be read.');
  const base = commit.parents[0] ?? null;
  const changes = await changedFiles(real, base ?? EMPTY_TREE, sha);
  return {commit, body: capGitBytes(body.trim(), 32768), base, ...changes};
}

/** Any two refs. `ahead`/`behind` count commits on each side since the merge base (git's `A...B` counts). */
export async function compareRefs(root: string, input: {base: unknown; head: unknown}): Promise<GitCompareResult> {
  const real = await gitRepository(root);
  const baseRef = typeof input.base === 'string' ? input.base.trim() : '', headRef = typeof input.head === 'string' ? input.head.trim() : '';
  const [base, head] = await Promise.all([refSha(real, baseRef), refSha(real, headRef)]);
  const mergeBase = (await runGit(real, ['merge-base', '--end-of-options', base, head]).catch(() => '')).trim() || null;
  let ahead = 0, behind = 0;
  if (mergeBase) {
    const counts = (await runGit(real, ['rev-list', '--left-right', '--count', '--end-of-options', `${base}...${head}`]).catch(() => '0\t0')).trim().split('\t');
    behind = Number(counts[0] ?? 0); ahead = Number(counts[1] ?? 0);
  }
  const changes = await changedFiles(real, base, head);
  return {base: {ref: baseRef, sha: base}, head: {ref: headRef, sha: head}, mergeBase, ahead, behind, ...changes};
}

async function blobAt(real: string, sha: string, path: string): Promise<{text: string; truncated: boolean} | null> {
  const exists = await runGit(real, ['cat-file', '-e', `${sha}:${path}`]).then(() => true, () => false);
  if (!exists) return null;
  try {
    const text = await runGit(real, ['show', '--no-color', `${sha}:${path}`], 30000);
    return Buffer.byteLength(text) > SIDE_BYTES ? {text: capGitBytes(text, SIDE_BYTES), truncated: true} : {text, truncated: false};
  } catch (error) {
    if (/too large/i.test(error instanceof Error ? error.message : '')) return {text: '', truncated: true};
    throw error;
  }
}

/** A file at two refs, for the diff view. Renames read the old name on the base side. Binary files carry no text. */
export async function refDiff(root: string, input: {base: unknown; head: unknown; path: unknown; previousPath?: unknown}): Promise<GitRefDiff> {
  const real = await gitRepository(root);
  const path = relativePath(input.path);
  const previousPath = input.previousPath === undefined || input.previousPath === '' ? path : relativePath(input.previousPath);
  const base = input.base === EMPTY_TREE ? EMPTY_TREE : await refSha(real, input.base);
  const head = await refSha(real, input.head);
  const numstat = (await runGit(real, ['diff', '--numstat', '-M', '--no-ext-diff', '--end-of-options', base, head, '--', previousPath, path]).catch(() => '')).trim();
  const binary = /^-\t-\t/m.test(numstat);
  if (binary) return {path, before: '', after: '', truncated: false, binary: true};
  const [before, after] = await Promise.all([blobAt(real, base, previousPath), blobAt(real, head, path)]);
  return {path, before: before?.text ?? '', after: after?.text ?? '', truncated: !!(before?.truncated || after?.truncated), binary: false};
}

const UNCOMMITTED = '0000000000000000000000000000000000000000';

/** `git blame --porcelain` of the working file. Lines edited since the last commit blame to the all-zero sha (`uncommitted`). */
export async function blameFile(root: string, value: unknown): Promise<GitBlame> {
  const real = await gitRepository(root);
  const path = relativePath(value);
  const absolute = await resolveInside(real, path);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw new Error('This file is not in the working tree.');
  if (stat.size > 4 * 1024 * 1024) throw new Error('This file is too large to blame in the app.');
  const raw = await runGit(real, ['blame', '--porcelain', '--end-of-options', '--', path], 60000);
  const lines: string[] = [];
  const commits: Record<string, GitBlameCommit> = {};
  const pending = new Map<string, Partial<GitBlameCommit> & {authorTime?: string; authorTz?: string}>();
  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) {
      current = header[1];
      if (lines.length >= BLAME_LINES) break;
      lines.push(current);
      pending.set(current, pending.get(current) ?? {});
      continue;
    }
    if (!current || line.startsWith('\t')) continue;
    const info = pending.get(current)!;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space), rest = space < 0 ? '' : line.slice(space + 1);
    if (key === 'author') info.author = rest;
    else if (key === 'author-time') info.authorTime = rest;
    else if (key === 'author-tz') info.authorTz = rest;
    else if (key === 'summary') info.summary = capGitBytes(rest, 512);
  }
  for (const [sha, info] of pending) {
    const uncommitted = sha === UNCOMMITTED;
    const seconds = Number(info.authorTime ?? 0);
    commits[sha] = {sha, short: sha.slice(0, 7), author: uncommitted ? 'You' : info.author ?? '', authoredAt: seconds ? new Date(seconds * 1000).toISOString() : '', summary: uncommitted ? 'Uncommitted changes' : info.summary ?? '', uncommitted};
  }
  return {path, lines, commits, truncated: lines.length >= BLAME_LINES};
}
