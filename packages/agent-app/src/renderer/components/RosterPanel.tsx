/**
 * A project's Roster (#193, #128, #186): the agents on it as a list or an org chart of reporting lines, Add agent (like
 * Paperclip's hire: name, title, reports to, runner and model, instructions), approval cards for hires waiting on you,
 * what each agent is working on now, and Pulse. Muster-native agents are the project's own members (project_members);
 * Paperclip agents come from the linked company. The old Agents tab lives here now, as "Working now".
 */
import { Check, List, Network, Pencil, Plus, UserPlus, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceAgent, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import type { ModelPreference } from '../../shared/domains/settings-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { AGENT_STATE_LABEL, Monogram, StateChip, agentTone } from './HubParts';
import { PulseBoard, type HubNav } from './HubPages';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { RosterGraph, runtimeLabel } from './RosterGraph';
import { DefaultModelPicker } from './settings/DefaultModelPicker';
import { Tip } from './Tooltip';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const memberOf = (agentId: string) => agentId.startsWith('member:') ? agentId.slice(7) : null;

export function RosterPanel({ snapshot, projectId, local, nav, children }: { snapshot: WorkspaceSnapshot; projectId: string; local: boolean; nav: HubNav; children?: React.ReactNode }): React.ReactElement {
  const [layout, setLayout] = useState<'list' | 'org'>(() => { try { return globalThis.localStorage?.getItem('muster.roster.layout') === 'org' ? 'org' : 'list'; } catch { return 'list'; } });
  useEffect(() => { try { globalThis.localStorage?.setItem('muster.roster.layout', layout); } catch { /* not remembered */ } }, [layout]);
  const [adding, setAdding] = useState(false);
  const agents = snapshot.agents.filter(a => a.role !== 'board');
  const pending = agents.filter(a => a.status === 'pending' && a.source === 'local');
  const working = agents.filter(a => a.status === 'running').length;
  return <div className="roster-panel">
    <div className="roster-bar">
      <p className="ws-project-note">{agents.length} {agents.length === 1 ? 'agent' : 'agents'} · {working} working now{snapshot.projects[0]?.source === 'paperclip' ? ` · from ${snapshot.paperclip?.company?.name ?? NAMES.paperclip}` : ''}</p>
      <span className="task-toolbar-spacer"/>
      <div className="task-toggle" role="radiogroup" aria-label="Roster layout">
        <Tip label="List"><button type="button" role="radio" aria-checked={layout === 'list'} aria-label="List" className="icon-button" onClick={() => setLayout('list')}><List size={15}/></button></Tip>
        <Tip label="Org chart"><button type="button" role="radio" aria-checked={layout === 'org'} aria-label="Org chart" className="icon-button" onClick={() => setLayout('org')}><Network size={15}/></button></Tip>
      </div>
      {local && <button type="button" className="settings-button secondary" onClick={() => setAdding(true)}><Plus size={14}/>{NAMES.addAgent}</button>}
    </div>
    {pending.map(a => <HireApprovalCard key={a.id} agent={a} snapshot={snapshot} projectId={projectId}/>)}
    {agents.length === 0 ? <ResourceState kind="empty" icon={<UserPlus size={20}/>} title={local ? 'No agents on this project yet' : 'No agents have worked on this project yet'} message={local ? 'Add an agent with a title, who it reports to, the runner and model it uses, and its instructions. Tasks can then be assigned to it and started in their own worktree.' : 'Agents appear here once they work on a task in this project.'}>
        {local && <button type="button" className="settings-button" onClick={() => setAdding(true)}><Plus size={14}/>{NAMES.addAgent}</button>}
      </ResourceState>
      : layout === 'org' ? <RosterGraph snapshot={snapshot} onOpenAgent={nav.onOpenAgent} onOpenTask={nav.onOpenTask}/>
      : <RosterList snapshot={snapshot} agents={agents} nav={nav}/>}
    {children}
    <PulseBoard snapshot={snapshot} nav={nav} scoped/>
    {local && <AgentSheet open={adding} projectId={projectId} snapshot={snapshot} onClose={() => setAdding(false)}/>}
  </div>;
}

/** Paperclip's agents list: a status bar, name, "title · runtime · model", who they report to, and state. */
export function RosterList({ snapshot, agents, nav }: { snapshot: WorkspaceSnapshot; agents: readonly WorkspaceAgent[]; nav: HubNav }): React.ReactElement {
  const byId = useMemo(() => new Map(snapshot.agents.map(a => [a.id, a])), [snapshot.agents]);
  const doing = useMemo(() => { const m = new Map<string, string>(); for (const t of snapshot.tasks) if (t.live && t.assigneeId) m.set(t.assigneeId, `${t.key} · ${t.title}`); return m; }, [snapshot.tasks]);
  const sorted = [...agents].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.name.localeCompare(b.name));
  return <ul className="ws-rows roster-list" aria-label={NAMES.roster}>{sorted.map(a => {
    const boss = a.reportsTo ? byId.get(a.reportsTo) : undefined;
    return <li key={a.id}><button type="button" className="ws-row roster-row" onClick={() => nav.onOpenAgent(a.id)}>
      <span className="roster-bar-mark" data-tone={agentTone(a.status)} aria-hidden="true"/>
      <span className="ws-row-text"><span className="ws-row-title">{a.name}</span>
        <span className="ws-row-meta">{[a.title, runtimeLabel(a.adapter) === '—' ? null : runtimeLabel(a.adapter), a.model].filter(Boolean).join(' · ') || 'Project default runner'}</span></span>
      {doing.get(a.id) ? <span className="roster-doing" title={doing.get(a.id)}>{doing.get(a.id)}</span> : a.lastActiveAt ? <span className="ws-row-age">active {agoLabel(a.lastActiveAt)}</span> : null}
      <span className="roster-boss">{boss ? <>reports to <Monogram name={boss.name} kind={boss.id === 'user:local' ? 'user' : 'agent'}/>{boss.name}</> : null}</span>
      <StateChip tone={agentTone(a.status)}>{AGENT_STATE_LABEL[a.status]}</StateChip>
    </button></li>;
  })}</ul>;
}

/** A hire waiting for approval: approve to let it run, decline to remove it. Also in the Inbox as Needs you. */
export function HireApprovalCard({ agent, snapshot, projectId }: { agent: WorkspaceAgent; snapshot: WorkspaceSnapshot; projectId: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const boss = agent.reportsTo ? snapshot.agents.find(a => a.id === agent.reportsTo) : undefined;
  const decide = async (approve: boolean) => {
    const id = agent.memberId ?? memberOf(agent.id);
    if (!id) return;
    setBusy(true);
    try { await invoke('project.members.decide', { projectId, id, approve }); await refreshWorkspace(); notifySuccess(approve ? `${agent.name} joined the ${NAMES.roster}.` : `${agent.name} was not added.`); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <section className="ws-card hire-card" aria-label={`Approve adding ${agent.name}`}>
    <header className="hire-card-head"><StateChip tone="warn">Approval</StateChip><strong>Add {agent.name}{agent.title ? ` as ${agent.title}` : ''}?</strong></header>
    <dl className="hire-card-facts">
      <div><dt>Reports to</dt><dd>{boss?.name ?? 'You'}</dd></div>
      <div><dt>Runner</dt><dd>{agent.runner ? `${runtimeLabel(agent.runner.providerId)} · ${agent.runner.model}` : 'Project default'}</dd></div>
      {agent.instructions?.trim() && <div><dt>Instructions</dt><dd className="hire-card-instructions">{agent.instructions.trim()}</dd></div>}
    </dl>
    <div className="hire-card-actions">
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false)}><X size={13}/>Decline</button>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void decide(true)}><Check size={13}/>Approve</button>
    </div>
  </section>;
}

/** Add agent / edit agent: name, title, reports to, runner and model, instructions. Stored on the project's members. */
export function AgentSheet({ open, projectId, snapshot, agent, onClose }: { open: boolean; projectId: string; snapshot: WorkspaceSnapshot; agent?: WorkspaceAgent; onClose: () => void }): React.ReactElement | null {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [reportsTo, setReportsTo] = useState('');
  const [runner, setRunner] = useState<ModelPreference | null>(null);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? ''); setTitle(agent?.title ?? ''); setInstructions(agent?.instructions ?? ''); setError('');
    setReportsTo(agent?.reportsTo && agent.reportsTo !== 'user:local' ? memberOf(agent.reportsTo) ?? '' : '');
    setRunner(agent?.runner ? { providerId: agent.runner.providerId, model: agent.runner.model } : null);
  }, [open]);
  const members = snapshot.agents.filter(a => a.source === 'local' && a.projectId === projectId && a.memberId && a.memberId !== 'agent' && a.id !== agent?.id && a.status !== 'pending');
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    const profile = { title: title.trim() || null, reportsTo: reportsTo || null, runner: runner ? { providerId: runner.providerId, model: runner.model } : null, instructions };
    try {
      const memberId = agent ? agent.memberId ?? memberOf(agent.id) : null;
      if (memberId) { await invoke('project.members.update', { projectId, id: memberId, name: name.trim(), ...profile }); notifySuccess(`${name.trim()} updated.`); }
      else {
        const added = await invoke('project.members.add', { projectId, name: name.trim(), kind: 'agent', role: 'agent', ...profile });
        notifySuccess(added.pendingAt ? `${added.name} is waiting for your approval (in the Inbox and on the ${NAMES.roster}).` : `${added.name} joined the ${NAMES.roster}.`);
      }
      await refreshWorkspace(); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <ModalSheet open={open} className="project-edit-dialog ws-agent-sheet" title={agent ? `Edit ${agent.name}` : NAMES.addAgent} description={agent ? undefined : 'An agent on this project’s Roster. Tasks assigned to it run on its runner, with its instructions, in their own worktree.'} initialFocus={field} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Name</span><input ref={field} className="ws-input" required maxLength={120} value={name} disabled={busy} placeholder="CTO" onChange={e => setName(e.target.value)}/></label>
        <label className="project-edit-goal"><span>Title</span><input className="ws-input" maxLength={120} value={title} disabled={busy} placeholder="Chief Technology Officer" onChange={e => setTitle(e.target.value)}/></label>
      </div>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Reports to</span><select className="ws-select is-field" value={reportsTo} disabled={busy} onChange={e => setReportsTo(e.target.value)}><option value="">You</option>{members.map(m => <option key={m.id} value={m.memberId ?? ''}>{m.name}{m.title ? ` · ${m.title}` : ''}</option>)}</select></label>
        <div className="project-edit-goal"><span>Runner and model</span><DefaultModelPicker label="Runner and model" value={runner} emptyLabel="Project default" showEffort={false} disabled={busy} onChange={setRunner}/></div>
      </div>
      <label className="project-edit-goal"><span>Instructions</span><textarea rows={6} maxLength={20000} value={instructions} disabled={busy} placeholder="What this agent owns, how it works, and when it should ask you" onChange={e => setInstructions(e.target.value)}/></label>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions"><span className="project-edit-spacer"/>
        <button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="project-edit-save" disabled={busy || !name.trim()}>{busy ? 'Saving…' : agent ? 'Save' : NAMES.addAgent}</button>
      </div>
    </form>
  </ModalSheet>;
}

/** Edit button for a Muster agent's page. */
export function EditAgentButton({ agent, snapshot }: { agent: WorkspaceAgent; snapshot: WorkspaceSnapshot }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (agent.source !== 'local' || !agent.projectId || !agent.memberId || agent.memberId === 'agent') return null;
  return <><button type="button" className="settings-button secondary" onClick={() => setOpen(true)}><Pencil size={13}/>Edit</button>
    <AgentSheet open={open} projectId={agent.projectId} snapshot={snapshot} agent={agent} onClose={() => setOpen(false)}/></>;
}
