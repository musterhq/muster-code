/**
 * One project page for every project (#193), Muster-native or Paperclip, laid out like Paperclip's:
 * - a header with the title, repository and open count;
 * - tabs: Dashboard · Tasks · Roster · Outputs · Ledger · Budget · Settings (Paperclip's Configuration). These live only
 *   inside a project; the app sidebar stays Inbox, New chat, Search, Memory, Automations, then Pinned, Folders, Projects.
 * Everything the old 13-tab project screen did is still here:
 * - Tasks has the list and board;
 * - Roster merged the old Agents tab (#186);
 * - Outputs also has Changes;
 * - Settings holds General (name, goal, key prefix, default model, approvals, instructions, coordinator, archive and
 *   delete), Folders, Members, Mail (renamed from the project "Inbox", #186), Chats, Knowledge, Runs & verification
 *   (schedules, verification, the task graph) and Activity.
 */
import { Menu } from '@base-ui/react/menu';
import { Archive, ArchiveRestore, Clipboard, Download, FolderClosed, MoreHorizontal, Settings2, SquarePen, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import type { DashboardData, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { budgetUse, OPEN_STATUSES } from '../../shared/domains/paperclip-protocol';
import type { ProjectDetails, TeamSettings } from '../../shared/domains/projects-protocol';
import { DEFAULT_TEAM_SETTINGS, keyPrefixOf } from '../../shared/domains/project-team-protocol';
import { formatUsd } from '../../shared/model-catalog';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { openAppSettings, openChangesTab, openMemoryScreen, notifyError, notifySuccess } from '../store';
import { type HubNav, LedgerPage, ListPage } from './HubPages';
import { MailboxInbox } from './MailboxInbox';
import { ProjectActivityPanel } from './ProjectActivityPanel';
import { ConfirmProjectAction, EditProjectDialog } from './ProjectEditDialog';
import { scopeToProject } from './ProjectHub';
import { HandoffCard, SourcesCard } from './ProjectKnowledge';
import { ProjectMembersSection } from './ProjectMembers';
import { CoordinatorCard, InstructionsCard } from './ProjectOverview';
import { GovernanceSection, SecretsSection } from './ProjectGovernance';
import { ChatsTab, FoldersTab, InlineText } from './ProjectParts';
import { ProjectAgentsSection, ProjectChangesSection, ProjectEnvironmentsSection, ProjectMemorySection } from './ProjectSections';
import { copyProjectExport, ProjectDecisionSection, ProjectTaskSection, relativeTime, saveProjectExport, useProjectWork, type TaskFilter } from './ProjectTasks';
import { ResourceState } from './ResourceState';
import { RosterPanel } from './RosterPanel';
import { ProjectDefaultModel } from './settings/ProjectDefaultModel';
import { NewTaskSheet } from './HubSetup';
import { TaskList } from './TaskList';
import { ProjectCostSummary } from './UsageCost';
import { DashboardPage, RunActivityChart } from './DashboardPage';

export type ProjectPageTab = 'dashboard' | 'tasks' | 'roster' | 'outputs' | 'ledger' | 'budget' | 'settings';
const TABS: { id: ProjectPageTab; label: string }[] = [{ id: 'dashboard', label: NAMES.dashboard }, { id: 'tasks', label: NAMES.tasks }, { id: 'roster', label: NAMES.roster }, { id: 'outputs', label: NAMES.outputs }, { id: 'ledger', label: NAMES.ledger }, { id: 'budget', label: NAMES.budget }, { id: 'settings', label: NAMES.settings }];
type SettingsSection = 'general' | 'folders' | 'members' | 'mail' | 'chats' | 'knowledge' | 'runs' | 'governance' | 'secrets' | 'activity';
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: 'General' }, { id: 'folders', label: 'Folders' }, { id: 'members', label: 'Members' }, { id: 'mail', label: NAMES.mail },
  { id: 'chats', label: 'Chats' }, { id: 'knowledge', label: 'Knowledge' }, { id: 'runs', label: 'Runs & verification' }, { id: 'governance', label: 'Run policy' }, { id: 'secrets', label: 'Secrets' }, { id: 'activity', label: 'Activity' },
];
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** What only a Muster project has: its record, folders and chats, and the actions of the app around it. */
export interface MusterProjectContext {
  project: ProjectDetails; allFolders: Folder[]; chats: Chat[];
  onUpdated: (p: ProjectDetails) => void; onStartChat: (folderId?: string) => void; onOpenChat: (id: string) => void; onLeave: () => void; onDeleted: () => void;
}

export function ProjectPage({ snapshot, projectId, nav, muster, initialTab = 'tasks' }: { snapshot: WorkspaceSnapshot | null; projectId: string; nav: HubNav; muster?: MusterProjectContext; initialTab?: ProjectPageTab }): React.ReactElement {
  const [tab, setTab] = useState<ProjectPageTab>(initialTab);
  const [section, setSection] = useState<SettingsSection>('general');
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  useEffect(() => { if (!status) return; const t = setTimeout(() => setStatus(''), 6000); return () => clearTimeout(t); }, [status]);
  const scoped = useMemo(() => snapshot ? scopeToProject(snapshot, projectId) : null, [snapshot, projectId]);
  const summary = scoped?.projects[0];
  const project = muster?.project;
  const name = project?.name ?? summary?.name ?? NAMES.projects;
  const local = Boolean(muster) || summary?.source === 'local';
  const open = scoped ? scoped.tasks.filter(t => OPEN_STATUSES.includes(t.status)).length : 0;
  const where = summary?.repo ?? summary?.cwd ?? (muster ? muster.allFolders.find(f => f.id === project?.primaryFolderId)?.path ?? null : null);
  const save = async (patch: { name?: string; goal?: string }) => { if (project) muster!.onUpdated(await invoke('project.update', { id: project.id, ...patch })); await refreshWorkspace(); };
  const restore = async () => { if (!project) return; try { muster!.onUpdated(await invoke('project.restore', { id: project.id })); setStatus('Project restored. Task runs can start again.'); } catch (err) { setStatus(errorText(err)); } };
  const tabKeys = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex(t => t.id === tab), next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault(); setTab(TABS[next].id); (e.currentTarget.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined)?.focus();
  };
  if (!muster && snapshot && !summary) return <ResourceState kind="empty" message="This project is no longer in the linked Paperclip."/>;
  return <article className="pp" aria-label={`Project ${name}`}>
    <header className="pp-head">
      <span className="pp-icon" aria-hidden="true"><FolderClosed size={16}/></span>
      <div className="pp-title">
        {project ? <InlineText className="pp-name" label="Project name" placeholder="Name this project" maxLength={256} value={project.name} onSave={next => save({ name: next })}/> : <h1 className="pp-name">{name}</h1>}
        <p className="pp-sub">{where && <span className="pp-repo" title={where}>{where}</span>}<span>{open} open{scoped ? ` of ${scoped.tasks.length}` : ''}</span>{summary?.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}{project?.archived && <span className="ws-chip" data-tone="warn">Archived</span>}</p>
        {summary?.source === 'local' && summary.org && <p className="project-edit-hint pp-imported-note">Imported copy from {summary.org}. Paperclip changes arrive when you import again; edits here, including a task's priority or owner, stay in Muster.</p>}
      </div>
      {muster && project && <div className="pp-actions">
        {!project.archived && <button type="button" className="settings-button secondary" onClick={() => muster.onStartChat(project.folderIds[0])}><SquarePen size={14}/>New chat</button>}
        <Menu.Root>
          <Menu.Trigger className="icon-button" aria-label="Project actions"><MoreHorizontal size={16}/></Menu.Trigger>
          <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="ui-menu-positioner"><Menu.Popup className="ui-menu">
            <Menu.Item onClick={() => setEditing(true)}><Settings2 size={14}/>Edit project…</Menu.Item>
            <Menu.Separator/>
            <Menu.Item onClick={() => void copyProjectExport(project, project.folderIds.length).then(setStatus)}><Clipboard size={14}/>Copy export JSON</Menu.Item>
            <Menu.Item onClick={() => void saveProjectExport(project).then(setStatus)}><Download size={14}/>Save export JSON…</Menu.Item>
            <Menu.Separator/>
            {project.archived ? <Menu.Item onClick={() => void restore()}><ArchiveRestore size={14}/>Restore project</Menu.Item> : <Menu.Item onClick={() => setConfirm('archive')}><Archive size={14}/>Archive project…</Menu.Item>}
            <Menu.Item className="project-menu-destructive" onClick={() => setConfirm('delete')}><Trash2 size={14}/>Delete project…</Menu.Item>
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>
      </div>}
    </header>
    {status && <p className="project-status" role="status">{status}</p>}
    <div className="pp-tabs" role="tablist" aria-label="Project views" onKeyDown={tabKeys}>
      {TABS.map(t => <button key={t.id} type="button" role="tab" id={`pp-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="pp-panel" tabIndex={tab === t.id ? 0 : -1} className="pp-tab" onClick={() => setTab(t.id)}>{t.label}</button>)}
    </div>
    <div className="pp-panel" role="tabpanel" id="pp-panel" aria-labelledby={`pp-tab-${tab}`} data-tab={tab}>
      {!scoped ? <ResourceState kind="loading" label="Loading the project" rows={5}/>
        : tab === 'tasks' ? <TaskList snapshot={scoped} tasks={scoped.tasks} scope={projectId} onOpenTask={nav.onOpenTask} onNewTask={project?.archived ? undefined : () => setCreating(true)} emptyMessage={local ? 'No tasks yet. Create one, give it an owner from the Roster, and start it in its own worktree.' : 'No tasks in this project yet.'}/>
        : tab === 'roster' ? <RosterPanel snapshot={scoped} projectId={projectId} local={local} nav={nav}>{muster && <WorkingNow projectId={projectId} chats={muster.chats} onOpenChat={muster.onOpenChat}/>}</RosterPanel>
        : tab === 'outputs' ? <div className="pp-outputs"><ListPage kind="artifacts" embedded projectId={projectId}/>{muster && <ProjectChangesSection folders={muster.allFolders.filter(f => muster.project.folderIds.includes(f.id))} onReview={f => { openChangesTab(f.id, f.name); muster.onLeave(); }}/>}</div>
        : tab === 'dashboard' ? <DashboardPage snapshot={scoped} nav={nav} projectId={projectId}/>
        : tab === 'ledger' ? <LedgerPage snapshot={scoped} nav={nav} projectId={projectId}/>
        : tab === 'budget' ? <BudgetTab projectId={projectId} local={local} name={name}/>
        : muster ? <MusterSettings context={muster} snapshot={scoped} section={section} onSection={setSection} onEdit={() => setEditing(true)} onArchive={() => setConfirm('archive')} onDelete={() => setConfirm('delete')} onRestore={() => void restore()} onStatus={setStatus}/>
        : <PaperclipSettings snapshot={scoped}/>}
    </div>
    <NewTaskSheet open={creating} snapshot={snapshot} projectId={projectId} onClose={() => setCreating(false)} onCreated={() => undefined}/>
    {muster && project && <>
      <EditProjectDialog project={project} allFolders={muster.allFolders} open={editing} onClose={() => setEditing(false)} onSaved={p => { muster.onUpdated(p); setStatus('Project saved.'); }} onArchive={() => { setEditing(false); setConfirm('archive'); }}/>
      <ConfirmProjectAction project={project} action={confirm} onClose={() => setConfirm(null)} onArchived={p => { muster.onUpdated(p); setStatus('Project archived. Task runs are paused.'); }} onDeleted={muster.onDeleted}/>
    </>}
  </article>;
}

/** The old Agents tab: which task runs are working or waiting right now, with their chats. */
function WorkingNow({ projectId, chats, onOpenChat }: { projectId: string; chats: Chat[]; onOpenChat: (id: string) => void }): React.ReactElement | null {
  const { work } = useProjectWork(projectId);
  // Only while something runs or waits: Pulse below already covers the rest.
  if (!work || !work.tasks.items.some(t => t.state === 'running' || t.state === 'needs-input')) return null;
  return <section className="ws-section" aria-label="Working now"><h2 className="ws-group-title">Working now</h2><ProjectAgentsSection work={work} chats={chats} onOpenChat={onOpenChat} onShowTasks={() => undefined}/></section>;
}

/** Settings for a Muster project: every section of the old project screen, grouped. */
function MusterSettings({ context, snapshot, section, onSection, onEdit, onArchive, onDelete, onRestore, onStatus }: { context: MusterProjectContext; snapshot: WorkspaceSnapshot; section: SettingsSection; onSection: (s: SettingsSection) => void; onEdit: () => void; onArchive: () => void; onDelete: () => void; onRestore: () => void; onStatus: (text: string) => void }): React.ReactElement {
  const { project, allFolders, chats, onUpdated, onStartChat, onOpenChat } = context;
  const { work, error, reload } = useProjectWork(project.id);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const folders = useMemo(() => project.folderIds.map(id => allFolders.find(f => f.id === id)).filter((f): f is Folder => Boolean(f)), [project.folderIds, allFolders]);
  const needsWork = section === 'general' || section === 'knowledge' || section === 'runs';
  return <div className="pp-settings">
    <nav className="pp-settings-nav" aria-label="Settings sections">{SECTIONS.map(s => <button key={s.id} type="button" className="ws-filter" aria-pressed={section === s.id} onClick={() => onSection(s.id)}>{s.label}</button>)}</nav>
    <div className="pp-settings-body">
      {needsWork && error ? <ResourceState kind="error" message="This project’s work could not be loaded." detail={error} onRetry={reload}/>
        : needsWork && !work ? <ResourceState kind="loading" label="Loading project" rows={4}/>
        : section === 'general' ? <GeneralSettings project={project} onUpdated={onUpdated} onEdit={onEdit} onArchive={onArchive} onDelete={onDelete} onRestore={onRestore} onOpenChat={onOpenChat}>
            <InstructionsCard projectId={project.id} instructions={work!.instructions} onChanged={reload}/>
            <CoordinatorCard projectId={project.id} coordinator={work!.coordinator} archived={project.archived} onOpenChat={onOpenChat} onChanged={reload}/>
          </GeneralSettings>
        : section === 'folders' ? <ProjectEnvironmentsSection chats={chats} folders={allFolders} onOpenChat={onOpenChat}><FoldersTab project={project} folders={folders} allFolders={allFolders} chats={chats} highlight={null} onUpdated={onUpdated} onStartChat={onStartChat}/></ProjectEnvironmentsSection>
        : section === 'members' ? <section aria-label="Members" className="project-section"><p className="project-section-note">People and agents on this project and what each may access. Agents are added and arranged on the {NAMES.roster} tab.</p><ProjectMembersSection project={project} folders={folders}/></section>
        : section === 'mail' ? <MailboxInbox projectId={project.id} title="Mail between this project’s chats, its task runs and you. Agents send and reply with the mailbox tools."/>
        : section === 'chats' ? <ChatsTab project={project} chats={chats} folders={allFolders} onOpenChat={onOpenChat} onStartChat={onStartChat} onStatus={onStatus}/>
        : section === 'knowledge' ? <div className="pp-stack">
            <div className="project-overview-cols"><SourcesCard projectId={project.id} onChanged={reload}/><ProjectMemorySection projectId={project.id} onOpenMemory={() => openMemoryScreen(`project:${project.id}`)}/></div>
            <HandoffCard projectId={project.id} tasks={work!.tasks.items} onOpenChat={onOpenChat}/>
            <ProjectDecisionSection projectId={project.id} work={work!} onChanged={reload}/>
          </div>
        : section === 'governance' ? <GovernanceSection projectId={project.id} snapshot={snapshot}/>
        : section === 'secrets' ? <SecretsSection projectId={project.id} snapshot={snapshot}/>
        : section === 'runs' ? <ProjectTaskSection project={project} folders={folders} work={work!} archived={project.archived} filter={filter} onFilter={setFilter} onChanged={reload}/>
        : <ProjectActivityPanel projectId={project.id} resolveRef={() => null} onOpenRef={() => undefined}/>}
    </div>
  </div>;
}

/** General: name and goal, task keys, default model, approval to add agents, the project's rules, and the danger zone. */
function GeneralSettings({ project, onUpdated, onEdit, onArchive, onDelete, onRestore, children }: { project: ProjectDetails; onUpdated: (p: ProjectDetails) => void; onEdit: () => void; onArchive: () => void; onDelete: () => void; onRestore: () => void; onOpenChat: (id: string) => void; children: React.ReactNode }): React.ReactElement {
  const [settings, setSettings] = useState<TeamSettings | null>(null);
  const [prefix, setPrefix] = useState('');
  useEffect(() => { let live = true; invoke('project.team.settings', { projectId: project.id }).then(s => { if (live) { setSettings(s); setPrefix(s.keyPrefix ?? ''); } }, () => { if (live) setSettings({ ...DEFAULT_TEAM_SETTINGS }); }); return () => { live = false; }; }, [project.id]);
  const change = async (patch: Partial<TeamSettings>) => {
    try { const next = await invoke('project.team.settings.set', { projectId: project.id, ...patch }); setSettings(next); setPrefix(next.keyPrefix ?? ''); await refreshWorkspace(); notifySuccess('Project settings saved.'); }
    catch (cause) { notifyError(cause); setPrefix(settings?.keyPrefix ?? ''); }
  };
  const save = async (patch: { name?: string; goal?: string }) => { onUpdated(await invoke('project.update', { id: project.id, ...patch })); await refreshWorkspace(); };
  return <div className="pp-stack">
    <dl className="pp-fields">
      <div><dt>Name</dt><dd><InlineText className="pp-field-text" label="Project name" placeholder="Name this project" maxLength={256} value={project.name} onSave={name => save({ name })}/></dd></div>
      <div><dt>Goal</dt><dd><InlineText className="pp-field-text" label="Shared goal" placeholder="Add a shared goal every chat and task run in this project can see" multiline maxLength={32768} value={project.goal} onSave={goal => save({ goal })}/></dd></div>
      <div><dt>Task keys</dt><dd className="pp-inline-form">
        <input className="ws-input pp-prefix" aria-label="Task key prefix" maxLength={8} value={prefix} placeholder={keyPrefixOf(project.name)} onChange={e => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') void change({ keyPrefix: prefix || null }); }}/>
        <button type="button" className="settings-button secondary" disabled={!settings || (prefix || null) === settings.keyPrefix} onClick={() => void change({ keyPrefix: prefix || null })}>Save</button>
        <span className="ws-faint">Tasks read {(prefix || keyPrefixOf(project.name))}-1, {(prefix || keyPrefixOf(project.name))}-2…</span></dd></div>
      <div><dt>Default model</dt><dd>{project.archived ? <span className="ws-faint">Restore the project to change it.</span> : <ProjectDefaultModel projectId={project.id}/>}</dd></div>
      <div><dt>Adding agents</dt><dd><label className="pp-check"><input type="checkbox" checked={settings?.requireHireApproval ?? false} disabled={!settings} onChange={e => void change({ requireHireApproval: e.target.checked })}/>Require approval to add an agent <span className="ws-faint">(new agents wait in the Inbox until you approve them)</span></label></dd></div>
      <div><dt>Folders and more</dt><dd><button type="button" className="settings-button secondary" onClick={onEdit}><Settings2 size={13}/>Edit project…</button></dd></div>
    </dl>
    <div className="project-overview-cols">{children}</div>
    <section className="pp-danger" aria-label="Danger zone">
      <h3>Danger zone</h3>
      {project.archived ? <p>Archived {project.archivedAt ? relativeTime(project.archivedAt) : ''}. Task runs are paused until you restore it. <button type="button" className="settings-button secondary" onClick={onRestore}><ArchiveRestore size={13}/>Restore project</button></p>
        : <p>Archive this project to pause its task runs and hide it from the sidebar. <button type="button" className="settings-button secondary" onClick={onArchive}><Archive size={13}/>Archive project…</button></p>}
      <p>Delete the project. Its chats stay and leave the project. <button type="button" className="settings-button danger" onClick={onDelete}><Trash2 size={13}/>Delete project…</button></p>
    </section>
  </div>;
}

/** A Paperclip project's configuration, read-only here (it is edited in Paperclip), with Import into Muster. */
function PaperclipSettings({ snapshot }: { snapshot: WorkspaceSnapshot }): React.ReactElement {
  const p = snapshot.projects[0];
  if (!p) return <ResourceState kind="empty" message="This project is no longer in the linked Paperclip."/>;
  return <div className="pp-stack">
    <dl className="pp-fields">
      <div><dt>Name</dt><dd>{p.name}</dd></div>
      <div><dt>Description</dt><dd className="pp-pre">{p.description || <span className="ws-faint">None</span>}</dd></div>
      <div><dt>Repository</dt><dd>{p.repo ?? <span className="ws-faint">None</span>}</dd></div>
      <div><dt>Local folder</dt><dd>{p.cwd ? <code>{p.cwd}</code> : <span className="ws-faint">None</span>}</dd></div>
      <div><dt>Memory</dt><dd>{p.memory ? `${p.memory.label} · ${p.memory.count} ${p.memory.count === 1 ? 'note' : 'notes'}` : <span className="ws-faint">No Muster folder matches this repository yet</span>}</dd></div>
    </dl>
    <p className="project-edit-hint">This project lives in {snapshot.paperclip?.company?.name ?? NAMES.paperclip}; change its configuration there. To work on its tasks in Muster, import it: it becomes its own project here, under its org.</p>
    <p><button type="button" className="settings-button secondary" onClick={() => openAppSettings('integrations')}>Import into Muster…</button></p>
  </div>;
}

/** Budget: this month's observed spend from the Ledger, a monthly budget (dollars, or tokens for unpriced models) with a
 *  soft alert at 80% (also an Inbox item, and another at 100%), and all-time cost. */
function BudgetTab({ projectId, local, name }: { projectId: string; local: boolean; name: string }): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<TeamSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  useEffect(() => {
    let live = true;
    invoke('paperclip.dashboard', { utcOffsetMinutes: -new Date().getTimezoneOffset(), projectId }).then(d => { if (live) setData(d); }, e => { if (live) setError(errorText(e)); });
    if (local) invoke('project.team.settings', { projectId }).then(s => { if (live) { setSettings(s); setDraft(s.monthlyBudgetUsd === null ? '' : String(s.monthlyBudgetUsd)); setTokenDraft(s.monthlyBudgetTokens == null ? '' : String(s.monthlyBudgetTokens)); } }, () => undefined);
    return () => { live = false; };
  }, [projectId, local]);
  const setBudget = async () => {
    const value = draft.trim() === '' ? null : Number(draft);
    if (value !== null && (!Number.isFinite(value) || value < 0)) { notifyError(new Error('Enter an amount in US dollars, or leave it empty for no budget.')); return; }
    try { setSettings(await invoke('project.team.settings.set', { projectId, monthlyBudgetUsd: value })); notifySuccess(value === null ? 'Budget removed.' : `Monthly budget set to ${formatUsd(value)}.`); } catch (cause) { notifyError(cause); }
  };
  const setTokenBudget = async () => {
    const value = tokenDraft.trim() === '' ? null : Number(tokenDraft.replace(/[,_\s]/g, ''));
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) { notifyError(new Error('Enter a whole number of tokens, or leave it empty for no token budget.')); return; }
    try { setSettings(await invoke('project.team.settings.set', { projectId, monthlyBudgetTokens: value })); notifySuccess(value === null ? 'Token budget removed.' : `Monthly token budget set to ${value.toLocaleString()} tokens.`); } catch (cause) { notifyError(cause); }
  };
  if (error) return <ResourceState kind="error" message="Spend could not be read." detail={error}/>;
  if (!data) return <ResourceState kind="loading" label="Reading spend" rows={3}/>;
  const spent = data.spend.usd, budget = settings?.monthlyBudgetUsd ?? null, tokenBudget = settings?.monthlyBudgetTokens ?? null, tokens = data.spend.tokens ?? 0;
  // A Paperclip project's budget is Paperclip's: its policy for this project, with the company's and its agents' alongside.
  const policy = !local ? data.budgets?.policies.find(p => p.scope === 'project' && p.scopeId === projectId) : undefined;
  const use = policy ? { unit: 'usd' as const, used: policy.observedUsd, limit: policy.limitUsd, ratio: policy.limitUsd ? policy.observedUsd / policy.limitUsd : 0 } : budgetUse({ usd: budget, tokens: tokenBudget }, { usd: spent, tokens });
  const ratio = use?.ratio ?? 0;
  const health = policy ? policy.status === 'hard_stop' || ratio >= 1 ? 'Over budget' : policy.status === 'warning' || ratio >= policy.warnPercent / 100 ? 'Near budget' : 'Healthy' : budget === null && tokenBudget === null ? 'No budget' : !use ? 'Unpriced' : ratio >= 1 ? 'Over budget' : ratio >= 0.8 ? 'Near budget' : 'Healthy';
  return <div className="pp-stack pp-budget">
    <div className="pp-budget-head"><div><p className="dash-label">Project</p><h2>{name}</h2><p className="ws-faint">Monthly budget · since {new Date(data.spend.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</p></div><span className="ws-chip" data-tone={health === 'Over budget' ? 'danger' : health === 'Near budget' ? 'warn' : health === 'Healthy' ? 'ok' : undefined}>{health}</span></div>
    <div className="pp-budget-grid">
      <div><p className="dash-label">Observed</p><p className="dash-value">{policy ? formatUsd(policy.observedUsd) : spent === null ? (data.spend.unpricedTurns ? 'Unpriced' : formatUsd(0)) : formatUsd(spent)}</p><p className="ws-faint">{data.spend.pricedTurns} priced {data.spend.pricedTurns === 1 ? 'turn' : 'turns'}{data.spend.unpricedTurns ? ` · ${data.spend.unpricedTurns} unpriced` : ''} · {tokens.toLocaleString()} tokens</p></div>
      <div><p className="dash-label">Budget</p><p className="dash-value">{policy ? formatUsd(policy.limitUsd) : use?.unit === 'tokens' ? `${tokenBudget!.toLocaleString()} tokens` : budget !== null ? formatUsd(budget) : tokenBudget !== null ? `${tokenBudget.toLocaleString()} tokens` : 'Not set'}</p><p className="ws-faint">{policy ? `${policy.hardStop ? 'Hard stop' : 'Soft alert'} at ${policy.hardStop ? 100 : policy.warnPercent}% · set in ${NAMES.paperclip}` : budget === null && tokenBudget === null ? 'No cap configured' : 'Soft alert at 80%, Inbox at 80% and 100%'}</p></div>
    </div>
    {use && <div className="pp-meter" role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={use.limit} aria-valuenow={use.used}><span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} data-tone={ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok'}/></div>}
    {local ? <div className="pp-inline-form"><label className="dash-label" htmlFor="pp-budget-input">Monthly budget (USD)</label>
      <input id="pp-budget-input" className="ws-input" inputMode="decimal" placeholder="No budget" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void setBudget(); }}/>
      <button type="button" className="settings-button" onClick={() => void setBudget()}>Set budget</button></div>
      : null}
    {local ? <div className="pp-inline-form"><label className="dash-label" htmlFor="pp-token-budget-input">Monthly budget (tokens)</label>
      <input id="pp-token-budget-input" className="ws-input" inputMode="numeric" placeholder={spent === null && data.spend.unpricedTurns ? 'For unpriced models' : 'No token budget'} value={tokenDraft} onChange={e => setTokenDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void setTokenBudget(); }}/>
      <button type="button" className="settings-button secondary" onClick={() => void setTokenBudget()}>Set token budget</button></div>
      : <><p className="project-edit-hint">Budgets for this project are set in {NAMES.paperclip}.</p>
        {data.budgets && data.budgets.policies.length > 0 && <section className="pp-cost" aria-label={`${NAMES.paperclip} budgets`}><h3 className="ws-group-title">{data.budgets.company} budgets{data.budgets.incidents ? ` · ${data.budgets.incidents} open ${data.budgets.incidents === 1 ? 'incident' : 'incidents'}` : ''}</h3>
          <ul className="ws-rows">{data.budgets.policies.map(p => <li key={p.id}><div className="ws-row is-static"><span className="ws-row-text"><span className="ws-row-title">{p.name}</span><span className="ws-row-meta">{p.scope} · {formatUsd(p.observedUsd)} of {formatUsd(p.limitUsd)} this month{p.hardStop ? ' · hard stop' : ''}</span></span><span className="ws-chip" data-tone={p.status === 'ok' ? 'ok' : p.status === 'warning' ? 'warn' : 'danger'}>{p.paused ? 'paused' : `${Math.round(p.percent)}%`}</span></div></li>)}</ul></section>}</>}
    <section className="dash-card"><RunActivityChart days={data.runs}/></section>
    {local && <section className="pp-cost"><h3 className="ws-group-title">All time</h3><div className="project-card project-cost-card"><ProjectCostSummary projectId={projectId}/></div></section>}
  </div>;
}
