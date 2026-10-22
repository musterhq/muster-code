import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { COALESCE_MS, MAX_WATCHED_ROOTS, WorkspaceWatchService } from '../src/runtime/workspace-watch.ts';

// FSEvents delivery is asynchronous; poll instead of fixed sleeps.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
// macOS FSEvents can replay events from just before the watcher opened
// (e.g. the temp root's own creation); drain that startup noise first.
async function settle(changed: string[]): Promise<void> {
  await sleep(QUIET_MS);
  changed.length = 0;
}
const QUIET_MS = COALESCE_MS + 350; // coalesce window + FSEvents latency margin

async function makeRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir); // /var -> /private/var on macOS
}

function makeService(t: { after(fn: () => void): void }) {
  const changed: string[] = [];
  const errors: Error[] = [];
  const svc = new WorkspaceWatchService(
    (id) => changed.push(id),
    (_id, err) => errors.push(err),
  );
  t.after(() => svc.dispose());
  return { svc, changed, errors };
}

test('create, rename, and delete each notify; a burst coalesces to one call', async (t) => {
  const root = await makeRoot(t);
  const { svc, changed } = makeService(t);
  await svc.watch('f1', root);
  await settle(changed);

  // burst of creates/edits -> exactly one notification
  for (let i = 0; i < 5; i++) await writeFile(join(root, `a${i}.txt`), String(i));
  await waitFor(() => changed.length === 1);
  await sleep(QUIET_MS);
  assert.deepEqual(changed, ['f1']);

  await rename(join(root, 'a0.txt'), join(root, 'b0.txt'));
  await waitFor(() => changed.length === 2);

  await sleep(QUIET_MS);
  await rm(join(root, 'b0.txt'));
  await waitFor(() => changed.length === 3);
});

test('node_modules noise is ignored; .git/index notifies; .git/objects does not', async (t) => {
  const root = await makeRoot(t);
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  const { svc, changed } = makeService(t);
  await svc.watch('f1', root);
  await settle(changed);

  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'x');
  await writeFile(join(root, '.git', 'objects', 'aa'), 'x');
  await sleep(QUIET_MS);
  assert.deepEqual(changed, [], 'ignored paths must not notify');

  await writeFile(join(root, '.git', 'index'), 'x'); // staging affects review
  await waitFor(() => changed.length === 1);
  assert.deepEqual(changed, ['f1']);
});

test('watch rejects missing root and non-directory root', async (t) => {
  const root = await makeRoot(t);
  const { svc } = makeService(t);
  await assert.rejects(svc.watch('f1', join(root, 'nope')), /ENOENT/);
  const file = join(root, 'plain.txt');
  await writeFile(file, 'x');
  await assert.rejects(svc.watch('f1', file), /not a directory/);
});

test('re-watching a folder id replaces the old root', async (t) => {
  const rootA = await makeRoot(t);
  const rootB = await makeRoot(t);
  const { svc, changed } = makeService(t);
  await svc.watch('f1', rootA);
  await svc.watch('f1', rootB);
  await settle(changed);

  await writeFile(join(rootA, 'old.txt'), 'x');
  await sleep(QUIET_MS);
  assert.deepEqual(changed, [], 'old root must be detached');

  await writeFile(join(rootB, 'new.txt'), 'x');
  await waitFor(() => changed.length === 1);
});

test('unwatch stops notifications and cancels pending coalesced ones', async (t) => {
  const root = await makeRoot(t);
  const { svc, changed } = makeService(t);
  await svc.watch('f1', root);
  await writeFile(join(root, 'a.txt'), 'x'); // lands inside the coalesce window
  svc.unwatch('f1');
  svc.unwatch('missing'); // unknown id is a no-op
  await sleep(QUIET_MS);
  assert.deepEqual(changed, []);
});

test('root cap fails explicitly; re-watching an existing id is exempt', async (t) => {
  const root = await makeRoot(t);
  const { svc } = makeService(t);
  for (let i = 0; i < MAX_WATCHED_ROOTS; i++) await svc.watch(`f${i}`, root);
  await assert.rejects(svc.watch('overflow', root), /Watch limit/);
  await svc.watch('f0', root); // replacement, not a new slot
});

test('dispose closes everything and rejects further watches', async (t) => {
  const root = await makeRoot(t);
  const { svc, changed } = makeService(t);
  await svc.watch('f1', root);
  svc.dispose();
  svc.dispose(); // idempotent
  await writeFile(join(root, 'a.txt'), 'x');
  await sleep(QUIET_MS);
  assert.deepEqual(changed, []);
  await assert.rejects(svc.watch('f2', root), /disposed/);
});


test('dispose and unwatch cancel asynchronous watcher creation', async (t) => {
  const root = await makeRoot(t);
  const first = makeService(t);
  const opening = first.svc.watch('f1', root);
  first.svc.dispose();
  await assert.rejects(opening, /cancelled/);
  const second = makeService(t);
  const pending = second.svc.watch('f1', root);
  second.svc.unwatch('f1');
  await assert.rejects(pending, /cancelled/);
});

test('source folders named build are not silently excluded', async (t) => {
  const root = await makeRoot(t);
  await mkdir(join(root, 'build'));
  const { svc, changed } = makeService(t);
  await svc.watch('f1', root);
  await settle(changed);
  await writeFile(join(root, 'build', 'source.ts'), 'export const source = true;');
  await waitFor(() => changed.length > 0);
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const hasGit = spawnSync('git', ['--version']).status === 0;

test('always-generated caches (.next, .turbo, __pycache__) never trigger refreshes', async (t) => {
  const root = await makeRoot(t);
  for (const dir of ['.next', '.turbo', '__pycache__']) await mkdir(join(root, dir));
  const { svc, changed } = makeService(t);
  await svc.watch('f', root);
  await settle(changed);
  for (const dir of ['.next', '.turbo', '__pycache__']) await writeFile(join(root, dir, 'chunk.js'), 'x');
  await sleep(QUIET_MS);
  assert.deepEqual(changed, []);
});

test('a git-ignored dist/ or target/ does not refresh; source files still do', { skip: !hasGit && 'git not installed' }, async (t) => {
  const root = await makeRoot(t);
  git(root, 'init', '-q');
  await writeFile(join(root, '.gitignore'), 'dist/\n/target\n');
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'target', 'debug'), { recursive: true });
  await mkdir(join(root, 'src'));
  const { svc, changed } = makeService(t);
  await svc.watch('f', root);
  await settle(changed);
  // A build writes many files; none of them may refresh the tree.
  for (let i = 0; i < 20; i++) {
    await writeFile(join(root, 'dist', `chunk${i}.js`), 'x');
    await writeFile(join(root, 'target', 'debug', `obj${i}.o`), 'x');
  }
  await sleep(QUIET_MS * 2);
  assert.deepEqual(changed, []);
  await writeFile(join(root, 'src', 'a.ts'), 'x');
  await waitFor(() => changed.length > 0);
});

test('a committed dist/ (not git-ignored) keeps refreshing', { skip: !hasGit && 'git not installed' }, async (t) => {
  const root = await makeRoot(t);
  git(root, 'init', '-q');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.js'), 'v1');
  const { svc, changed } = makeService(t);
  await svc.watch('f', root);
  await settle(changed);
  await writeFile(join(root, 'dist', 'index.js'), 'v2');
  await waitFor(() => changed.length > 0);
});

test('ignoring dist/ in .gitignore takes effect without re-watching the folder', { skip: !hasGit && 'git not installed' }, async (t) => {
  const root = await makeRoot(t);
  git(root, 'init', '-q');
  await mkdir(join(root, 'dist'));
  const { svc, changed } = makeService(t);
  await svc.watch('f', root);
  await settle(changed);
  await writeFile(join(root, 'dist', 'a.js'), 'x');
  await waitFor(() => changed.length > 0); // not ignored yet: cached as committed output
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await waitFor(() => changed.length > 1); // the .gitignore edit itself refreshes
  await settle(changed);
  await writeFile(join(root, 'dist', 'b.js'), 'x');
  await sleep(QUIET_MS * 2);
  assert.deepEqual(changed, []);
});
