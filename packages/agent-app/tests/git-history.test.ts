import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {blameFile, commitDetail, compareRefs, listCommits, refDiff} from '../src/runtime/git-history.ts';
import {conflictFile, conflictState, continueOperation, markResolved, writeConflict} from '../src/runtime/git-conflicts.ts';
import {cancelClone, cloneProgress, defaultDestination, repositoryName, startClone, validateCloneUrl} from '../src/runtime/git-clone.ts';
import {applyConflictChoices, hasConflictMarkers, parseConflicts} from '../src/shared/conflict-markers.ts';
import {createGitDomain} from '../src/runtime/domains/git.ts';
import {GIT_COMMANDS} from '../src/shared/domains/git-protocol.ts';
import type {GitEvent} from '../src/shared/domains/git-protocol.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {Folder} from '../src/shared/protocol.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z'}}, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${String(stderr)}`)); else resolve(String(stdout));
    });
  });
}
async function temp(label: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), `muster-hist-${label}-`))); roots.push(dir); return dir; }
async function repo(): Promise<string> {
  const dir = await temp('repo');
  await run(dir, ['init', '-q', '-b', 'main']);
  await run(dir, ['config', 'user.email', 'test@example.com']);
  await run(dir, ['config', 'user.name', 'Muster Test']);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
  await run(dir, ['config', 'merge.conflictstyle', 'merge']);
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await run(dir, ['add', '--', 'a.txt']);
  await run(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}
const commit = async (dir: string, file: string, content: string, message: string) => { await writeFile(join(dir, file), content); await run(dir, ['add', '-A']); await run(dir, ['commit', '-q', '-m', message]); };

test('log pages newest first with decorations, commit detail lists files against the first parent, compare and refDiff read any two refs', async () => {
  const dir = await repo();
  await commit(dir, 'b.txt', 'b\n', 'add b');
  await run(dir, ['tag', 'v1']);
  await commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'extend a\n\nBody line.');
  await run(dir, ['mv', 'b.txt', 'c.txt']);
  await run(dir, ['commit', '-q', '-m', 'rename b']);
  await writeFile(join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 255, 0, 3]));
  await run(dir, ['add', '-A']);
  await run(dir, ['commit', '-q', '-m', 'binary']);

  const page = await listCommits(dir, {limit: 2});
  assert.equal(page.commits.length, 2); assert.equal(page.hasMore, true); assert.equal(page.skip, 0);
  assert.equal(page.commits[0].subject, 'binary'); assert.equal(page.commits[0].head, true);
  assert.deepEqual(page.commits[0].refs, ['main']);
  assert.equal(page.commits[0].author, 'Muster Test'); assert.match(page.commits[0].authoredAt, /^2026-01-02T/); assert.equal(page.commits[0].short.length >= 7, true);
  const rest = await listCommits(dir, {skip: 2, limit: 10});
  assert.deepEqual(rest.commits.map(c => c.subject), ['extend a', 'add b', 'first']); assert.equal(rest.hasMore, false);
  assert.deepEqual(rest.commits[1].refs, ['tag: v1']);
  assert.equal(rest.commits[2].parents.length, 0);
  const forPath = await listCommits(dir, {path: 'c.txt'});
  assert.deepEqual(forPath.commits.map(c => c.subject), ['rename b', 'add b'], 'a path filter follows renames');
  await assert.rejects(listCommits(dir, {ref: '--output=/tmp/x'}), /valid base branch or commit|No branch or commit/);
  await assert.rejects(listCommits(dir, {path: '../etc/passwd'}), /escapes|Choose a file/i);

  const extend = rest.commits[0];
  const detail = await commitDetail(dir, extend.sha);
  assert.equal(detail.commit.subject, 'extend a'); assert.equal(detail.body, 'extend a\n\nBody line.'); assert.equal(detail.base, rest.commits[1].sha);
  assert.deepEqual(detail.files, [{path: 'a.txt', status: 'M', adds: 1, dels: 0, binary: false}]);
  const root = await commitDetail(dir, rest.commits[2].sha);
  assert.equal(root.base, null); assert.deepEqual(root.files.map(f => [f.path, f.status, f.adds]), [['a.txt', 'A', 3]], 'a root commit diffs against the empty tree');
  const renamed = await commitDetail(dir, page.commits[1].sha);
  assert.deepEqual(renamed.files, [{path: 'c.txt', previousPath: 'b.txt', status: 'R', adds: 0, dels: 0, binary: false}]);
  const binary = await commitDetail(dir, page.commits[0].sha);
  assert.deepEqual(binary.files, [{path: 'pic.bin', status: 'A', adds: null, dels: null, binary: true}]);

  await run(dir, ['switch', '-q', '-c', 'topic', 'v1']);
  await commit(dir, 't.txt', 't\n', 'topic work');
  const compare = await compareRefs(dir, {base: 'main', head: 'topic'});
  assert.equal(compare.base.ref, 'main'); assert.equal(compare.head.sha, (await run(dir, ['rev-parse', 'topic'])).trim());
  assert.equal(compare.mergeBase, rest.commits[1].sha); assert.equal(compare.ahead, 1); assert.equal(compare.behind, 3);
  assert.deepEqual(compare.files.map(f => `${f.status} ${f.previousPath ? f.previousPath + '→' : ''}${f.path}`).sort(), ['A t.txt', 'D pic.bin', 'M a.txt', 'R c.txt→b.txt']);
  await assert.rejects(compareRefs(dir, {base: 'main', head: 'nope'}), /No branch or commit named/);

  const diff = await refDiff(dir, {base: 'main', head: 'topic', path: 'a.txt'});
  assert.equal(diff.before, 'one\ntwo\nthree\nfour\n'); assert.equal(diff.after, 'one\ntwo\nthree\n'); assert.equal(diff.binary, false);
  const added = await refDiff(dir, {base: 'main', head: 'topic', path: 't.txt'});
  assert.equal(added.before, ''); assert.equal(added.after, 't\n');
  const rename = await refDiff(dir, {base: renamed.base!, head: page.commits[1].sha, path: 'c.txt', previousPath: 'b.txt'});
  assert.equal(rename.before, 'b\n'); assert.equal(rename.after, 'b\n', 'a rename reads the old name on the base side');
  const bin = await refDiff(dir, {base: 'v1', head: 'main', path: 'pic.bin'});
  assert.equal(bin.binary, true); assert.equal(bin.after, '');
});

test('blame maps every working line to a commit and marks uncommitted edits', async () => {
  const dir = await repo();
  await commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'extend a');
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  const blame = await blameFile(dir, 'a.txt');
  assert.equal(blame.lines.length, 5);
  const first = blame.commits[blame.lines[0]], fourth = blame.commits[blame.lines[3]], fifth = blame.commits[blame.lines[4]];
  assert.equal(first.summary, 'first'); assert.equal(fourth.summary, 'extend a'); assert.equal(first.author, 'Muster Test'); assert.match(first.authoredAt, /^2026-01-02/);
  assert.equal(blame.lines[0], blame.lines[2], 'unchanged lines share the first commit');
  assert.equal(fifth.uncommitted, true); assert.equal(fifth.author, 'You'); assert.equal(fifth.short, '0000000');
  await assert.rejects(blameFile(dir, 'missing.txt'), /not in the working tree/);
  await assert.rejects(blameFile(dir, '../a.txt'), /escapes|Choose a file/i);
});

test('conflict markers parse (merge and diff3 styles) and rebuild with per-block choices', () => {
  const merge = 'a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nz\n';
  const parsed = parseConflicts(merge);
  assert.equal(parsed.conflicts, 1); assert.equal(parsed.blocks.length, 3);
  const block = parsed.blocks[1];
  assert.equal(block.kind, 'conflict');
  if (block.kind !== 'conflict') return;
  assert.deepEqual(block.current, ['ours']); assert.deepEqual(block.incoming, ['theirs']); assert.equal(block.base, null); assert.equal(block.currentLabel, 'HEAD'); assert.equal(block.incomingLabel, 'topic');
  assert.equal(applyConflictChoices(parsed, new Map([[block.id, 'current']])), 'a\nours\nz\n');
  assert.equal(applyConflictChoices(parsed, new Map([[block.id, 'incoming']])), 'a\ntheirs\nz\n');
  assert.equal(applyConflictChoices(parsed, new Map([[block.id, 'both']])), 'a\nours\ntheirs\nz\n');
  assert.equal(applyConflictChoices(parsed, new Map([[block.id, {edit: 'merged\nby hand'}]])), 'a\nmerged\nby hand\nz\n');
  assert.equal(applyConflictChoices(parsed, new Map()), merge, 'unchosen blocks keep their markers verbatim');
  const diff3 = '<<<<<<< HEAD\nours\n||||||| base\norig\n=======\ntheirs\n>>>>>>> topic\n';
  const three = parseConflicts(diff3).blocks[0];
  assert.equal(three.kind === 'conflict' && three.base?.join() , 'orig');
  assert.equal(hasConflictMarkers('<<<<<<< HEAD\nno end\n'), false, 'an unterminated marker is plain text');
  assert.equal(parseConflicts('no newline at end').trailingNewline, false);
  assert.equal(applyConflictChoices(parseConflicts('x\r\n<<<<<<< a\n1\r\n=======\r\n2\r\n>>>>>>> b\r\n'), new Map([['c0', 'both']])), 'x\r\n1\r\n2\r\n');
});

test('merge conflict: detect, read stages, write a resolution, mark resolved and continue; abort restores the branch', async () => {
  const dir = await repo();
  await run(dir, ['switch', '-q', '-c', 'topic']);
  await commit(dir, 'a.txt', 'one\nTOPIC\nthree\n', 'topic change');
  await run(dir, ['switch', '-q', 'main']);
  await commit(dir, 'a.txt', 'one\nMAIN\nthree\n', 'main change');
  assert.equal((await conflictState(dir)).operation, null);
  await run(dir, ['merge', 'topic']).catch(() => undefined);

  const state = await conflictState(dir);
  assert.equal(state.operation, 'merge'); assert.equal(state.currentLabel, 'main'); assert.equal(state.incomingLabel, 'topic'); assert.equal(state.incomingSubject, 'topic change');
  assert.deepEqual(state.files, [{path: 'a.txt', status: 'UU', description: 'Both modified', resolved: false}]); assert.equal(state.canContinue, false);
  await assert.rejects(continueOperation(dir, 'continue'), /Resolve and mark/);

  const file = await conflictFile(dir, 'a.txt');
  assert.equal(file.base, 'one\ntwo\nthree\n'); assert.equal(file.ours, 'one\nMAIN\nthree\n'); assert.equal(file.theirs, 'one\nTOPIC\nthree\n');
  assert.match(file.working, /<<<<<<< HEAD\nMAIN\n=======\nTOPIC\n>>>>>>> topic/);
  await assert.rejects(conflictFile(dir, 'nope.txt'), /no conflict to resolve/);

  const parsed = parseConflicts(file.working);
  const resolved = applyConflictChoices(parsed, new Map([[parsed.blocks.find(b => b.kind === 'conflict')!.id, 'both']]));
  await assert.rejects(writeConflict(dir, {path: 'a.txt', content: file.working, revision: file.revision, markResolved: true}), /Resolve every conflict block/);
  await assert.rejects(writeConflict(dir, {path: 'a.txt', content: resolved, revision: 'stale'}), /changed on disk/);
  let next = await writeConflict(dir, {path: 'a.txt', content: resolved, revision: file.revision});
  assert.equal(next.files.length, 1, 'a plain save keeps the file unmerged');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\nMAIN\nTOPIC\nthree\n');
  next = await markResolved(dir, ['a.txt']);
  assert.deepEqual(next.files, []); assert.equal(next.canContinue, true); assert.equal(next.operation, 'merge');
  const done = await continueOperation(dir, 'continue');
  assert.equal(done.state.operation, null); assert.equal(done.status.conflicted, false); assert.equal(done.status.files.length, 0);
  assert.match((await run(dir, ['log', '-1', '--format=%s'])).trim(), /Merge branch 'topic'/);
  await assert.rejects(continueOperation(dir, 'abort'), /No merge, rebase/);

  // Abort: a second conflicting merge is dropped and the tree returns to the pre-merge state.
  await run(dir, ['switch', '-q', '-c', 'other', 'HEAD~1']);
  await commit(dir, 'a.txt', 'one\nOTHER\nthree\n', 'other change');
  await run(dir, ['switch', '-q', 'main']);
  await run(dir, ['merge', 'other']).catch(() => undefined);
  assert.equal((await conflictState(dir)).operation, 'merge');
  const aborted = await continueOperation(dir, 'abort');
  assert.equal(aborted.state.operation, null); assert.equal(aborted.status.files.length, 0);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\nMAIN\nTOPIC\nthree\n');
});

test('cherry-pick and rebase conflicts are detected with their own labels; write+markResolved stages in one step', async () => {
  const dir = await repo();
  await run(dir, ['switch', '-q', '-c', 'topic']);
  await commit(dir, 'a.txt', 'one\nTOPIC\nthree\n', 'topic change');
  await run(dir, ['switch', '-q', 'main']);
  await commit(dir, 'a.txt', 'one\nMAIN\nthree\n', 'main change');
  await run(dir, ['cherry-pick', 'topic']).catch(() => undefined);
  let state = await conflictState(dir);
  assert.equal(state.operation, 'cherry-pick'); assert.equal(state.incomingSubject, 'topic change'); assert.equal(state.files[0]?.status, 'UU');
  const file = await conflictFile(dir, 'a.txt');
  const parsed = parseConflicts(file.working);
  state = await writeConflict(dir, {path: 'a.txt', content: applyConflictChoices(parsed, new Map([[parsed.blocks[1].id, 'incoming']])), revision: file.revision, markResolved: true});
  assert.deepEqual(state.files, []); assert.equal(state.canContinue, true);
  const picked = await continueOperation(dir, 'continue');
  assert.equal(picked.state.operation, null);
  assert.equal((await run(dir, ['log', '-1', '--format=%s'])).trim(), 'topic change');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\nTOPIC\nthree\n');

  await run(dir, ['switch', '-q', '-c', 'feature', 'HEAD~2']);
  await commit(dir, 'a.txt', 'one\nFEATURE\nthree\n', 'feature change');
  await run(dir, ['rebase', 'main']).catch(() => undefined);
  state = await conflictState(dir);
  assert.equal(state.operation, 'rebase'); assert.equal(state.incomingLabel, 'feature (replaying)'); assert.equal(state.incomingSubject, 'feature change');
  assert.equal(state.currentLabel, 'main', 'during a rebase HEAD is the upstream side');
  const aborted = await continueOperation(dir, 'abort');
  assert.equal(aborted.state.operation, null); assert.equal(aborted.status.branch, 'feature');
});

test('clone from a local bare repository streams progress, adds the folder and cleans up on cancel; URLs are validated', async () => {
  const source = await repo(), bare = await temp('bare'), home = await temp('home');
  await run(bare, ['init', '-q', '--bare', '-b', 'main']);
  await run(source, ['push', '-q', bare, 'main']);
  const events: GitEvent[] = [];
  const destination = join(home, 'Code', 'cloned');
  const added: string[] = [];
  const started = await startClone({url: bare, destination}, event => events.push(event), async path => { added.push(path); return {id: 'f9', path, name: 'cloned'}; });
  assert.equal(started.destination, destination); assert.equal(started.name, 'cloned');
  for (let i = 0; i < 400 && !events.some(e => e.phase === 'done' || e.phase === 'failed'); i++) await new Promise(r => setTimeout(r, 25));
  const last = events[events.length - 1];
  assert.equal(last.phase, 'done', JSON.stringify(events));
  if (last.phase !== 'done') return;
  assert.equal(last.path, destination); assert.equal(last.folder.id, 'f9'); assert.deepEqual(added, [destination]);
  assert.ok(events.some(e => e.phase === 'progress'), 'progress was reported');
  assert.equal(await readFile(join(destination, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  await assert.rejects(startClone({url: bare, destination}, () => {}, async () => ({id: 'x', path: '', name: ''})), /not empty/);

  // Cancel: the partial checkout is removed.
  const cancelEvents: GitEvent[] = [];
  const second = join(home, 'Code', 'cancelled');
  const cancelled = await startClone({url: bare, destination: second}, event => cancelEvents.push(event), async path => ({id: 'f10', path, name: 'x'}));
  cancelClone(cancelled.id);
  for (let i = 0; i < 400 && !cancelEvents.some(e => e.phase !== 'progress'); i++) await new Promise(r => setTimeout(r, 25));
  const final = cancelEvents[cancelEvents.length - 1];
  assert.ok(final.phase === 'cancelled' || final.phase === 'done', JSON.stringify(cancelEvents));
  if (final.phase === 'cancelled') await assert.rejects(stat(second), 'the partial clone is removed');

  assert.equal(validateCloneUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(validateCloneUrl(' git@github.com:o/r.git '), 'git@github.com:o/r.git');
  assert.equal(validateCloneUrl('ssh://git@example.com:2222/o/r'), 'ssh://git@example.com:2222/o/r');
  assert.throws(() => validateCloneUrl('https://user:secret@github.com/o/r'), /Remove the password/);
  assert.throws(() => validateCloneUrl('ext::sh'), /not supported|Enter an https/);
  assert.throws(() => validateCloneUrl('ext::sh -c whoami'), /Enter a repository URL/);
  assert.throws(() => validateCloneUrl('--upload-pack=evil'), /Enter a repository URL/);
  assert.throws(() => validateCloneUrl('github.com/o/r'), /Enter an https/);
  assert.equal(repositoryName('https://github.com/o/My-Repo.git'), 'My-Repo');
  assert.equal(repositoryName('git@github.com:o/r'), 'r');
  assert.equal(repositoryName('https://x.y/'), 'x.y');
  assert.equal(repositoryName('///'), 'repository');
  const suggested = await defaultDestination('https://github.com/o/r.git');
  assert.ok(suggested.path.endsWith(join('Code', 'r')) || /Code\/r-\d+$/.test(suggested.path), suggested.path); assert.equal(suggested.name, 'r');
  assert.deepEqual(cloneProgress('Receiving objects:  50% (10/20)'), {percent: 43, message: 'Receiving objects:  50% (10/20)'});
  assert.equal(cloneProgress('Resolving deltas: 100% (3/3), done.')?.percent, 95);
  assert.equal(cloneProgress('fatal: repository not found'), null);
  assert.equal(cloneProgress('Cloning into \'x\'...')?.percent, 0);
});

test('the git domain exposes every history, conflict and clone command and refuses continue while a chat runs', async () => {
  const dir = await repo();
  const folders: Folder[] = [{id: 'f1', path: dir, name: 'repo'}];
  const chats: Array<{id: string; folderId: string; status: string}> = [];
  const emitted: unknown[] = [];
  const context = {
    dataDir: dir, emit: (event: unknown) => emitted.push(event),
    store: {snapshot: () => ({folders, chats, projects: [], version: 1})},
    folderFor: (id: string) => { const found = folders.find(folder => folder.id === id); if (!found) throw new Error('Unknown folder.'); return found; },
    invoke: async (_command: string, input: {path: string}) => ({id: 'f2', path: input.path, name: 'added'}),
  } as unknown as DomainContext;
  const {handlers} = createGitDomain(context);
  for (const name of ['git.log', 'git.commitDetail', 'git.compare', 'git.refDiff', 'git.blame', 'git.conflicts', 'git.conflictFile', 'git.conflictWrite', 'git.conflictMarkResolved', 'git.conflictContinue', 'git.clone.start', 'git.clone.cancel', 'git.clone.defaultDestination', 'git.clone.pickDestination']) {
    assert.ok(name in GIT_COMMANDS, `${name} is in GIT_COMMANDS`); assert.equal(typeof handlers[name], 'function', `${name} has a handler`);
  }
  const page = await handlers['git.log']({folderId: 'f1'}) as {commits: unknown[]};
  assert.equal(page.commits.length, 1);
  assert.equal(((await handlers['git.conflicts']({folderId: 'f1'})) as {operation: unknown}).operation, null);
  assert.deepEqual((await handlers['git.blame']({folderId: 'f1', path: 'a.txt'}) as {lines: string[]}).lines.length, 3);
  chats.push({id: 'c', folderId: 'f1', status: 'running'});
  await assert.rejects(Promise.resolve(handlers['git.conflictContinue']({folderId: 'f1', action: 'abort'})), /chat is running/);
  await assert.rejects(Promise.resolve(handlers['git.clone.pickDestination']({})), /desktop window/);
  await assert.rejects(Promise.resolve(handlers['git.clone.start']({url: 'nope'})), /Enter an https/);
});

test('a failed clone empties a folder the user chose but never removes it; a folder the clone created is removed', async () => {
  const home = await temp('clone-fail');
  const missing = join(home, 'no-such-repo');
  const waitFor = async (events: GitEvent[]) => { for (let i = 0; i < 400 && !events.some(e => e.phase !== 'progress'); i++) await new Promise(r => setTimeout(r, 25)); return events[events.length - 1]; };

  const chosen = join(home, 'chosen'); await mkdir(chosen);
  const chosenEvents: GitEvent[] = [];
  await startClone({url: missing, destination: chosen}, event => chosenEvents.push(event), async path => ({id: 'x', path, name: 'x'}));
  assert.equal((await waitFor(chosenEvents)).phase, 'failed');
  assert.ok((await stat(chosen)).isDirectory(), 'the folder the user picked survives');
  assert.deepEqual(await readdir(chosen), []);

  const fresh = join(home, 'fresh');
  const freshEvents: GitEvent[] = [];
  await startClone({url: missing, destination: fresh}, event => freshEvents.push(event), async path => ({id: 'x', path, name: 'x'}));
  assert.equal((await waitFor(freshEvents)).phase, 'failed');
  await assert.rejects(stat(fresh), 'the folder the clone created is removed');

  const busy = join(home, 'busy'); await mkdir(busy); await writeFile(join(busy, 'keep.txt'), 'mine');
  await assert.rejects(startClone({url: missing, destination: busy}, () => {}, async () => ({id: 'x', path: '', name: ''})), /not empty/);
  assert.equal(await readFile(join(busy, 'keep.txt'), 'utf8'), 'mine');
});

test('a conflicted file larger than the view cap is never overwritten with its clipped copy', async () => {
  const dir = await repo();
  const big = (label: string) => `one\n${label}\n${'filler line\n'.repeat(60_000)}tail\n`;// ~720 KB, past the 512 KB side cap
  await run(dir, ['switch', '-q', '-c', 'topic']);
  await commit(dir, 'a.txt', big('TOPIC'), 'topic change');
  await run(dir, ['switch', '-q', 'main']);
  await commit(dir, 'a.txt', big('MAIN'), 'main change');
  await run(dir, ['merge', 'topic']).catch(() => undefined);
  const file = await conflictFile(dir, 'a.txt');
  assert.equal(file.truncated, true);
  const before = await readFile(join(dir, 'a.txt'), 'utf8');
  const parsed = parseConflicts(file.working);
  const clipped = applyConflictChoices(parsed, new Map(parsed.blocks.filter(b => b.kind === 'conflict').map(b => [b.id, 'current' as const])));
  await assert.rejects(writeConflict(dir, {path: 'a.txt', content: clipped, revision: file.revision}), /too large to resolve in the app/);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), before, 'the working file keeps its tail');
  await run(dir, ['merge', '--abort']);
});
