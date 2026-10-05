/**
 * A run on its own page (Wave 4, G14): who ran, for which task, why it started, how it ended and what it cost, then what happened in
 * it, step by step, read from the run's own chat. Reached from a run row in the Ledger, a task's Runs tab or its Last run.
 */
import { AlertTriangle, Brain, ExternalLink, FileText, MessageSquare, Terminal, User, Wrench } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { LedgerEntry, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import type { TimelineItem } from '../../shared/protocol';
import { invoke } from '../bridge';
import { useEventLoad } from '../orgHooks';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError } from '../store';
import { Monogram, Receipt, RUN_STATE_LABEL, StateChip, duration, explainRunError, runTone } from './HubParts';
import type { HubNav } from './HubPages';
import { MessageBody } from './MessageBody';
import { ResourceState } from './ResourceState';
import './org-panels.css';

const ICON: Record<TimelineItem['kind'], React.ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>> = { user: User, assistant: MessageSquare, reasoning: Brain, tool: Terminal, approval: Wrench, question: MessageSquare, notice: AlertTriangle };
const LABEL: Record<TimelineItem['kind'], string> = { user: 'Prompt', assistant: 'Said', reasoning: 'Thought', tool: 'Ran', approval: 'Asked to approve', question: 'Asked you', notice: 'Notice' };
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export function RunDetailPage({ snapshot, runId, nav }: { snapshot: WorkspaceSnapshot; runId: string; nav: HubNav }): React.ReactElement {
  const listed = snapshot.runs.find(r => r.id === runId);
  // The snapshot only keeps a server's latest runs. A run it does not list (a task's older run) is read by id from the server, and a
  // server run's receipt and tool use are read there too: its list row carries neither.
  const fromServer = listed ? listed.source === 'paperclip' : Boolean(snapshot.paperclip);
  const remote = useEventLoad(() => false, () => fromServer ? invoke('paperclip.run', { id: runId }) : Promise.resolve(null), [runId, fromServer, listed?.status]);
  const run = listed ?? remote.data?.run ?? undefined;
  const agent = run?.agentId ? snapshot.agents.find(a => a.id === run.agentId) : undefined, task = run?.taskId ? snapshot.tasks.find(t => t.id === run.taskId) : undefined;
  const chatId = run?.chatId ?? null;
  const timeline = useEventLoad(e => e.type === 'timelinePatch' && (e as { chatId: string }).chatId === chatId, () => chatId ? invoke('chat.timeline', { id: chatId }) : Promise.resolve(null), [chatId, run?.status]);
  const ledger = useEventLoad(() => false, () => chatId ? invoke('paperclip.ledger', { limit: 500 }) : Promise.resolve(null), [chatId]);
  const receipt = useMemo<LedgerEntry | null>(() => {
    // A receipt is this run's by its run id (a server run has no chat); a Muster turn is matched by its chat, nearest to the run's end.
    const mine = (ledger.data?.entries ?? []).filter(e => e.runId === runId || (chatId !== null && e.chatId === chatId));
    const exact = mine.filter(e => e.runId === runId), pool = exact.length ? exact : mine;
    const nearest = pool.sort((a, b) => Math.abs(Date.parse(a.endedAt) - Date.parse(run?.finishedAt ?? run?.createdAt ?? a.endedAt)) - Math.abs(Date.parse(b.endedAt) - Date.parse(run?.finishedAt ?? run?.createdAt ?? b.endedAt)))[0] ?? null;
    return remote.data?.receipt ?? nearest;
  }, [ledger.data, remote.data, runId, chatId, run?.finishedAt, run?.createdAt]);
  const [all, setAll] = useState(false);
  const openLink = (url: string) => { void invoke('link.open', { url }).catch(notifyError); };
  if (!run) {
    if (fromServer && remote.loading) return <ResourceState kind="loading" label="Reading the run from the server" rows={3}/>;
    if (remote.error) return <ResourceState kind="error" message="This run could not be read from the server." detail={remote.error} onRetry={remote.reload}/>;
    // "Missing" is only said after the server itself answered "no such run"; a failed read is an error with its reason (above).
    return fromServer
      ? <ResourceState kind="empty" title="This run was not found" message={`Neither the recent runs kept here nor the connected server has run ${runId.slice(0, 8)}…: the server answered that it has no such run. It may have been deleted, or it is older than anything kept. The Ledger's Runs tab lists the runs that exist.`}/>
      : <ResourceState kind="empty" title="This run is no longer listed" message="Runs older than the workspace keeps are not shown. The Ledger's Runs tab lists what is."/>;
  }
  const items = (timeline.data?.items ?? []).filter(i => i.kind !== 'reasoning' || all), shown = all ? items : items.slice(-60);
  const why = explainRunError(run.error);
  return <div className="ws-page run-detail" aria-label="Run">
    <header className="run-detail-head">
      <Monogram name={agent?.name ?? '?'}/><h1 className="run-detail-title">{agent?.name ?? 'Agent'}</h1><StateChip tone={runTone(run.status)}>{RUN_STATE_LABEL[run.status]}</StateChip>
      {task && <button type="button" className="ws-link" onClick={() => nav.onOpenTask(task.id)}><span className="ws-key">{task.key}</span> {task.title}</button>}
      <span className="project-edit-spacer"/>{chatId && <button type="button" className="settings-button secondary" onClick={() => nav.onOpenChat(chatId)}>Open run chat</button>}
      {remote.data?.links.run && <button type="button" className="settings-button secondary" onClick={() => openLink(remote.data!.links.run!)}><ExternalLink size={13} aria-hidden="true"/>Open in server</button>}
    </header>
    <dl className="run-detail-facts">
      <div><dt>Started by</dt><dd>{run.trigger ?? '—'}</dd></div>
      <div><dt>Started</dt><dd title={exactTime(run.startedAt ?? run.createdAt)}>{new Date(run.startedAt ?? run.createdAt).toLocaleString()} · {agoLabel(run.startedAt ?? run.createdAt)}</dd></div>
      <div><dt>Took</dt><dd>{run.status === 'running' ? 'running now' : duration(run.startedAt, run.finishedAt) || '0s'}</dd></div>
      <div><dt>Source</dt><dd>{run.source === 'paperclip' ? 'Connected server' : 'Muster'}</dd></div>
    </dl>
    {why && <p className="run-detail-error" role="alert"><AlertTriangle size={13} aria-hidden="true"/> {why}</p>}
    {receipt ? <Receipt entry={receipt} defaultOpen/> : chatId ? <p className="ws-faint">{ledger.loading ? 'Reading the Ledger…' : 'This run has no Ledger receipt yet.'}</p> : fromServer ? <p className="ws-faint" data-receipt="none">{remote.loading ? 'Reading the server’s receipt…' : remote.error ? `The server’s receipt for this run was not fetched: ${remote.error}` : 'The server returned no receipt for this run.'}</p> : null}
    {chatId ? <section aria-label="What happened">
      <div className="run-detail-bar"><h2 className="ws-group-title">What happened<span>{items.length}</span></h2><label className="org-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>Everything, with thoughts</label></div>
      {timeline.loading && !timeline.data ? <ResourceState kind="loading" compact label="Reading the run" rows={3}/> : timeline.error ? <ResourceState kind="error" compact message="The run could not be read." detail={timeline.error} onRetry={timeline.reload}/>
        : shown.length === 0 ? <p className="ws-faint">Nothing was recorded for this run.</p>
        : <ol className="run-steps">{!all && items.length > shown.length && <li className="ws-faint">{items.length - shown.length} earlier steps. Tick “Everything” to see them.</li>}
          {shown.map(i => { const Icon = ICON[i.kind]; return <li key={i.id} className="run-step" data-kind={i.kind}>
            <Icon size={13} aria-hidden="true"/><div className="run-step-body"><span className="run-step-label">{LABEL[i.kind]}{i.status && i.kind === 'tool' ? <span className="ws-faint"> · {i.status}</span> : null}<time className="ws-faint" title={exactTime(i.createdAt)}> · {new Date(i.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>
              {i.kind === 'assistant' ? <div className="run-step-text"><MessageBody text={i.text}/></div> : <span className="run-step-text">{clip(i.text, i.kind === 'user' ? 600 : 240)}</span>}</div></li>; })}</ol>}
    </section> : <p className="ws-faint">This run happened on the connected server; its full step-by-step trace stays there.{remote.data?.links.run && <> <a className="ws-link" href={remote.data.links.run} onClick={e => { e.preventDefault(); openLink(remote.data!.links.run!); }}>Open it in the server</a>.</>}{remote.data?.links.task && <> <a className="ws-link" href={remote.data.links.task} onClick={e => { e.preventDefault(); openLink(remote.data!.links.task!); }}>Open its task in the server</a>.</>}</p>}
  </div>;
}
