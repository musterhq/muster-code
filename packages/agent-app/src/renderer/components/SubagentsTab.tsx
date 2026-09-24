import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Bot, Brain, ChevronRight, CircleCheck, CircleDot, CircleHelp, CircleX, Clock3, Copy, MoreHorizontal, Send, Square } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { Collapsible as Disclosure } from '@base-ui/react/collapsible';
import type { TimelineItem } from '../../shared/protocol';
import { SUBAGENT_STEER_MAX, type SubagentControlAction, type SubagentControlCapabilities, type SubagentTranscript } from '../../shared/domains/subagents-protocol';
import type { WorkspaceTab } from '../store';
import { notifyError, notifySuccess, retryTimeline } from '../store';
import { useStore } from '../useStore';
import { invoke } from '../bridge';
import { copyText } from '../clipboard';
import { AgentGlyph, agentDisplayName } from '../agentIdentity';
import {
  EMPTY_ACTIVITY_ITEMS, childTimelineItems, formatElapsed, getSubagentActivity, phaseCounts, phaseGlyph, selectSubagent, selectedSubagent,
  subagentPhase, subagentState, subscribeSubagentSelection, type SubagentActivity, type SubagentPhaseKind, type SubagentSummary,
} from '../subagentActivity';
import { useDisclosure } from './useDisclosure';
import { MessageBody } from './MessageBody';
import { ActivityGroup } from './ActivityGroup';
import './subagents-tab.css';
import {Tip} from './Tooltip';

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

const PHASE_ICON = {running:CircleDot, waiting:Clock3, completed:CircleCheck, verified:CircleCheck, failed:CircleX, unknown:CircleHelp};
const PHASE_HINT: Record<SubagentPhaseKind, string> = {
  running:'The subagent is working', waiting:'Queued or waiting for input', completed:'Finished; no result reported to the parent yet',
  verified:'Finished and reported its result back to the parent', failed:'Failed or was stopped', unknown:'The provider has not reported a state',
};
function PhaseBadge({kind, label}: {kind:SubagentPhaseKind; label:string}) {
  const Icon = PHASE_ICON[kind];
  return <span className={`subagent-phase is-${kind}`} title={PHASE_HINT[kind]}><Icon size={12} aria-hidden="true" />{label}</span>;
}

/** A 1s clock, only while something visible is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}
function elapsedLabel(start: string | undefined, end: string | undefined, running: boolean, now: number): string | undefined {
  const from = start ? Date.parse(start) : NaN, to = running ? now : end ? Date.parse(end) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? formatElapsed(to - from) : undefined;
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

/** TRN-10: what the parent's provider route can do to one child. Unknown until the runtime answers, then real or explained. */
type Controls = {caps:SubagentControlCapabilities | null; busy:string | null; act(agent:SubagentActivity, action:SubagentControlAction, text?:string):Promise<boolean>};
function useSubagentControls(chatId: string | undefined): Controls {
  const [caps, setCaps] = useState<SubagentControlCapabilities | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setCaps(null);
    if (chatId) invoke('subagents.capabilities', {chatId}).then(value => { if (live) setCaps(value); }, cause => { if (live) setCaps({stop:false, steer:false, reason:cause instanceof Error ? cause.message : String(cause)}); });
    return () => { live = false; };
  }, [chatId]);
  const act = async (agent: SubagentActivity, action: SubagentControlAction, text?: string) => {
    if (!chatId) return false;
    setBusy(`${agent.threadId}:${action}`);
    try {
      const result = await invoke('subagents.control', {chatId, threadId:agent.threadId, action, ...(text ? {text} : {})});
      if (result.ok) notifySuccess(action === 'stop' ? `Stop sent to ${agent.name}` : `Steered ${agent.name}`);
      else notifyError(new Error(result.reason || `${agent.name} could not be ${action === 'stop' ? 'stopped' : 'steered'}.`));
      return result.ok;
    } catch (cause) { notifyError(cause); return false; }
    finally { setBusy(null); }
  };
  return {caps, busy, act};
}
/** The reason a control is off: loading, the provider cannot, or the child is not running. */
function controlHint(caps: SubagentControlCapabilities | null, action: SubagentControlAction, live: boolean, name: string): string {
  if (!caps) return 'Checking what this provider supports…';
  if (!caps[action]) return caps.reason ?? 'This provider cannot do that.';
  if (!live) return `${name} is not running`;
  return action === 'stop' ? `Stop ${name}'s current turn` : `Send ${name} an instruction mid-turn`;
}
function FailureReason({agent}: {agent:SubagentActivity}) {
  return <p className={`subagent-failure${agent.error ? '' : ' is-unreported'}`} role="note"><CircleX size={12} aria-hidden="true" /><span>{agent.error ?? 'No failure reason reported by the provider.'}</span></p>;
}
function SteerForm({agent, controls, onDone}: {agent:SubagentActivity; controls:Controls; onDone:() => void}) {
  const [draft, setDraft] = useState('');
  const sending = controls.busy === `${agent.threadId}:steer`;
  const submit = async () => { const text = draft.trim(); if (!text || sending) return; if (await controls.act(agent, 'steer', text)) { setDraft(''); onDone(); } };
  return <form className="subagent-steer-form" aria-label={`Steer ${agent.name}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <textarea value={draft} rows={2} maxLength={SUBAGENT_STEER_MAX} autoFocus placeholder={`Tell ${agent.name} what to change…`} aria-label={`Instruction for ${agent.name}`} disabled={sending}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); } }} />
    <div className="subagent-steer-actions">
      <button type="button" onClick={onDone} disabled={sending}>Cancel</button>
      <button type="submit" className="is-primary" disabled={sending || !draft.trim()}><Send size={12} aria-hidden="true" />{sending ? 'Sending…' : 'Send'}</button>
    </div>
  </form>;
}

function AgentCard({agent, chatId, now, controls}: {agent:SubagentActivity; chatId:string; now:number; controls:Controls}) {
  const phase = subagentPhase(agent);
  const elapsed = elapsedLabel(agent.startedAt, agent.updatedAt, phase.kind === 'running', now);
  const meta = [agent.role, agent.model, elapsed].filter(Boolean).join(' · ');
  return <article className={`subagent-card is-${phase.kind}`} aria-label={`${agent.name}, ${phase.label}`}>
    <button type="button" className="subagent-open" onClick={() => selectSubagent(chatId, agent.id)} aria-label={`Open ${agent.name} transcript`}>
      <span className="subagent-avatar"><AgentGlyph name={agent.name} state={phaseGlyph(phase.kind)} /></span>
      <span className="subagent-open-text"><strong title={agent.name}>{agent.name}</strong>{meta && <span className="subagent-meta">{meta}</span>}</span>
      <PhaseBadge {...phase} />
      <ChevronRight className="subagent-open-chevron" size={13} aria-hidden="true" />
    </button>
    {phase.kind === 'failed' && <FailureReason agent={agent} />}
    {(phase.kind === 'running' || phase.kind === 'waiting') && controls.caps?.stop && <div className="subagent-card-actions">
      <button type="button" className="subagent-stop" disabled={controls.busy === `${agent.threadId}:stop`} onClick={() => void controls.act(agent, 'stop')} aria-label={`Stop ${agent.name}`} title={controlHint(controls.caps, 'stop', true, agent.name)}><Square size={10} aria-hidden="true" />Stop</button>
    </div>}
    {agent.prompt && <AgentDetail agent={agent} chatId={chatId} label="Prompt" field="prompt" />}
    {agent.result && phase.kind !== 'failed' && <AgentDetail agent={agent} chatId={chatId} label="Last reported result" field="result" />}
  </article>;
}

function ReasoningRow({item}: {item:TimelineItem}) {
  const [open, setOpen] = useDisclosure('reasoning:' + item.id);
  const running = item.status === 'running';
  return <Disclosure.Root open={open} onOpenChange={setOpen} className="card-collapsible">
    <Disclosure.Trigger className="activity-summary">
      <span className={running ? 'tool-glyph is-active' : 'tool-glyph'} aria-hidden="true"><Brain size={14} /></span>
      <span>{running ? 'Thinking' : 'Thought'}</span><ChevronRight className="tool-chevron" size={12} />
    </Disclosure.Trigger>
    <Disclosure.Panel className="activity-disclosure"><div className="card-collapsible-body msg-text msg-reasoning">{item.text}</div></Disclosure.Panel>
  </Disclosure.Root>;
}

/** Same row vocabulary as the chat: user bubbles, MessageBody answers, grouped tool activity. */
function Transcript({items, running}: {items:readonly TimelineItem[]; running:boolean}) {
  const out: React.ReactNode[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind === 'tool') {
      const tools: TimelineItem[] = [];
      while (index < items.length && items[index].kind === 'tool') tools.push(items[index++]);
      index--;
      out.push(<ActivityGroup key={tools[0].id} items={tools} live={running && index === items.length - 1} />);
    } else if (item.kind === 'user') out.push(<div key={item.id} className="subagent-user"><div className="msg msg-user"><div className="msg-text">{item.text}</div></div></div>);
    else if (item.kind === 'assistant') out.push(<div key={item.id} className="msg msg-assistant"><MessageBody text={item.text} /></div>);
    else if (item.kind === 'reasoning') out.push(<ReasoningRow key={item.id} item={item} />);
    else if (item.text) out.push(<p key={item.id} className="subagents-status">{item.text}</p>);
  }
  return <>{out}</>;
}

type Load = {phase:'loading' | 'ready' | 'error'; value?:SubagentTranscript; error?:string};
const POLL_MS = 2000;
/** Reads the child thread; polls every 2s while it runs. A newer parent report refreshes it once. */
function useTranscript(chatId: string, threadId: string, reportKey: string, expectActive: boolean): [Load, () => void] {
  const [load, setLoad] = useState<Load>({phase:'loading'});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => invoke('subagents.transcript', {chatId, threadId}).then(value => {
      if (!live) return;
      setLoad({phase:'ready', value});
      // A just-spawned child has no turn yet ('unknown'); keep polling while the parent still reports it active.
      if (value.status === 'running' || value.status === 'unknown' && expectActive) timer = setTimeout(run, POLL_MS);
    }, cause => {
      if (!live) return;
      setLoad(previous => ({...previous, phase:'error', error:cause instanceof Error ? cause.message : String(cause)}));
    });
    void run();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [chatId, threadId, reportKey, attempt, expectActive]);
  return [load, () => { setLoad(previous => ({...previous, phase:'loading'})); setAttempt(value => value + 1); }];
}

function SubagentDetail({agent, chatId, parentItems, parentModel, controls}: {agent:SubagentActivity; chatId:string; parentItems:readonly TimelineItem[]; parentModel?:string; controls:Controls}) {
  const [steering, setSteering] = useState(false);
  const reportedKind = subagentPhase(agent).kind;
  const [load, retry] = useTranscript(chatId, agent.threadId, `${agent.state ?? ''}\0${agent.updatedAt ?? ''}`, reportedKind === 'running' || reportedKind === 'waiting');
  const transcript = load.value;
  const phase = subagentPhase(agent, transcript?.status);
  const running = phase.kind === 'running';
  const now = useNow(running);
  const elapsed = elapsedLabel(transcript?.startedAt ?? agent.startedAt, transcript?.updatedAt ?? agent.updatedAt, running, now);
  const model = agent.model ?? transcript?.model ?? parentModel;
  const role = agent.role ?? transcript?.role;
  const back = () => selectSubagent(chatId, null);
  const tagged = transcript ? [] : childTimelineItems(parentItems, agent.threadId);
  let items: readonly TimelineItem[] = transcript?.items ?? tagged;
  if (agent.prompt && !items.some(item => item.kind === 'user')) items = [{id:`${agent.threadId}:prompt`, chatId, kind:'user', text:agent.prompt, createdAt:agent.startedAt ?? ''}, ...items];
  const scroller = useRef<HTMLDivElement>(null), pinned = useRef(true);
  useLayoutEffect(() => { const el = scroller.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [items.length, items.at(-1)?.text.length]);
  const copyId = () => copyText(agent.threadId).then(() => notifySuccess('Thread ID copied'), notifyError);
  return <section className="subagent-view" aria-label={`${agent.name} transcript`} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); back(); } }}>
    <header className="subagent-view-head">
      <Tip label="Back to subagents"><button type="button" className="subagent-back" onClick={back} aria-label="Back to subagents"><ArrowLeft size={15} /></button></Tip>
      <span className="subagent-avatar"><AgentGlyph name={agent.name} state={phaseGlyph(phase.kind)} /></span>
      <div className="subagent-view-title">
        <h2 title={agent.name}>{agent.name}</h2>
        <p>{[role, model].filter(Boolean).join(' · ') || 'Subagent'}</p>
      </div>
      <PhaseBadge {...phase} />
      {elapsed && <span className="subagent-elapsed" aria-label={`${running ? 'Running for' : 'Ran for'} ${elapsed}`} title={running ? 'Running for' : 'Ran for'}><Clock3 size={12} aria-hidden="true" />{elapsed}</span>}
      <span className="subagent-steer">
        <button type="button" disabled={!controls.caps?.steer || !running} aria-pressed={steering} onClick={() => setSteering(value => !value)} aria-label={`Steer ${agent.name}`} title={controlHint(controls.caps, 'steer', running, agent.name)}><Send size={12} aria-hidden="true" />Steer</button>
        <button type="button" className="subagent-stop" disabled={!controls.caps?.stop || !(running || phase.kind === 'waiting') || controls.busy === `${agent.threadId}:stop`} onClick={() => void controls.act(agent, 'stop')} aria-label={`Stop ${agent.name}`} title={controlHint(controls.caps, 'stop', running || phase.kind === 'waiting', agent.name)}><Square size={10} aria-hidden="true" />Stop</button>
      </span>
      <Menu.Root>
        <Menu.Trigger className="subagent-more" aria-label={`More actions for ${agent.name}`}><MoreHorizontal size={15} /></Menu.Trigger>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="subagent-menu-positioner"><Menu.Popup className="ui-menu subagent-menu">
          <Menu.Item onClick={() => void copyId()}><Copy size={14} />Copy thread ID</Menu.Item>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>
    </header>
    {steering && running && <SteerForm agent={agent} controls={controls} onDone={() => setSteering(false)} />}
    {phase.kind === 'failed' && <FailureReason agent={agent} />}
    <div className="subagent-transcript" ref={scroller} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} aria-busy={load.phase === 'loading'}>
      <Transcript items={items} running={running} />
      {load.phase === 'loading' && !transcript && <p className="subagents-status" role="status">Loading transcript…</p>}
      {load.phase === 'error' && <div className="subagents-error"><p className="subagents-status is-error" role="status">Transcript unavailable: {load.error}{transcript || tagged.length ? ' Showing the last available activity.' : ''}</p><button className="subagents-retry" onClick={retry} aria-label="Retry loading subagent transcript">Retry</button></div>}
      {load.phase === 'ready' && !items.length && <p className="subagents-status">{running ? 'Starting…' : 'This thread has no activity.'}</p>}
      {load.phase === 'ready' && agent.result && phase.kind === 'verified' && <div className="subagent-report"><span><CircleCheck size={12} aria-hidden="true" />Reported back to the parent</span><MessageBody text={agent.result} /></div>}
    </div>
  </section>;
}

export function SubagentsTab({tab}: {tab:WorkspaceTab}): React.ReactElement {
  const state = useStore();
  const chatId = tab.chatId;
  const chat = state.snapshot?.chats.find(chat => chat.id === chatId);
  const loadable = chatId ? state.timelines[chatId] : undefined;
  const parentItems = loadable?.value ?? EMPTY_ACTIVITY_ITEMS;
  const reported = getSubagentActivity(parentItems).agents;
  // Never a raw thread id as a name: name, else role, else the task's gist, else "Agent N" (same as the timeline rows).
  const agents = useMemo(() => reported.map((agent, index) => ({...agent, name: agentDisplayName(agent, index + 1)})), [reported]);
  const loading = !!chatId && (!loadable || loadable.phase === 'idle' || loadable.phase === 'loading');
  const selectedId = useSyncExternalStore(subscribeSubagentSelection, () => chatId ? selectedSubagent(chatId) : null);
  const selected = selectedId ? agents.find(agent => agent.id === selectedId) : undefined;
  const controls = useSubagentControls(chatId);
  const now = useNow(!selected && agents.some(agent => subagentPhase(agent).kind === 'running'));
  if (selected && chatId) return <div className="subagents-tab is-detail"><SubagentDetail key={selected.id} agent={selected} chatId={chatId} parentItems={parentItems} parentModel={chat?.model} controls={controls} /></div>;
  const counts = phaseCounts(agents);
  return <div className="subagents-tab" aria-label="Subagent activity" aria-busy={loading}>
    <header className="subagents-header">
      <div><h2>Subagents</h2><p title={chat?.title}>{chat?.title || 'Conversation activity'}</p></div>
      <span className="subagents-count" aria-label={`${agents.length} subagents`}>{agents.length}</span>
    </header>
    {agents.length > 0 && <div className="subagent-counts" role="group" aria-label="Subagent states">
      <span>{counts.running} running</span>{counts.waiting > 0 && <span>{counts.waiting} waiting</span>}<span>{counts.completed} completed</span><span>{counts.verified} reported back</span>
      {counts.failed > 0 && <span className="is-failed">{counts.failed} failed or stopped</span>}
      {counts.unknown > 0 && <span>{counts.unknown} not reported</span>}
    </div>}
    {agents.length > 0 && <p className="subagents-provenance">Open an agent to follow its own thread. States come from the parent's reports, including saved history.</p>}
    {!chatId && <p className="subagents-status is-error" role="status">This saved tab has no conversation reference.</p>}
    {loading && <p className="subagents-status" role="status">{agents.length ? 'Refreshing activity…' : 'Loading activity…'}</p>}
    {loadable?.phase === 'error' && <div className="subagents-error"><p className="subagents-status is-error" role="status">Activity unavailable: {loadable.error || 'The conversation could not be loaded.'}{agents.length > 0 ? ' Showing the last available reports.' : ''}</p>{chatId && <button className="subagents-retry" onClick={() => retryTimeline(chatId)} aria-label="Retry loading subagent activity">Retry</button>}</div>}
    {chatId && !agents.length && !loading && loadable?.phase !== 'error' && <div className="subagents-empty"><Bot size={22} aria-hidden="true" /><p>No subagents reported yet.</p><span>Delegated work appears here when the provider supplies child activity.</span></div>}
    <div className="subagents-list">{agents.map(agent => <AgentCard key={`${chatId}:${agent.id}`} agent={agent} chatId={chatId!} now={now} controls={controls} />)}</div>
  </div>;
}
