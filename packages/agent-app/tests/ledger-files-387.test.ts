import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {attachTurnLedger, TurnLedger} from '../src/runtime/turn-ledger.ts';
import {snapshotTree} from '../src/runtime/review-baseline.ts';
import type {DomainContext, RunSettled, RunStarted} from '../src/runtime/domains/types.ts';
import type {LedgerEntry} from '../src/shared/domains/paperclip-protocol.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], {stdio: 'pipe', encoding: 'utf8'});

async function repo(t: {after(fn: () => Promise<void> | void): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'muster-387-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  sh(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'base');
  return dir;
}

/** Runs one turn through the real ledger hooks: baseline, start, `work`, settle. Returns the Receipt. */
async function turn(t: {after(fn: () => void): void}, dir: string, work: () => Promise<void>): Promise<LedgerEntry> {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ledger = new TurnLedger(db), appended: LedgerEntry[] = [];
  let start!: (run: RunStarted) => Promise<void> | void, settle!: (run: RunSettled) => Promise<void> | void;
  const context = {db: () => db, hooks: {
    onRunStarted: (fn: typeof start) => { start = fn; return () => undefined; },
    onRunSettled: (fn: typeof settle) => { settle = fn; return () => undefined; },
    onProviderEvent: () => () => undefined,
  }} as unknown as DomainContext;
  const off = attachTurnLedger(context, () => ledger, entry => appended.push(entry));
  t.after(off);
  const chat = {id: 'c', title: 'Chat'} as RunStarted['chat'];
  // git's reflog keeps whole seconds: let the setup commits fall before the turn.
  await delay(1100);
  db.prepare('INSERT INTO review_baselines VALUES (?,?,?,?,?,?)').run('r', 'c', null, await snapshotTree(dir), new Date().toISOString(), null);
  await start({chat, runId: 'r', cwd: dir});
  await work();
  await settle({chat, runId: 'r', status: 'completed'});
  assert.equal(appended.length, 1);
  return appended[0];
}

// Spec: MUS-SPEC-17-387A (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-387a)
test('#387 a checkout during a turn is not counted as the turn\'s edits; the agent\'s own edit and commit are', async t => {
  const dir = await repo(t);
  sh(dir, 'checkout', '-qb', 'other');
  for (const n of [1, 2, 3, 4, 5]) await writeFile(join(dir, `other${n}.txt`), `${n}\n`);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'five files');
  sh(dir, 'checkout', '-q', 'main');
  const receipt = await turn(t, dir, async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    sh(dir, 'checkout', '-q', 'other');
    await writeFile(join(dir, 'd.txt'), 'new\n');
    sh(dir, 'add', 'd.txt'); sh(dir, 'commit', '-qm', 'agent commit');
  });
  assert.deepEqual(receipt.files?.map(file => `${file.status}:${file.path}`).sort(), ['added:d.txt', 'modified:a.txt']);
});

// Spec: MUS-SPEC-17-387B (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-387b)
test('#387 a rebase during a turn adds none of the rebased-in files to the Receipt', async t => {
  const dir = await repo(t);
  sh(dir, 'checkout', '-qb', 'feature');
  sh(dir, 'checkout', '-q', 'main');
  for (const n of [1, 2, 3]) await writeFile(join(dir, `main${n}.txt`), `${n}\n`);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'main moves on');
  sh(dir, 'checkout', '-q', 'feature');
  const receipt = await turn(t, dir, async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    sh(dir, 'add', 'a.txt'); sh(dir, 'commit', '-qm', 'agent edit');
    sh(dir, 'rebase', 'main');
  });
  assert.deepEqual(receipt.files?.map(file => `${file.status}:${file.path}`), ['modified:a.txt']);
});
