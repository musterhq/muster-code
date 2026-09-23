import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, realpathSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArtifactAccess, MAX_ARTIFACT_READ_BYTES, timelineMentions} from '../src/runtime/artifact-access.ts';
import {ARTIFACTS_COMMANDS} from '../src/shared/domains/artifacts-protocol.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const item = (kind: TimelineItem['kind'], text: string, data?: Record<string, unknown>): TimelineItem => ({id: String(Math.random()), chatId: 'c1', kind, text, createdAt: '', ...(data ? {data} : {})});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-access-')));
  const file = join(root, 'report.md'); writeFileSync(file, '# Report\nline 2\n');
  const items: TimelineItem[] = [item('tool', `Write ${file}`)];
  const access = new ArtifactAccess({timeline: id => id === 'c1' ? items : [], chatExists: id => id === 'c1' || id === 'c2', home: join(root, 'home')});
  return {root, file, items, access, done: () => rmSync(root, {recursive: true, force: true})};
}

test('commands are allowlisted', () => {
  assert.equal(ARTIFACTS_COMMANDS['artifacts.authorize'], true);
  assert.equal(ARTIFACTS_COMMANDS['artifacts.read'], true);
});

test('a path named by a tool item is authorized and read back read-only', async () => {
  const {file, access, done} = setup();
  try {
    const grant = await access.authorize('c1', file);
    assert.equal(grant.name, 'report.md');
    assert.match(grant.handle, /^[A-Za-z0-9_-]{24}$/);
    const read = await access.read(grant.handle);
    assert.equal(read.text, '# Report\nline 2\n');
    assert.equal(read.binary, false);
    assert.equal(read.truncated, false);
  } finally { done(); }
});

test('paths absent from the chat timeline, or only in user/assistant text, are refused', async () => {
  const {root, items, access, done} = setup();
  try {
    const other = join(root, 'other.txt'); writeFileSync(other, 'x');
    await assert.rejects(access.authorize('c1', other), /agent wrote or used/);
    items.push(item('assistant', `see ${other}`), item('user', other));
    await assert.rejects(access.authorize('c1', other), /agent wrote or used/);
    // A different chat has its own timeline.
    await assert.rejects(access.authorize('c2', join(root, 'report.md')), /agent wrote or used/);
    await assert.rejects(access.authorize('gone', other), /no longer exists/);
    // Structured fileChange data counts.
    items.push(item('approval', 'Apply changes', {kind: 'fileChange', diff: [{path: other}]}));
    assert.equal((await access.authorize('c1', other)).name, 'other.txt');
  } finally { done(); }
});

test('symlinks, directories, relative paths, dot-dot and credential files are refused', async () => {
  const {root, file, items, access, done} = setup();
  try {
    const link = join(root, 'link.md'); symlinkSync(file, link); items.push(item('tool', `cat ${link}`));
    await assert.rejects(access.authorize('c1', link), /symbolic link/);
    const dir = join(root, 'dir'); mkdirSync(dir); items.push(item('tool', `ls ${dir}`));
    await assert.rejects(access.authorize('c1', dir), /regular files/);
    items.push(item('tool', 'cat report.md'));
    await assert.rejects(access.authorize('c1', 'report.md'), /absolute paths/);
    await assert.rejects(access.authorize('c1', `${root}/dir/../report.md`), /absolute paths/);
    const ssh = join(root, '.ssh'); mkdirSync(ssh); writeFileSync(join(ssh, 'id_ed25519'), 'secret'); items.push(item('tool', `cat ${join(ssh, 'id_ed25519')}`));
    await assert.rejects(access.authorize('c1', join(ssh, 'id_ed25519')), /Credential/);
    const env = join(root, '.env'); writeFileSync(env, 'KEY=1'); items.push(item('tool', `cat ${env}`));
    await assert.rejects(access.authorize('c1', env), /Credential/);
    await assert.rejects(access.authorize('c1', `${file}\0`), /Choose a file/);
  } finally { done(); }
});

test('~/ paths resolve against home; a replaced file or unknown handle cannot be read', async () => {
  const {root, items, access, done} = setup();
  try {
    mkdirSync(join(root, 'home')); const notes = join(root, 'home', 'notes.txt'); writeFileSync(notes, 'hi');
    items.push(item('tool', 'wrote ~/notes.txt'));
    const grant = await access.authorize('c1', '~/notes.txt');
    assert.equal(grant.path, notes);
    assert.equal((await access.read(grant.handle)).text, 'hi');
    // Swap in a symlink after authorization: the read is refused.
    renameSync(notes, `${notes}.bak`); symlinkSync('/etc/hosts', notes);
    await assert.rejects(access.read(grant.handle), /replaced/);
    await assert.rejects(access.read('nope'), /expired/);
    await assert.rejects(access.read(42), /expired/);
  } finally { done(); }
});

test('large files are bounded and binary files are flagged', async () => {
  const {root, items, access, done} = setup();
  try {
    const big = join(root, 'big.log'); writeFileSync(big, 'a'.repeat(MAX_ARTIFACT_READ_BYTES + 10)); items.push(item('tool', big));
    const read = await access.read((await access.authorize('c1', big)).handle);
    assert.equal(read.truncated, true); assert.equal(read.text.length, MAX_ARTIFACT_READ_BYTES); assert.equal(read.size, MAX_ARTIFACT_READ_BYTES + 10);
    const bin = join(root, 'a.bin'); writeFileSync(bin, Buffer.from([1, 0, 2])); items.push(item('tool', bin));
    const binary = await access.read((await access.authorize('c1', bin)).handle);
    assert.equal(binary.binary, true); assert.equal(binary.text, '');
  } finally { done(); }
});

test('timelineMentions ignores non-tool items', () => {
  assert.equal(timelineMentions([item('assistant', '/tmp/x')], '/tmp/x'), false);
  assert.equal(timelineMentions([item('tool', 'ok', {changes: [{path: '/tmp/x'}]})], '/tmp/x'), true);
});
