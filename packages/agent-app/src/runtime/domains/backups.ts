/**
 * The backups domain (Wave 4, G30). Contract: shared/domains/backups-protocol.ts.
 * One timer, set for the next due time and nowhere else: no polling. A backup that is overdue when the app opens runs a couple of
 * minutes later, off the start-up path. After sleep the timer is re-set from the clock, so a laptop that slept through its time catches up.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BACKUP_SETTINGS, type BackupEntry, type BackupSettings, type BackupStatus } from '../../shared/domains/backups-protocol.ts';
import { BACKUP_DIR, cancelRestore, clearRestoreNote, lastRestoreNote, listBackups, pendingRestore, pruneBackups, removeBackup, stageRestore, takeBackup } from '../backups.ts';
import type { DomainContext, DomainModule } from './types.ts';

const MAX_TIMER_MS = 2 ** 31 - 1, HOUR = 3_600_000, STARTUP_DELAY_MS = 120_000;
/** Tests only: a fake clock, fake timers and a short start-up delay. Unset in the app. */
export const backupsClock: { now?: () => number; timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }; startupDelayMs?: number } = {};

export function createBackupsDomain(ctx: DomainContext): DomainModule {
  const file = join(ctx.dataDir, 'muster-backups.json');
  const now = () => backupsClock.now?.() ?? Date.now();
  const timers = () => backupsClock.timers ?? { set: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS)); t.unref?.(); return t; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  interface Stored { settings: BackupSettings; lastAt: string | null; lastError: string | null }
  let state: Stored = { settings: { ...DEFAULT_BACKUP_SETTINGS }, lastAt: null, lastError: null }, timer: unknown, running = false, disposed = false;
  try { if (existsSync(file)) { const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>; state = { settings: { ...DEFAULT_BACKUP_SETTINGS, ...(r.settings ?? {}) }, lastAt: r.lastAt ?? null, lastError: r.lastError ?? null }; } } catch { /* defaults */ }
  const save = () => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, file); try { chmodSync(file, 0o600); } catch { /* no modes */ } };
  const latest = (): number => { const b = listBackups(ctx.dataDir)[0]; return b ? Date.parse(b.createdAt) : state.lastAt ? Date.parse(state.lastAt) : 0; };
  const nextAt = (): number | null => state.settings.enabled ? latest() + state.settings.intervalHours * HOUR : null;

  function arm() {
    if (timer) { timers().clear(timer); timer = undefined; }
    if (disposed || !state.settings.enabled) return;
    const due = latest() + state.settings.intervalHours * HOUR;
    const wait = due <= now() ? (backupsClock.startupDelayMs ?? STARTUP_DELAY_MS) : due - now();
    timer = timers().set(() => { timer = undefined; void runNow('schedule').catch(() => undefined); }, wait);
  }
  async function runNow(trigger: BackupEntry['trigger']): Promise<BackupEntry> {
    if (running) throw new Error('A backup is already running.');
    running = true;
    try {
      const entry = takeBackup(ctx.dataDir, trigger, process.env.MUSTER_APP_VERSION ?? null, new Date(now()));
      pruneBackups(ctx.dataDir, state.settings.keep); clearRestoreNote(ctx.dataDir);
      state = { ...state, lastAt: entry.createdAt, lastError: null }; save();
      return entry;
    } catch (e) {
      state = { ...state, lastError: e instanceof Error ? e.message : String(e) }; save();
      throw e;
    } finally { running = false; arm(); ctx.emit({ type: 'backupsChanged' } as never); }
  }
  const status = (): BackupStatus => {
    const n = nextAt();
    return { settings: state.settings, backups: listBackups(ctx.dataDir), nextAt: n === null ? null : new Date(Math.max(n, now())).toISOString(), lastAt: state.lastAt, lastError: state.lastError, running,
      pendingRestore: pendingRestore(ctx.dataDir), lastRestore: lastRestoreNote(ctx.dataDir), dir: join(ctx.dataDir, BACKUP_DIR) };
  };
  arm();
  return {
    handlers: {
      'backups.status': () => status(),
      'backups.settings.set': input => {
        const next = { ...state.settings };
        if (input.enabled !== undefined) next.enabled = input.enabled === true;
        if (input.intervalHours !== undefined) { const v = Number(input.intervalHours); if (!Number.isInteger(v) || v < 6 || v > 168) throw new Error('Back up every 6 to 168 hours.'); next.intervalHours = v; }
        if (input.keep !== undefined) { const v = Number(input.keep); if (!Number.isInteger(v) || v < 1 || v > 30) throw new Error('Keep 1 to 30 backups.'); next.keep = v; }
        state = { ...state, settings: next }; save(); pruneBackups(ctx.dataDir, next.keep); arm();
        return status();
      },
      'backups.run': () => runNow('manual'),
      'backups.restore': input => { if (typeof input.id !== 'string') throw new Error('Choose a backup.'); stageRestore(ctx.dataDir, input.id); ctx.emit({ type: 'backupsChanged' } as never); return status(); },
      'backups.restore.cancel': () => { cancelRestore(ctx.dataDir); ctx.emit({ type: 'backupsChanged' } as never); return status(); },
      'backups.remove': input => { if (typeof input.id !== 'string') throw new Error('Choose a backup.'); if (pendingRestore(ctx.dataDir)?.id === input.id) throw new Error('This backup is staged for a restore. Cancel the restore first.'); removeBackup(ctx.dataDir, input.id); arm(); return status(); },
    },
    power: event => { if (event.state === 'resume') arm(); },
    dispose() { disposed = true; if (timer) timers().clear(timer); timer = undefined; },
  };
}
