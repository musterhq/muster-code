/**
 * Your stats (G38): what you got done with your agents, from the Ledger and the task states: tasks completed, agent turns,
 * tokens and estimated cost, which providers did the work, a 28-day activity strip, your streak and your busiest projects.
 * On a project's Dashboard it counts only that project. Read-only; nothing is recorded for it.
 */
import { CheckCheck, Flame } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { ProfileStats } from '../../shared/domains/insight-protocol';
import { formatTokenCount, formatUsd } from '../../shared/model-catalog';
import { invoke } from '../bridge';
import { Bars } from './DashboardPage';
import { ResourceState } from './ResourceState';
import './costs-panel.css';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const since = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;

export function YouCard({ projectId }: { projectId?: string }): React.ReactElement | null {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; setFailed(false);
    invoke('insight.profile', { utcOffsetMinutes: -new Date().getTimezoneOffset(), ...(projectId ? { projectId } : {}) }).then(s => { if (live) setStats(s); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [projectId]);
  // A Muster Server that keeps this read for owners and admins just leaves the card out.
  if (failed) return null;
  if (!stats) return <section className="ws-section you" aria-label="You"><h2 className="dash-label">You</h2><ResourceState kind="loading" label="Reading your stats" rows={2} compact/></section>;
  const s = stats, empty = s.runs.total === 0 && s.tasks.total === 0;
  return <section className="ws-section you" aria-label="You">
    <div className="ws-section-head"><h2 className="dash-label">{projectId ? 'Your part in this project' : 'You'}</h2>{s.since && <span className="ws-faint you-since">Since {since(s.since)}</span>}</div>
    {s.truncated && <p className="ws-faint" role="status" data-truncated="true">The Ledger holds more than a report reads, so the oldest days are missing from these numbers.</p>}
    {empty ? <p className="ws-board-empty">Your stats start with your first task or agent run.</p> : <>
      <div className="costs-tiles you-tiles">
        <div className="dash-tile is-static"><span className="dash-tile-icon" aria-hidden="true"><CheckCheck size={15}/></span><span className="dash-value">{s.tasks.completed}</span><span className="dash-tile-label">Tasks completed</span><span className="dash-tile-detail">{s.tasks.open} open · {s.tasks.failed} failed · {s.tasks.total} in all</span></div>
        <div className="dash-tile is-static"><span className="dash-value">{s.runs.total}</span><span className="dash-tile-label">Agent turns</span><span className="dash-tile-detail">{s.runs.succeeded} finished · {s.runs.failed} failed · last 90 days</span></div>
        <div className="dash-tile is-static"><span className="dash-value">{formatTokenCount(s.tokens.input + s.tokens.output)}</span><span className="dash-tile-label">Tokens</span><span className="dash-tile-detail">{s.costUsd === null ? (s.unpricedTurns ? 'Unpriced' : '—') : `${formatUsd(s.costUsd)}${s.unpricedTurns ? ' + unpriced' : ''}`} estimated</span></div>
        <div className="dash-tile is-static"><span className="dash-tile-icon" aria-hidden="true"><Flame size={15}/></span><span className="dash-value">{s.streak}</span><span className="dash-tile-label">{s.streak === 1 ? 'Day streak' : 'Days streak'}</span><span className="dash-tile-detail">{s.activeDays} active {s.activeDays === 1 ? 'day' : 'days'} in 28</span></div>
      </div>
      <div className="you-cols">
        <div className="dash-card"><Bars title="Agent turns" span="Last 28 days" days={s.activity.map(a => a.day)} series={s.activity.map(a => [{ key: 'r', label: 'Turns', value: a.runs, tone: 'accent' }])} legend={[{ label: 'Turns per day', tone: 'accent' }]}/></div>
        <div className="you-side">
          <div className="dash-card you-mix"><strong>Provider mix</strong>
            {s.providerMix.length === 0 ? <p className="ws-board-empty">No turns yet.</p> : <ul>{s.providerMix.slice(0, 5).map(m => <li key={m.provider}><span className="you-mix-name" title={m.provider}>{m.name}</span><span className="costs-share" aria-hidden="true"><span style={{ width: `${Math.max(3, Math.round(m.share * 100))}%` }}/></span><span className="you-mix-pct">{pct(m.share)}</span></li>)}</ul>}
          </div>
          {s.topProjects.length > 0 && <div className="dash-card you-mix"><strong>Busiest projects</strong><ul>{s.topProjects.map(p => <li key={p.projectId}><span className="you-mix-name" title={p.name}>{p.name}</span><span className="ws-faint">{p.completed} done · {p.open} open</span></li>)}</ul></div>}
        </div>
      </div>
    </>}
  </section>;
}
