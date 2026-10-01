/**
 * Audit Runs (C26): every agent run the workspace knows about, over a window you choose, filterable by outcome and agent, each
 * row opening its task or chat. Read from the workspace snapshot the Ledger already holds; nothing extra is fetched or kept.
 */
import { History } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { agoLabel, exactTime } from '../relativeTime';
import { RUN_OUTCOME_LABEL, RUN_WINDOW_LABEL, countOutcomes, filterRuns, type RunOutcome, type RunWindow } from '../runsModel';
import { closeSettings, selectChat } from '../store';
import { Monogram, RUN_STATE_LABEL, StateChip, duration, explainRunError, runTone } from './HubParts';
import type { HubNav } from './HubPages';
import { ResourceState } from './ResourceState';
import './costs-panel.css';

export function AuditRuns({ snapshot, nav }: { snapshot: WorkspaceSnapshot; nav: HubNav }): React.ReactElement {
  const [span, setSpan] = useState<RunWindow>('7d');
  const [outcome, setOutcome] = useState<RunOutcome>('all');
  const [agentId, setAgentId] = useState('');
  const inWindow = useMemo(() => filterRuns(snapshot.runs, { window: span, outcome: 'all', agentId }), [snapshot.runs, span, agentId]);
  const counts = useMemo(() => countOutcomes(inWindow), [inWindow]);
  const rows = useMemo(() => outcome === 'all' ? inWindow : filterRuns(inWindow, { window: 'all', outcome, agentId: '' }), [inWindow, outcome]);
  const agents = useMemo(() => new Map(snapshot.agents.map(a => [a.id, a])), [snapshot.agents]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const withRuns = useMemo(() => [...new Set(snapshot.runs.map(r => r.agentId).filter((a): a is string => Boolean(a)))].map(id => agents.get(id)).filter(Boolean), [snapshot.runs, agents]);
  return <div className="audit-runs" aria-label="Runs">
    <div className="ws-filters" role="toolbar" aria-label="Filter the runs">
      {(Object.keys(RUN_OUTCOME_LABEL) as RunOutcome[]).map(o => <button key={o} type="button" className="ws-filter" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>{RUN_OUTCOME_LABEL[o]}<span>{counts[o]}</span></button>)}
      <span className="task-toolbar-spacer"/>
      <select className="ws-select" aria-label="Window" value={span} onChange={e => setSpan(e.target.value as RunWindow)}>{(Object.keys(RUN_WINDOW_LABEL) as RunWindow[]).map(w => <option key={w} value={w}>{RUN_WINDOW_LABEL[w]}</option>)}</select>
      {withRuns.length > 1 && <select className="ws-select" aria-label="Agent" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">Every agent</option>{withRuns.map(a => <option key={a!.id} value={a!.id}>{a!.name}</option>)}</select>}
    </div>
    {rows.length === 0 ? <ResourceState kind="empty" icon={<History size={20}/>} title="No runs match" message={snapshot.runs.length ? 'Try a longer window, or another outcome or agent.' : 'Agent runs show here as they happen.'}/>
      : <table className="audit-table"><thead><tr><th scope="col">Agent</th><th scope="col">Task</th><th scope="col">Started by</th><th scope="col">Outcome</th><th scope="col" className="numeric">Took</th><th scope="col" className="numeric">When</th></tr></thead>
        <tbody>{rows.slice(0, 300).map(r => { const agent = r.agentId ? agents.get(r.agentId) : undefined, task = r.taskId ? tasks.get(r.taskId) : undefined;
          return <tr key={r.id}>
            <th scope="row"><span className="audit-agent"><Monogram name={agent?.name ?? '?'}/>{agent?.name ?? 'Agent'}</span></th>
            <td>{task ? <button type="button" className="ws-link" title={task.title} onClick={() => nav.onOpenTask(task.id)}><span className="ws-key">{task.key}</span> {task.title}</button> : r.chatId ? <button type="button" className="ws-link" onClick={() => { void selectChat(r.chatId!); closeSettings(); }}>Open chat</button> : <span className="ws-faint">—</span>}</td>
            <td className="ws-faint">{r.trigger ?? '—'}</td>
            <td><StateChip tone={runTone(r.status)}>{RUN_STATE_LABEL[r.status]}</StateChip>{r.error && <span className="audit-error" title={r.error}>{explainRunError(r.error)}</span>}</td>
            <td className="numeric">{r.status === 'running' ? 'running' : duration(r.startedAt, r.finishedAt) || '0s'}</td>
            <td className="numeric" title={exactTime(r.startedAt ?? r.createdAt)}>{agoLabel(r.startedAt ?? r.createdAt)}</td>
          </tr>; })}</tbody></table>}
    {rows.length > 300 && <p className="ws-faint">Showing the newest 300 of {rows.length}.</p>}
  </div>;
}
