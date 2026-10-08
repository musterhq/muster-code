import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {captureBaseline, isGitWorkTree, ReviewBaselineStore} from '../src/runtime/review-baseline.ts';
import {reviewChanges} from '../src/runtime/review.ts';
import {attachTurnLedger, filesChanged, TurnLedger} from '../src/runtime/turn-ledger.ts';
import {mergeReviewFiles} from '../src/renderer/turnFileChanges.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', encoding: 'utf8'});

/** A repo plus a checkout-style worktree (<app data>/worktrees/<repo>/muster-KEY) whose .git is a file. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'muster-wt-'));
  const main = join(base, 'repo'); mkdirSync(main);
  sh(main, 'init', '-q', '-b', 'main'); sh(main, 'config', 'user.email', 't@example.com'); sh(main, 'config', 'user.name', 'T'); sh(main, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(main, '.gitignore'), 'dist/\n*.log\n');
  writeFileSync(join(main, 'a.txt'), 'one\ntwo\nthree\n');
  sh(main, 'add', '-A'); sh(main, 'commit', '-q', '-m', 'init');
  const parent = join(base, 'agent-data', 'worktrees', 'repo'); mkdirSync(parent, {recursive: true});
  const tree = join(parent, 'muster-KEY-1');
  sh(main, 'worktree', 'add', '-q', '-b', 'muster/KEY-1', tree);
  return {base, main, tree};
}

test('a checkout worktree has a .git FILE and is still detected as a work tree', async () => {
  const {base, tree} = fixture();
  try {
    assert.equal(statSync(join(tree, '.git')).isFile(), true);
    assert.equal(await isGitWorkTree(tree), true);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('a worktree turn records a baseline and a shell edit shows up against it, gitignored files excluded', async () => {
  const {base, main, tree} = fixture();
  try {
    const store = new ReviewBaselineStore(new DatabaseSync(':memory:'));
    const info = await captureBaseline(store, {runId: 'run-wt', chatId: 'chat-wt', folderId: 'f', cwd: tree});
    assert.match(info.treeSha ?? '', /^[0-9a-f]{40}$/, info.reason ?? '');
    // The model edits through a shell command, not apply_patch.
    execFileSync('sh', ['-c', "printf 'one\\nTWO\\nthree\\n' > a.txt && echo hi > made.txt && mkdir -p dist && echo x > dist/out.js && echo y > run.log"], {cwd: tree});
    const turn = await reviewChanges(tree, {runId: 'run-wt'}, info.treeSha);
    assert.deepEqual(turn.files.map(file => `${file.status}:${file.path}`).sort(), ['added:made.txt', 'modified:a.txt']);
    const files = await filesChanged(tree, info.treeSha);
    assert.deepEqual(files?.map(file => file.path).sort(), ['a.txt', 'made.txt']);
    assert.equal(sh(main, 'status', '--porcelain'), '', 'the main checkout is untouched');
    assert.equal(existsSync(join(tree, '.git')), true);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('a normal folder chat behaves the same', async () => {
  const {base, main} = fixture();
  try {
    const store = new ReviewBaselineStore(new DatabaseSync(':memory:'));
    const info = await captureBaseline(store, {runId: 'run-n', chatId: 'chat-n', folderId: 'f', cwd: main});
    writeFileSync(join(main, 'b.txt'), 'new\n'); mkdirSync(join(main, 'dist')); writeFileSync(join(main, 'dist', 'x.js'), 'x');
    const turn = await reviewChanges(main, {runId: 'run-n'}, info.treeSha);
    assert.deepEqual(turn.files.map(file => file.path), ['b.txt']);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('the Receipt of a worktree chat with no project lists the files a shell command changed', async () => {
  const {base, tree} = fixture();
  try {
    const db = new DatabaseSync(':memory:');
    const ledger = new TurnLedger(db), appended: any[] = [], hooks: any = {};
    const context = {db: () => db, hooks: {onRunStarted: (fn: any) => { hooks.start = fn; return () => {}; }, onRunSettled: (fn: any) => { hooks.settle = fn; return () => {}; }, onProviderEvent: (fn: any) => { hooks.event = fn; return () => {}; }}} as any;
    const off = attachTurnLedger(context, () => ledger, entry => appended.push(entry));
    const store = new ReviewBaselineStore(db);
    const chat = {id: 'wt-chat', title: 'KEY-1 · Task', providerId: 'hybrow', model: 'intelligent-planner'};
    await captureBaseline(store, {runId: 'r1', chatId: chat.id, folderId: 'f', cwd: tree});
    await hooks.start({chat, runId: 'r1', cwd: tree});
    execFileSync('sh', ['-c', "echo changed >> a.txt && echo y > run.log"], {cwd: tree});
    await hooks.settle({chat, runId: 'r1', status: 'completed'});
    off();
    assert.deepEqual(appended[0].files.map((f: any) => `${f.status}:${f.path}`), ['modified:a.txt']);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('git-reported files join the provider-reported ones without duplicating them', () => {
  const reported = [{path: '/w/repo/a.txt', kind: 'update' as const, adds: 1, dels: 0, patches: [], status: 'completed'}];
  const git = [
    {path: 'a.txt', status: 'modified', adds: 1, dels: 0, beforeHash: 'x', afterHash: 'y', revision: 'r'},
    {path: 'made.txt', status: 'untracked', adds: 2, dels: 0, beforeHash: 'x', afterHash: 'y', revision: 'r'},
    {path: 'gone.txt', status: 'deleted', adds: 0, dels: 3, beforeHash: 'x', afterHash: 'y', revision: 'r'},
  ];
  const merged = mergeReviewFiles(reported, git, path => path.startsWith('/w/repo/') ? path.slice(8) : path);
  assert.deepEqual(merged.map(entry => `${entry.kind}:${entry.path}`), ['update:/w/repo/a.txt', 'add:made.txt', 'delete:gone.txt']);
  assert.deepEqual(mergeReviewFiles([], undefined).length, 0);
});
