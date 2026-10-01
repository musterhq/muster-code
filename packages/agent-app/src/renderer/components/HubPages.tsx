/** The hub pages (#115): Inbox (every chat and run that needs you), Roster (org graph + Pulse), an agent's page, Ledger
 *  (Receipts, Timeline, Activity, Costs) and Outputs. Muster's own rows and the linked Paperclip's render the same way,
 *  tagged by source. */
import { AgentGovernancePanel } from './AgentGovernance';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Box, History, Inbox, Pause, Play, Square, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerSource, LedgerView, WorkspaceAgent, WorkspaceList, WorkspaceRun, WorkspaceSnapshot, WorkspaceSource } from '../../shared/domains/paperclip-protocol';
import { formatUsd } from '../../shared/model-catalog';
import { INBOX_BUCKETS, NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { dismissInboxItem, useInboxDismissals } from '../hubStore';
import { buildActivity, type ActivityItem, type InboxBucket } from '../inboxModel';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { useStore } from '../useStore';
import { AGENT_STATE_LABEL, ApprovalActions, INBOX_KIND_LABEL, Monogram, Receipt, RUN_STATE_LABEL, StateChip, TaskStatusIcon, agentTone, costText, duration, explainRunError, runTone, type Tone } from './HubParts';
import { MailboxInbox } from './MailboxInbox';
import { ResourceState } from './ResourceState';
import { useRuntimeLabel } from './RosterGraph';
import { EditAgentButton, HireApprovalCard } from './RosterPanel';
import { Tip } from './Tooltip';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export interface HubNav { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; onOpenChat: (id: string) => void }

export function PageHeader({ title, detail, children }: { title: string; detail?: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  return <header className="ws-page-head"><div className="ws-page-title"><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{children && <div className="ws-page-actions">{children}</div>}</header>;
}
/** Paperclip rows, and Ledger entries imported from past chats (#190): those were never hash-chained, and say so. */
const SourceTag = ({ source }: { source: LedgerSource }) => source === 'paperclip' ? <span className="ws-source">{NAMES.paperclip}</span>
  : source === 'history' ? <span className="ws-source ws-source-history" title="Imported from saved chats and Paperclip activity from before the Ledger recorded turns. Not part of the verified chain.">Imported history</span> : null;

// --- Inbox -----------------------------------------------------------------------------------------------------------
const BUCKETS: { id: 'all' | InboxBucket; label: string }[] = [{ id: 'all', label: 'All' }, ...(Object.entries(INBOX_BUCKETS) as [InboxBucket, string][]).map(([id, label]) => ({ id, label }))];
const BUCKET_TONE: Record<InboxBucket, Tone> = { needs: 'accent', problems: 'danger', review: 'violet', done: 'ok', mentions: 'faint' };
const KIND_LABEL: Record<string, string> = { ...INBOX_KIND_LABEL, completed: 'Done', failed: 'Failed', interrupted: 'Interrupted' };
export function InboxPage({ snapshot, nav }: { snapshot: WorkspaceSnapshot | null; nav: HubNav }): React.ReactElement {
  const { snapshot: app } = useStore();
  const [filter, setFilter] = useState<'all' | InboxBucket>('all');
  const [group, setGroup] = useState('all');
  const dismissed = useInboxDismissals();
  const items = useMemo(() => buildActivity(app, snapshot, Date.now(), [], dismissed), [app?.chats, app?.attention, app?.projects, app?.folders, snapshot?.inbox, dismissed]);
  const groups = useMemo(() => [...new Set(items.map(i => i.group))], [items]);
  const counts = useMemo(() => { const c = new Map<string, number>(); for (const i of items) c.set(i.bucket, (c.get(i.bucket) ?? 0) + 1); return c; }, [items]);
  const visible = items.filter(i => (filter === 'all' || i.bucket === filter) && (group === 'all' || i.group === group));
  const byGroup = new Map<string, ActivityItem[]>();
  for (const item of visible) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  const act = (item: ActivityItem) => item.action.kind === 'chat' ? nav.onOpenChat(item.action.chatId) : item.action.kind === 'task' ? nav.onOpenTask(item.action.taskId) : item.action.kind === 'agent' ? nav.onOpenAgent(item.action.agentId) : undefined;
  const label = (item: ActivityItem) => item.action.kind === 'chat' ? item.bucket === 'needs' ? 'Answer' : item.kind === 'interrupted' ? 'Continue' : item.bucket === 'problems' ? 'Retry' : 'Open chat' : item.action.kind === 'task' ? item.bucket === 'needs' ? 'Answer' : 'Open task' : item.action.kind === 'agent' ? 'Open agent' : '';
  const mailProject = group !== 'all' ? app?.projects.find(p => p.name === group)?.id ?? null : null;
  // Paperclip offline: never claim "all caught up" when its items could not be read.
  const offline = snapshot?.paperclip?.stale ? snapshot.paperclip : null;
  return <div className="ws-page">
    <PageHeader title={NAMES.inbox} detail="Every chat and run that needs you, finished, or went wrong: folders, projects and Paperclip, in one place."/>
    <div className="ws-filters" role="toolbar" aria-label="Filter the inbox">
      {BUCKETS.map(f => <button key={f.id} type="button" className="ws-filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{f.id === 'all' ? items.length : counts.get(f.id) ?? 0}</span></button>)}
      {groups.length > 1 && <select className="ws-select" aria-label="Group" value={group} onChange={e => setGroup(e.target.value)}><option value="all">Everything</option>{groups.map(g => <option key={g} value={g}>{g}</option>)}</select>}
    </div>
    {offline && <ResourceState kind="partial" compact message={offline.cached ? `${NAMES.paperclip} can’t be reached, so its items are from the last copy and may be out of date.` : `${NAMES.paperclip} can’t be reached, so its questions, approvals and problems are not shown.`}/>}
    {visible.length === 0 ? <ResourceState kind="empty" icon={<Inbox size={20}/>} title={items.length ? 'Nothing here' : offline ? 'Nothing from Muster needs you' : 'You’re all caught up'} message={items.length ? 'No items match these filters.' : offline ? `${NAMES.paperclip} items will show here once it can be reached.` : 'Questions and approvals from your agents, finished turns, reviews, problems and mail land here.'}/>
      : [...byGroup].map(([name, rows]) => <section key={name} className="ws-section" aria-label={name}>
        <h2 className="ws-group-title">{name}<span>{rows.length}</span></h2>
        <ul className="ws-rows">{rows.map(item => <li key={item.id}>
          <div className={`ws-row ws-inbox-row${item.unread ? ' is-unread' : ''}`}>
            <span className="ws-unread-dot" aria-label={item.unread ? 'Unread' : undefined}/>
            <StateChip tone={BUCKET_TONE[item.bucket]}>{KIND_LABEL[item.kind] ?? INBOX_BUCKETS[item.bucket]}</StateChip>
            <button type="button" className="ws-row-text ws-row-link" disabled={item.action.kind === 'none'} onClick={() => act(item)}><span className="ws-row-title">{item.title}</span><span className="ws-row-meta">{item.kind === 'failed_run' || item.kind === 'agent_error' ? explainRunError(item.why) : item.why}</span></button>
            {item.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}
            <span className="ws-row-age" title={exactTime(item.at)}>{agoLabel(item.at)}</span>
            {item.action.kind !== 'none' && <button type="button" className="settings-button secondary ws-row-action" onClick={() => act(item)}>{label(item)}</button>}
            <Tip label="Dismiss"><button type="button" className="icon-button ws-row-dismiss" aria-label={`Dismiss ${item.title}`} onClick={() => void dismissInboxItem(item).catch(notifyError)}><X size={13} aria-hidden="true"/></button></Tip>
          </div>
          {item.approval && <ApprovalActions approvalId={item.approval.id} verbs={item.approval.verbs}/>}
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
  const paperclipAgents = (n: number) => `${n} ${NAMES.paperclip} ${n === 1 ? 'agent' : 'agents'}`;
  const label = (s: WorkspaceSource) => scoped ? s === 'paperclip' ? `${paperclipAgents(running(s))} (company-wide)` : 'Muster agents on this project' : s === 'paperclip' ? snapshot.paperclip?.company?.name ?? NAMES.paperclip : 'Muster';
  const confirmText = (s: WorkspaceSource) => scoped && s === 'paperclip' ? `Pause ${paperclipAgents(running(s))}? They also stop working on other projects.`
    : `Pause every ${scoped ? 'Muster agent on this project' : `${label(s)} agent`}? Running work stops and nothing new starts until you resume.`;
  // From a project page: Muster's Pause stops that project's agents, Paperclip's stops the company's (its agents belong to the company).
  // Resume wakes only what that Pause paused, never an agent you paused on purpose or one waiting for approval.
  const pauseAll = (source: WorkspaceSource, paused: boolean) => invoke(paused ? 'paperclip.pauseAll' : 'paperclip.resumeAll', { source, ...(scoped && source === 'local' && projectId ? { projectId } : {}) });
  return <section className="ws-section" aria-label={NAMES.pulse}>
    <div className="ws-section-head"><h2>{NAMES.pulse}</h2>
      <div className="ws-page-actions">{sources.map(source => {
        const paused = source === 'paperclip' && snapshot.agentCounts ? snapshot.agentCounts.paused : snapshot.agents.filter(a => a.source === source && a.status === 'paused').length;
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
    <section className="ws-section" aria-label="Work"><h2 className="ws-group-title">Work<span>{tasks.length}</span></h2>
      {tasks.length === 0 ? <p className="ws-board-empty">No tasks assigned.</p> : <ul className="ws-rows">{tasks.slice(0, 30).map(t => <li key={t.id}><button type="button" className="ws-row" onClick={() => nav.onOpenTask(t.id)}>
        <TaskStatusIcon status={t.status}/><span className="ws-key">{t.key}</span><span className="ws-row-title ws-grow">{t.title}</span>{t.live && <span className="ws-live"><span className="ws-live-dot"/>live</span>}<span className="ws-row-age" title={exactTime(t.updatedAt)}>{agoLabel(t.updatedAt)}</span>
      </button></li>)}</ul>}
    </section>
    <PulseBoard snapshot={snapshot} nav={nav} agentId={agent.id}/>
  </div>;
}

// --- Ledger ----------------------------------------------------------------------------------------------------------------
type LedgerTab = 'receipts' | 'timeline' | 'activity' | 'costs';
/** `projectId` shows only that project's turns (the project page's Ledger tab), without its own page title. */
export function LedgerPage({ snapshot, nav, projectId }: { snapshot: WorkspaceSnapshot; nav: HubNav; projectId?: string }): React.ReactElement {
  const [tab, setTab] = useState<LedgerTab>('receipts');
  const [view, setView] = useState<LedgerView | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; setError(''); invoke('paperclip.ledger', { limit: projectId ? 1000 : 300 }).then(v => { if (live) { const mine = new Set(snapshot.tasks.map(t => t.id)); setView(projectId ? { ...v, entries: v.entries.filter(e => e.projectId === projectId || (e.taskId !== null && mine.has(e.taskId))) } : v); } }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [snapshot.fetchedAt, tick]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const costs = useMemo(() => {
    const rows = new Map<string, { agent: string; model: string; turns: number; input: number; output: number; cost: number | null; unpriced: number }>();
    for (const e of view?.entries ?? []) {
      const key = `${e.agent}|${e.model ?? ''}`, row = rows.get(key) ?? { agent: e.agent, model: e.model ?? '—', turns: 0, input: 0, output: 0, cost: null, unpriced: 0 };
      row.turns++; row.input += e.tokens?.input ?? 0; row.output += e.tokens?.output ?? 0;
      if (e.costUsd !== null) row.cost = (row.cost ?? 0) + e.costUsd; else row.unpriced++;
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output) || b.turns - a.turns);
  }, [view]);
  const chain = view?.chain;
  const imported = view?.entries.filter(e => e.source === 'history').length ?? 0;
  const [importing, setImporting] = useState(false);
  const importHistory = () => { setImporting(true); invoke('paperclip.ledger.backfill', {}).then(r => { notifySuccess(r.turns ? `Imported ${r.turns} past ${r.turns === 1 ? 'turn' : 'turns'} as history.` : 'No past turns to import.'); setTick(n => n + 1); }, notifyError).finally(() => setImporting(false)); };
  const TABS: [LedgerTab, string][] = [['receipts', NAMES.receipts], ['timeline', NAMES.timeline], ['activity', 'Activity'], ['costs', 'Costs']];
  return <div className="ws-page ws-page-fill">
    <PageHeader title={projectId ? '' : NAMES.ledger} detail={projectId ? '' : "One entry per agent turn: who ran, on which model, what it cost in tokens, which tools it used and which files it changed."}>
      <div className="ws-segmented is-inline" role="tablist" aria-label="Ledger views">{TABS.map(([t, l]) => <button key={t} type="button" role="tab" aria-selected={tab === t} className="ws-segment" onClick={() => setTab(t)}><span className="ws-segment-label">{l}</span></button>)}</div>
    </PageHeader>
    {chain && !(projectId && snapshot.projects[0]?.source === 'paperclip') && <p className="ws-chain" data-ok={chain.ok ? 'true' : 'false'}>{chain.ok ? chain.entries === 0 ? 'No Muster turns recorded yet' : `Muster chain verified · ${chain.entries} ${chain.entries === 1 ? 'entry' : 'entries'} · head ${chain.head.slice(0, 12)}` : `Chain broken at entry #${chain.brokenAt}: an entry was changed or removed after it was written.`}{imported ? ` · ${imported} imported from history (not chained)` : ''}</p>}
    {tab === 'activity' ? <ListPage kind="audit" embedded/>
      : tab === 'timeline' ? <Timeline snapshot={snapshot} view={view} onOpenTask={nav.onOpenTask}/>
      : error ? <ResourceState kind="error" message="The ledger could not be read." detail={error} onRetry={() => setTick(n => n + 1)}/>
      : !view ? <ResourceState kind="loading" label="Reading the ledger" rows={4}/>
      : view.entries.length === 0 ? <ResourceState kind="empty" icon={<History size={20}/>} title="No turns recorded yet" message="Every agent turn from now on gets a receipt here. Past turns: Import history.">
          <div className="resource-state-actions"><button type="button" className="ws-import-history" disabled={importing} onClick={importHistory}><History size={12} aria-hidden="true"/>{importing ? 'Importing…' : 'Import history'}</button></div>
        </ResourceState>
      : tab === 'costs' ? <ul className="ws-rows">{costs.map(r => <li key={`${r.agent}|${r.model}`}><div className="ws-row is-static"><Monogram name={r.agent}/><span className="ws-row-text"><span className="ws-row-title">{r.agent}</span><span className="ws-row-meta">{r.model}</span></span><span className="ws-row-count">{r.turns} {r.turns === 1 ? 'turn' : 'turns'}</span><span className="ws-row-count">{(r.input / 1000).toFixed(1)}k in · {(r.output / 1000).toFixed(1)}k out</span><span className="ws-row-count">{r.cost !== null ? (r.cost >= 0.01 ? formatUsd(r.cost) : '< $0.01') : 'unpriced'}{r.cost !== null && r.unpriced ? ` + ${r.unpriced} unpriced` : ''}</span></div></li>)}</ul>
      : <ul className="ws-ledger">{view.entries.map(e => { const t = e.taskId ? tasks.get(e.taskId) : undefined; return <li key={e.id}>
          <div className="ws-ledger-head"><Monogram name={e.agent}/><span className="ws-ledger-agent">{e.agent}</span>{t ? <button type="button" className="ws-link" onClick={() => nav.onOpenTask(t.id)}>{t.key} · {t.title}</button> : <span className="ws-grow"/>}<SourceTag source={e.source}/><span className="ws-row-age" title={exactTime(e.endedAt)}>{agoLabel(e.endedAt)}</span></div>
          <Receipt entry={e}/>
        </li>; })}</ul>}
  </div>;
}

/** Ledger › Timeline: one lane per agent, a dot per turn, and hand-off edges where work passed from one agent to another. */
function Timeline({ snapshot, view, onOpenTask }: { snapshot: WorkspaceSnapshot; view: LedgerView | null; onOpenTask: (id: string) => void }): React.ReactElement {
  const byId = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const handoffs = useMemo(() => snapshot.tasks.filter(t => t.parentId && byId.get(t.parentId)?.assigneeLabel && t.assigneeLabel && byId.get(t.parentId)!.assigneeLabel !== t.assigneeLabel)
    .map(t => ({ from: byId.get(t.parentId!)!.assigneeLabel!, to: t.assigneeLabel!, at: t.createdAt, task: t })), [snapshot.tasks, byId]);
  const turns = (view?.entries ?? []).map(e => ({ agent: e.agent, at: e.endedAt, outcome: e.outcome, taskId: e.taskId }));
  const lanes = [...new Set([...handoffs.flatMap(h => [h.from, h.to]), ...turns.map(t => t.agent)])];
  const times = [...handoffs.map(h => Date.parse(h.at)), ...turns.map(t => Date.parse(t.at))].filter(Number.isFinite);
  if (!lanes.length || !times.length) return <ResourceState kind="empty" icon={<History size={20}/>} message="Turns and hand-offs appear here as agents work."/>;
  const min = Math.min(...times), max = Math.max(...times, min + 60_000), W = 1000, LANE = 34, LEFT = 150, H = lanes.length * LANE + 36;
  const x = (iso: string) => LEFT + ((Date.parse(iso) - min) / (max - min)) * (W - LEFT - 20), y = (agent: string) => 18 + lanes.indexOf(agent) * LANE + LANE / 2;
  return <div className="ws-timeline" role="img" aria-label={`Timeline: ${turns.length} turns and ${handoffs.length} hand-offs across ${lanes.length} agents`}>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMinYMin meet">
      {lanes.map(l => <g key={l}><line className="ws-timeline-lane" x1={LEFT} x2={W - 10} y1={y(l)} y2={y(l)}/><text className="ws-timeline-label" x={LEFT - 12} y={y(l) + 4} textAnchor="end">{l}</text></g>)}
      {handoffs.map(h => <path key={`h:${h.task.id}`} className="ws-timeline-edge" d={`M${x(h.at)},${y(h.from)}C${x(h.at) + 24},${y(h.from)} ${x(h.at) + 24},${y(h.to)} ${x(h.at)},${y(h.to)}`}><title>{`${h.from} → ${h.to}: ${h.task.key} ${h.task.title}`}</title></path>)}
      {turns.map((t, i) => <circle key={i} className="ws-timeline-dot" data-outcome={runTone(t.outcome)} cx={x(t.at)} cy={y(t.agent)} r={4} onClick={() => t.taskId && onOpenTask(t.taskId)}><title>{`${t.agent} · ${t.outcome} · ${new Date(t.at).toLocaleString()}`}</title></circle>)}
      <text className="ws-timeline-label" x={LEFT} y={H - 6}>{new Date(min).toLocaleString()}</text>
      <text className="ws-timeline-label" x={W - 10} y={H - 6} textAnchor="end">{new Date(max).toLocaleString()}</text>
    </svg>
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
    {error ? <ResourceState kind="error" message="This list could not be loaded." detail={error} onRetry={() => setTick(n => n + 1)}/>
      : !data ? <ResourceState kind="loading" label="Loading" rows={4}/>
      : rows.length === 0 ? <ResourceState kind="empty" icon={<Icon size={20}/>} message={kind === 'artifacts' ? 'Files and documents your agents attach to tasks appear here.' : 'Task changes, runs and decisions are logged here as they happen.'}/>
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

