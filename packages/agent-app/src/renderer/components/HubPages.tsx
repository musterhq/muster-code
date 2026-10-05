/** The hub pages (#115): Inbox (every chat and run that needs you), Roster (org graph + Pulse), an agent's page, Ledger
 *  (Receipts, Timeline, Activity, Costs) and Outputs. Muster's own rows and the linked Paperclip's render the same way,
 *  tagged by source. */
import { AgentGovernancePanel } from './AgentGovernance';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Box, Download, History, Inbox, Pause, Play, Square, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerSource, LedgerView, WorkspaceAgent, WorkspaceList, WorkspaceRun, WorkspaceSnapshot, WorkspaceSource } from '../../shared/domains/paperclip-protocol';
import { formatUsd } from '../../shared/model-catalog';
import { INBOX_BUCKETS, NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { dismissInboxItem, refreshWorkspace, rememberInboxRead, useHubRoute, useInboxDismissals } from '../hubStore';
import { applyView, buildActivity, decisionOrder, nextWake, overdueDecision, readColumns, readTidy, snoozedNow, tidyPlan, unreadNow, writeColumns, writeTidy, type ActivityItem, type InboxBucket, type InboxColumn, type InboxView, type TidyPolicy } from '../inboxModel';
import { GanttTimeline } from './Gantt';
import { activityCsv, downloadText } from '../activityCsv';
import { DecisionExtras, GateActions, InboxViews, SnoozeMenu, useInboxMeta } from './WorkInbox';
import { agoLabel, exactTime } from '../relativeTime';
import { openTaskInOrg } from '../orgStore';
import { readHideRoutine, writeHideRoutine } from '../runsModel';
import { shortcutsEnabled } from '../shortcuts';
import { notifyError, notifySuccess } from '../store';
import { useStore } from '../useStore';
import { AGENT_STATE_LABEL, ApprovalActions, INBOX_KIND_LABEL, Monogram, Receipt, RUN_STATE_LABEL, StateChip, TaskStatusIcon, agentTone, duration, explainRunError, runTone, type Tone } from './HubParts';
import { AuditRuns } from './AuditRuns';
import { CostsPanel } from './CostsPanel';
import { ReflectActions, ReflectionSection } from './ReflectionCoach';
import { InboxOptions } from './InboxOptions';
import { MailboxInbox } from './MailboxInbox';
import { ResourceState } from './ResourceState';
import { useRuntimeLabel } from './RosterGraph';
import { EditAgentButton, HireApprovalCard } from './RosterPanel';
import { Tip } from './Tooltip';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export interface HubNav { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; onOpenChat: (id: string) => void; /** Opens a run's own page (G14). */ onOpenRun?: (id: string) => void }

export function PageHeader({ title, detail, children }: { title: string; detail?: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  return <header className="ws-page-head"><div className="ws-page-title"><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{children && <div className="ws-page-actions">{children}</div>}</header>;
}
/** Paperclip rows, and Ledger entries imported from past chats (#190): those were never hash-chained, and say so. */
const SourceTag = ({ source }: { source: LedgerSource }) => source === 'paperclip' ? <span className="ws-source">{NAMES.paperclip}</span>
  : source === 'history' ? <span className="ws-source ws-source-history" title="Imported from saved chats and Muster Server activity from before the Ledger recorded turns. Not part of the verified chain.">Imported history</span> : null;

// --- Inbox -----------------------------------------------------------------------------------------------------------
const BUCKETS: { id: 'all' | InboxBucket; label: string }[] = [{ id: 'all', label: 'All' }, ...(Object.entries(INBOX_BUCKETS) as [InboxBucket, string][]).map(([id, label]) => ({ id, label }))];
const BUCKET_TONE: Record<InboxBucket, Tone> = { needs: 'accent', problems: 'danger', review: 'violet', done: 'ok', mentions: 'faint' };
const KIND_LABEL: Record<string, string> = { ...INBOX_KIND_LABEL, completed: 'Done', failed: 'Failed', interrupted: 'Interrupted' };
export function InboxPage({ snapshot, nav }: { snapshot: WorkspaceSnapshot | null; nav: HubNav }): React.ReactElement {
  const { snapshot: app } = useStore();
  const [filter, setFilter] = useState<'all' | InboxBucket>('all');
  const [group, setGroup] = useState('all');
  const [view, setView] = useState<InboxView>('all');
  const [clock, setClock] = useState(0);
  const { meta, reload: reloadMeta } = useInboxMeta();
  const dismissed = useInboxDismissals();
  const all = useMemo(() => buildActivity(app, snapshot, Date.now(), [], dismissed), [app?.chats, app?.attention, app?.projects, app?.folders, snapshot?.inbox, snapshot?.runs, dismissed]);
  // G36: items from runs that started by themselves (automations, timers, heartbeats) can be folded away.
  const [hideRoutine, setHideRoutine] = useState(() => readHideRoutine(globalThis.localStorage));
  const [columns, setColumns] = useState<Record<InboxColumn, boolean>>(() => readColumns(globalThis.localStorage));
  const [tidy, setTidy] = useState<TidyPolicy>(() => readTidy(globalThis.localStorage));
  const routine = all.filter(i => i.routine).length;
  const items = useMemo(() => hideRoutine ? all.filter(i => !i.routine) : all, [all, hideRoutine]);
  const owner = (taskId: string) => snapshot?.tasks.find(t => t.id === taskId)?.assigneeId;
  const now = Date.now();
  // A snooze ends by itself: one timeout for the earliest, never an interval.
  useEffect(() => { const at = nextWake(items, meta); if (at === null) return; const t = setTimeout(() => setClock(n => n + 1), Math.min(at - Date.now() + 250, 2 ** 31 - 1)); return () => clearTimeout(t); }, [items, meta, clock]);
  const inView = useMemo(() => applyView(items, view, meta, owner, now), [items, view, meta, snapshot?.tasks, clock]);
  const viewCounts = useMemo<Record<InboxView, number>>(() => ({ all: applyView(items, 'all', meta, owner, now).length, mine: applyView(items, 'mine', meta, owner, now).length, unread: applyView(items, 'unread', meta, owner, now).length, snoozed: applyView(items, 'snoozed', meta, owner, now).length }), [items, meta, snapshot?.tasks, clock]);
  const groups = useMemo(() => [...new Set(inView.map(i => i.group))], [inView]);
  const counts = useMemo(() => { const c = new Map<string, number>(); for (const i of inView) c.set(i.bucket, (c.get(i.bucket) ?? 0) + 1); return c; }, [inView]);
  const visible = decisionOrder(inView.filter(i => (filter === 'all' || i.bucket === filter) && (group === 'all' || i.group === group)), meta);
  // The tidy policy runs when the Inbox is on screen and its items change; it never touches a question, approval, review or problem.
  useEffect(() => {
    const plan = tidyPlan(all, tidy, i => unreadNow(i, meta));
    for (const i of plan.dismiss) void dismissInboxItem({ id: i.id, at: i.at, title: i.title }, { remember: false }).catch(() => undefined);
    if (plan.read.length) void invoke('work.inbox.read', { items: plan.read.map(i => ({ id: i.id, at: i.at })) }).then(reloadMeta, () => undefined);
  }, [all, tidy, meta]);
  const markRead = (list: readonly ActivityItem[]) => { if (!list.length) return; rememberInboxRead(list.filter(i => unreadNow(i, meta)).map(i => i.id)); void invoke('work.inbox.read', { items: list.map(i => ({ id: i.id, at: i.at })) }).then(reloadMeta, notifyError); };
  const unreadVisible = visible.filter(i => unreadNow(i, meta));
  const byGroup = new Map<string, ActivityItem[]>();
  for (const item of visible) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  const act = (item: ActivityItem) => { markRead([item]); open(item); };
  // C3: with a row focused (j / k), a or y dismisses it and r marks it read. Never while typing or with a modifier held.
  const rowKey = (e: React.KeyboardEvent, item: ActivityItem) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !shortcutsEnabled() || (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if (e.key === 'a' || e.key === 'y') { e.preventDefault(); const next = (e.currentTarget.closest('li')?.nextElementSibling ?? e.currentTarget.closest('li')?.previousElementSibling)?.querySelector<HTMLElement>('.ws-row-link'); void dismissInboxItem({ id: item.id, at: item.at, title: item.title }).catch(notifyError); next?.focus(); }
    else if (e.key === 'r') { e.preventDefault(); markRead([item]); }
    else if (e.key === 'U' && e.shiftKey) { e.preventDefault(); void invoke('work.inbox.unread', { items: [{ id: item.id }] }).then(reloadMeta, notifyError); }
    else if (e.key === 'x' && item.bucket === 'needs') { e.preventDefault(); void dismissInboxItem({ id: item.id, at: item.at, title: item.title }).catch(notifyError); }
  };
  const open = (item: ActivityItem) => item.action.kind === 'chat' ? nav.onOpenChat(item.action.chatId) : item.action.kind === 'task' ? (item.org ? void openTaskInOrg(item.org.id, item.action.taskId) : nav.onOpenTask(item.action.taskId)) : item.action.kind === 'agent' ? nav.onOpenAgent(item.action.agentId) : undefined;
  const label = (item: ActivityItem) => item.action.kind === 'chat' ? item.bucket === 'needs' ? 'Answer' : item.kind === 'interrupted' ? 'Continue' : item.bucket === 'problems' ? 'Retry' : 'Open chat' : item.action.kind === 'task' ? item.bucket === 'needs' ? 'Answer' : 'Open task' : item.action.kind === 'agent' ? 'Open agent' : '';
  const mailProject = group !== 'all' ? app?.projects.find(p => p.name === group)?.id ?? null : null;
  // Paperclip offline: never claim "all caught up" when its items could not be read.
  const offline = snapshot?.paperclip?.stale ? snapshot.paperclip : null;
  return <div className="ws-page" data-hide-type={columns.type ? undefined : ''} data-hide-detail={columns.detail ? undefined : ''} data-hide-age={columns.age ? undefined : ''}>
    <PageHeader title={NAMES.inbox} detail="Every chat and run that needs you, finished, or went wrong: folders, projects and your server, in one place."/>
    <InboxViews view={view} counts={viewCounts} onView={setView} unread={unreadVisible.length} onMarkAll={() => markRead(unreadVisible)}/>
    <div className="ws-filters" role="toolbar" aria-label="Filter the inbox">
      {BUCKETS.map(f => <button key={f.id} type="button" className="ws-filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{f.id === 'all' ? inView.length : counts.get(f.id) ?? 0}</span></button>)}
      {(routine > 0 || hideRoutine) && <button type="button" className="ws-filter" aria-pressed={hideRoutine} title="Hide items from automations, timers and heartbeats" onClick={() => { const next = !hideRoutine; setHideRoutine(next); writeHideRoutine(globalThis.localStorage, next); }}>Hide routine<span>{routine}</span></button>}
      <InboxOptions columns={columns} onColumns={next => { setColumns(next); writeColumns(globalThis.localStorage, next); }} tidy={tidy} onTidy={next => { setTidy(next); writeTidy(globalThis.localStorage, next); }}/>
      {groups.length > 1 && <select className="ws-select" aria-label="Group" value={group} onChange={e => setGroup(e.target.value)}><option value="all">Everything</option>{groups.map(g => <option key={g} value={g}>{g}</option>)}</select>}
    </div>
    {offline && <ResourceState kind="partial" compact message={/token|sign.?in|refused|expired|unauthori[sz]ed/i.test(offline.stale ?? '') ? `${offline.stale} Sign in again in Settings › Integrations; the items below are from the last copy.` : offline.cached ? `${NAMES.paperclip} can’t be reached, so its items are from the last copy and may be out of date.` : `${NAMES.paperclip} can’t be reached, so its questions, approvals and problems are not shown.`}/>}
    {visible.length === 0 ? <ResourceState kind="empty" icon={<Inbox size={20}/>} title={view === 'snoozed' ? 'Nothing snoozed' : view === 'unread' && items.length ? 'Nothing unread' : view === 'mine' && items.length ? 'Nothing is waiting on you' : items.length ? 'Nothing here' : offline ? 'Nothing from Muster needs you' : 'You’re all caught up'} message={view === 'snoozed' ? 'Snoozed items wait here and come back by themselves at the time you chose.' : items.length ? 'No items match these filters.' : offline ? `${NAMES.paperclip} items will show here once it can be reached.` : 'Questions and approvals from your agents, finished turns, reviews, problems and mail land here.'}/>
      : [...byGroup].map(([name, rows]) => <section key={name} className="ws-section" aria-label={name}>
        <h2 className="ws-group-title">{name}<span>{rows.length}</span></h2>
        <ul className="ws-rows">{rows.map(item => <li key={item.id}>
          <div className={`ws-row ws-inbox-row${unreadNow(item, meta) ? ' is-unread' : ''}`} data-overdue={overdueDecision(item, meta) || undefined} onKeyDown={e => rowKey(e, item)}>
            <span className="ws-unread-dot" aria-label={unreadNow(item, meta) ? 'Unread' : undefined}/>
            <StateChip tone={BUCKET_TONE[item.bucket]}>{KIND_LABEL[item.kind] ?? INBOX_BUCKETS[item.bucket]}</StateChip>
            <button type="button" className="ws-row-text ws-row-link" disabled={item.action.kind === 'none'} onClick={() => act(item)}><span className="ws-row-title">{item.title}</span><span className="ws-row-meta">{item.kind === 'failed_run' || item.kind === 'agent_error' ? explainRunError(item.why) : item.why}</span></button>
            {item.org ? <span className="ws-source ws-org-chip" title={`${item.org.name} · ${NAMES.server}`}>{item.org.name}</span> : item.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}
            <span className="ws-row-age" title={exactTime(item.at)}>{agoLabel(item.at)}</span>
            {item.action.kind !== 'none' && <button type="button" className="settings-button secondary ws-row-action" onClick={() => act(item)}>{label(item)}</button>}
            <GateActions item={item} onChanged={reloadMeta}/>
            <ReflectActions item={item} onChanged={() => void refreshWorkspace(true)}/>
            {item.source !== 'paperclip' && !item.id.startsWith('chat-') && <SnoozeMenu item={item} snoozed={snoozedNow(item, meta)} onChanged={reloadMeta}/>}
            <Tip label="Dismiss"><button type="button" className="icon-button ws-row-dismiss" aria-label={`Dismiss ${item.title}`} onClick={() => void dismissInboxItem({ id: item.id, at: item.at, title: item.title }).catch(notifyError)}><X size={13} aria-hidden="true"/></button></Tip>
          </div>
          {item.approval && <ApprovalActions approvalId={item.approval.id} verbs={item.approval.verbs}/>}
          {item.bucket === 'needs' && item.taskId && !item.id.startsWith('ws:gate:') && <DecisionExtras item={item} meta={meta.get(item.id)} agentName={item.agentId ? snapshot?.agents.find(a => a.id === item.agentId)?.name ?? null : null} onChanged={reloadMeta}/>}
        </li>)}</ul>
      </section>)}
    {mailProject && <section className="ws-section" aria-label="Project mailbox"><MailboxInbox projectId={mailProject} title="This project’s mailbox: reply to your agents here."/></section>}
  </div>;
}

// --- Pulse -------------------------------------------------------------------------------------------------------------
/** Pulse: queued / running / recently failed runs, with Pause all and Resume all per source. */
export function PulseBoard({ snapshot, nav, agentId, scoped = false, projectId }: { snapshot: WorkspaceSnapshot; nav: HubNav; agentId?: string; scoped?: boolean; projectId?: string }): React.ReactElement {
  const agents = useMemo(() => new Map(snapshot.agents.map(a => [a.id, a])), [snapshot.agents]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkspaceSource | null>(null);
  const day = Date.now() - 86_400_000;
  const runs = agentId ? snapshot.runs.filter(r => r.agentId === agentId) : snapshot.runs;
  const columns: { id: string; label: string; runs: WorkspaceRun[] }[] = [
    { id: 'queued', label: 'Queued', runs: runs.filter(r => r.status === 'queued') },
    { id: 'running', label: 'Running', runs: runs.filter(r => r.status === 'running') },
    { id: 'failed', label: 'Failed · 24h', runs: runs.filter(r => (r.status === 'failed' || r.status === 'timed_out') && Date.parse(r.finishedAt ?? r.createdAt) > day).slice(0, 12) },
  ];
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => { setBusy(key); try { await fn(); notifySuccess(done); } catch (cause) { notifyError(cause); } finally { setBusy(null); setConfirm(null); } };
  const sources: WorkspaceSource[] = agentId ? [] : [...(snapshot.agents.some(a => a.source === 'local' && a.pausable) ? ['local' as const] : []), ...(snapshot.agents.some(a => a.source === 'paperclip') ? ['paperclip' as const] : [])];
  // Paperclip agents belong to the company, not the project: pausing one here also stops its work on every other project.
  // The count is the whole company's (what Pause really stops), not just the agents on this page; a pending hire is never counted.
  const running = (s: WorkspaceSource) => s === 'paperclip' && snapshot.agentCounts ? snapshot.agentCounts.active : snapshot.agents.filter(a => a.source === s && a.pausable && a.status !== 'paused' && a.status !== 'terminated' && a.status !== 'pending').length;
  const paperclipAgents = (n: number) => `${n} server ${n === 1 ? 'agent' : 'agents'}`;
  const label = (s: WorkspaceSource) => scoped ? s === 'paperclip' ? `${paperclipAgents(running(s))} (org-wide)` : 'Muster agents on this project' : s === 'paperclip' ? snapshot.paperclip?.company?.name ?? NAMES.paperclip : 'Muster';
  const confirmText = (s: WorkspaceSource) => scoped && s === 'paperclip' ? `Pause ${paperclipAgents(running(s))}? They also stop working on other projects.`
    : `Pause every ${scoped ? 'Muster agent on this project' : `${label(s)} agent`}? Running work stops and nothing new starts until you resume.`;
  // From a project page: Muster's Pause stops that project's agents, Paperclip's stops the company's (its agents belong to the company).
  // Resume wakes only what that Pause paused, never an agent you paused on purpose or one waiting for approval.
  const pauseAll = (source: WorkspaceSource, paused: boolean) => invoke(paused ? 'paperclip.pauseAll' : 'paperclip.resumeAll', { source, ...(scoped && source === 'local' && projectId ? { projectId } : {}) });
  return <section className="ws-section" aria-label={NAMES.pulse}>
    <div className="ws-section-head"><h2>{NAMES.pulse}</h2>
      <div className="ws-page-actions">{sources.map(source => {
        // Resume wakes only what Muster's Pause stopped, so the button counts (and enables on) exactly those.
        const rc = snapshot.agentCounts?.resumable;
        const paused = rc ? source === 'paperclip' ? rc.paperclip : scoped && projectId ? rc.projects[projectId] ?? 0 : rc.local + Object.values(rc.projects).reduce((n, x) => n + x, 0) : snapshot.agents.filter(a => a.source === source && a.status === 'paused').length;
        return confirm === source
          ? <span key={source} className="ws-confirm"><span className="ws-confirm-text">{confirmText(source)}</span>
              <button type="button" className="settings-button secondary" onClick={() => setConfirm(null)}>Keep running</button>
              <button type="button" className="settings-button danger" disabled={busy !== null} onClick={() => void act(`pause:${source}`, () => pauseAll(source, true), `Paused ${label(source)}.`)}><Pause size={13}/>Pause</button></span>
          : <span key={source} className="ws-confirm"><button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => setConfirm(source)}><Pause size={13}/>Pause {label(source)}</button>
              <button type="button" className="settings-button secondary" disabled={busy !== null || paused === 0} onClick={() => void act(`resume:${source}`, () => pauseAll(source, false), `Resumed ${label(source)}.`)}><Play size={13}/>Resume{paused ? ` (${paused})` : ''}</button></span>;
      })}</div>
    </div>
    <div className="ws-board">{columns.map(col => <div key={col.id} className="ws-board-col" aria-label={col.label}>
      <h3>{col.label}<span>{col.runs.length}</span></h3>
      {col.runs.length === 0 ? <p className="ws-board-empty">{col.id === 'running' ? 'Nothing running.' : col.id === 'queued' ? 'Nothing queued.' : 'No failures in the last day.'}</p>
        : <ul>{col.runs.map(run => { const agent = run.agentId ? agents.get(run.agentId) : undefined, task = run.taskId ? tasks.get(run.taskId) : undefined; return <li key={run.id} className="ws-run">
          <Monogram name={agent?.name ?? '?'}/>
          <button type="button" className="ws-run-main" disabled={!task} onClick={() => task && nav.onOpenTask(task.id)}>
            <span className="ws-run-title">{agent?.name ?? 'Agent'}{task ? <> · <span className="ws-key">{task.key}</span> {task.title}</> : run.trigger ? ` · ${run.trigger}` : ''}</span>
            <span className="ws-run-meta"><StateChip tone={runTone(run.status)}>{RUN_STATE_LABEL[run.status]}</StateChip><span title={exactTime(run.startedAt ?? run.createdAt)}>{run.status === 'running' ? `for ${duration(run.startedAt, null)}` : run.finishedAt ? `${duration(run.startedAt, run.finishedAt) || '0s'} · ${agoLabel(run.finishedAt)}` : agoLabel(run.createdAt)}</span><SourceTag source={run.source}/></span>
            {run.error && <span className="ws-run-error">{explainRunError(run.error)}</span>}
          </button>
          {run.cancellable && <Tip label="Cancel run"><button type="button" className="icon-button" aria-label={`Cancel ${agent?.name ?? 'agent'} run`} disabled={busy !== null} onClick={() => void act(run.id, () => invoke('paperclip.run.cancel', { id: run.id }), 'Run cancelled.')}><Square size={13}/></button></Tip>}
        </li>; })}</ul>}
    </div>)}</div>
  </section>;
}

// --- Agent page ---------------------------------------------------------------------------------------------------------
export function AgentPage({ snapshot, agentId, nav }: { snapshot: WorkspaceSnapshot; agentId: string; nav: HubNav }): React.ReactElement {
  const runtimeLabel = useRuntimeLabel();
  const agent = snapshot.agents.find(a => a.id === agentId);
  const [busy, setBusy] = useState(false);
  if (!agent) return <ResourceState kind="empty" message="This agent is no longer on the Roster."/>;
  const boss = agent.reportsTo ? snapshot.agents.find(a => a.id === agent.reportsTo) : undefined;
  const reports = snapshot.agents.filter(a => a.reportsTo === agent.id);
  const tasks = snapshot.tasks.filter(t => t.assigneeId === agent.id).sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt));
  const toggle = async () => { setBusy(true); try { await invoke(agent.status === 'paused' ? 'paperclip.agent.resume' : 'paperclip.agent.pause', { id: agent.id }); notifySuccess(`${agent.name} ${agent.status === 'paused' ? 'resumed' : 'paused'}.`); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const chip = (a: WorkspaceAgent) => <button key={a.id} type="button" className="ws-chip-link" onClick={() => nav.onOpenAgent(a.id)}><Monogram name={a.name}/>{a.name}</button>;
  return <div className="ws-page">
    <PageHeader title={agent.name} detail={<>{agent.title ?? agent.role} · {runtimeLabel(agent.adapter)}{agent.model ? ` · ${agent.model}` : ''} <SourceTag source={agent.source}/></>}>
      <StateChip tone={agentTone(agent.status)}>{AGENT_STATE_LABEL[agent.status]}</StateChip>
      <EditAgentButton agent={agent} snapshot={snapshot}/>
      {agent.pausable && agent.status !== 'terminated' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void toggle()}>{agent.status === 'paused' ? <><Play size={13}/>Resume</> : <><Pause size={13}/>Pause</>}</button>}
    </PageHeader>
    {agent.status === 'pending' && agent.projectId && <HireApprovalCard agent={agent} snapshot={snapshot} projectId={agent.projectId}/>}
    {agent.instructions?.trim() ? <section className="ws-section" aria-label="Instructions"><h2 className="ws-group-title">Instructions</h2><p className="ws-agent-cap ws-pre">{agent.instructions.trim()}</p></section>
      : agent.capabilities && <p className="ws-agent-cap">{agent.capabilities}</p>}
    {agent.error && <ResourceState kind="partial" compact message={explainRunError(agent.error) ?? agent.error}/>}
    <dl className="ws-agent-facts">
      <div><dt>Reports to</dt><dd>{boss ? chip(boss) : <span className="ws-faint">Nobody</span>}</dd></div>
      <div><dt>Direct reports</dt><dd>{reports.length ? <span className="ws-chips">{reports.map(chip)}</span> : <span className="ws-faint">None</span>}</dd></div>
      <div><dt>Last active</dt><dd>{agent.lastActiveAt ? agoLabel(agent.lastActiveAt) : '—'}</dd></div>
    </dl>
    {agent.source === 'local' && agent.projectId && agent.memberId && agent.memberId !== 'agent' && <AgentGovernancePanel agent={agent} snapshot={snapshot}/>}
    {agent.source === 'local' && agent.projectId && agent.memberId && agent.memberId !== 'agent' && <ReflectionSection agent={agent}/>}
    <section className="ws-section" aria-label="Work"><h2 className="ws-group-title">Work<span>{tasks.length}</span></h2>
      {tasks.length === 0 ? <p className="ws-board-empty">No tasks assigned.</p> : <ul className="ws-rows">{tasks.slice(0, 30).map(t => <li key={t.id}><button type="button" className="ws-row" onClick={() => nav.onOpenTask(t.id)}>
        <TaskStatusIcon status={t.status}/><span className="ws-key">{t.key}</span><span className="ws-row-title ws-grow">{t.title}</span>{t.live && <span className="ws-live"><span className="ws-live-dot"/>live</span>}<span className="ws-row-age" title={exactTime(t.updatedAt)}>{agoLabel(t.updatedAt)}</span>
      </button></li>)}</ul>}
    </section>
    <PulseBoard snapshot={snapshot} nav={nav} agentId={agent.id}/>
  </div>;
}

// --- Ledger ----------------------------------------------------------------------------------------------------------------
type LedgerTab = 'receipts' | 'runs' | 'timeline' | 'activity' | 'costs';
/** `projectId` shows only that project's turns (the project page's Ledger tab), without its own page title. */
export function LedgerPage({ snapshot, nav, projectId }: { snapshot: WorkspaceSnapshot; nav: HubNav; projectId?: string }): React.ReactElement {
  const route = useHubRoute();
  const [tab, setTab] = useState<LedgerTab>(!projectId && route.page === 'ledger' && route.arg === 'costs' ? 'costs' : 'receipts');
  const [view, setView] = useState<LedgerView | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; setError(''); invoke('paperclip.ledger', { limit: projectId ? 1000 : 300 }).then(v => { if (live) { const mine = new Set(snapshot.tasks.map(t => t.id)); setView(projectId ? { ...v, entries: v.entries.filter(e => e.projectId === projectId || (e.taskId !== null && mine.has(e.taskId))) } : v); } }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [snapshot.fetchedAt, tick]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const chain = view?.chain;
  /** A project that lives on the connected server: its costs and activity come from that server, not from this Mac's Ledger. */
  const serverProject = Boolean(projectId) && (snapshot.projects.find(p => p.id === projectId) ?? snapshot.projects[0])?.source === 'paperclip';
  const [orgActivity, setOrgActivity] = useState(false);
  const imported = view?.entries.filter(e => e.source === 'history').length ?? 0;
  const [importing, setImporting] = useState(false);
  const importHistory = () => { setImporting(true); invoke('paperclip.ledger.backfill', {}).then(r => { notifySuccess(r.turns ? `Imported ${r.turns} past ${r.turns === 1 ? 'turn' : 'turns'} as history.` : 'No past turns to import.'); setTick(n => n + 1); }, notifyError).finally(() => setImporting(false)); };
  const TABS: [LedgerTab, string][] = [['receipts', NAMES.receipts], ['runs', 'Runs'], ['timeline', NAMES.timeline], ['activity', 'Activity'], ['costs', 'Costs']];
  return <div className="ws-page ws-page-fill">
    <PageHeader title={projectId ? '' : NAMES.ledger} detail={projectId ? '' : "One entry per agent turn: who ran, on which model, what it cost in tokens, which tools it used and which files it changed."}>
      <div className="ws-segmented is-inline" role="tablist" aria-label="Ledger views">{TABS.map(([t, l]) => <button key={t} type="button" role="tab" aria-selected={tab === t} className="ws-segment" onClick={() => setTab(t)}><span className="ws-segment-label">{l}</span></button>)}</div>
    </PageHeader>
    {chain && !(projectId && snapshot.projects[0]?.source === 'paperclip') && <p className="ws-chain" data-ok={chain.ok ? 'true' : 'false'}>{chain.ok ? chain.entries === 0 ? 'No Muster turns recorded yet' : `Muster chain verified · ${chain.entries} ${chain.entries === 1 ? 'entry' : 'entries'} · head ${chain.head.slice(0, 12)}` : `Chain broken at entry #${chain.brokenAt}: an entry was changed or removed after it was written.`}{imported ? ` · ${imported} imported from history (not chained)` : ''}</p>}
    {tab === 'activity' ? <>
        {serverProject && <div className="task-toolbar"><div className="ws-segmented is-inline" role="radiogroup" aria-label="Activity scope">
          <button type="button" role="radio" aria-checked={!orgActivity} className="ws-segment" onClick={() => setOrgActivity(false)}><span className="ws-segment-label">This project</span></button>
          <button type="button" role="radio" aria-checked={orgActivity} className="ws-segment" onClick={() => setOrgActivity(true)}><span className="ws-segment-label">Organisation activity</span></button></div></div>}
        {serverProject && orgActivity && <p className="ws-faint ws-activity-scope" role="status">Organisation activity: every event in {snapshot.paperclip?.company?.name ?? 'the whole organisation'}, not only this project’s.</p>}
        <ListPage kind="audit" embedded {...(projectId && !orgActivity ? { projectId } : {})}/>
      </>
      : tab === 'runs' ? <AuditRuns snapshot={snapshot} nav={nav}/>
      : tab === 'timeline' ? <GanttTimeline snapshot={snapshot} view={view} onOpenTask={nav.onOpenTask}/>
      : tab === 'costs' ? <CostsPanel {...(projectId ? { projectId } : {})} server={serverProject}/>
      : error ? <ResourceState kind="error" message="The ledger could not be read." detail={error} onRetry={() => setTick(n => n + 1)}/>
      : !view ? <ResourceState kind="loading" label="Reading the ledger" rows={4}/>
      : view.entries.length === 0 ? <ResourceState kind="empty" icon={<History size={20}/>} title="No turns recorded yet" message="Every agent turn from now on gets a receipt here. Past turns: Import history.">
          <div className="resource-state-actions"><button type="button" className="ws-import-history" disabled={importing} onClick={importHistory}><History size={12} aria-hidden="true"/>{importing ? 'Importing…' : 'Import history'}</button></div>
        </ResourceState>
      : <ul className="ws-ledger">{view.entries.map(e => { const t = e.taskId ? tasks.get(e.taskId) : undefined; return <li key={e.id}>
          <div className="ws-ledger-head"><Monogram name={e.agent}/><span className="ws-ledger-agent">{e.agent}</span>{t ? <button type="button" className="ws-link" onClick={() => nav.onOpenTask(t.id)}>{t.key} · {t.title}</button> : <span className="ws-grow"/>}<SourceTag source={e.source}/><span className="ws-row-age" title={exactTime(e.endedAt)}>{agoLabel(e.endedAt)}</span></div>
          <Receipt entry={e}/>
        </li>; })}</ul>}
  </div>;
}

// --- Outputs and the Ledger's activity list ---------------------------------------------------------------------------------
export function ListPage({ kind, embedded = false, projectId }: { kind: 'artifacts' | 'audit'; embedded?: boolean; projectId?: string }): React.ReactElement {
  const [data, setData] = useState<WorkspaceList | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; setData(null); setError(''); invoke('paperclip.list', { kind }).then(d => { if (live) setData(d); }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [kind, tick]);
  const Icon = kind === 'artifacts' ? Box : History;
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (data?.rows ?? []).filter(r => !projectId || r.projectId === projectId), [data, projectId]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 52, getItemKey: i => rows[i]?.id ?? i, overscan: 8 });
  return <div className={embedded ? 'ws-embedded-list' : 'ws-page ws-page-fill'}>
    {!embedded && <PageHeader title={NAMES.outputs} detail="Files, documents and work products your agents produced, newest first."/>}
    {data?.note && <ResourceState kind="partial" compact message={data.note}/>}
    {kind === 'audit' && rows.length > 0 && <div className="task-toolbar"><span className="task-toolbar-spacer"/><button type="button" className="settings-button secondary" onClick={() => downloadText(`muster-activity-${new Date().toISOString().slice(0, 10)}.csv`, activityCsv(rows))}><Download size={13}/>Export CSV</button></div>}
    {error ? <ResourceState kind="error" message="This list could not be loaded." detail={error} onRetry={() => setTick(n => n + 1)}/>
      : !data ? <ResourceState kind="loading" label="Loading" rows={4}/>
      : rows.length === 0 ? <ResourceState kind="empty" icon={<Icon size={20}/>} message={kind === 'artifacts' ? 'Files and documents your agents attach to tasks appear here.' : projectId ? 'No activity has been logged for this project yet.' : 'Task changes, runs and decisions are logged here as they happen.'}/>
      : <div ref={scroller} className="ws-virtual" role="list" aria-label={kind === 'artifacts' ? NAMES.outputs : 'Activity'}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => { const r = rows[item.index]; return <div key={r.id} role="listitem" className="ws-virtual-row" style={{ transform: `translateY(${item.start}px)`, height: 52 }}>
            <div className="ws-row is-static"><Icon size={15} aria-hidden="true" className="ws-row-icon"/>
              <span className="ws-row-text"><span className="ws-row-title">{r.title}</span><span className="ws-row-meta">{r.detail}</span></span>
              <SourceTag source={r.source}/>
              {r.at && <span className="ws-row-age" title={exactTime(r.at)}>{agoLabel(r.at)}</span>}
            </div>
          </div>; })}
        </div></div>}
  </div>;
}

