/**
 * The hub screen (#115): Inbox, Roster, an agent, Ledger, Outputs and task threads, opened from the app's own sidebar.
 * It has no sidebar of its own; the app sidebar stays put, as for Memory and Automations. While it is on screen it keeps
 * the workspace snapshot live (hubStore.useWorkspace); when it closes, live updates stop.
 */
import { ArrowLeft, ChevronRight, List, Network } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { openHub, refreshWorkspace, useHubRoute, useWorkspace, type HubPage } from '../hubStore';
import { restoreFocus } from '../focus';
import { closeSettings, selectChat } from '../store';
import { AgentPage, InboxPage, LedgerPage, ListPage, PageHeader, PulseBoard, type HubNav } from './HubPages';
import { DashboardPage } from './DashboardPage';
import { NewTaskSheet } from './HubSetup';
import { ProjectPage } from './ProjectPage';
import { RosterList } from './RosterPanel';
import { RosterGraph } from './RosterGraph';
import { TaskList } from './TaskList';
import { Tip } from './Tooltip';
import { openProject } from '../projectFocus';
import { TaskStatusIcon } from './HubParts';
import { TaskView } from './HubTask';
import { ResourceState } from './ResourceState';
import { RunDetailPage } from './RunDetail';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './workspace.css';

const TITLE: Record<HubPage, string> = { inbox: NAMES.inbox, ledger: NAMES.ledger, agent: NAMES.roster, task: NAMES.tasks, project: NAMES.projects, dashboard: NAMES.dashboard, tasks: NAMES.tasks, roster: NAMES.roster, outputs: NAMES.outputs, run: 'Run' };

export function HubScreen(): React.ReactElement {
  const route = useHubRoute();
  const ws = useWorkspace();
  const snapshot = ws.snapshot;
  const back = useRef<HTMLButtonElement>(null), launcher = useRef<Element | null>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus({ focusVisible: false } as FocusOptions); }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };
  const nav: HubNav = {
    onOpenTask: id => openHub('task', id),
    onOpenAgent: id => openHub('agent', id),
    onOpenRun: id => openHub('run', id),
    onOpenChat: id => { void selectChat(id); closeSettings(); },
  };
  // A Muster project opens on the Projects screen (its page with Settings and the rest); a Paperclip one opens here.
  const localProject = route.page === 'project' && route.arg && snapshot?.projects.find(p => p.id === route.arg)?.source === 'local' ? route.arg : null;
  useEffect(() => { if (localProject) openProject(localProject); }, [localProject]);
  const task = route.page === 'task' && route.arg ? snapshot?.tasks.find(t => t.id === route.arg || t.key === route.arg) : undefined;
  const agent = route.page === 'agent' && route.arg ? snapshot?.agents.find(a => a.id === route.arg) : undefined;
  const parent: HubPage | null = route.page === 'agent' && route.from && route.from !== 'agent' ? route.from : null;
  const parentLabel = parent === 'project' ? snapshot?.projects.find(p => p.id === route.fromArg)?.name ?? NAMES.projects : parent === 'task' ? snapshot?.tasks.find(t => t.id === route.fromArg)?.key ?? NAMES.tasks : parent ? TITLE[parent] : '';
  const body = route.page === 'inbox' ? <InboxPage snapshot={snapshot} nav={nav}/>
    : ws.error && !snapshot ? <ResourceState kind="error" message="Your projects could not be read." detail={ws.error} onRetry={() => void refreshWorkspace(true)}/>
    : !snapshot ? <ResourceState kind="loading" label="Loading" rows={5}/>
    : route.page === 'project' && route.arg ? <div className="ws-page pp-host"><ProjectPage key={route.arg} snapshot={snapshot} projectId={route.arg} nav={nav}/></div>
    : route.page === 'dashboard' ? <DashboardPage snapshot={snapshot} nav={nav}/>
    : route.page === 'tasks' ? <AllTasks snapshot={snapshot} nav={nav}/>
    : route.page === 'roster' ? <AllRoster snapshot={snapshot} nav={nav}/>
    : route.page === 'outputs' ? <ListPage kind="artifacts"/>
    : route.page === 'agent' && route.arg ? <AgentPage snapshot={snapshot} agentId={route.arg} nav={nav}/>
    : route.page === 'ledger' ? <LedgerPage snapshot={snapshot} nav={nav}/>
    : route.page === 'run' && route.arg ? <RunDetailPage key={route.arg} snapshot={snapshot} runId={route.arg} nav={nav}/>
    : route.page === 'task' && route.arg ? <TaskView key={route.arg} taskId={route.arg} snapshot={snapshot} onOpenTask={nav.onOpenTask} onOpenAgent={nav.onOpenAgent} onOpenRun={nav.onOpenRun}/>
    : <InboxPage snapshot={snapshot} nav={nav}/>;
  return <section className="settings-screen ws-screen" aria-label={TITLE[route.page]} onKeyDown={e => {
    if (e.key !== 'Escape' || e.defaultPrevented || (e.target as HTMLElement).closest('input,textarea,select,[role="dialog"],[role="listbox"]')) return;
    e.preventDefault(); leave();
  }}>
    <header className="settings-topbar ws-topbar">
      <button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>
      <span className="ws-crumb">
        {task ? (() => { const project = snapshot?.projects.find(p => p.id === task.projectId); return project ? <><button type="button" className="ws-crumb-link" onClick={() => project.source === 'local' ? openProject(project.id) : openHub('project', project.id)}>{project.name}</button><ChevronRight size={13} aria-hidden="true"/></> : null; })()
          : parent && <><button type="button" className="ws-crumb-link" onClick={() => openHub(parent, route.fromArg)}>{parentLabel}</button><ChevronRight size={13} aria-hidden="true"/></>}
        {task ? <><TaskStatusIcon status={task.status} size={13}/><strong>{task.title}</strong><span className="ws-key">{task.key}</span></>
          : agent ? <strong>{agent.name}</strong> : route.page === 'project' ? <strong>{snapshot?.projects.find(p => p.id === route.arg)?.name ?? NAMES.projects}</strong> : <strong>{TITLE[route.page]}</strong>}
      </span>
      {snapshot?.paperclip && <span className="ws-topbar-origin" title={snapshot.paperclip.stale ?? (snapshot.paperclip.live === 'poll' ? 'This Muster Server does not push live events, so Muster checks it every 15 seconds while this screen is open.' : undefined)}><span className="ws-conn-dot" data-live={snapshot.paperclip.live} data-stale={snapshot.paperclip.stale ? 'true' : undefined} aria-hidden="true"/>{NAMES.paperclip} · {snapshot.paperclip.company?.name ?? snapshot.paperclip.origin}{snapshot.paperclip.stale ? ' · offline' : snapshot.paperclip.live === 'poll' ? ' · updates every 15 s' : ''}</span>}
    </header>
    <div className="ws-main">{body}</div>
  </section>;
}

/** The app-wide Tasks page: every task across Muster projects and the linked Paperclip, same list and board. */
function AllTasks({ snapshot, nav }: { snapshot: WorkspaceSnapshot; nav: HubNav }): React.ReactElement {
  const [creating, setCreating] = useState(false);
  return <div className="ws-page ws-page-fill">
    <PageHeader title={NAMES.tasks} detail="Every task in every project: yours, your agents’ and your server’s."/>
    <TaskList snapshot={snapshot} tasks={snapshot.tasks} scope="all" showProject onOpenTask={nav.onOpenTask} onNewTask={snapshot.projects.length ? () => setCreating(true) : undefined} emptyMessage={snapshot.projects.length ? 'No tasks yet.' : 'Create a project first: tasks belong to a project.'}/>
    <NewTaskSheet open={creating} snapshot={snapshot} projectId={null} onClose={() => setCreating(false)} onCreated={() => undefined}/>
  </div>;
}

/** The app-wide Roster: every agent, grouped by the project it belongs to, as a list or one org chart. */
function AllRoster({ snapshot, nav }: { snapshot: WorkspaceSnapshot; nav: HubNav }): React.ReactElement {
  const [layout, setLayout] = useState<'list' | 'org'>('list');
  const agents = snapshot.agents.filter(a => a.role !== 'board');
  const groups = [
    ...snapshot.projects.filter(p => p.source === 'local').map(p => ({ id: p.id, name: p.name, local: true, agents: agents.filter(a => a.projectId === p.id) })),
    ...(agents.some(a => a.source === 'paperclip') ? [{ id: 'paperclip', name: snapshot.paperclip?.company?.name ?? NAMES.paperclip, local: false, agents: agents.filter(a => a.source === 'paperclip') }] : []),
  ].filter(g => g.agents.length || g.local);
  return <div className="ws-page">
    <PageHeader title={NAMES.roster} detail={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} across your projects${snapshot.paperclip ? ` and ${snapshot.paperclip.company?.name ?? NAMES.paperclip}` : ''}.`}>
      <div className="task-toggle" role="radiogroup" aria-label="Roster layout">
        <Tip label="List"><button type="button" role="radio" aria-checked={layout === 'list'} aria-label="List" className="icon-button" onClick={() => setLayout('list')}><List size={15}/></button></Tip>
        <Tip label="Org chart"><button type="button" role="radio" aria-checked={layout === 'org'} aria-label="Org chart" className="icon-button" onClick={() => setLayout('org')}><Network size={15}/></button></Tip>
      </div>
    </PageHeader>
    {layout === 'org' ? (agents.length ? <RosterGraph snapshot={snapshot} onOpenAgent={nav.onOpenAgent} onOpenTask={nav.onOpenTask}/> : <ResourceState kind="empty" message="No agents yet."/>)
      : groups.length === 0 ? <ResourceState kind="empty" message="No projects yet. Create a project, then add agents on its Roster tab."/>
      : groups.map(g => <section key={g.id} className="ws-section" aria-label={g.name}>
          <div className="ws-section-head"><h2 className="ws-group-title">{g.name}<span>{g.agents.length}</span></h2>{g.local && <button type="button" className="ws-link" onClick={() => openProject(g.id)}>Open project</button>}</div>
          {g.agents.length ? <RosterList snapshot={snapshot} agents={g.agents} nav={nav}/> : <p className="ws-board-empty">No agents on this project yet. Open it and use Add agent on its {NAMES.roster} tab.</p>}
        </section>)}
    <PulseBoard snapshot={snapshot} nav={nav}/>
  </div>;
}
