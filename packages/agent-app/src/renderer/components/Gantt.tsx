/** Ledger › Timeline as a Gantt (G1): a bar per run on a row per task or agent, range and zoom, a density minimap and stats. */
import { History, Minus, Plus } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import type { LedgerView, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { buildGantt, durationLabel, RANGE_LABEL, ticks, type GanttGroup, type GanttRange } from '../ganttModel';
import { exactTime } from '../relativeTime';
import { RUN_STATE_LABEL } from './HubParts';
import { ResourceState } from './ResourceState';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

const ROW = 30, AXIS = 26, BASE = 920, ZOOMS = [1, 2, 4, 8] as const;
const tone = (status: string) => status === 'running' ? 'accent' : status === 'queued' ? 'warn' : status === 'succeeded' ? 'ok' : status === 'cancelled' || status === 'interrupted' ? 'faint' : 'danger';
const stamp = (t: number, span: number) => new Date(t).toLocaleString(undefined, span > 2 * 86_400_000 ? { month: 'short', day: 'numeric' } : span > 6 * 3_600_000 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });

export function GanttTimeline({ snapshot, view, onOpenTask }: { snapshot: WorkspaceSnapshot; view: LedgerView | null; onOpenTask: (id: string) => void }): React.ReactElement {
  const [range, setRange] = useState<GanttRange>('7d'), [group, setGroup] = useState<GanttGroup>('task'), [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const scroller = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const gantt = useMemo(() => buildGantt({ runs: snapshot.runs, entries: view?.entries ?? [], tasks: snapshot.tasks, agents: snapshot.agents, range, group, now }), [snapshot.runs, snapshot.tasks, snapshot.agents, view?.entries, range, group, snapshot.fetchedAt]);
  const { lanes, min, max, stats, density } = gantt, span = Math.max(1, max - min), W = BASE * zoom, H = Math.max(1, lanes.length) * ROW + AXIS;
  const x = (t: number) => ((t - min) / span) * W, peak = Math.max(1, ...density);
  const jump = (fraction: number) => { const el = scroller.current; if (el) el.scrollLeft = fraction * el.scrollWidth - el.clientWidth / 2; };
  return <section className="work-gantt" aria-label="Gantt timeline">
    <div className="task-toolbar" role="toolbar" aria-label="Timeline controls">
      <select className="ws-select" aria-label="Range" value={range} onChange={e => setRange(e.target.value as GanttRange)}>{(Object.keys(RANGE_LABEL) as GanttRange[]).map(r => <option key={r} value={r}>{RANGE_LABEL[r]}</option>)}</select>
      <div className="task-toggle" role="radiogroup" aria-label="Rows">
        <button type="button" role="radio" aria-checked={group === 'task'} className="ws-filter" onClick={() => setGroup('task')}>By task</button>
        <button type="button" role="radio" aria-checked={group === 'agent'} className="ws-filter" onClick={() => setGroup('agent')}>By agent</button>
      </div>
      <span className="task-toolbar-spacer"/>
      <Tip label="Zoom out"><button type="button" className="icon-button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoom(z => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!)}><Minus size={14}/></button></Tip>
      <span className="work-zoom" aria-live="polite">×{zoom}</span>
      <Tip label="Zoom in"><button type="button" className="icon-button" aria-label="Zoom in" disabled={zoom === 8} onClick={() => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!)}><Plus size={14}/></button></Tip>
    </div>
    {lanes.length === 0 ? <ResourceState kind="empty" icon={<History size={20}/>} message={snapshot.runs.length ? `No runs in ${RANGE_LABEL[range].toLowerCase()}. Widen the range.` : 'Runs appear here as bars once agents work on tasks.'}/> : <>
      <ul className="work-gantt-stats" aria-label="Timeline stats">
        <li><strong>{stats.runs}</strong> {stats.runs === 1 ? 'run' : 'runs'}</li><li><strong>{stats.tasks}</strong> {stats.tasks === 1 ? 'task' : 'tasks'}</li><li><strong>{stats.agents}</strong> {stats.agents === 1 ? 'agent' : 'agents'}</li>
        <li><strong>{stats.succeeded}</strong> succeeded</li><li data-bad={stats.failed ? 'true' : undefined}><strong>{stats.failed}</strong> failed</li>{stats.running > 0 && <li><strong>{stats.running}</strong> running</li>}
        <li><strong>{durationLabel(stats.activeMs)}</strong> of work</li><li><strong>{stats.turns}</strong> {stats.turns === 1 ? 'turn' : 'turns'}</li>{stats.busiest && <li>busiest: <strong>{stats.busiest}</strong></li>}
      </ul>
      <div className="work-minimap" role="img" aria-label="Activity overview, click to jump">{density.map((d, i) => <button key={i} type="button" tabIndex={-1} aria-hidden="true" style={{ height: `${Math.max(8, (d / peak) * 100)}%` }} data-on={d > 0 || undefined} onClick={() => jump((i + 0.5) / density.length)}/>)}</div>
      <div className="work-gantt-body">
        <ul className="work-gantt-labels" style={{ paddingTop: AXIS }}>{lanes.map(l => <li key={l.id} style={{ height: ROW }}>{l.taskId ? <button type="button" className="ws-link work-lane-link" title={l.label} onClick={() => onOpenTask(l.taskId!)}>{l.label}</button> : <span className="work-lane-label" title={l.label}>{l.label}</span>}{l.sub && <span className="ws-faint work-lane-sub">{l.sub}</span>}</li>)}</ul>
        <div ref={scroller} className="work-gantt-scroll">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${stats.runs} runs from ${exactTime(new Date(min).toISOString())} to ${exactTime(new Date(max).toISOString())}`}>
            {ticks(min, max).map(t => <g key={t}><line className="work-gantt-grid" x1={x(t)} x2={x(t)} y1={AXIS - 4} y2={H}/><text className="work-gantt-tick" x={x(t) + 4} y={14}>{stamp(t, span)}</text></g>)}
            {lanes.map((l, i) => <g key={l.id} transform={`translate(0 ${AXIS + i * ROW})`}>
              <line className="work-gantt-lane" x1={0} x2={W} y1={ROW} y2={ROW}/>
              {l.bars.map(b => <g key={b.id}><rect className="work-gantt-bar" data-tone={tone(b.status)} data-running={b.running || undefined} x={x(b.start)} y={7} width={Math.max(4, x(b.end) - x(b.start))} height={16} rx={4} tabIndex={0} role="button"
                  aria-label={`${b.agent}, ${RUN_STATE_LABEL[b.status]}, ${durationLabel(b.end - b.start)}${l.taskId ? `, ${l.label}` : ''}`} onClick={() => b.taskId && onOpenTask(b.taskId)} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && b.taskId) { e.preventDefault(); onOpenTask(b.taskId); } }}>
                  <title>{`${b.agent} · ${RUN_STATE_LABEL[b.status]} · ${durationLabel(b.end - b.start)} · ${new Date(b.start).toLocaleString()}`}</title></rect>
                {b.turns.map((t, k) => <circle key={k} className="work-gantt-turn" cx={x(t)} cy={15} r={2.5}/>)}</g>)}
            </g>)}
          </svg>
        </div>
      </div>
    </>}
  </section>;
}
