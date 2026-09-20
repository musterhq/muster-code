import React from 'react';
import { Bot, ChevronRight, CircleCheck, CircleDot, CircleHelp, CircleX, Clock3 } from 'lucide-react';
import type { WorkspaceTab } from '../store';
import { retryTimeline } from '../store';
import { useStore } from '../useStore';
import { EMPTY_ACTIVITY_ITEMS, getSubagentActivity, subagentState, type SubagentActivity, type SubagentSummary } from '../subagentActivity';
import { Collapsible as Disclosure } from '@base-ui/react/collapsible';
import { useDisclosure } from './useDisclosure';
import { MessageBody } from './MessageBody';
import './subagents-tab.css';

export function SubagentStatus({state}: {state?: string}) {
  const {kind, label} = subagentState(state);
  const Icon = {working:CircleDot, waiting:Clock3, done:CircleCheck, failed:CircleX, unknown:CircleHelp}[kind];
  return <span className={`subagent-state is-${kind}`} title={state ? `Provider reported: ${state}` : 'The provider has not reported a child state'}>
    <Icon size={13} aria-hidden="true" />{label}
  </span>;
}

export function SubagentCounts({counts}: {counts:SubagentSummary['counts']}) {
  return <div className="subagent-counts" role="group" aria-label="Last reported subagent counts">
    <span>{counts.working} working</span><span>{counts.waiting} waiting</span><span>{counts.done} done</span>
    {counts.failed > 0 && <span className="is-failed">{counts.failed} failed or stopped</span>}
    {counts.unknown > 0 && <span>{counts.unknown} other or unreported</span>}
  </div>;
}

function AgentDetail({agent, chatId, label, field}: {agent:SubagentActivity; chatId:string; label:string; field:'prompt' | 'result'}) {
  const [open, setOpen] = useDisclosure(JSON.stringify(['subagent', chatId, agent.id, field]));
  return <Disclosure.Root open={open} onOpenChange={setOpen} className="subagent-detail">
    <Disclosure.Trigger className="subagent-detail-trigger" aria-label={`${label} for ${agent.name}`}>
      <ChevronRight size={12} aria-hidden="true" /><span>{label}</span>
    </Disclosure.Trigger>
    <Disclosure.Panel className="activity-disclosure subagent-detail-panel">
      <div className="subagent-detail-body"><MessageBody text={agent[field]!} /></div>
    </Disclosure.Panel>
  </Disclosure.Root>;
}

function AgentRow({agent, chatId}: {agent:SubagentActivity; chatId:string}) {
  return <article className="subagent-row" aria-label={`${agent.name}, ${subagentState(agent.state).label}`}>
    <div className="subagent-row-head">
      <span className="subagent-avatar" aria-hidden="true"><Bot size={15} /></span>
      <strong title={agent.name}>{agent.name}</strong>
      <SubagentStatus state={agent.state} />
    </div>
    {(agent.role || agent.model) && <div className="subagent-meta">{[agent.role, agent.model].filter(Boolean).join(' · ')}</div>}
    <div className="subagent-identity"><span>Thread</span><code title={agent.threadId}>{agent.threadId}</code></div>
    {agent.prompt && <AgentDetail agent={agent} chatId={chatId} label="Prompt" field="prompt" />}
    {agent.result && <AgentDetail agent={agent} chatId={chatId} label="Last reported result" field="result" />}
    {!agent.prompt && !agent.result && <p className="subagent-unavailable">The provider has not supplied a prompt or result.</p>}
  </article>;
}

export function SubagentsTab({tab}: {tab:WorkspaceTab}): React.ReactElement {
  const state = useStore();
  const chatId = tab.chatId;
  const chat = state.snapshot?.chats.find(chat => chat.id === chatId);
  const loadable = chatId ? state.timelines[chatId] : undefined;
  const {agents, counts} = getSubagentActivity(loadable?.value ?? EMPTY_ACTIVITY_ITEMS);
  const loading = !!chatId && (!loadable || loadable.phase === 'idle' || loadable.phase === 'loading');
  return <div className="subagents-tab" aria-label="Subagent activity" aria-busy={loading}>
    <header className="subagents-header">
      <div><h2>Subagents</h2><p title={chat?.title}>{chat?.title || 'Conversation activity'}</p></div>
      <span className="subagents-count" aria-label={`${agents.length} subagents`}>{agents.length}</span>
    </header>
    {agents.length > 0 && <><SubagentCounts counts={counts} /><p className="subagents-provenance">Last reported states, including saved history. New reports update this view.</p></>}
    {!chatId && <p className="subagents-status is-error" role="status">This saved tab has no conversation reference.</p>}
    {loading && <p className="subagents-status" role="status">{agents.length ? 'Refreshing activity…' : 'Loading activity…'}</p>}
    {loadable?.phase === 'error' && <div className="subagents-error"><p className="subagents-status is-error" role="status">Activity unavailable: {loadable.error || 'The conversation could not be loaded.'}{agents.length > 0 ? ' Showing the last available reports.' : ''}</p>{chatId && <button className="subagents-retry" onClick={() => retryTimeline(chatId)} aria-label="Retry loading subagent activity">Retry</button>}</div>}
    {chatId && !agents.length && !loading && loadable?.phase !== 'error' && <div className="subagents-empty"><Bot size={22} aria-hidden="true" /><p>No subagents reported yet.</p><span>Delegated work appears here when the provider supplies child activity.</span></div>}
    <div className="subagents-list">{agents.map(agent => <AgentRow key={`${chatId}:${agent.id}`} agent={agent} chatId={chatId!} />)}</div>
  </div>;
}
