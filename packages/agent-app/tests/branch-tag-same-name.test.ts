/** #671: a tag that shares the branch's name must not turn the branch into `heads/<name>`. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { realGit } from '../src/runtime/checkout/git-port.ts';
import { readRepoEvidence } from '../src/runtime/domains/memory.ts';

const repoWith = (setup: (g: (...a: string[]) => string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'muster-tagname-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'release'); writeFileSync(join(dir, 'a'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'one');
  setup(g);
  return { dir, g, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test('checkout and memory name the branch when a tag shares its name', async () => {
  const r = repoWith(g => { g('tag', 'release'); });
  try {
    assert.equal(await realGit.defaultBranch(r.dir, 'nope'), 'release');
    assert.equal((await readRepoEvidence(r.dir))?.branch, 'release');
  } finally { r.done(); }
});

test('a detached HEAD: checkout falls back to the short sha, memory records no branch', async () => {
  const r = repoWith(g => g('checkout', '-q', '--detach'));
  try {
    const sha = r.g('rev-parse', '--short', 'HEAD');
    assert.equal(await realGit.defaultBranch(r.dir, 'nope'), sha);
    const evidence = await readRepoEvidence(r.dir);
    assert.ok(evidence?.head);
    assert.equal(evidence?.branch, undefined);
  } finally { r.done(); }
});
