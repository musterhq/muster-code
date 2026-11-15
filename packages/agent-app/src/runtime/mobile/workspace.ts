/**
 * Files, Git and pull requests for the phone (#326 phase 6), through the desktop's own runtime commands: files.list and
 * files.read (folder-confined, links out of the folder refused), git.status, git.mutate, git.commit, git.branches and git.switch,
 * and github.pr.draft, github.pr.create and github.pr.requestReview. Everything is scoped to the chat's folder; the phone gets
 * folder-relative paths, never the folder's own path, the remote's address or a credential. Push and pull requests run here
 * with this computer's credentials.
 */
import type {Chat, GitLocalFile, GitLocalStatus, Snapshot, TimelineItem} from '../../shared/protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {FILE_MATCHES_MAX, FILE_PAGE_LINES, MobileError, type MobileBranch, type MobileFileChange, type MobileFileEntry, type MobileFilePage, type MobileGitStatus, type MobileMethods, type MobilePullRequestDraft} from '../../shared/mobile/protocol.ts';
import type {DomainContext} from '../domains/types.ts';
import {highlightLines, languageOf, Palette} from './highlight.ts';

type Invoke = DomainContext['invoke'];
export interface WorkspaceContext {
  invoke: Invoke;
  snapshot(): Promise<Snapshot>;
  chat: Chat;
  /** Throws unless the session is open and may act, right before a write. */
  recheck(): void;
  /** Test seam: awaited after a write's reads and before its access check. */
  beforeWrite?(): Promise<void>;
  scrub?(text: string): string;
}

const OUTSIDE = 'That path is outside this chat’s folder.';
const MISSING = 'That file is not in this chat’s folder any more.';
/** A folder-relative path from the phone: no absolute paths, no `~`, no `..` and no NUL. Links out of the folder are refused by
 *  the desktop's own files commands. */
export function relPath(value: unknown, allowEmpty = false): string {
  if (value === undefined && allowEmpty) return '';
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new MobileError('bad-request', 'Missing or invalid path.');
  const slashed = value.replace(/\\/g, '/');
  if (/^(?:\/|~|[A-Za-z]:)/.test(slashed) || slashed.split('/').some(part => part === '..')) throw new MobileError('refused', OUTSIDE);
  const path = slashed.replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '');
  if (!path && !allowEmpty) throw new MobileError('bad-request', 'Missing or invalid path.');
  return path;
}
async function folderOf(ctx: WorkspaceContext): Promise<{id: string; name: string}> {
  const folder = ctx.chat.folderId ? (await ctx.snapshot()).folders.find(entry => entry.id === ctx.chat.folderId && !entry.missing) : undefined;
  if (!folder) throw new MobileError('not-found', `This chat has no folder on ${device().your}.`);
  return {id: folder.id, name: folder.name || folder.path.split(/[\\/]/).filter(Boolean).pop() || 'Folder'};
}
/** The desktop's file errors name absolute paths; the phone gets one of these instead. */
function fileError(error: unknown): MobileError {
  const message = (error as Error)?.message ?? '';
  if (/outside|escapes|symlink|NUL/i.test(message)) return new MobileError('refused', OUTSIDE);
  if (/ENOENT|ENOTDIR|Not a file|not a directory/i.test(message)) return new MobileError('not-found', MISSING);
  return new MobileError('failed', 'That file could not be read.');
}

const changeOf = (file: GitLocalFile): MobileFileChange => file.conflict ? 'conflict' : file.untracked || file.index === 'A' ? 'added'
  : file.index === 'D' || file.worktree === 'D' ? 'deleted' : file.index === 'R' || file.previousPath ? 'renamed' : 'modified';
async function changesOf(ctx: WorkspaceContext, folderId: string): Promise<Map<string, MobileFileChange>> {
  try { return new Map((await ctx.invoke('git.status', {folderId})).files.map(file => [file.path, changeOf(file)])); } catch { return new Map(); }
}

export async function listFolder(ctx: WorkspaceContext, rawPath: unknown): Promise<MobileMethods['files.list']['result']> {
  const folder = await folderOf(ctx), path = relPath(rawPath, true);
  let entries;
  try { entries = await ctx.invoke('files.list', {folderId: folder.id, path}); } catch (error) { throw fileError(error); }
  const changes = await changesOf(ctx, folder.id);
  const out = entries.map((entry): MobileFileEntry => {
    const at = entry.path.replace(/\\/g, '/');
    if (entry.kind === 'file') { const change = changes.get(at); return {name: entry.name, path: at, kind: 'file', ...(change ? {change} : {})}; }
    let changed = 0;
    for (const key of changes.keys()) if (key.startsWith(`${at}/`)) changed++;
    return {name: entry.name, path: at, kind: 'directory', ...(changed ? {changed} : {})};
  });
  return {folder: folder.name, path, entries: out, truncated: entries.length >= 2000};
}

export async function readPage(ctx: WorkspaceContext, rawPath: unknown, rawFrom: unknown, rawQuery: unknown): Promise<MobileFilePage> {
  const folder = await folderOf(ctx), path = relPath(rawPath);
  const from = rawFrom === undefined ? 0 : typeof rawFrom === 'number' && Number.isInteger(rawFrom) && rawFrom >= 0 ? rawFrom : -1;
  if (from < 0) throw new MobileError('bad-request', 'Missing or invalid from.');
  const query = rawQuery === undefined || rawQuery === '' ? null : typeof rawQuery === 'string' && rawQuery.length <= 256 ? rawQuery.toLowerCase() : undefined;
  if (query === undefined) throw new MobileError('bad-request', 'Missing or invalid query.');
  const change = (await changesOf(ctx, folder.id)).get(path);
  const empty = {path, ...(change ? {change} : {}), palette: [], lines: [], from: 0, total: 0, next: null};
  let read;
  try { read = await ctx.invoke('files.read', {folderId: folder.id, path}); }
  catch (error) { if (/^Binary file/.test((error as Error)?.message ?? '')) return {...empty, binary: true}; throw fileError(error); }
  if (read.truncated) return {...empty, tooLarge: true};
  const all = read.text.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const start = Math.min(from, all.length), slice = all.slice(start, start + FILE_PAGE_LINES);
  const palette = new Palette();
  const lines = await highlightLines(slice, languageOf(path), palette);
  const next = start + slice.length < all.length ? start + slice.length : null;
  const page: MobileFilePage = {...empty, palette: palette.entries, lines, from: start, total: all.length, next};
  if (query) {
    const matches: number[] = [];
    for (let at = 0; at < all.length && matches.length <= FILE_MATCHES_MAX; at++) if (all[at]!.toLowerCase().includes(query)) matches.push(at);
    page.matches = matches.slice(0, FILE_MATCHES_MAX);
    if (matches.length > FILE_MATCHES_MAX) page.matchesTruncated = true;
  }
  return page;
}

// ---------------------------------------------------------------------------------------------------------------------
// Git

/** Takes credentials out of anything Git or GitHub said: user:password@ in addresses and token-shaped words. */
export const noSecrets = (text: string): string => text
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,})\b/g, '[hidden]');
const firstParagraph = (text: string) => text.trim().split(/\n\s*\n/)[0]!.trim();

async function agentMessage(ctx: WorkspaceContext): Promise<MobileGitStatus['message']> {
  let items: TimelineItem[] = [];
  try { items = (await ctx.invoke('chat.timeline', {id: ctx.chat.id})).items; } catch { /* no message */ }
  const reply = [...items].reverse().find(item => item.kind === 'assistant' && item.text?.trim());
  const subject = ctx.chat.title.trim().slice(0, 72);
  if (!subject && !reply) return null;
  const body = reply ? noSecrets((ctx.scrub ?? (text => text))(firstParagraph(reply.text))).slice(0, 2000) : '';
  return {subject: subject || firstParagraph(body).slice(0, 72), body: subject ? body : ''};
}
function mobileStatus(status: GitLocalStatus, message: MobileGitStatus['message']): MobileGitStatus {
  return {branch: status.branch, detached: status.detached, upstream: status.upstream && !status.upstreamGone ? status.upstream : null,
    ahead: status.ahead ?? 0, behind: status.behind ?? 0, conflicted: status.conflicted, truncated: status.truncated, revision: status.revision,
    files: [...status.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({path: file.path, ...(file.previousPath ? {previousPath: file.previousPath} : {}), change: changeOf(file), staged: file.staged})), message};
}
const gitError = (error: unknown) => error instanceof MobileError ? error : new MobileError('failed', noSecrets((error as Error)?.message ?? 'Git did not do that.').slice(0, 500));
async function write<T>(ctx: WorkspaceContext, run: () => Promise<T>): Promise<T> {
  await ctx.beforeWrite?.();
  ctx.recheck();
  try { return await run(); } catch (error) { throw gitError(error); }
}

export async function gitStatus(ctx: WorkspaceContext): Promise<MobileGitStatus> {
  const folder = await folderOf(ctx);
  let status;
  try { status = await ctx.invoke('git.status', {folderId: folder.id}); } catch (error) { throw gitError(error); }
  return mobileStatus(status, await agentMessage(ctx));
}

export async function gitCommit(ctx: WorkspaceContext, p: Record<string, unknown>): Promise<MobileMethods['git.commit']['result']> {
  const folder = await folderOf(ctx), folderId = folder.id;
  const paths = Array.isArray(p.paths) && p.paths.length && p.paths.length <= 100 ? p.paths.map(value => relPath(value)) : null;
  if (!paths) throw new MobileError('bad-request', 'Choose between 1 and 100 files to commit.');
  if (typeof p.message !== 'string' || !p.message.trim() || p.message.length > 32_768) throw new MobileError('bad-request', 'Write a commit message.');
  if (typeof p.revision !== 'string') throw new MobileError('bad-request', 'Refresh and try again.');
  const message = p.message;
  const before = await ctx.invoke('git.status', {folderId});
  if (before.revision !== p.revision) throw new MobileError('refused', 'The folder changed since you looked. Refresh and try again.');
  const listed = new Set(before.files.map(file => file.path));
  if (paths.some(path => !listed.has(path))) throw new MobileError('refused', 'A file you chose is no longer changed. Refresh and try again.');
  return write(ctx, async () => {
    let status = before;
    // Exactly the chosen files: others already staged on the desktop are unstaged first (their changes stay).
    const unstage = status.files.filter(file => file.staged && !paths.includes(file.path)).map(file => file.path);
    if (unstage.length) status = await ctx.invoke('git.mutate', {folderId, operation: 'unstage', revision: status.revision, paths: unstage});
    ctx.recheck();
    status = await ctx.invoke('git.mutate', {folderId, operation: 'stage', revision: status.revision, paths});
    ctx.recheck();
    const result = await ctx.invoke('git.commit', {folderId, revision: status.revision, message, push: p.push === true});
    return {status: mobileStatus(result.status, null), pushed: result.pushed, ...(result.pushError ? {pushError: noSecrets(result.pushError).slice(0, 500)} : {})};
  });
}

const running = (chat?: Chat) => chat?.status === 'running' || chat?.status === 'stopping';
export async function gitBranches(ctx: WorkspaceContext): Promise<MobileMethods['git.branches']['result']> {
  const folder = await folderOf(ctx);
  try {
    const [branches, status] = await Promise.all([ctx.invoke('git.branches', {folderId: folder.id}), ctx.invoke('git.status', {folderId: folder.id})]);
    const local = branches.local.map((branch): MobileBranch => ({name: branch.name, ...(branch.name === branches.current ? {current: true} : {}),
      ...(branch.ahead ? {ahead: branch.ahead} : {}), ...(branch.behind ? {behind: branch.behind} : {})}));
    return {current: branches.current, local, remote: (branches.remote ?? []).map(name => ({name})), uncommitted: status.files.length, running: running(ctx.chat)};
  } catch (error) { throw gitError(error); }
}

const BRANCH = /^[^\s~^:?*[\\\0-\x1f\x7f]{1,255}$/;
export async function gitSwitch(ctx: WorkspaceContext, p: Record<string, unknown>): Promise<MobileMethods['git.switch']['result']> {
  const folder = await folderOf(ctx), folderId = folder.id;
  if (typeof p.branch !== 'string' || !BRANCH.test(p.branch) || p.branch.includes('..') || p.branch.startsWith('-')) throw new MobileError('bad-request', 'That is not a branch name.');
  const branch = p.branch;
  let target: {branch: string; create?: boolean; base?: string; track?: boolean} = {branch, ...(p.create === true ? {create: true} : {})};
  if (p.remote === true) {
    const branches = await ctx.invoke('git.branches', {folderId});
    if (!(branches.remote ?? []).includes(branch)) throw new MobileError('not-found', 'That remote branch is not on this computer. Fetch on the computer first.');
    const name = branch.slice(branch.indexOf('/') + 1);
    target = branches.local.some(entry => entry.name === name) ? {branch: name} : {branch: name, create: true, base: branch, track: true};
  }
  return write(ctx, async () => {
    // As on the desktop, a running agent owns the working tree: it is stopped before the branch changes under it.
    let paused = false;
    if (running((await ctx.snapshot()).chats.find(chat => chat.id === ctx.chat.id))) {
      await ctx.invoke('chat.stop', {id: ctx.chat.id});
      paused = true;
      const end = Date.now() + 15_000;
      while (running((await ctx.snapshot()).chats.find(chat => chat.id === ctx.chat.id))) {
        if (Date.now() > end) throw new MobileError('failed', 'The agent did not stop in time, so the branch was not switched.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      ctx.recheck();
    }
    const status = await ctx.invoke('git.status', {folderId});
    const result = await ctx.invoke('git.switch', {folderId, ...target, revision: status.revision, carry: true});
    if (result.blocked) throw new MobileError('failed', 'The branch was not switched.');
    return {status: mobileStatus(result.status, null), paused};
  });
}

export async function prDraft(ctx: WorkspaceContext): Promise<MobilePullRequestDraft> {
  const folder = await folderOf(ctx);
  let draft;
  try { draft = await ctx.invoke('github.pr.draft', {folderId: folder.id}); } catch (error) { throw gitError(error); }
  return {available: draft.available, ...(draft.reason ? {reason: noSecrets(draft.reason)} : {}), head: draft.head, base: draft.base, bases: draft.bases.slice(0, 50),
    title: noSecrets(draft.title), body: noSecrets(draft.body), needsPush: draft.needsPush,
    ...(draft.existing ? {existing: {number: draft.existing.number, url: noSecrets(draft.existing.url), title: draft.existing.title}} : {})};
}

const REVIEWER = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,99}$/;
export async function prCreate(ctx: WorkspaceContext, p: Record<string, unknown>): Promise<MobileMethods['pr.create']['result']> {
  const folder = await folderOf(ctx), folderId = folder.id;
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 256) throw new MobileError('bad-request', 'Give the pull request a title.');
  if (typeof p.body !== 'string' || p.body.length > 65_536) throw new MobileError('bad-request', 'The description is too long.');
  if (typeof p.base !== 'string' || !BRANCH.test(p.base)) throw new MobileError('bad-request', 'Choose the branch to merge into.');
  const reviewers = p.reviewers === undefined ? [] : Array.isArray(p.reviewers) && p.reviewers.length <= 10 && p.reviewers.every(value => typeof value === 'string' && REVIEWER.test(value)) ? p.reviewers as string[] : null;
  if (!reviewers) throw new MobileError('bad-request', 'Invalid reviewers.');
  const [title, body, base, draft] = [p.title, p.body, p.base, p.draft === true];
  return write(ctx, async () => {
    const pr = await ctx.invoke('github.pr.create', {folderId, base, title, body, draft, push: true});
    if (reviewers.length) { ctx.recheck(); await ctx.invoke('github.pr.requestReview', {folderId, number: pr.number, reviewers}); }
    return {number: pr.number, url: noSecrets(pr.url), title: pr.title, draft: pr.draft};
  });
}
