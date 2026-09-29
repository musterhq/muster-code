/**
 * Dashboard (#132, #193), laid out like Paperclip's:
 * - live agent cards (what each agent is working on now, or when it finished);
 * - four metric tiles;
 * - 14-day charts: run activity, tasks by status and success rate;
 * - recent activity and recent tasks.
 * The numbers are aggregated in SQL in the runtime (`paperclip.dashboard`). They refresh on the same workspace events
 * as every other hub page and never on a timer. Spend with no known price reads "Unpriced", never $0.
 */
import { Bot, CircleDot, DollarSign, ShieldCheck } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { DashboardData, DashboardDay, WorkspaceAgent, WorkspaceRun, WorkspaceSnapshot, WorkspaceStatus } from '../../shared/domains/paperclip-protocol';
import { STATUS_LABEL } from '../../shared/domains/paperclip-protocol';
import { formatUsd } from '../../shared/model-catalog';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { openHub } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { Monogram, TaskStatusIcon } from './HubParts';
import { PageHeader, type HubNav } from './HubPages';
import { ResourceState } from './ResourceState';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const shortDay = (day: string) => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };

/** The four tiles' numbers from the snapshot the hub already holds; the same counts the Tasks page and Pulse show. */
export function dashboardTiles(snapshot: WorkspaceSnapshot, data: DashboardData | null) {
  const agents = snapshot.agents.filter(a => a.role !== 'board' && a.status !== 'terminated' && a.status !== 'pending');
  const count = (s: WorkspaceAgent['status']) => agents.filter(a => a.status === s).length;
  const open = snapshot.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
  const spend = data?.spend;
  return {
    agents: { value: agents.length, detail: `${count('running')} running, ${count('paused')} paused, ${count('error')} ${count('error') === 1 ? 'error' : 'errors'}` },
    tasks: { value: snapshot.tasks.filter(t => t.status === 'in_progress').length, detail: `${open.length} open, ${open.filter(t => t.status === 'blocked').length} blocked` },
    spend: !spend ? { value: '…', detail: 'Reading the Ledger' }
      : spend.usd === null ? { value: spend.unpricedTurns ? 'Unpriced' : formatUsd(0), detail: spend.unpricedTurns ? `${spend.unpricedTurns} unpriced ${spend.unpricedTurns === 1 ? 'turn' : 'turns'} this month` : 'No agent turns this month' }
      : { value: formatUsd(spend.usd), detail: `${spend.pricedTurns} priced ${spend.pricedTurns === 1 ? 'turn' : 'turns'}${spend.unpricedTurns ? ` + ${spend.unpricedTurns} unpriced` : ''} this month` },
    approvals: { value: snapshot.inbox.filter(i => i.kind === 'approval').length, detail: 'Waiting for your decision' },
  };
}

/** Each agent's latest run: working now, or finished N ago. Agents that never ran are left out. */
export function agentCards(snapshot: WorkspaceSnapshot, limit = 8): { agent: WorkspaceAgent; run: WorkspaceRun }[] {
  const latest = new Map<string, WorkspaceRun>();
  for (const run of snapshot.runs) if (run.agentId && (!latest.has(run.agentId) || run.status === 'running' && latest.get(run.agentId)!.status !== 'running')) latest.set(run.agentId, run);
  const byId = new Map(snapshot.agents.map(a => [a.id, a]));
  return [...latest].flatMap(([id, run]) => { const agent = byId.get(id); return agent ? [{ agent, run }] : []; })
    .sort((a, b) => Number(b.run.status === 'running') - Number(a.run.status === 'running') || (b.run.finishedAt ?? b.run.createdAt).localeCompare(a.run.finishedAt ?? a.run.createdAt)).slice(0, limit);
}

/** `projectId` scopes it to one project (the project page's Dashboard tab), where it renders without its own page header. */
export function DashboardPage({ snapshot, nav, projectId }: { snapshot: WorkspaceSnapshot; nav: HubNav; projectId?: string }): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  // Refetched when the workspace snapshot changes (its events), never on a timer.
  useEffect(() => { let live = true; setError(''); invoke('paperclip.dashboard', { utcOffsetMinutes: -new Date().getTimezoneOffset(), ...(projectId ? { projectId } : {}) }).then(d => { if (live) setData(d); }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [snapshot.fetchedAt, tick, projectId]);
  const tiles = dashboardTiles(snapshot, data);
  const cards = useMemo(() => agentCards(snapshot), [snapshot.runs, snapshot.agents]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const recent = useMemo(() => [...snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10), [snapshot.tasks]);
  return <div className={`ws-page dash${projectId ? ' is-embedded' : ''}`}>
    {!projectId && <PageHeader title={NAMES.dashboard} detail="What your agents are doing, what it costs, and how the last two weeks went, across Muster and Paperclip."/>}
    <section className="ws-section" aria-label="Agents">
      <h2 className="dash-label">Agents</h2>
      {cards.length === 0 ? <ResourceState kind="empty" compact icon={<Bot size={18}/>} message={snapshot.agents.some(a => a.role !== 'board') ? 'No agent has run yet. Start a task from a project and it shows here while it works.' : `No agents yet. Add one on a project’s ${NAMES.roster} tab.`}>
          <div className="resource-state-actions"><button type="button" className="settings-button secondary" onClick={() => openHub('roster')}>Open {NAMES.roster}</button></div>
        </ResourceState>
        : <div className="dash-agents">{cards.map(({ agent, run }) => { const task = run.taskId ? tasks.get(run.taskId) : undefined; const working = run.status === 'running';
          return <article key={agent.id} className="dash-agent" data-live={working || undefined}>
            <header><Monogram name={agent.name}/><button type="button" className="ws-name-link" onClick={() => nav.onOpenAgent(agent.id)}>{agent.name}</button>{working && <span className="ws-live"><span className="ws-live-dot"/>live</span>}</header>
            {task ? <button type="button" className="dash-agent-task" onClick={() => nav.onOpenTask(task.id)}><TaskStatusIcon status={task.status} size={13}/><span className="ws-row-title">{task.title}</span><span className="ws-key">{task.key}</span></button>
              : <p className="dash-agent-task is-static"><span className="ws-row-title">{run.trigger ?? 'Agent run'}</span></p>}
            <footer title={exactTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}>{working ? `Working now · started ${agoLabel(run.startedAt ?? run.createdAt)}` : `${run.status === 'failed' ? 'Failed' : 'Finished'} ${agoLabel(run.finishedAt ?? run.createdAt)}`}</footer>
          </article>; })}</div>}
      {cards.length > 0 && <button type="button" className="ws-link dash-more" onClick={() => openHub('ledger')}>View all runs</button>}
    </section>
    <section className="dash-tiles" aria-label="Metrics">
      <Tile icon={<Bot size={15}/>} label="Agents enabled" value={tiles.agents.value} detail={tiles.agents.detail} onClick={() => openHub('roster')}/>
      <Tile icon={<CircleDot size={15}/>} label="Tasks in progress" value={tiles.tasks.value} detail={tiles.tasks.detail} onClick={() => openHub('tasks')}/>
      <Tile icon={<DollarSign size={15}/>} label="Month spend" value={tiles.spend.value} detail={tiles.spend.detail} onClick={() => openHub('ledger')}/>
      <Tile icon={<ShieldCheck size={15}/>} label="Pending approvals" value={tiles.approvals.value} detail={tiles.approvals.detail} onClick={() => openHub('inbox')}/>
    </section>
    {error ? <ResourceState kind="error" message="The Dashboard’s numbers could not be read." detail={error} onRetry={() => setTick(n => n + 1)}/>
      : !data ? <ResourceState kind="loading" label="Reading the Ledger" rows={3}/>
      : <section className="dash-charts" aria-label="Last 14 days">
          <div className="dash-card"><RunActivityChart days={data.runs}/></div>
          <div className="dash-card"><TasksByStatusChart data={data}/></div>
          <div className="dash-card"><SuccessRateChart days={data.runs}/></div>
        </section>}
    <div className="dash-lists">
      <section className="ws-section" aria-label="Recent activity"><h2 className="dash-label">Recent activity</h2>
        {!data ? null : data.activity.length === 0 ? <p className="ws-board-empty">Task changes, runs, hires and decisions show here as they happen.</p>
          : <ul className="ws-rows">{data.activity.map(a => <li key={a.id}><div className="ws-row is-static dash-activity"><Monogram name={a.actor || 'Muster'} kind={a.actor === 'user' || a.actor === 'You' ? 'user' : 'agent'}/>
              <span className="ws-row-text"><span className="ws-row-title">{a.summary}</span><span className="ws-row-meta">{[a.actor === 'user' ? 'You' : a.actor, a.projectName].filter(Boolean).join(' · ')}</span></span>
              {a.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}<span className="ws-row-age" title={exactTime(a.at)}>{agoLabel(a.at)}</span></div></li>)}</ul>}
      </section>
      <section className="ws-section" aria-label="Recent tasks"><h2 className="dash-label">Recent tasks</h2>
        {recent.length === 0 ? <p className="ws-board-empty">No tasks yet. Create one from a project’s Tasks tab.</p>
          : <ul className="ws-rows">{recent.map(t => <li key={t.id}><button type="button" className="ws-row dash-task" onClick={() => nav.onOpenTask(t.id)}>
              <TaskStatusIcon status={t.status}/><span className="ws-row-text"><span className="ws-row-title">{t.title}</span><span className="ws-row-meta">{t.assigneeLabel ?? 'No owner'}</span></span>
              <span className="ws-key">{t.key}</span><span className="ws-row-age" title={exactTime(t.updatedAt)}>{agoLabel(t.updatedAt)}</span></button></li>)}</ul>}
      </section>
    </div>
  </div>;
}

function Tile({ icon, label, value, detail, onClick }: { icon: React.ReactNode; label: string; value: React.ReactNode; detail: string; onClick: () => void }): React.ReactElement {
  return <button type="button" className="dash-tile" onClick={onClick}><span className="dash-tile-icon" aria-hidden="true">{icon}</span><span className="dash-value">{value}</span><span className="dash-tile-label">{label}</span><span className="dash-tile-detail">{detail}</span></button>;
}

// --- Charts: one bar per day, stacked, token colours, a legend and a per-bar tooltip (title), axis labels at the ends and middle.
interface Segment { key: string; label: string; value: number; tone: string }
function Bars({ title, days, series, legend, format = n => String(n), max }: { title: string; days: string[]; series: Segment[][]; legend: { label: string; tone: string }[]; format?: (n: number) => string; max?: number }): React.ReactElement {
  const top = max ?? Math.max(1, ...series.map(s => s.reduce((n, x) => n + x.value, 0)));
  const W = 280, H = 96, gap = 4, bw = (W - gap * (days.length - 1)) / days.length;
  const total = series.reduce((n, s) => n + s.reduce((m, x) => m + x.value, 0), 0);
  return <figure className="dash-chart">
    <figcaption><strong>{title}</strong><span>Last 14 days</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`${title}, last 14 days${total ? '' : ': nothing yet'}`}>
      <line className="dash-axis" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5}/>
      {days.map((day, i) => { let y = H; const x = i * (bw + gap);
        return <g key={day} className="dash-bar"><title>{`${shortDay(day)}: ${series[i].filter(s => s.value).map(s => `${s.label} ${format(s.value)}`).join(', ') || 'nothing'}`}</title>
          <rect className="dash-hit" x={x} y={0} width={bw} height={H}/>
          {series[i].filter(s => s.value > 0).map((s, j, list) => { const h = Math.max(3, (s.value / top) * (H - 6)); y -= h;
            // The bottom segment sits on the baseline; each one above leaves a 2px surface gap; only the top end is rounded.
            return <rect key={s.key} data-tone={s.tone} x={x} y={y} width={bw} height={j === 0 ? h : h - 2} rx={j === list.length - 1 ? 2 : 0}/>; })}
        </g>; })}
    </svg>
    <div className="dash-axis-labels" aria-hidden="true"><span>{shortDay(days[0])}</span><span>{shortDay(days[Math.floor(days.length / 2)])}</span><span>{shortDay(days[days.length - 1])}</span></div>
    <ul className="dash-legend">{legend.map(l => <li key={l.label}><span data-tone={l.tone} aria-hidden="true"/>{l.label}</li>)}</ul>
  </figure>;
}
export function RunActivityChart({ days }: { days: DashboardDay[] }): React.ReactElement {
  return <Bars title="Run activity" days={days.map(d => d.day)} series={days.map(d => [{ key: 's', label: 'Succeeded', value: d.succeeded, tone: 'ok' }, { key: 'f', label: 'Failed', value: d.failed, tone: 'danger' }, { key: 'o', label: 'Other', value: d.other, tone: 'faint' }])}
    legend={[{ label: 'Succeeded', tone: 'ok' }, { label: 'Failed', tone: 'danger' }, { label: 'Other', tone: 'faint' }]}/>;
}
const STATUS_TONE: Partial<Record<WorkspaceStatus, string>> = { in_progress: 'accent', in_review: 'violet', done: 'ok', blocked: 'warn', todo: 'dim', backlog: 'faint' };
function TasksByStatusChart({ data }: { data: DashboardData }): React.ReactElement {
  const statuses = (Object.keys(STATUS_TONE) as WorkspaceStatus[]).filter(s => data.tasksByDay.some(d => d.counts[s]));
  const shown = statuses.length ? statuses : (['in_progress', 'done'] as WorkspaceStatus[]);
  return <Bars title="Tasks by status" days={data.tasksByDay.map(d => d.day)} series={data.tasksByDay.map(d => shown.map(s => ({ key: s, label: STATUS_LABEL[s], value: d.counts[s] ?? 0, tone: STATUS_TONE[s]! })))}
    legend={shown.map(s => ({ label: STATUS_LABEL[s], tone: STATUS_TONE[s]! }))}/>;
}
function SuccessRateChart({ days }: { days: DashboardDay[] }): React.ReactElement {
  return <Bars title="Success rate" days={days.map(d => d.day)} max={100} format={n => `${n}%`}
    series={days.map(d => { const ended = d.succeeded + d.failed; return [{ key: 'r', label: 'Succeeded', value: ended ? Math.round((d.succeeded / ended) * 100) : 0, tone: ended && d.failed > d.succeeded ? 'danger' : 'ok' }]; })}
    legend={[{ label: 'Share of finished runs that succeeded', tone: 'ok' }]}/>;
}
