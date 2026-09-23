import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dirtyFileCount, gitStatus} from '../src/runtime/git-local.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-untracked-'));
  const run = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  writeFileSync(join(root, 'README.md'), 'hi\n'); run('add', '.'); run('commit', '-qm', 'init');
  return root;
}

test('the status revision notices an edit deep inside a fully-untracked folder', async () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'feature/deep'), {recursive: true});
    writeFileSync(join(root, 'feature/deep/a.ts'), 'one\n');
    const before = await gitStatus(root);
    assert.deepEqual(before.files.map(file => file.path), ['feature/'], 'status still collapses the folder to one row');
    writeFileSync(join(root, 'feature/deep/a.ts'), 'two, longer\n');
    utimesSync(join(root, 'feature/deep/a.ts'), new Date(), new Date(Date.now() + 5_000));
    const after = await gitStatus(root);
    assert.notEqual(after.revision, before.revision, 'a stale revision must be rejected by mutateGit');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('dirtyFileCount counts each file inside a new folder, not the folder as one', async () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'feature'), {recursive: true});
    for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, 'feature', name), name);
    writeFileSync(join(root, 'README.md'), 'changed\n');
    assert.equal(await dirtyFileCount(root), 4);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('redactGitText masks URL credentials but leaves an @ inside a query or fragment alone', async () => {
  const {redactGitText} = await import('../src/runtime/git-local.ts');
  assert.equal(redactGitText('https://user:tok@github.com/o/r'), 'https://***@github.com/o/r');
  assert.equal(redactGitText('see https://example.com?q=a@b.com'), 'see https://example.com?q=a@b.com');
  assert.equal(redactGitText('see https://example.com#who@x'), 'see https://example.com#who@x');
});
