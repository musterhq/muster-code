import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {constants, promises as fs, existsSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executeTool, type ToolContext} from '../src/runtime/adapters/http-tools.ts';

// Direct Node runs need only this helper, not an Electron/renderer build. On unchanged main it does not exist yet.
const build = new URL('../scripts/build-write-helper.mjs', import.meta.url);
if (existsSync(build)) childProcess.execFileSync(process.execPath, [fileURLToPath(build)], {stdio: 'inherit'});

async function sandbox(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'muster-write710-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const ws = join(root, 'ws'), outside = join(root, 'outside');
  await fs.mkdir(ws); await fs.mkdir(outside); await fs.mkdir(join(ws, 'd'));
  return {ws, outside};
}
const ctx = (cwd: string): ToolContext => ({cwd, access: 'workspace', signal: new AbortController().signal, emit() {}, threadId: 't', turnId: 'u'});
const call = (name: string, args: object) => ({id: '1', name, arguments: JSON.stringify(args)});

/** Force the actual filesystem swap at the mutation boundary, then undo it before path-based cleanup can find it.
 * Main opens/makes by pathname; the fix pins the parent and asks for stdin before opening the final name.
 * Both schedules exercise executeTool and assert the files the user can see, not helper implementation details. */
function race(t: TestContext, ws: string, outside: string, directory = false) {
  let attacked = false, restored: Promise<void> = Promise.resolve();
  const swap = async () => {
    attacked = true;
    await fs.rename(join(ws, 'd'), join(ws, 'held'));
    await fs.symlink(outside, join(ws, 'd'), process.platform === 'win32' ? 'junction' : undefined);
  };
  const restore = async () => { await fs.unlink(join(ws, 'd')); await fs.rename(join(ws, 'held'), join(ws, 'd')); };
  const open = fs.open, mkdir = fs.mkdir, spawn = childProcess.spawn;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!directory && String(args[0]) === join(ws, 'd', 'x.txt') && typeof args[1] === 'number' && (args[1] & constants.O_CREAT)) {
      await swap(); try { return await open(...args); } finally { await restore(); }
    }
    return open(...args);
  });
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (directory && String(args[0]) === join(ws, 'd', 'sub')) {
      await swap(); try { return await mkdir(...args); } finally { await restore(); }
    }
    return mkdir(...args);
  });
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const child = spawn(...args);
    if (String(args[0]).includes('muster-write')) {
      const end = child.stdin!.end.bind(child.stdin!);
      // The helper has pinned all parents before it asks for the content. Hold that content until the swap completes.
      child.stdin!.end = ((...input: Parameters<typeof end>) => {
        restored = (async () => {
          await swap();
          const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
          end(...input); await closed; await restore();
        })();
        return child.stdin!;
      }) as typeof end;
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return async () => { await restored; assert.equal(attacked, true, 'the folder was swapped during this tool call'); };
}

// Spec: MUS-SPEC-19-710A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-710a)
test('a workspace write raced at file creation leaves no empty file outside', async t => {
  const {ws, outside} = await sandbox(t);
  const done = race(t, ws, outside);
  const result = await executeTool(call('write_file', {path: 'd/x.txt', content: 'new content'}), ctx(ws));
  await done();
  assert.deepEqual(await fs.readdir(outside), [], 'even an empty file must never be created outside');
  if (result.ok) assert.equal(await fs.readFile(join(ws, 'd/x.txt'), 'utf8'), 'new content');
});

// Spec: MUS-SPEC-19-710B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-710b)
test('a workspace write raced at parent creation leaves no folder outside', async t => {
  const {ws, outside} = await sandbox(t);
  const done = race(t, ws, outside, true);
  const result = await executeTool(call('write_file', {path: 'd/sub/x.txt', content: 'new content'}), ctx(ws));
  await done();
  assert.deepEqual(await fs.readdir(outside), [], 'no empty parent folder may be created outside');
  if (result.ok) assert.equal(await fs.readFile(join(ws, 'd/sub/x.txt'), 'utf8'), 'new content');
});

// Spec: MUS-SPEC-19-710C (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-710c)
test('a workspace edit raced at file open leaves nothing outside and preserves outside files', async t => {
  const {ws, outside} = await sandbox(t);
  await fs.writeFile(join(ws, 'd/x.txt'), 'before'); await fs.writeFile(join(outside, 'keep.txt'), 'keep');
  const done = race(t, ws, outside);
  const result = await executeTool(call('edit_file', {path: 'd/x.txt', old_string: 'before', new_string: 'after'}), ctx(ws));
  await done();
  assert.deepEqual(await fs.readdir(outside), ['keep.txt'], 'the edit must not create even an empty file outside');
  assert.equal(await fs.readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(join(ws, 'd/x.txt'), 'utf8'), result.ok ? 'after' : 'before');
});

test('workspace writes still create parents, overwrite and edit UTF-8 files', async t => {
  const {ws} = await sandbox(t);
  for (const [name, args, content] of [
    ['write_file', {path: 'new/子/x.txt', content: 'hello 🌿'}, 'hello 🌿'],
    ['write_file', {path: 'new/子/x.txt', content: 'hello again'}, 'hello again'],
    ['edit_file', {path: 'new/子/x.txt', old_string: 'again', new_string: '🌿'}, 'hello 🌿'],
    ['write_file', {path: 'new/子/x.txt', content: ''}, ''],
  ] as const) {
    const result = await executeTool(call(name, args), ctx(ws));
    assert.equal(result.ok, true, result.content);
    assert.equal(await fs.readFile(join(ws, 'new/子/x.txt'), 'utf8'), content);
  }
});
