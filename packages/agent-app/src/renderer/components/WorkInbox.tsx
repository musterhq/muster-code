/**
 * The Inbox's work-layer parts (Wave 2): the Mine / Unread / Snoozed views with Mark all read (C4), Snooze on an item (C4),
 * and the decisions desk (G37): a decide-by date and "Ask <agent> for a recommendation" on what waits for you, plus the
 * approve / decline buttons for an automation run held at its approval gate (G20).
 */
import { Menu } from '@base-ui/react/menu';
import { AlarmClock, BellOff, Check, CheckCheck, Lightbulb, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { snoozeChoices } from '../../shared/snooze';
import { decisionOverdue, type InboxMeta, type Recommendation } from '../../shared/domains/work-protocol';
import { INBOX_VIEW_LABEL, type ActivityItem, type InboxMetaMap, type InboxView } from '../inboxModel';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { useWorkLoad } from '../workHooks';
import { StateChip } from './HubParts';
import { dayLabel } from './WorkParts';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

/** Read, snooze, decide-by and recommendations for every Inbox item, reloaded when the runtime says the Inbox changed. */
export function useInboxMeta(): { meta: InboxMetaMap; reload: () => void } {
  const { data, reload } = useWorkLoad(null, ['inbox'], () => invoke('work.inbox.state', {}));
  const meta = useMemo<InboxMetaMap>(() => new Map((data?.items ?? []).map((m: InboxMeta) => [m.id, m])), [data]);
  return { meta, reload };
}

export function InboxViews({ view, counts, onView, unread, onMarkAll }: { view: InboxView; counts: Record<InboxView, number>; onView: (v: InboxView) => void; unread: number; onMarkAll: () => void }): React.ReactElement {
  return <div className="ws-filters work-inbox-views" role="tablist" aria-label="Inbox views">
    {(Object.keys(INBOX_VIEW_LABEL) as InboxView[]).map(v => <button key={v} type="button" role="tab" aria-selected={view === v} className="ws-filter" aria-pressed={view === v} onClick={() => onView(v)}>{INBOX_VIEW_LABEL[v]}<span>{counts[v]}</span></button>)}
    <span className="task-toolbar-spacer"/>
    <button type="button" className="settings-button secondary" disabled={unread === 0} onClick={onMarkAll}><CheckCheck size={13}/>Mark all read</button>
  </div>;
}

/** Snooze one item: later today, tomorrow, next week or a date. It comes back by itself at that time. */
export function SnoozeMenu({ item, snoozed, onChanged }: { item: ActivityItem; snoozed: boolean; onChanged: () => void }): React.ReactElement {
  const [custom, setCustom] = useState('');
  const choices = useMemo(() => snoozeChoices().filter(c => c.until), []);
  const snooze = async (until: string | null) => { try { await invoke('work.inbox.snooze', { id: item.id, at: item.at, until }); onChanged(); await refreshWorkspace(); } catch (cause) { notifyError(cause); } };
  if (snoozed) return <Tip label="Wake now"><button type="button" className="icon-button" aria-label={`Wake ${item.title}`} onClick={() => void snooze(null)}><BellOff size={13}/></button></Tip>;
  return <Menu.Root>
    <Tip label="Snooze"><Menu.Trigger className="icon-button" aria-label={`Snooze ${item.title}`}><AlarmClock size={13}/></Menu.Trigger></Tip>
    <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} className="ui-menu-positioner"><Menu.Popup className="ui-menu work-snooze-menu">
      <Menu.Group><Menu.GroupLabel className="ui-menu-label">Snooze until</Menu.GroupLabel>
        {choices.map(c => <Menu.Item key={c.preset} onClick={() => void snooze(c.until!)}>{c.label}<small className="ws-faint"> {c.hint}</small></Menu.Item>)}
      </Menu.Group>
      <Menu.Separator/>
      <form className="work-label-form" onSubmit={e => { e.preventDefault(); const t = custom ? new Date(custom) : null; if (t && t.getTime() > Date.now()) void snooze(t.toISOString()); else notifyError(new Error('Choose a time in the future.')); }}>
        <input className="ws-input" type="datetime-local" aria-label="Snooze until a date and time" value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.stopPropagation()}/>
        <button type="submit" className="settings-button secondary" disabled={!custom}>Set</button>
      </form>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

const REC_TONE = { working: 'accent', ready: 'ok', failed: 'danger' } as const;
/** Under a Needs-you item: when you must decide by, the agent's recommendation, and the ask. */
export function DecisionExtras({ item, meta, agentName, onChanged }: { item: ActivityItem; meta: InboxMeta | undefined; agentName: string | null; onChanged: () => void }): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  if (!item.projectId || item.source !== 'muster') return null;
  const date = meta?.decideBy ?? '', rec: Recommendation | null = meta?.recommendation ?? null, overdue = decisionOverdue(meta?.decideBy ?? null);
  const setDate = async (value: string) => { try { await invoke('work.inbox.decideBy', { id: item.id, date: value || null }); onChanged(); } catch (cause) { notifyError(cause); } };
  const ask = async () => { setBusy(true); try { await invoke('work.inbox.recommend', { id: item.id, projectId: item.projectId!, taskId: item.taskId ?? null, title: item.title, why: item.why }); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const who = agentName ?? 'the agent';
  return <div className="work-decision" aria-label={`Decision tools for ${item.title}`}>
    <label className="work-decide-by" data-overdue={overdue || undefined}>
      <span>Decide by</span>
      <input className="ws-input" type="date" aria-label={`Decide ${item.title} by`} value={date} onChange={e => void setDate(e.target.value)}/>
      {date && <StateChip tone={overdue ? 'danger' : 'faint'}>{overdue ? `Overdue since ${dayLabel(date)}` : dayLabel(date)}</StateChip>}
    </label>
    <button type="button" className="settings-button secondary" disabled={busy || rec?.state === 'working'} onClick={() => void ask()}><Lightbulb size={13}/>{rec?.state === 'ready' ? `Ask ${who} again` : rec?.state === 'working' ? `${who} is thinking…` : `Ask ${who} for a recommendation`}</button>
    {rec && <div className="work-rec" data-state={rec.state} role="note"><div className="work-rec-head"><StateChip tone={REC_TONE[rec.state]}>{rec.state === 'ready' ? `${rec.agent}’s recommendation` : rec.state === 'working' ? `${rec.agent} is reading…` : 'No recommendation'}</StateChip><span className="ws-faint">{agoLabel(rec.at)}</span></div>{rec.text && <p>{rec.text}</p>}</div>}
  </div>;
}

/** An automation run held for your approval: approve it to start, or decline. */
export function GateActions({ item, onChanged }: { item: ActivityItem; onChanged: () => void }): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const gateId = item.id.startsWith('ws:gate:') ? item.id.slice('ws:gate:'.length) : null;
  if (!gateId) return null;
  const decide = async (approve: boolean) => {
    setBusy(true);
    try { await invoke('automations.gate.decide', { id: gateId, approve }); notifySuccess(approve ? 'Approved. The run is starting.' : 'Declined. Nothing was started.'); await refreshWorkspace(true); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <span className="work-gate"><button type="button" className="settings-button" disabled={busy} onClick={() => void decide(true)}><Check size={13}/>Approve</button><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false)}><X size={13}/>Decline</button></span>;
}
