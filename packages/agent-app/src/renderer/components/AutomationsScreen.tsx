import { AlertCircle, ArrowLeft, CalendarClock, ChevronRight, MessageSquare, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatPermissionMode } from '../../shared/protocol';
import { AUTOMATION_AWAKE_NOTE, REPO_TRIGGER_EVENTS, type RepoTriggerEvent, type AutomationCatchUp, type AutomationMode, type AutomationOverlap, type AutomationPreview, type AutomationRun, type AutomationSaveInput, type AutomationSchedule, type AutomationView } from '../../shared/domains/automations-protocol';
import { invoke } from '../bridge';
import { closeSettings, loadAutomations, loadProviders, notifyError, notifySuccess, selectChat } from '../store';
import { focusComposer, restoreFocus } from '../focus';
import { compactAge, exactTime } from '../relativeTime';
import { useStore } from '../useStore';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './automations.css';
import { ResourceState } from './ResourceState';
import {Tip} from './Tooltip';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const TIME_ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone'); } catch { return [LOCAL_TZ]; } })();
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'], DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ACCESS: Record<ChatPermissionMode, string> = { 'read-only': 'Read only', workspace: 'Workspace', full: 'Full access' };
const STATUS: Record<AutomationRun['status'], string> = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Stopped', skipped: 'Skipped', missed: 'Missed' };
const TRIGGER: Record<AutomationRun['trigger'], string> = { schedule: 'Scheduled', manual: 'Run now', 'catch-up': 'Catch-up', watch: 'Files changed', repo: 'Repository event' };
type Repeat = 'interval' | 'daily' | 'cron' | 'watch' | 'repo';
const REPO_EVENT_LABEL: Record<RepoTriggerEvent, string> = { 'pr-opened': 'Pull request opened', 'pr-updated': 'Pull request updated', 'check-failed': 'Check failed', push: 'Push to branch' };

interface Draft {
  name: string; prompt: string; repeat: Repeat; minutes: number; time: string; days: number[]; expr: string; watchFolderId: string; timezone: string; repoEvents: RepoTriggerEvent[]; repoBranch: string;
  targetKind: 'new' | 'chat'; folderId: string; projectId: string; model: string; mode: AutomationMode; chatId: string;
  permissionMode: ChatPermissionMode; overlap: AutomationOverlap; catchUp: AutomationCatchUp; acknowledged: boolean;
}
const PRESETS: { label: string; apply: Partial<Draft> }[] = [
  { label: 'Every hour', apply: { repeat: 'interval', minutes: 60 } },
  { label: 'Every morning at 9', apply: { repeat: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  { label: 'Weekdays at 9', apply: { repeat: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } },
  { label: 'Mondays at 10', apply: { repeat: 'daily', time: '10:00', days: [1] } },
];
function blankDraft(folderId = ''): Draft {
  return { name: '', prompt: '', repeat: 'daily', minutes: 60, time: '09:00', days: [1, 2, 3, 4, 5], expr: '0 9 * * 1-5', watchFolderId: folderId, timezone: LOCAL_TZ, repoEvents: ['check-failed'], repoBranch: '', targetKind: 'new', folderId, projectId: '', model: '', mode: 'agent', chatId: '', permissionMode: 'workspace', overlap: 'skip', catchUp: 'one', acknowledged: false };
}
function draftOf(automation: AutomationView): Draft {
  const draft = { ...blankDraft(), name: automation.name, prompt: automation.prompt, timezone: automation.timezone, permissionMode: automation.permissionMode, overlap: automation.overlap, catchUp: automation.catchUp };
  const s = automation.schedule, t = automation.target;
  if (s.kind === 'interval') Object.assign(draft, { repeat: 'interval', minutes: s.minutes });
  else if (s.kind === 'daily') Object.assign(draft, { repeat: 'daily', time: s.time, days: s.days });
  else if (s.kind === 'cron') Object.assign(draft, { repeat: 'cron', expr: s.expr });
  else if (s.kind === 'repo') Object.assign(draft, { repeat: 'repo', watchFolderId: s.folderId, repoEvents: s.events, repoBranch: s.branch ?? '' });
  else Object.assign(draft, { repeat: 'watch', watchFolderId: s.folderId });
  if (t.kind === 'chat') Object.assign(draft, { targetKind: 'chat', chatId: t.chatId });
  else Object.assign(draft, { targetKind: 'new', folderId: t.folderId ?? '', projectId: t.projectId ?? '', mode: t.mode, model: t.providerId && t.model ? `${t.providerId}::${t.model}` : '' });
  return draft;
}
const scheduleOf = (draft: Draft): AutomationSchedule => draft.repeat === 'interval' ? { kind: 'interval', minutes: draft.minutes }
  : draft.repeat === 'daily' ? { kind: 'daily', time: draft.time, days: [...draft.days].sort((a, b) => a - b) }
  : draft.repeat === 'cron' ? { kind: 'cron', expr: draft.expr }
  : draft.repeat === 'repo' ? { kind: 'repo', folderId: draft.watchFolderId, events: REPO_TRIGGER_EVENTS.filter(event => draft.repoEvents.includes(event)), ...(draft.repoBranch.trim() ? { branch: draft.repoBranch.trim() } : {}) }
  : { kind: 'watch', folderId: draft.watchFolderId };
function targetOf(draft: Draft): AutomationSaveInput['target'] {
  if (draft.targetKind === 'chat') return { kind: 'chat', chatId: draft.chatId };
  const [providerId, ...model] = draft.model ? draft.model.split('::') : [];
  return { kind: 'new', mode: draft.mode, ...(draft.folderId ? { folderId: draft.folderId } : {}), ...(draft.projectId ? { projectId: draft.projectId } : {}), ...(providerId && model.length ? { providerId, model: model.join('::') } : {}) };
}
const inputOf = (draft: Draft): AutomationSaveInput => ({ name: draft.name.trim(), prompt: draft.prompt.trim(), schedule: scheduleOf(draft), timezone: draft.timezone, target: targetOf(draft), permissionMode: draft.permissionMode, overlap: draft.overlap, catchUp: draft.catchUp, ...(draft.permissionMode === 'full' ? { acknowledgeFullAccess: draft.acknowledged } : {}) });

/** "Mon, Sep 21, 9:00 AM" in the automation's zone, with the zone named when it is not this Mac's. */
function runTime(value: string, timeZone: string): string {
  try { return new Date(value).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, ...(timeZone !== LOCAL_TZ ? { timeZoneName: 'short' } : {}) }); } catch { return exactTime(value); }
}
function untilLabel(value: string, now: number): string {
  const ms = Date.parse(value) - now;
  if (ms < 60_000) return 'in under a minute';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `in ${minutes}m` : minutes < 48 * 60 ? `in ${Math.round(minutes / 60)}h` : `in ${Math.round(minutes / 1440)}d`;
}
function duration(run: AutomationRun): string | null {
  if (!run.startedAt || !run.endedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  return now;
}
const openChat = (chatId: string) => void selectChat(chatId).then(() => focusComposer());

function Editor({ editing, onDone }: { editing: AutomationView | null; onDone: (saved?: AutomationView) => void }): React.ReactElement {
  const state = useStore(), snapshot = state.snapshot;
  const folders = snapshot?.folders ?? [], projects = (snapshot?.projects ?? []).filter(project => !project.archived);
  const chats = (snapshot?.chats ?? []).filter(chat => !chat.archived);
  const [draft, setDraft] = useState<Draft>(() => editing ? draftOf(editing) : blankDraft(folders[0]?.id ?? ''));
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = useRef<HTMLInputElement>(null);
  const patch = (next: Partial<Draft>) => setDraft(current => ({ ...current, ...next }));
  useEffect(() => { name.current?.focus(); void loadProviders(); }, []);
  const models = useMemo(() => (state.providers.value ?? []).filter(provider => provider.available).flatMap(provider => provider.models.map(model => ({ value: `${provider.id}::${model.id}`, label: `${provider.name} · ${model.name}` }))), [state.providers.value]);
  const previewKey = JSON.stringify([scheduleOf(draft), draft.timezone, targetOf(draft), draft.permissionMode]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      invoke('automations.preview', { schedule: scheduleOf(draft), timezone: draft.timezone, target: targetOf(draft), permissionMode: draft.permissionMode })
        .then(result => { if (live) { setPreview(result); setPreviewError(''); } })
        .catch(cause => { if (live) { setPreview(null); setPreviewError(errorText(cause).replace(/^automations\.preview: /, '')); } });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [previewKey]);
  const chatAccessNote = draft.targetKind === 'chat' && draft.chatId ? (() => { const chat = chats.find(entry => entry.id === draft.chatId); return chat ? `Runs continue “${chat.title}” in its folder with its model.` : ''; })() : '';
  const ready = draft.name.trim() && draft.prompt.trim() && (draft.targetKind === 'new' || draft.chatId) && (draft.repeat !== 'daily' || draft.days.length) && (draft.repeat !== 'watch' || draft.watchFolderId) && (draft.repeat !== 'repo' || (draft.watchFolderId && draft.repoEvents.length)) && (draft.permissionMode !== 'full' || draft.acknowledged) && !previewError;
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      const saved = editing ? await invoke('automations.update', { ...inputOf(draft), id: editing.id }) : await invoke('automations.create', inputOf(draft));
      onDone(saved);
    } catch (cause) { setError(errorText(cause).replace(/^automations\.(create|update): /, '')); setBusy(false); }
  };
  const toggleDay = (day: number) => patch({ days: draft.days.includes(day) ? draft.days.filter(entry => entry !== day) : [...draft.days, day] });
  return (
    <form className="automation-editor" aria-label={editing ? `Edit ${editing.name}` : 'New automation'} onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); } }}>
      <header><h2>{editing ? 'Edit automation' : 'New automation'}</h2>{editing && <span className="automation-version">v{editing.version} · saving makes v{editing.version + 1}</span>}</header>
      <label>Name<input ref={name} type="text" value={draft.name} maxLength={120} placeholder="Morning triage" onChange={event => patch({ name: event.target.value })} /></label>
      <label>Prompt<textarea value={draft.prompt} rows={4} placeholder="Review issues opened since the last run and summarize anything urgent." onChange={event => patch({ prompt: event.target.value })} /></label>

      <fieldset>
        <legend>Schedule</legend>
        <div className="automation-presets" role="group" aria-label="Presets">
          {PRESETS.map(preset => <button key={preset.label} type="button" className="automation-chip" aria-pressed={JSON.stringify(scheduleOf({ ...draft, ...preset.apply })) === JSON.stringify(scheduleOf(draft))} onClick={() => patch(preset.apply)}>{preset.label}</button>)}
        </div>
        <div className="automation-row">
          <label>Repeat<select value={draft.repeat} onChange={event => patch({ repeat: event.target.value as Repeat })}>
            <option value="interval">Every few minutes or hours</option><option value="daily">On days at a time</option><option value="cron">Cron expression</option><option value="watch">When files change</option><option value="repo">On repository or CI events</option>
          </select></label>
          {draft.repeat === 'interval' && <label>Every<span className="automation-inline"><input type="number" min={5} max={10080} step={5} value={draft.minutes} onChange={event => patch({ minutes: Math.round(Number(event.target.value) || 0) })} /><span>minutes</span></span></label>}
          {draft.repeat === 'daily' && <label>At<input type="time" value={draft.time} required onChange={event => patch({ time: event.target.value })} /></label>}
          {draft.repeat === 'cron' && <label className="automation-grow">Cron<input type="text" className="automation-mono" value={draft.expr} spellCheck={false} placeholder="minute hour day month weekday" onChange={event => patch({ expr: event.target.value })} /></label>}
          {(draft.repeat === 'watch' || draft.repeat === 'repo') && <label className="automation-grow">{draft.repeat === 'repo' ? 'Repository folder' : 'Folder'}<select value={draft.watchFolderId} onChange={event => patch({ watchFolderId: event.target.value })}><option value="" disabled>Choose a folder</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
          {draft.repeat === 'repo' && draft.repoEvents.includes('push') && <label>Branch<input type="text" className="automation-mono" value={draft.repoBranch} placeholder="default branch" spellCheck={false} onChange={event => patch({ repoBranch: event.target.value })} /></label>}
          {draft.repeat !== 'interval' && draft.repeat !== 'watch' && draft.repeat !== 'repo' && <label className="automation-grow">Time zone<input type="text" list="automation-time-zones" value={draft.timezone} spellCheck={false} onChange={event => patch({ timezone: event.target.value })} /></label>}
        </div>
        {draft.repeat === 'daily' && <div className="automation-days" role="group" aria-label="Days">{DAY_LETTERS.map((letter, day) => <Tip key={day} label={DAY_NAMES[day]}><button type="button" aria-label={DAY_NAMES[day]} aria-pressed={draft.days.includes(day)} onClick={() => toggleDay(day)}>{letter}</button></Tip>)}</div>}
        {draft.repeat === 'repo' && <div className="automation-days automation-repo-events" role="group" aria-label="Repository events">{REPO_TRIGGER_EVENTS.map(event => <button key={event} type="button" aria-pressed={draft.repoEvents.includes(event)} onClick={() => patch({ repoEvents: draft.repoEvents.includes(event) ? draft.repoEvents.filter(item => item !== event) : [...draft.repoEvents, event] })}>{REPO_EVENT_LABEL[event]}</button>)}</div>}
        {draft.repeat === 'repo' && <p className="automation-help">Checks GitHub about once a minute through the GitHub CLI (slower after errors or rate limits). Events that arrive together start one run, and the run is told what happened.</p>}
        {draft.repeat === 'watch' && <p className="automation-help">Runs after files in the folder change, at most once a minute. Changes the run makes itself never trigger another.</p>}
        <datalist id="automation-time-zones">{TIME_ZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
        <div className="automation-preview" aria-live="polite">
          {previewError ? <p className="automation-error"><AlertCircle size={13} />{previewError}</p>
            : preview && <>
              {preview.next.length > 0 && <p><span>Next runs</span>{preview.next.map(time => <time key={time} dateTime={time}>{runTime(time, draft.timezone)}</time>)}</p>}
              {preview.issues.map(issue => <p key={issue} className="automation-warning"><AlertCircle size={13} />{issue}</p>)}
            </>}
        </div>
      </fieldset>

      <fieldset>
        <legend>Where it runs</legend>
        <div className="automation-segmented" role="radiogroup" aria-label="Target">
          <button type="button" role="radio" aria-checked={draft.targetKind === 'new'} onClick={() => patch({ targetKind: 'new' })}>New chat each run</button>
          <button type="button" role="radio" aria-checked={draft.targetKind === 'chat'} onClick={() => patch({ targetKind: 'chat', chatId: draft.chatId || chats[0]?.id || '' })}>Continue a chat</button>
        </div>
        {draft.targetKind === 'new' ? <div className="automation-row">
          <label>Folder<select value={draft.folderId} onChange={event => patch({ folderId: event.target.value })}><option value="">No folder</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
          {projects.length > 0 && <label>Project<select value={draft.projectId} onChange={event => patch({ projectId: event.target.value })}><option value="">None</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
          <label>Mode<select value={draft.mode} onChange={event => patch({ mode: event.target.value as AutomationMode })}><option value="agent">Agent</option><option value="plan">Plan</option><option value="ask">Ask</option></select></label>
          <label className="automation-grow">Model<select value={draft.model} onChange={event => patch({ model: event.target.value })}><option value="">Folder default</option>{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}{draft.model && !models.some(model => model.value === draft.model) && <option value={draft.model}>{draft.model.split('::').slice(1).join('::')}</option>}</select></label>
        </div> : <div className="automation-row">
          <label className="automation-grow">Chat<select value={draft.chatId} onChange={event => patch({ chatId: event.target.value })}><option value="" disabled>Choose a chat</option>{chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
        </div>}
        {chatAccessNote && <p className="automation-help">{chatAccessNote}</p>}
      </fieldset>

      <fieldset>
        <legend>Rules</legend>
        <div className="automation-row">
          <label>Access<select value={draft.permissionMode} onChange={event => patch({ permissionMode: event.target.value as ChatPermissionMode, acknowledged: false })}>{(Object.keys(ACCESS) as ChatPermissionMode[]).map(mode => <option key={mode} value={mode}>{ACCESS[mode]}</option>)}</select></label>
          <label>If still running<select value={draft.overlap} onChange={event => patch({ overlap: event.target.value as AutomationOverlap })}><option value="skip">Skip that run</option><option value="queue">Run after it finishes</option></select></label>
          <label>After sleep<select value={draft.catchUp} onChange={event => patch({ catchUp: event.target.value as AutomationCatchUp })}><option value="one">Run once to catch up</option><option value="none">Skip missed runs</option></select></label>
        </div>
        {draft.permissionMode === 'full' && <label className="automation-ack"><input type="checkbox" checked={draft.acknowledged} onChange={event => patch({ acknowledged: event.target.checked })} /><span>Unattended runs may read and change any file, run any command and use the network. Confirm again whenever this automation changes.</span></label>}
        <p className="automation-help">{AUTOMATION_AWAKE_NOTE}</p>
      </fieldset>

      {error && <p className="automation-error" role="alert"><AlertCircle size={13} />{error}</p>}
      <div className="automation-actions">
        <button type="button" className="settings-button secondary" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="settings-button" disabled={!ready || busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}</button>
      </div>
    </form>
  );
}

function History({ automation }: { automation: AutomationView }): React.ReactElement {
  const snapshot = useStore().snapshot;
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState('');
  // Refetch whenever the live list reports a different latest or active run.
  const marker = `${automation.lastRun?.id}:${automation.lastRun?.status}:${automation.activeRun?.id}:${automation.activeRun?.status}`;
  useEffect(() => {
    let live = true;
    invoke('automations.runs', { id: automation.id, limit: 50 }).then(value => { if (live) { setRuns(value); setError(''); } }).catch(cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [automation.id, marker]);
  if (error) return <ResourceState kind="error" compact message="Run history could not be loaded." detail={error}/>;
  if (!runs) return <ResourceState kind="loading" compact label="Loading history" rows={2}/>;
  if (!runs.length) return <p className="automation-help">No runs yet. {automation.nextRunAt ? `The first one is ${runTime(automation.nextRunAt, automation.timezone)}.` : 'Use Run now to try it.'}</p>;
  return (
    <ol className="automation-history" aria-label={`${automation.name} run history`}>
      {runs.map(run => {
        const chat = run.chatId ? snapshot?.chats.find(entry => entry.id === run.chatId) : undefined, took = duration(run);
        return (
          <li key={run.id} data-status={run.status}>
            <span className="automation-run-status" data-status={run.status}>{STATUS[run.status]}</span>
            <span className="automation-run-main">
              <span>{TRIGGER[run.trigger]} · <time dateTime={run.scheduledFor} title={exactTime(run.scheduledFor)}>{runTime(run.scheduledFor, automation.timezone)}</time>{took && ` · ${took}`}{run.version !== automation.version && ` · v${run.version}`}</span>
              {run.reason && <span className="automation-run-reason">{run.reason}</span>}
            </span>
            {run.chatId && (chat
              ? <button type="button" className="automation-link" onClick={() => openChat(run.chatId!)}><MessageSquare size={12} />{chat.title}</button>
              : <span className="automation-run-reason">Chat deleted</span>)}
          </li>
        );
      })}
    </ol>
  );
}

function AutomationRow({ automation, open, now, onToggle, onEdit }: { automation: AutomationView; open: boolean; now: number; onToggle: () => void; onEdit: () => void }): React.ReactElement {
  const [busy, setBusy] = useState<'run' | 'pause' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const act = async (kind: 'run' | 'pause' | 'delete') => {
    if (busy) return;
    if (kind === 'delete' && !confirming) { setConfirming(true); return; }
    setBusy(kind);
    try {
      if (kind === 'run') {
        const run = await invoke('automations.runNow', { id: automation.id });
        if (run.status === 'skipped') notifySuccess(`${automation.name}: ${run.reason ?? 'skipped'}`);
        else if (run.status === 'queued') notifySuccess(`${automation.name} will run when the current run finishes.`);
        else if (run.status === 'failed') notifyError(new Error(run.reason ?? 'The run could not start.'));
        else notifySuccess(`${automation.name} started`, run.chatId ? { label: 'Open chat', run: () => openChat(run.chatId!) } : undefined);
      } else if (kind === 'pause') await invoke(automation.paused ? 'automations.resume' : 'automations.pause', { id: automation.id });
      else await invoke('automations.delete', { id: automation.id });
    } catch (cause) { notifyError(cause); }
    finally { setBusy(null); setConfirming(false); }
  };
  const active = automation.activeRun, state = automation.paused ? 'paused' : active ? active.status : automation.issues.length ? 'issue' : 'scheduled';
  const when = automation.paused ? 'Paused' : active?.status === 'running' ? 'Running now' : active?.status === 'queued' ? 'Queued' : automation.nextRunAt ? `Next ${untilLabel(automation.nextRunAt, now)}` : automation.schedule.kind === 'watch' ? 'Watching for changes' : automation.schedule.kind === 'repo' ? 'Watching the repository' : 'Not scheduled';
  return (
    <li className="automation-item" data-open={open || undefined} data-state={state}>
      <div className="automation-item-head">
        <button type="button" className="automation-item-main" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={14} className="automation-caret" aria-hidden="true" />
          <span className="automation-state" data-state={state} aria-hidden="true" />
          <span className="automation-item-text">
            <span className="automation-item-name">{automation.name}</span>
            <span className="automation-item-meta">{automation.summary}{automation.nextRunAt && !automation.paused && <> · <time dateTime={automation.nextRunAt} title={exactTime(automation.nextRunAt)}>{runTime(automation.nextRunAt, automation.timezone)}</time></>}</span>
          </span>
          <span className="automation-item-when">{when}</span>
          {automation.lastRun && <span className="automation-run-status" data-status={automation.lastRun.status} title={`Last run ${exactTime(automation.lastRun.endedAt ?? automation.lastRun.scheduledFor)}`}>{STATUS[automation.lastRun.status]} {compactAge(automation.lastRun.endedAt ?? automation.lastRun.scheduledFor, now)}</span>}
        </button>
        <div className="automation-item-actions">
          <Tip label="Run now"><button type="button" className="icon-button" aria-label={`Run ${automation.name} now`} disabled={busy !== null} onClick={() => void act('run')}><Play size={14} /></button></Tip>
          <Tip label={automation.paused ? 'Resume' : 'Pause'}><button type="button" className="icon-button" aria-label={automation.paused ? `Resume ${automation.name}` : `Pause ${automation.name}`} disabled={busy !== null} onClick={() => void act('pause')}>{automation.paused ? <CalendarClock size={14} /> : <Pause size={14} />}</button></Tip>
          <Tip label="Edit"><button type="button" className="icon-button" aria-label={`Edit ${automation.name}`} onClick={onEdit}><Pencil size={14} /></button></Tip>
          {confirming
            ? <><button type="button" className="automation-confirm" onClick={() => setConfirming(false)}>Keep</button><button type="button" className="automation-confirm danger" disabled={busy !== null} onClick={() => void act('delete')}>Delete</button></>
            : <Tip label="Delete"><button type="button" className="icon-button" aria-label={`Delete ${automation.name}`} onClick={() => void act('delete')}><Trash2 size={14} /></button></Tip>}
        </div>
      </div>
      {open && <div className="automation-detail">
        {automation.issues.map(issue => <p key={issue} className="automation-warning"><AlertCircle size={13} />{issue}</p>)}
        <p className="automation-prompt">{automation.prompt}</p>
        <p className="automation-help">{automation.target.kind === 'chat' ? 'Continues one chat' : 'New chat each run'} · {ACCESS[automation.permissionMode]} · {automation.overlap === 'skip' ? 'skips overlapping runs' : 'queues overlapping runs'} · {automation.catchUp === 'one' ? 'catches up once after sleep' : 'skips missed runs'} · v{automation.version}</p>
        <History automation={automation} />
      </div>}
    </li>
  );
}

/** Automations (Codex "Scheduled"): recurring agent work with pause, run now and per-run history. */
export function AutomationsScreen(): React.ReactElement {
  const state = useStore(), now = useNow();
  const [editing, setEditing] = useState<AutomationView | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null), launcher = useRef<Element | null>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); void loadAutomations(); }, []);
  const automations = state.automations.value ?? [];
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };
  const done = (saved?: AutomationView) => {
    setEditing(null);
    if (saved) { setOpen(saved.id); notifySuccess(saved.version > 1 ? `Saved ${saved.name}` : `Created ${saved.name}`); }
  };
  return (
    <section className="settings-screen automations-screen" aria-label="Automations" onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); leave();
    }}>
      <header className="settings-topbar">
        <button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15} />Back to app</button>
        <span>Automations</span>
      </header>
      <div className="settings-scroll"><div className="settings-content">
        <div className="settings-title">
          <div>
            <h1>Automations</h1>
            <p>Recurring agent work on a schedule or when files change. {AUTOMATION_AWAKE_NOTE.split('. ')[0]}.</p>
          </div>
          {editing === null && <button className="settings-button" onClick={() => setEditing('new')}><Plus size={14} />New automation</button>}
        </div>
        {editing !== null && <Editor key={editing === 'new' ? 'new' : editing.id} editing={editing === 'new' ? null : editing} onDone={done} />}
        {state.automations.phase === 'error' && !automations.length
          ? <ResourceState kind="error" message="Automations could not be loaded." detail={state.automations.error} onRetry={() => void loadAutomations(true)}/>
          : state.automations.phase !== 'ready' && !automations.length ? <ResourceState kind="loading" label="Loading automations"/>
          : automations.length === 0 && editing === null ? <div className="automation-empty">
              <CalendarClock size={20} aria-hidden="true" />
              <p>No automations yet. Schedule a prompt to run every hour, on weekdays at 9, or whenever files change, in a fresh chat or one you pick.</p>
              <button type="button" className="settings-button secondary" onClick={() => setEditing('new')}><Plus size={14} />New automation</button>
            </div>
          : <ul className="automation-list" aria-label="Automations">
              {automations.map(automation => <AutomationRow key={automation.id} automation={automation} now={now} open={open === automation.id} onToggle={() => setOpen(open === automation.id ? null : automation.id)} onEdit={() => setEditing(automation)} />)}
            </ul>}
      </div></div>
    </section>
  );
}
