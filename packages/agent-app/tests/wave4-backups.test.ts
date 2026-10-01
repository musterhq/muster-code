/** Wave 4: G30 scheduled backups: consistent copies, 0600 files, retention, verified restore applied at the next start, one timer. */
import assert from 'node:assert/strict';
import { statSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyPendingRestore, listBackups, takeBackup, verifyBackup, stageRestore } from '../src/runtime/backups.ts';
import { backupsClock, createBackupsDomain } from '../src/runtime/domains/backups.ts';
import { FakeClock } from './wave1-harness.ts';

async function dir(t: import('node:test').TestContext) {
  const d = await mkdtemp(join(tmpdir(), 'muster-w4-bak-')); t.after(async () => { backupsClock.now = undefined; backupsClock.timers = undefined; backupsClock.startupDelayMs = undefined; await rm(d, { recursive: true, force: true }); });
  const a = new DatabaseSync(join(d, 'muster-agent.sqlite')); a.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('one');");
  const b = new DatabaseSync(join(d, 'muster-project-tasks.sqlite')); b.exec("CREATE TABLE tasks(v TEXT); INSERT INTO tasks VALUES('task');");
  t.after(() => { for (const x of [a, b]) try { x.close(); } catch { /* closed by the test */ } });
  return { d, a, b };
}
const ctx = (d: string) => ({ dataDir: d, emit() {} }) as never;

test('G30: a backup copies every database consistently, restricts permissions and verifies', async t => {
  const { d, a } = await dir(t);
  const e = takeBackup(d, 'manual', '0.3.0');
  assert.deepEqual(e.files.map(f => f.name), ['muster-agent.sqlite', 'muster-project-tasks.sqlite']);
  const root = join(d, 'backups/scheduled');
  assert.equal(statSync(root).mode & 0o777, 0o700);
  for (const f of e.files) assert.equal(statSync(join(root, e.id, f.name)).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, e.id, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(new DatabaseSync(join(root, e.id, 'muster-agent.sqlite'), { readOnly: true }).prepare('SELECT v FROM t').get()!.v, 'one');
  assert.ok(verifyBackup(d, e.id).verified);
  a.exec("INSERT INTO t VALUES('two')");
  // A tampered file is refused.
  writeFileSync(join(root, e.id, 'muster-project-tasks.sqlite'), 'garbage');
  assert.throws(() => verifyBackup(d, e.id), /changed after it was made/);
  assert.throws(() => verifyBackup(d, '../../etc'), /does not exist/);
});

test('G30: the schedule uses one timer, keeps N, and survives disabling', async t => {
  const { d } = await dir(t);
  const clock = new FakeClock(); backupsClock.now = clock.now; backupsClock.timers = { set: clock.set, clear: clock.clear }; backupsClock.startupDelayMs = 1000;
  const m = createBackupsDomain(ctx(d));
  const status = () => m.handlers['backups.status']!({}) as any;
  assert.equal(status().backups.length, 0); assert.ok(status().nextAt, 'on by default');
  assert.equal(clock.pending, 1, 'exactly one timer');
  await m.handlers['backups.settings.set']!({ keep: 2, intervalHours: 6 });
  await clock.advance(1500); await new Promise(r => setTimeout(r, 400));
  assert.equal(status().backups.length, 1); assert.equal(status().backups[0].trigger, 'schedule');
  assert.equal(clock.pending, 1, 'one timer for the next backup');
  for (let i = 0; i < 3; i++) { await m.handlers['backups.run']!({}); await clock.advance(1000); }
  assert.equal(status().backups.length, 2, 'retention keeps two');
  await m.handlers['backups.settings.set']!({ enabled: false });
  assert.equal(clock.pending, 0); assert.equal(status().nextAt, null);
  assert.throws(() => m.handlers['backups.settings.set']!({ intervalHours: 2 }), /6 to 168/);
  assert.throws(() => m.handlers['backups.settings.set']!({ keep: 99 }), /1 to 30/);
  m.dispose?.();
});

test('G30: a restore is staged, applied at the next start, and the replaced data is kept', async t => {
  const { d, a } = await dir(t);
  const m = createBackupsDomain(ctx(d));
  const e = await m.handlers['backups.run']!({}) as { id: string };
  a.exec("INSERT INTO t VALUES('two')");
  const st = await m.handlers['backups.restore']!({ id: e.id }) as any;
  assert.equal(st.pendingRestore.id, e.id);
  await assert.rejects(Promise.resolve().then(() => m.handlers['backups.remove']!({ id: e.id })), /staged for a restore/);
  a.close();
  const note = applyPendingRestore(d)!;
  assert.match(note, /Restored the backup/);
  const live = new DatabaseSync(join(d, 'muster-agent.sqlite'), { readOnly: true });
  assert.deepEqual(live.prepare('SELECT v FROM t').all().map(r => r.v), ['one']); live.close();
  const kept = join(d, 'backups/before-restore'); assert.equal(readdirSync(kept).length, 1);
  assert.equal(applyPendingRestore(d), null, 'applied once');
  assert.ok(existsSync(join(d, 'backups/restore-result.txt')));
  assert.equal(listBackups(d).length, 1);
  m.dispose?.();
  // A corrupted backup staged by hand is dropped, never half-applied.
  const e2 = takeBackup(d, 'manual', null); stageRestore(d, e2.id); writeFileSync(join(d, 'backups/scheduled', e2.id, 'muster-agent.sqlite'), 'x');
  assert.match(applyPendingRestore(d)!, /dropped/);
  assert.equal(new DatabaseSync(join(d, 'muster-agent.sqlite'), { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM t').get()!.n, 1);
  void readFileSync;
});
