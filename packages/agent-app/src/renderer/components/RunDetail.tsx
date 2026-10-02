/**
 * A run on its own page (Wave 4, G14): who ran, for which task, why it started, how it ended and what it cost, then what happened in
 * it, step by step, read from the run's own chat. Reached from a run row in the Ledger, a task's Runs tab or its Last run.
 */
import { AlertTriangle, Brain, FileText, MessageSquare, Terminal, User, Wrench } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { LedgerEntry, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import type { TimelineItem } from '../../shared/protocol';
import { invoke } from '../bridge';
import { useEventLoad } from '../orgHooks';
import { agoLabel, exactTime } from '../relativeTime';
import { Monogram, Receipt, RUN_STATE_LABEL, StateChip, duration, explainRunError, runTone } from './HubParts';
import type { HubNav } from './HubPages';
import { MessageBody } from './MessageBody';
import { ResourceState } from './ResourceState';
import './org-panels.css';

const ICON: Record<TimelineItem['kind'], React.ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>> = { user: User, assistant: MessageSquare, reasoning: Brain, tool: Terminal, approval: Wrench, question: MessageSquare, notice: AlertTriangle };
const LABEL: Record<TimelineItem['kind'], string> = { user: 'Prompt', assistant: 'Said', reasoning: 'Thought', tool: 'Ran', approval: 'Asked to approve', question: 'Asked you', notice: 'Notice' };
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export function RunDetailPage({ snapshot, runId, nav }: { snapshot: WorkspaceSnapshot; runId: string; nav: HubNav }): React.ReactElement {
  const run = snapshot.runs.find(r => r.id === runId);
  const agent = run?.agentId ? snapshot.agents.find(a => a.id === run.agentId) : undefined, task = run?.taskId ? snapshot.tasks.find(t => t.id === run.taskId) : undefined;
  const chatId = run?.chatId ?? null;
  const timeline = useEventLoad(e => e.type === 'timelinePatch' && (e as { chatId: string }).chatId === chatId, () => chatId ? invoke('chat.timeline', { id: chatId }) : Promise.resolve(null), [chatId, run?.status]);
  const ledger = useEventLoad(() => false, () => chatId ? invoke('paperclip.ledger', { limit: 500 }) : Promise.resolve(null), [chatId]);
  const receipt = useMemo<LedgerEntry | null>(() => {
    const mine = (ledger.data?.entries ?? []).filter(e => e.chatId === chatId);
    return mine.sort((a, b) => Math.abs(Date.parse(a.endedAt) - Date.parse(run?.finishedAt ?? run?.createdAt ?? a.endedAt)) - Math.abs(Date.parse(b.endedAt) - Date.parse(run?.finishedAt ?? run?.createdAt ?? b.endedAt)))[0] ?? null;
  }, [ledger.data, chatId, run?.finishedAt, run?.createdAt]);
  const [all, setAll] = useState(false);
  if (!run) return <ResourceState kind="empty" title="This run is no longer listed" message="Runs older than the workspace keeps are not shown. The Ledger's Runs tab lists what is."/>;
  const items = (timeline.data?.items ?? []).filter(i => i.kind !== 'reasoning' || all), shown = all ? items : items.slice(-60);
  const why = explainRunError(run.error);
  return <div className="ws-page run-detail" aria-label="Run">
    <header className="run-detail-head">
      <Monogram name={agent?.name ?? '?'}/><h1 className="run-detail-title">{agent?.name ?? 'Agent'}</h1><StateChip tone={runTone(run.status)}>{RUN_STATE_LABEL[run.status]}</StateChip>
      {task && <button type="button" className="ws-link" onClick={() => nav.onOpenTask(task.id)}><span className="ws-key">{task.key}</span> {task.title}</button>}
      <span className="project-edit-spacer"/>{chatId && <button type="button" className="settings-button secondary" onClick={() => nav.onOpenChat(chatId)}>Open run chat</button>}
    </header>
    <dl className="run-detail-facts">
      <div><dt>Started by</dt><dd>{run.trigger ?? '—'}</dd></div>
      <div><dt>Started</dt><dd title={exactTime(run.startedAt ?? run.createdAt)}>{new Date(run.startedAt ?? run.createdAt).toLocaleString()} · {agoLabel(run.startedAt ?? run.createdAt)}</dd></div>
      <div><dt>Took</dt><dd>{run.status === 'running' ? 'running now' : duration(run.startedAt, run.finishedAt) || '0s'}</dd></div>
      <div><dt>Source</dt><dd>{run.source === 'paperclip' ? 'Linked Paperclip' : 'Muster'}</dd></div>
    </dl>
    {why && <p className="run-detail-error" role="alert"><AlertTriangle size={13} aria-hidden="true"/> {why}</p>}
    {receipt ? <Receipt entry={receipt} defaultOpen/> : chatId ? <p className="ws-faint">{ledger.loading ? 'Reading the Ledger…' : 'This run has no Ledger receipt yet.'}</p> : null}
    {chatId ? <section aria-label="What happened">
      <div className="run-detail-bar"><h2 className="ws-group-title">What happened<span>{items.length}</span></h2><label className="org-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>Everything, with thoughts</label></div>
      {timeline.loading && !timeline.data ? <ResourceState kind="loading" compact label="Reading the run" rows={3}/> : timeline.error ? <ResourceState kind="error" compact message="The run could not be read." detail={timeline.error} onRetry={timeline.reload}/>
        : shown.length === 0 ? <p className="ws-faint">Nothing was recorded for this run.</p>
        : <ol className="run-steps">{!all && items.length > shown.length && <li className="ws-faint">{items.length - shown.length} earlier steps. Tick “Everything” to see them.</li>}
          {shown.map(i => { const Icon = ICON[i.kind]; return <li key={i.id} className="run-step" data-kind={i.kind}>
            <Icon size={13} aria-hidden="true"/><div className="run-step-body"><span className="run-step-label">{LABEL[i.kind]}{i.status && i.kind === 'tool' ? <span className="ws-faint"> · {i.status}</span> : null}<time className="ws-faint" title={exactTime(i.createdAt)}> · {new Date(i.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>
              {i.kind === 'assistant' ? <div className="run-step-text"><MessageBody text={i.text}/></div> : <span className="run-step-text">{clip(i.text, i.kind === 'user' ? 600 : 240)}</span>}</div></li>; })}</ol>}
    </section> : <p className="ws-faint">This run happened in the linked Paperclip; its steps stay there.</p>}
  </div>;
}
