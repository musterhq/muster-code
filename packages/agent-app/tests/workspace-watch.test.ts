import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
