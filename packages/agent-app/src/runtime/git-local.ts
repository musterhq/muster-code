import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {resolveInside} from './paths.ts';
import type {GitLocalStatus, GitLocalFile} from '../shared/protocol.ts';

const queues = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const depth = depths.get(root) ?? 0;
  if (depth >= 8) throw new Error('Git is busy. Wait for the current operation.');
  depths.set(root, depth + 1);
  const previous = queues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(root, next);
  try { return await next; }
  finally {
    const count = (depths.get(root) ?? 1) - 1;
    if (count) depths.set(root, count); else depths.delete(root);
    if (queues.get(root) === next) queues.delete(root);
  }
}

/** Local Git only. No shell evaluation, interactive prompts or inherited Git redirection. */
function git(root: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--literal-pathspecs', '-C', root, ...args], {
      env: {...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'},
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '', size = 0, failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const timer = setTimeout(() => stop('Git timed out. Refresh status before trying again; a hook may have failed.'), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) stop('Git output is too large. Use the repository terminal for this operation.');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr.trim() || `Git exited with status ${code}.`));
      else resolve(stdout);
    });
  });
}

async function repository(root: string): Promise<string> {
  const real = await fs.realpath(root);
  const top = await git(real, ['rev-parse', '--show-toplevel']);
  if (await fs.realpath(top.trimEnd()) !== real) {
    throw new Error('Open the repository root to manage Git. This folder is inside a larger repository.');
  }
  return real;
}

async function snapshot(root: string): Promise<GitLocalStatus> {
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const cached = await git(root, ['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-ext-diff', '--']);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
  const fields = raw.split('\0');
  let branch = '', detached = false, unborn = false;
  const files: GitLocalFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith('## ')) {
      const label = field.slice(3);
      detached = label.startsWith('HEAD (');
      unborn = label.startsWith('No commits yet on ') || label.startsWith('Initial commit on ');
      branch = unborn ? label.replace(/^(No commits yet|Initial commit) on /, '') : label.split('...')[0];
      continue;
    }
    const status = field.slice(0, 2), path = field.slice(3);
    const previousPath = /[RC]/.test(status) ? fields[++index] : undefined;
    files.push({path, ...(previousPath ? {previousPath} : {}), index: status[0], worktree: status[1],
      staged: status[0] !== ' ' && status !== '??', untracked: status === '??',
      conflict: ['DD','AU','UD','UA','DU','AA','UU'].includes(status)});
  }
  const fingerprint = createHash('sha256').update(raw).update(cached).update(head);
  // Detect working-file edits even when the two-letter status stays unchanged.
  // Bounded metadata reads avoid hashing multi-gigabyte files during refresh.
  for (let start=0;start<Math.min(files.length,500);start+=16) {
    const stamps = await Promise.all(files.slice(start,Math.min(start+16,500)).map(async file=>{
      try {
        const path = await resolveInside(root,file.path), stat = await fs.lstat(path,{bigint:true});
        return `${file.path}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch(error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${file.path}\0missing`;
        // Outward symlinks remain visible but cannot be staged through this pane.
        return `${file.path}\0unavailable`;
      }
    }));
    for (const stamp of stamps) fingerprint.update(stamp);
  }
  return {branch, detached, unborn, revision: fingerprint.digest('hex'),
    files: files.slice(0, 500), truncated: files.length > 500, stagedCount: files.filter(file => file.staged).length,
    conflicted: files.some(file => file.conflict)};
}

export async function gitStatus(root: string): Promise<GitLocalStatus> {
  return serial(await repository(root), () => snapshot(root));
}

/** Mutations require the exact status revision the user acted on. Never auto-retry. */
export async function mutateGit(root: string, operation: 'stage' | 'unstage' | 'commit', revision: string, paths: unknown, message?: string): Promise<GitLocalStatus> {
  const real = await repository(root);
  return serial(real, async () => {
    const before = await snapshot(real);
    if (before.revision !== revision) throw new Error('The repository changed. Refresh and review it before retrying.');
    if (operation === 'commit') {
      if (!message?.trim() || message.length > 32768 || message.includes('\0')) throw new Error('Enter a commit message (at most 32 KB).');
      if (before.conflicted) throw new Error('Resolve conflicts before committing.');
      if (!before.stagedCount) throw new Error('Stage changes before committing.');
      if (before.truncated) throw new Error('This repository has more changes than the pane can show. Review and commit in the terminal.');
      await git(real, ['commit', '-m', message], 120000);
    } else {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw new Error('Choose between 1 and 100 changed paths.');
      const selected = new Set<string>();
      for (const value of paths) {
        if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw new Error('Invalid Git path.');
        const entry = before.files.find(file => file.path === value);
        if (!entry) throw new Error('A selected path is no longer in this change list. Refresh it.');
        await resolveInside(real, value);
        selected.add(value);
        if (entry.previousPath) { await resolveInside(real, entry.previousPath); selected.add(entry.previousPath); }
      }
      const list = [...selected];
      if (operation === 'stage') await git(real, ['add', '--', ...list]);
      else if (before.unborn) await git(real, ['rm', '--cached', '--ignore-unmatch', '--', ...list]);
      else await git(real, ['restore', '--staged', '--', ...list]);
    }
    return snapshot(real);
  });
}
