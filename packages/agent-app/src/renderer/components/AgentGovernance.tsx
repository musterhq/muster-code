/**
 * What governs an agent (Wave 1 of the Paperclip-parity work, #117), on the agent's page inside a project: its instruction
 * bundle with revisions (G11), how it wakes and why (C14, C30), what it may do and the tools it may use (G12, G13), the
 * identity its commits carry (C12) and the secrets lent to it (G23). Muster agents only; every control talks to the
 * project's governance commands and says what happened.
 */
import { History, Play, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import type { WorkspaceAgent, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import {
  ASSIGN_SCOPE_LABEL, BUNDLE_HELP, CONTAINMENT_LABEL, LIVENESS_LABEL, RUN_REASON_LABEL,
  type AgentCapabilities, type AgentGovernanceView, type AssignScope, type Containment, type HeartbeatPolicy, type ProjectSecret, type ToolRule, type ToolRuleEffect, type ToolRuleMatch, type WakeRecord,
} from '../../shared/domains/project-governance-protocol';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { StateChip } from './HubParts';
import { ResourceState } from './ResourceState';
import './governance.css';

type Tab = 'instructions' | 'runtime' | 'permissions' | 'secrets' | 'revisions';
const TABS: [Tab, string][] = [['instructions', 'Instructions'], ['runtime', 'Runtime'], ['permissions', 'Permissions'], ['secrets', 'Secrets'], ['revisions', 'Revisions']];
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const INTERVALS: [number, string][] = [[60, 'Every minute'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [1800, 'Every 30 minutes'], [3600, 'Every hour'], [7200, 'Every 2 hours'], [21600, 'Every 6 hours'], [43200, 'Every 12 hours'], [86400, 'Every day']];
const WAKE_TONE: Record<WakeRecord['status'], 'ok' | 'warn' | 'danger' | 'faint'> = { started: 'ok', coalesced: 'faint', throttled: 'warn', deferred: 'warn', skipped: 'faint', refused: 'danger', storm: 'danger' };

export function AgentGovernancePanel({ agent, snapshot }: { agent: WorkspaceAgent; snapshot: WorkspaceSnapshot }): React.ReactElement | null {
  const [tab, setTab] = useState<Tab>('instructions');
  const [view, setView] = useState<AgentGovernanceView | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const projectId = agent.projectId, memberId = agent.memberId;
  useEffect(() => {
    if (!projectId || !memberId) return;
    let live = true; setError('');
    invoke('project.agent.gov.get', { projectId, memberId }).then(v => { if (live) setView(v); }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [projectId, memberId, tick]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  if (agent.source !== 'local' || !projectId || !memberId) return null;
  return <section className="ws-section gov-panel" aria-label="Governance">
    <div className="gov-head"><h2 className="ws-group-title">Governance</h2>
      <div className="ws-segmented is-inline" role="tablist" aria-label="Agent governance">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className="ws-segment" onClick={() => setTab(id)}><span className="ws-segment-label">{label}</span></button>)}</div></div>
    {error && !view ? <ResourceState kind="error" message="This agent’s governance could not be loaded." detail={error} onRetry={reload}/>
      : !view ? <ResourceState kind="loading" compact label="Loading" rows={3}/>
      : tab === 'instructions' ? <InstructionsTab projectId={projectId} memberId={memberId} view={view} onChanged={() => { reload(); void refreshWorkspace(); }}/>
      : tab === 'runtime' ? <RuntimeTab projectId={projectId} memberId={memberId} agent={agent} view={view} snapshot={snapshot} onChanged={reload}/>
      : tab === 'permissions' ? <PermissionsTab projectId={projectId} memberId={memberId} view={view} onChanged={reload}/>
      : tab === 'secrets' ? <SecretsTab projectId={projectId} memberId={memberId} agentName={agent.name} onChanged={() => { reload(); void refreshWorkspace(); }}/>
      : <RevisionsTab projectId={projectId} memberId={memberId} view={view} onChanged={() => { reload(); void refreshWorkspace(); }}/>}
  </section>;
}

function Check({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return <label className="pp-check gov-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/>{label}{hint && <span className="ws-faint"> {hint}</span>}</label>;
}

// --- Instructions: the bundle (G11) -------------------------------------------------------------------------------------------
function InstructionsTab({ projectId, memberId, view, onChanged }: { projectId: string; memberId: string; view: AgentGovernanceView; onChanged: () => void }): React.ReactElement {
  const [name, setName] = useState('AGENTS.md');
  const file = view.files.find(f => f.name === name) ?? view.files[0]!;
  const [text, setText] = useState(file.text);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  useEffect(() => { setText(view.files.find(f => f.name === name)?.text ?? ''); setNote(''); }, [name, view.files]);
  const dirty = text !== (view.files.find(f => f.name === name)?.text ?? '');
  const save = async () => {
    setBusy(true);
    try { const out = await invoke('project.agent.files.save', { projectId, memberId, name, text, ...(note.trim() ? { note: note.trim() } : {}) }); notifySuccess(out.revision ? `${name} saved as revision ${out.revision.version}.` : 'Nothing changed.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const remove = async () => { setBusy(true); try { await invoke('project.agent.files.remove', { projectId, memberId, name }); setName('AGENTS.md'); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const addFile = () => { const n = adding.trim().endsWith('.md') ? adding.trim() : `${adding.trim()}.md`; if (!adding.trim()) return; setName(n); setText(''); setAdding(''); };
  const standard = ['AGENTS.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md'];
  const known = view.files.some(f => f.name === name);
  return <div className="gov-body">
    <p className="project-section-note">The folder of notes every run of this agent receives. {BUNDLE_HELP[name] ?? 'An extra note: listed by name in every run; the agent asks you if it needs it.'}</p>
    <div className="gov-files" role="tablist" aria-label="Instruction files">
      {view.files.map(f => <button key={f.name} type="button" role="tab" aria-selected={f.name === name} className="ws-filter" onClick={() => setName(f.name)}>{f.name}{f.text.trim() ? '' : <span className="ws-faint"> · empty</span>}</button>)}
      {!known && <button type="button" role="tab" aria-selected className="ws-filter">{name} · new</button>}
      <span className="gov-add"><input type="text" className="ws-input" aria-label="New file name" placeholder="NOTES.md" value={adding} maxLength={64} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFile(); } }}/><button type="button" className="icon-button" aria-label="Add file" disabled={!adding.trim()} onClick={addFile}><Plus size={14}/></button></span>
    </div>
    <textarea className="gov-editor" aria-label={`${name} text`} rows={12} maxLength={32768} value={text} disabled={busy} placeholder={name === 'AGENTS.md' ? 'What this agent owns, how it works, and when it should ask you' : 'Write in Markdown'} onChange={e => setText(e.target.value)}/>
    <div className="gov-actions">
      <input type="text" className="ws-input" aria-label="Revision note" placeholder="Revision note (optional)" maxLength={500} value={note} onChange={e => setNote(e.target.value)}/>
      {!standard.includes(name) && known && <button type="button" className="settings-button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={13}/>Remove file</button>}
      <button type="button" className="settings-button" disabled={busy || (!dirty && known)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  </div>;
}

// --- Runtime: heartbeat, wakes (C14, C30) --------------------------------------------------------------------------------------
function RuntimeTab({ projectId, memberId, agent, view, snapshot, onChanged }: { projectId: string; memberId: string; agent: WorkspaceAgent; view: AgentGovernanceView; snapshot: WorkspaceSnapshot; onChanged: () => void }): React.ReactElement {
  const [hb, setHb] = useState<HeartbeatPolicy>(view.governance.heartbeat);
  const [busy, setBusy] = useState(false);
  const [wakeTask, setWakeTask] = useState('');
  const [last, setLast] = useState<WakeRecord | null>(null);
  useEffect(() => setHb(view.governance.heartbeat), [view.governance.heartbeat]);
  const dirty = JSON.stringify(hb) !== JSON.stringify(view.governance.heartbeat);
  const save = async () => { setBusy(true); try { await invoke('project.agent.gov.set', { projectId, memberId, heartbeat: hb }); notifySuccess('Run policy saved.'); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const wake = async () => { setBusy(true); try { const r = await invoke('project.agent.wake', { projectId, memberId, ...(wakeTask ? { taskId: wakeTask } : {}) }); setLast(r); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const tasks = snapshot.tasks.filter(t => t.assigneeId === agent.id && t.status !== 'done' && t.status !== 'cancelled');
  const taskKey = (id: string | null) => snapshot.tasks.find(t => t.id === id)?.key ?? '';
  return <div className="gov-body">
    <p className="project-section-note">Everything is off until you turn it on. A timer wake only starts a run when this agent has ready work; an idle heartbeat costs nothing.</p>
    <div className="gov-grid">
      <Check label="Heartbeat timer" checked={hb.enabled} disabled={busy} onChange={enabled => setHb({ ...hb, enabled })}/>
      <label className="gov-field"><span>Wake</span><select className="ws-select is-field" aria-label="Heartbeat interval" value={INTERVALS.some(([s]) => s === hb.intervalSec) ? hb.intervalSec : 'custom'} disabled={busy || !hb.enabled} onChange={e => setHb({ ...hb, intervalSec: Number(e.target.value) })}>
        {!INTERVALS.some(([s]) => s === hb.intervalSec) && <option value="custom">Every {hb.intervalSec} s</option>}{INTERVALS.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select></label>
      <Check label="Wake when a task is assigned to it" checked={hb.wakeOnAssignment} disabled={busy} onChange={wakeOnAssignment => setHb({ ...hb, wakeOnAssignment })}/>
      <Check label="Wake on a comment or @mention" checked={hb.wakeOnComment} disabled={busy} onChange={wakeOnComment => setHb({ ...hb, wakeOnComment })}/>
      <Check label="Wake on a decision" hint="(review verdicts and answers reach it with their note)" checked={hb.wakeOnDecision} disabled={busy} onChange={wakeOnDecision => setHb({ ...hb, wakeOnDecision })}/>
      <label className="gov-field"><span>Runs at once</span><span className="gov-inline"><input className="ws-input gov-num" type="number" min={0} max={8} aria-label="Most tasks at once" value={hb.maxConcurrent} disabled={busy} onChange={e => setHb({ ...hb, maxConcurrent: Number(e.target.value) })}/> tasks · 0 means no limit beyond the project’s</span></label>
      <label className="gov-field"><span>Least time between wakes</span><span className="gov-inline"><input className="ws-input gov-num" type="number" min={0} max={3600} aria-label="Least seconds between wakes" value={hb.minGapSec} disabled={busy} onChange={e => setHb({ ...hb, minGapSec: Number(e.target.value) })}/> seconds · wakes inside it merge into one run</span></label>
    </div>
    <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button" disabled={busy || !dirty} onClick={() => void save()}>Save</button></div>
    <h3 className="ws-prop-group">Wake now</h3>
    <div className="gov-actions">
      <select className="ws-select is-field" aria-label="Task to wake it for" value={wakeTask} disabled={busy} onChange={e => setWakeTask(e.target.value)}><option value="">Its next ready task</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}</select>
      <button type="button" className="settings-button secondary" disabled={busy || agent.status === 'paused'} onClick={() => void wake()}><Play size={13}/>Wake now</button>
    </div>
    {last && <p role="status" className="gov-result" data-status={last.status}>{last.status === 'started' ? 'Started a run.' : last.detail}</p>}
    <h3 className="ws-prop-group">Recent wakes</h3>
    {view.wakes.length === 0 ? <p className="ws-board-empty">No wakes yet.</p> : <ul className="ws-rows gov-list" aria-label="Recent wakes">{view.wakes.slice(0, 12).map(w => <li key={w.id} className="gov-item">
      <StateChip tone={WAKE_TONE[w.status]}>{w.status}</StateChip><span className="gov-item-title">{RUN_REASON_LABEL[w.reason]}{w.taskId ? ` · ${taskKey(w.taskId)}` : ''}{w.merged > 1 ? ` · ${w.merged} requests` : ''}</span><span className="ws-faint gov-item-detail">{w.detail}</span><time className="ws-row-age" title={exactTime(w.createdAt)}>{agoLabel(w.createdAt)}</time></li>)}</ul>}
    <h3 className="ws-prop-group">Recent runs</h3>
    {view.runs.length === 0 ? <p className="ws-board-empty">No runs yet.</p> : <ul className="ws-rows gov-list" aria-label="Recent runs">{view.runs.slice(0, 12).map(r => <li key={r.chatId} className="gov-item">
      <StateChip tone="faint">{RUN_REASON_LABEL[r.reason]}</StateChip><span className="gov-item-title">{taskKey(r.taskId)}</span><span className="ws-faint gov-item-detail">{[r.liveness ? LIVENESS_LABEL[r.liveness] : null, r.continuations ? `${r.continuations} continued` : null, r.retries ? `${r.retries} retried` : null, r.comment === 'asked' ? 'asked to comment' : r.comment === 'backstop' ? 'no comment from the agent' : null].filter(Boolean).join(' · ')}</span><time className="ws-row-age" title={exactTime(r.createdAt)}>{agoLabel(r.createdAt)}</time></li>)}</ul>}
  </div>;
}

// --- Permissions, tool rules, git identity (G12, G13, C12) ---------------------------------------------------------------------
function PermissionsTab({ projectId, memberId, view, onChanged }: { projectId: string; memberId: string; view: AgentGovernanceView; onChanged: () => void }): React.ReactElement {
  const g = view.governance;
  const [caps, setCaps] = useState<AgentCapabilities>(g.capabilities);
  const [rules, setRules] = useState<Omit<ToolRule, 'id'>[]>(g.toolRules.map(({ id: _id, ...r }) => r));
  const [identity, setIdentity] = useState({ name: g.gitIdentity?.name ?? '', email: g.gitIdentity?.email ?? '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCaps(g.capabilities); setRules(g.toolRules.map(({ id: _id, ...r }) => r)); setIdentity({ name: g.gitIdentity?.name ?? '', email: g.gitIdentity?.email ?? '' }); }, [g]);
  const save = async (what: 'caps' | 'rules' | 'identity') => {
    setBusy(true);
    try {
      if (what === 'caps') await invoke('project.agent.gov.set', { projectId, memberId, capabilities: caps });
      else if (what === 'rules') await invoke('project.agent.gov.set', { projectId, memberId, toolRules: rules.filter(r => r.pattern.trim()) });
      else await invoke('project.agent.gov.set', { projectId, memberId, gitIdentity: identity.name.trim() || identity.email.trim() ? { name: identity.name, email: identity.email } : null });
      notifySuccess('Saved.'); onChanged();
    } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const low = caps.trust === 'low-trust';
  const setRule = (i: number, patch: Partial<Omit<ToolRule, 'id'>>) => setRules(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  return <div className="gov-body">
    <h3 className="ws-prop-group">What it may do</h3>
    <p className="project-section-note">Applies to what this agent asks for in its own replies. Its runs can never go above <strong>{view.ceiling === 'full' ? 'Full access' : view.ceiling === 'workspace' ? 'Workspace' : 'Read-only'}</strong> here{low ? ' (low-trust agents never get Full access)' : ''}.</p>
    <div className="gov-grid">
      <label className="gov-field"><span>Trust</span><select className="ws-select is-field" aria-label="Trust" value={caps.trust} disabled={busy} onChange={e => setCaps({ ...caps, trust: e.target.value as AgentCapabilities['trust'] })}><option value="standard">Standard</option><option value="low-trust">Low-trust (contained)</option></select></label>
      {low && <label className="gov-field"><span>Contained to</span><select className="ws-select is-field" aria-label="Containment" value={caps.containment} disabled={busy} onChange={e => setCaps({ ...caps, containment: e.target.value as Containment })}>{(Object.keys(CONTAINMENT_LABEL) as Containment[]).map(c => <option key={c} value={c}>{CONTAINMENT_LABEL[c]}</option>)}</select></label>}
      <Check label="Can create and assign tasks" checked={caps.canAssign} disabled={busy} onChange={canAssign => setCaps({ ...caps, canAssign })}/>
      <label className="gov-field"><span>Where</span><select className="ws-select is-field" aria-label="Assign scope" value={caps.assignScope} disabled={busy || !caps.canAssign} onChange={e => setCaps({ ...caps, assignScope: e.target.value as AssignScope })}>{(Object.keys(ASSIGN_SCOPE_LABEL) as AssignScope[]).map(s => <option key={s} value={s}>{ASSIGN_SCOPE_LABEL[s]}</option>)}</select></label>
      <Check label="Can propose adding agents" hint={low ? '(not for low-trust agents)' : '(you approve when the project requires it)'} checked={caps.canHire && !low} disabled={busy || low} onChange={canHire => setCaps({ ...caps, canHire })}/>
    </div>
    <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button" disabled={busy || JSON.stringify(caps) === JSON.stringify(g.capabilities)} onClick={() => void save('caps')}>Save</button></div>
    <h3 className="ws-prop-group">Tool rules</h3>
    <p className="project-section-note">Checked when a run asks to run a command, change files or call a connector. The strictest matching rule wins. “Allow” answers the approval for you; it never lifts a read-only run. Patterns use * and ?.</p>
    {rules.length === 0 && <p className="ws-board-empty">No rules: the usual approval cards apply.</p>}
    <ul className="gov-rules" aria-label="Tool rules">{rules.map((r, i) => <li key={i} className="gov-rule">
      <select className="ws-select" aria-label={`Rule ${i + 1} matches`} value={r.match} onChange={e => setRule(i, { match: e.target.value as ToolRuleMatch })}><option value="command">Command</option><option value="file">File path</option><option value="mcp">Connector tool</option><option value="any">Anything</option></select>
      <input type="text" className="ws-input" aria-label={`Rule ${i + 1} pattern`} placeholder={r.match === 'command' ? 'git push*' : r.match === 'file' ? '.env*' : r.match === 'mcp' ? 'github/*' : '*'} maxLength={300} value={r.pattern} onChange={e => setRule(i, { pattern: e.target.value })}/>
      <select className="ws-select" aria-label={`Rule ${i + 1} effect`} value={r.effect} onChange={e => setRule(i, { effect: e.target.value as ToolRuleEffect })}><option value="allow">Allow</option><option value="ask">Ask me</option><option value="deny">Deny</option></select>
      <input type="text" className="ws-input" aria-label={`Rule ${i + 1} note`} placeholder="Why (optional)" maxLength={200} value={r.note ?? ''} onChange={e => setRule(i, { note: e.target.value })}/>
      <button type="button" className="icon-button" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rs => rs.filter((_, j) => j !== i))}><Trash2 size={14}/></button></li>)}</ul>
    <div className="gov-actions"><button type="button" className="settings-button secondary" disabled={busy || rules.length >= 60} onClick={() => setRules(rs => [...rs, { match: 'command', pattern: '', effect: 'ask' }])}><Plus size={13}/>Add rule</button><span className="gov-grow"/>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void save('rules')}>Save rules</button></div>
    <h3 className="ws-prop-group">Git identity</h3>
    <p className="project-section-note">Commits this agent makes carry this name and email, not yours. In a task’s own worktree it is written to the worktree’s config; in the main checkout (which keeps your identity) it applies to the run only.</p>
    <div className="gov-grid">
      <label className="gov-field"><span>Name</span><input type="text" className="ws-input" aria-label="Git name" maxLength={120} placeholder="CTO Agent" value={identity.name} disabled={busy} onChange={e => setIdentity({ ...identity, name: e.target.value })}/></label>
      <label className="gov-field"><span>Email</span><input type="text" className="ws-input" aria-label="Git email" maxLength={200} placeholder="cto@yourcompany.dev" value={identity.email} disabled={busy} onChange={e => setIdentity({ ...identity, email: e.target.value })}/></label>
    </div>
    <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button" disabled={busy || (identity.name === (g.gitIdentity?.name ?? '') && identity.email === (g.gitIdentity?.email ?? ''))} onClick={() => void save('identity')}>Save identity</button></div>
  </div>;
}

// --- Secrets lent to this agent (G23) ---------------------------------------------------------------------------------------------
function SecretsTab({ projectId, memberId, agentName, onChanged }: { projectId: string; memberId: string; agentName: string; onChanged: () => void }): React.ReactElement {
  const [data, setData] = useState<{ secrets: ProjectSecret[]; secureStorage: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; invoke('project.secrets.list', { projectId }).then(d => { if (live) setData(d); }, () => { if (live) setData({ secrets: [], secureStorage: false }); }); return () => { live = false; }; }, [projectId, tick]);
  const toggle = async (name: string, granted: boolean) => { try { await invoke('project.secrets.grant', { projectId, name, memberId, granted }); setTick(n => n + 1); onChanged(); } catch (cause) { notifyError(cause); } };
  if (!data) return <ResourceState kind="loading" compact label="Loading" rows={2}/>;
  return <div className="gov-body">
    <p className="project-section-note">Secrets you lend to {agentName} reach its runs as environment variables (Codex, Claude Code and OpenCode runs). Values are never shown or written into prompts. Add and rotate secrets in the project’s Settings › Secrets.</p>
    {!data.secureStorage && <p role="alert" className="gov-result" data-status="refused">This computer has no secure keychain, so Muster cannot store secrets. Nothing is saved in plain text.</p>}
    {data.secrets.length === 0 ? <p className="ws-board-empty">No secrets in this project yet.</p> : <ul className="ws-rows gov-list" aria-label="Project secrets">{data.secrets.map(s => <li key={s.name} className="gov-item"><label className="pp-check"><input type="checkbox" checked={s.grantedTo.includes(agentName)} onChange={e => void toggle(s.name, e.target.checked)}/><code>{s.name}</code></label>
      <span className="ws-faint gov-item-detail">v{s.version}{s.expiresAt ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}` : ''}{s.description ? ` · ${s.description}` : ''}</span></li>)}</ul>}
  </div>;
}

// --- Revisions (G11) ----------------------------------------------------------------------------------------------------------------
function RevisionsTab({ projectId, memberId, view, onChanged }: { projectId: string; memberId: string; view: AgentGovernanceView; onChanged: () => void }): React.ReactElement {
  const [busy, setBusy] = useState('');
  const restore = async (id: string) => { setBusy(id); try { const out = await invoke('project.agent.revisions.restore', { projectId, memberId, revisionId: id }); notifySuccess(`Restored as revision ${out.revision.version}.`); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(''); } };
  if (view.revisions.length === 0) return <p className="ws-board-empty">No revisions yet. Each save of an instruction file makes one.</p>;
  return <ul className="ws-rows gov-list" aria-label="Revisions">{view.revisions.map((r, i) => <li key={r.id} className="gov-item"><History size={13} aria-hidden="true"/>
    <span className="gov-item-title">Revision {r.version}{i === 0 ? ' · current' : ''}</span><span className="ws-faint gov-item-detail">{r.actor} · changed {r.changed.join(', ') || 'nothing'}{r.note ? ` · ${r.note}` : ''}</span><time className="ws-row-age" title={exactTime(r.createdAt)}>{agoLabel(r.createdAt)}</time>
    {i > 0 && <button type="button" className="settings-button secondary" disabled={busy !== ''} onClick={() => void restore(r.id)}>{busy === r.id ? 'Restoring…' : 'Restore'}</button>}</li>)}</ul>;
}
