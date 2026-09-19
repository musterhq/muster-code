import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAnnotations } from '../src/runtime/file-annotations.ts';

const REV = 'a'.repeat(64); // valid sha256 hex

let dataDir: string;

before(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'fa-test-'));
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('persistence, reopen, and quote/location round-trip', () => {
  const fa = new FileAnnotations(dataDir);
  const added = fa.add({
    folderId: 'folder1',
    path: 'docs/readme.md',
    revision: REV,
    location: 'Page 2',
    quote: 'the quick brown fox',
    note: 'check this',
  });

  assert.equal(added.folderId, 'folder1');
  assert.equal(added.path, 'docs/readme.md');
  assert.equal(added.quote, 'the quick brown fox');
  assert.equal(added.location, 'Page 2');
  assert.ok(added.id.length > 0);
  assert.ok(added.createdAt.length > 0);
  fa.close();

  // Reopen: annotation must persist
  const fa2 = new FileAnnotations(dataDir);
  const list = fa2.list('folder1', 'docs/readme.md');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, added.id);
  assert.equal(list[0]!.quote, 'the quick brown fox');
  assert.equal(list[0]!.location, 'Page 2');
  assert.equal(list[0]!.note, 'check this');
  fa2.close();
});

test('invalid input and 200-annotation cap', () => {
  const fa = new FileAnnotations(dataDir);

  // empty note rejected
  assert.throws(() => fa.add({
    folderId: 'f', path: 'x/y.txt', revision: REV, location: 'L1', quote: '', note: '',
  }), /note must be non-empty/);

  // absolute path rejected
  assert.throws(() => fa.add({
    folderId: 'f', path: '/etc/passwd', revision: REV, location: 'L1', quote: '', note: 'n',
  }), /relative/);

  // bad revision rejected
  assert.throws(() => fa.add({
    folderId: 'f', path: 'x/y.txt', revision: 'badhex', location: 'L1', quote: '', note: 'n',
  }), /sha256/);

  // empty location rejected
  assert.throws(() => fa.add({
    folderId: 'f', path: 'x/y.txt', revision: REV, location: '', quote: '', note: 'n',
  }), /location must be non-empty/);

  // fill to 200 for a specific file
  const capPath = 'cap/test.txt';
  for (let i = 0; i < 200; i++) {
    fa.add({ folderId: 'capfolder', path: capPath, revision: REV, location: `L${i}`, quote: '', note: `note${i}` });
  }
  assert.throws(() =>
    fa.add({ folderId: 'capfolder', path: capPath, revision: REV, location: 'L200', quote: '', note: 'overflow' }),
    /limit reached/
  );

  // different file in same folder must not be blocked
  fa.add({ folderId: 'capfolder', path: 'cap/other.txt', revision: REV, location: 'L1', quote: '', note: 'ok' });

  fa.close();
});

test('scoped delete: only removes matching folder+path+id', () => {
  const fa = new FileAnnotations(dataDir);

  const a1 = fa.add({ folderId: 'scope-folder', path: 'a/file.txt', revision: REV, location: 'L1', quote: 'q', note: 'n1' });
  const a2 = fa.add({ folderId: 'scope-folder', path: 'a/file.txt', revision: REV, location: 'L2', quote: 'q', note: 'n2' });
  const b1 = fa.add({ folderId: 'scope-folder', path: 'b/file.txt', revision: REV, location: 'L1', quote: 'q', note: 'n3' });

  // Wrong path: should not remove a1 even if id matches
  fa.remove('scope-folder', 'b/file.txt', a1.id);
  assert.equal(fa.list('scope-folder', 'a/file.txt').length, 2);

  // Correct scope: removes only a1
  fa.remove('scope-folder', 'a/file.txt', a1.id);
  const remaining = fa.list('scope-folder', 'a/file.txt');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, a2.id);

  // b/file.txt untouched
  assert.equal(fa.list('scope-folder', 'b/file.txt').length, 1);
  assert.equal(fa.list('scope-folder', 'b/file.txt')[0]!.id, b1.id);

  fa.close();
});
