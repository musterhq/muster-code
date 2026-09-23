import React, {useEffect, useState} from 'react';
import {ChevronDown, ChevronRight, Loader2, Square, Wrench} from 'lucide-react';
import type {CiCheckLog, CiRepair} from '../../shared/domains/ci-protocol';
import {CI_REPAIR_DEFAULT_ATTEMPTS, CI_REPAIR_MAX_ATTEMPTS, ciRepairActive} from '../../shared/domains/ci-protocol';
import type {GitHubCheck} from '../../shared/domains/github-protocol';
import {invoke, subscribe} from '../bridge';
import {notifyError, selectChat} from '../store';
import {cleanIpcError} from './resourceErrors';
import './ci-repair.css';

/**
 * GIT-08 surfaces shared by the PR tab's Checks section and the summary card: a failing check's log
 * excerpt (read on expand) and the "Fix failing checks" repair task with its live progress and Stop.
 */

/** The latest repair for one PR, kept live by `ciRepair` events. */
export function useCiRepair(folderId: string, number: number): CiRepair | undefined {
  const [repair, setRepair] = useState<CiRepair>();
  useEffect(() => {
    let alive = true;
    setRepair(undefined);
    invoke('ci.repair.list', {folderId}).then(list => {
      if (!alive) return;
      const mine = (list ?? []).filter(item => item.number === number).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
      if (mine) setRepair(previous => previous && previous.startedAt > mine.startedAt ? previous : mine);
    }, () => undefined);
    const off = subscribe(event => { if (event.type === 'ciRepair' && event.repair.folderId === folderId && event.repair.number === number) setRepair(event.repair); });
    return () => { alive = false; off(); };
  }, [folderId, number]);
  return repair;
}

/** One failing check's log: collapsed by default, read once on first expand. */
export function CheckLogDisclosure({folderId, number, check, compact = false}: {folderId: string; number: number; check: GitHubCheck; compact?: boolean}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<CiCheckLog>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || log) return;
    let alive = true;
    invoke('ci.checkLog', {folderId, number, checkId: check.id}).then(value => { if (alive) setLog(value); }, cause => { if (alive) setError(cleanIpcError(cause) || 'The log could not be read.'); });
    return () => { alive = false; };
  }, [open, log, folderId, number, check.id]);
  return <div className={`ci-log${compact ? ' is-compact' : ''}`}>
    <button type="button" className="ci-log-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown size={12} aria-hidden="true"/> : <ChevronRight size={12} aria-hidden="true"/>}{open ? 'Hide log' : 'Show log'}
    </button>
    {open && <div className="ci-log-body" role="region" aria-label={`Log for ${check.name}`}>
      {!log && !error && <p className="ci-muted" role="status"><Loader2 size={11} className="ci-spin" aria-hidden="true"/>Reading the log…</p>}
      {error && <p className="ci-error" role="alert">{error}</p>}
      {log && (log.excerpt.trim() ? <pre className="ci-log-text">{log.truncated ? '…\n' : ''}{log.excerpt}</pre> : <p className="ci-muted">This check published no log text.</p>)}
      {log && log.annotations.length > 0 && <ul className="ci-annotations">{log.annotations.slice(0, compact ? 5 : 20).map((note, index) =>
        <li key={index} className={`is-${note.level}`}><code>{note.path}{note.line ? `:${note.line}` : ''}</code> {note.message.split('\n')[0]}</li>)}</ul>}
    </div>}
  </div>;
}

const PHASE_LABEL: Record<CiRepair['phase'], string> = {checking: 'Checking CI', fixing: 'Fixing', waiting: 'Waiting for CI', succeeded: 'Fixed', exhausted: 'Still failing', failed: 'Repair stopped', stopped: 'Stopped'};

/** "Fix failing checks" (bounded attempts) or, while one runs, its progress and Stop. The last finished repair's outcome stays visible. */
export function CiRepairControls({folderId, number, failing, chatId, compact = false}: {folderId: string; number: number; failing: number; chatId?: string; compact?: boolean}): React.ReactElement | null {
  const repair = useCiRepair(folderId, number);
  const [attempts, setAttempts] = useState(CI_REPAIR_DEFAULT_ATTEMPTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = repair && ciRepairActive(repair);
  if (!active && !failing && !repair) return null;
  const start = async () => {
    setBusy(true); setError('');
    try { await invoke('ci.repair.start', {folderId, number, maxAttempts: attempts, ...(chatId ? {chatId} : {})}); }
    catch (cause) { setError(cleanIpcError(cause)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!repair) return;
    setBusy(true);
    try { await invoke('ci.repair.stop', {id: repair.id}); } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const attempt = repair?.attempts.at(-1);
  return <div className={`ci-repair${compact ? ' is-compact' : ''}`} data-phase={repair?.phase}>
    {repair && <p className="ci-repair-status" role="status" aria-live="polite">
      {active && <Loader2 size={12} className="ci-spin" aria-hidden="true"/>}
      <strong>{PHASE_LABEL[repair.phase]}</strong>
      {attempt && <span className="ci-muted"> · attempt {attempt.n} of {repair.maxAttempts}</span>}
      <span className="ci-repair-message">{repair.message}</span>
    </p>}
    <div className="ci-repair-actions">
      {active
        ? <>
          {repair.chatId && <button type="button" className="pr-button is-quiet" onClick={() => void selectChat(repair.chatId!)}>Open chat</button>}
          <button type="button" className="pr-button" disabled={busy} onClick={() => void stop()}><Square size={11} aria-hidden="true"/>Stop</button>
        </>
        : failing > 0 && <>
          <label className="ci-attempts" title="The agent gets at most this many tries; it stops early when checks pass">
            <span>Attempts</span>
            <select value={attempts} disabled={busy} onChange={event => setAttempts(Number(event.target.value))} aria-label="Maximum repair attempts">
              {Array.from({length: CI_REPAIR_MAX_ATTEMPTS}, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <button type="button" className="pr-button is-primary" disabled={busy} onClick={() => void start()}>
            {busy ? <Loader2 size={12} className="ci-spin" aria-hidden="true"/> : <Wrench size={12} aria-hidden="true"/>}Fix failing checks
          </button>
        </>}
    </div>
    {error && <p className="ci-error" role="alert">{error}</p>}
  </div>;
}
