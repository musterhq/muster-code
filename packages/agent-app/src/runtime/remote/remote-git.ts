/**
 * #147: the Git pane for a folder on an SSH host. Git runs on the host (`git --literal-pathspecs`, no prompts, no optional
 * locks) through the shared connection; arguments arrive single-quoted. Status keeps the local pane's revision check: a stage,
 * commit or push names the exact status it acted on, and a changed repository is refused.
 */
import { createHash } from 'node:crypto';
import type { ChangedFile, GitLocalStatus } from '../../shared/protocol.ts';
import { gitErrorMessage, githubWebUrl, parseStatus, serial } from '../git-local.ts';
import { parseNameStatus, parseNumstat } from '../review.ts';
import type { RemoteHost } from '../../shared/domains/remote-protocol.ts';
import type { RemoteHub } from './hub.ts';
import { relPath } from './remote-fs.ts';

const GIT = `set -u
cd -P -- "$1" 2>/dev/null || { printf 'The folder is no longer on the host.\\n' >&2; exit 70; }
g() { GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' git --literal-pathspecs "$@"; }
`;
const SEP = '\0MUSTER-SECTION\0';
export const GIT_SCRIPTS = {
  /** Status, staged diff, HEAD and the push remote in one round trip. */
  snapshot: `${GIT}top=$(g rev-parse --show-toplevel) || exit 80
[ "$(cd -P -- "$top" && pwd -P)" = "$(pwd -P)" ] || { printf 'Open the repository root to manage Git. This folder is inside a larger repository.\\n' >&2; exit 81; }
g status --porcelain=v1 -z --branch --untracked-files=normal || exit 80; printf '\\0MUSTER-SECTION\\0'
g diff --cached --raw --no-abbrev -z --no-ext-diff -- || exit 80; printf '\\0MUSTER-SECTION\\0'
g rev-parse --verify -q HEAD 2>/dev/null; printf '\\0MUSTER-SECTION\\0'
g remote get-url origin 2>/dev/null; exit 0`,
  /** cksum of each named file (or "missing"), so an edit that keeps the two-letter status still moves the revision. */
  stamps: `${GIT}shift; for f; do if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\t%s\\n' "$f" "$(cksum < "$f")"; else printf '%s\\tmissing\\n' "$f"; fi; done; exit 0`,
  /** `git <args>` from the folder. */
  git: `${GIT}shift; g "$@"`,
  /** HEAD's copy and the working copy of one path, for the diff. */
  diff: `${GIT}g show "HEAD:./$2" 2>/dev/null | head -c 1048577; printf '\\0MUSTER-SECTION\\0'; [ -f "$2" ] && [ ! -L "$2" ] && head -c 1048577 < "$2"; exit 0`,
} as const;

export class RemoteGit {
  constructor(private hub: RemoteHub) {}
  private async run(h: RemoteHost, script: keyof typeof GIT_SCRIPTS, root: string, argv: string[] = [], timeoutMs = 30_000) {
    const r = await this.hub.exec(h, GIT_SCRIPTS[script], [root, ...argv], { timeoutMs, maxBytes: 4 * 1024 * 1024 });
    if (r.code !== 0) throw new Error(gitErrorMessage(r.stderr, `Git exited with status ${r.code}.`));
    return r.stdout.toString('utf8');
  }
  private git(h: RemoteHost, root: string, args: string[], timeoutMs = 30_000) { return this.run(h, 'git', root, args, timeoutMs); }

  private async snapshot(h: RemoteHost, root: string): Promise<GitLocalStatus> {
    const [raw = '', cached = '', head = '', origin = ''] = (await this.run(h, 'snapshot', root)).split(SEP);
    const parsed = parseStatus(raw), fingerprint = createHash('sha256').update(raw).update(cached).update(head);
    const paths = parsed.files.slice(0, 500).map(f => f.path.replace(/\/$/, ''));
    if (paths.length) fingerprint.update(await this.run(h, 'stamps', root, paths));
    const untrackedDirs = parsed.files.filter(f => f.untracked && f.path.endsWith('/')).map(f => f.path);
    if (untrackedDirs.length) fingerprint.update(await this.git(h, root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...untrackedDirs.slice(0, 200)]).catch(() => ''));
    const remoteUrl = githubWebUrl(origin.trim());
    const { files, upstream, upstreamGone, ahead, behind } = parsed;
    return { branch: parsed.branch, detached: parsed.detached, unborn: parsed.unborn, revision: fingerprint.digest('hex'), files: files.slice(0, 500), truncated: files.length > 500,
      stagedCount: files.filter(f => f.staged).length, conflicted: files.some(f => f.conflict),
      ...(upstream ? { upstream } : {}), ...(upstreamGone ? { upstreamGone } : {}), ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), ...(remoteUrl ? { remoteUrl } : {}) };
  }
  status(h: RemoteHost, root: string) { return serial(`ssh:${h.id}:${root}`, () => this.snapshot(h, root)); }

  mutate(h: RemoteHost, root: string, operation: unknown, revision: unknown, paths: unknown, message: unknown): Promise<GitLocalStatus> {
    if (!['stage', 'unstage', 'commit'].includes(String(operation))) throw new Error('Invalid Git operation.');
    return serial(`ssh:${h.id}:${root}`, async () => {
      const before = await this.snapshot(h, root);
      if (before.revision !== revision) throw new Error('The repository changed. Refresh and review it before retrying.');
      if (operation === 'commit') {
        if (typeof message !== 'string' || !message.trim() || message.length > 32768 || message.includes('\0')) throw new Error('Enter a commit message (at most 32 KB).');
        if (before.conflicted) throw new Error('Resolve conflicts before committing.');
        if (!before.stagedCount) throw new Error('Stage changes before committing.');
        if (before.truncated) throw new Error('This repository has more changes than the pane can show. Review and commit in the terminal.');
        await this.git(h, root, ['commit', '-m', message], 120_000);
      } else {
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw new Error('Choose between 1 and 100 changed paths.');
        const selected = new Set<string>();
        for (const value of paths) {
          if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw new Error('Invalid Git path.');
          const entry = before.files.find(f => f.path === value); if (!entry) throw new Error('A selected path is no longer in this change list. Refresh it.');
          relPath(value.replace(/\/$/, '')); selected.add(value); if (entry.previousPath) { relPath(entry.previousPath); selected.add(entry.previousPath); }
        }
        const list = [...selected];
        if (operation === 'stage') await this.git(h, root, ['add', '--', ...list]);
        else if (before.unborn) await this.git(h, root, ['rm', '--cached', '--ignore-unmatch', '--', ...list]);
        else await this.git(h, root, ['restore', '--staged', '--', ...list]);
      }
      return this.snapshot(h, root);
    });
  }
  push(h: RemoteHost, root: string, revision: unknown): Promise<GitLocalStatus> {
    return serial(`ssh:${h.id}:${root}`, async () => {
      const before = await this.snapshot(h, root);
      if (before.revision !== revision) throw new Error('The repository changed. Refresh and review it before retrying.');
      if (before.detached) throw new Error('Check out a branch before pushing. HEAD is detached.');
      if (before.unborn) throw new Error('Commit before pushing. This branch has no commits yet.');
      if (before.conflicted) throw new Error('Resolve conflicts before pushing.');
      if (before.ahead && before.behind) throw new Error('This branch has diverged from its upstream. Pull or rebase before pushing.');
      const config = async (key: string) => (await this.git(h, root, ['config', '--get', key]).catch(() => '')).trim();
      const remote = await config(`branch.${before.branch}.pushRemote`) || await config('remote.pushDefault') || await config(`branch.${before.branch}.remote`)
        || ((await this.git(h, root, ['remote']).catch(() => '')).split('\n').includes('origin') ? 'origin' : '');
      if (!remote || remote === '.') throw new Error(remote === '.' ? 'This branch tracks a local branch. Push it from a terminal.' : 'Add a remote before pushing.');
      const merge = before.upstream ? await config(`branch.${before.branch}.merge`) : '';
      await this.git(h, root, ['push', ...(before.upstream ? [] : ['-u']), remote, `HEAD:${merge || `refs/heads/${before.branch}`}`], 90_000);
      return this.snapshot(h, root);
    });
  }
  async changes(h: RemoteHost, root: string): Promise<ChangedFile[]> {
    const status = await this.status(h, root);
    const base = status.unborn ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : 'HEAD';
    const [names, counts] = await Promise.all([this.git(h, root, ['diff', '--no-ext-diff', '--no-textconv', base, '-M', '-z', '--name-status', '--']), this.git(h, root, ['diff', '--no-ext-diff', '--no-textconv', base, '-M', '-z', '--numstat', '--'])]);
    const numstat = parseNumstat(Buffer.from(counts)), files: ChangedFile[] = [];
    for (const [path, { status: kind, previousPath }] of parseNameStatus(Buffer.from(names))) { const c = numstat.get(path) ?? { adds: 0, dels: 0 }; files.push({ path, ...(previousPath ? { previousPath } : {}), status: kind, adds: c.adds, dels: c.dels }); }
    for (const f of status.files) if (f.untracked) files.push({ path: f.path.replace(/\/$/, ''), status: 'added', adds: 0, dels: 0, ...(f.path.endsWith('/') ? { untrackedRoot: f.path } : {}) });
    return files;
  }
  async diff(h: RemoteHost, root: string, pathInput: unknown) {
    const path = relPath(pathInput);
    const [before = '', after = ''] = (await this.run(h, 'diff', root, [path])).split(SEP);
    const cap = 1024 * 1024, truncated = Buffer.byteLength(before) > cap || Buffer.byteLength(after) > cap;
    return { path, before: before.slice(0, cap), after: after.slice(0, cap), truncated };
  }
}
