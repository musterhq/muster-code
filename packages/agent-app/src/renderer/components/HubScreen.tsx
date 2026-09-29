/**
 * The hub screen (#115): Inbox, Roster, an agent, Ledger, Outputs and task threads, opened from the app's own sidebar.
 * It has no sidebar of its own; the app sidebar stays put, as for Memory and Automations. While it is on screen it keeps
 * the workspace snapshot live (hubStore.useWorkspace); when it closes, live updates stop.
 */
import { ArrowLeft, ChevronRight } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { NAMES } from '../../shared/workspace-names';
import { openHub, refreshWorkspace, useHubRoute, useWorkspace, type HubPage } from '../hubStore';
import { restoreFocus } from '../focus';
import { closeSettings, selectChat } from '../store';
import { AgentPage, InboxPage, LedgerPage, type HubNav } from './HubPages';
import { ProjectPage } from './ProjectHub';
import { TaskStatusIcon } from './HubParts';
import { TaskView } from './HubTask';
import { ResourceState } from './ResourceState';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';

const TITLE: Record<HubPage, string> = { inbox: NAMES.inbox, ledger: NAMES.ledger, agent: NAMES.roster, task: NAMES.tasks, project: NAMES.projects };

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
    onOpenChat: id => { void selectChat(id); closeSettings(); },
  };
  const task = route.page === 'task' && route.arg ? snapshot?.tasks.find(t => t.id === route.arg || t.key === route.arg) : undefined;
  const agent = route.page === 'agent' && route.arg ? snapshot?.agents.find(a => a.id === route.arg) : undefined;
  const parent: HubPage | null = route.page === 'agent' && route.from && route.from !== 'agent' ? route.from : null;
  const parentLabel = parent === 'project' ? snapshot?.projects.find(p => p.id === route.fromArg)?.name ?? NAMES.projects : parent === 'task' ? snapshot?.tasks.find(t => t.id === route.fromArg)?.key ?? NAMES.tasks : parent ? TITLE[parent] : '';
  const body = route.page === 'inbox' ? <InboxPage snapshot={snapshot} nav={nav}/>
    : ws.error && !snapshot ? <ResourceState kind="error" message="Your projects could not be read." detail={ws.error} onRetry={() => void refreshWorkspace(true)}/>
    : !snapshot ? <ResourceState kind="loading" label="Loading" rows={5}/>
    : route.page === 'project' && route.arg ? <ProjectPage key={route.arg} snapshot={snapshot} projectId={route.arg} nav={nav}/>
    : route.page === 'agent' && route.arg ? <AgentPage snapshot={snapshot} agentId={route.arg} nav={nav}/>
    : route.page === 'ledger' ? <LedgerPage snapshot={snapshot} nav={nav}/>
    : route.page === 'task' && route.arg ? <TaskView key={route.arg} taskId={route.arg} snapshot={snapshot} onOpenTask={nav.onOpenTask} onOpenAgent={nav.onOpenAgent}/>
    : <InboxPage snapshot={snapshot} nav={nav}/>;
  return <section className="settings-screen ws-screen" aria-label={TITLE[route.page]} onKeyDown={e => {
    if (e.key !== 'Escape' || e.defaultPrevented || (e.target as HTMLElement).closest('input,textarea,select,[role="dialog"],[role="listbox"]')) return;
    e.preventDefault(); leave();
  }}>
    <header className="settings-topbar ws-topbar">
      <button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>
      <span className="ws-crumb">
        {task ? (() => { const project = snapshot?.projects.find(p => p.id === task.projectId); return project ? <><span className="ws-crumb-link is-static">{project.name}</span><ChevronRight size={13} aria-hidden="true"/></> : null; })()
          : parent && <><button type="button" className="ws-crumb-link" onClick={() => openHub(parent, route.fromArg)}>{parentLabel}</button><ChevronRight size={13} aria-hidden="true"/></>}
        {task ? <><TaskStatusIcon status={task.status} size={13}/><strong>{task.title}</strong><span className="ws-key">{task.key}</span></>
          : agent ? <strong>{agent.name}</strong> : route.page === 'project' ? <strong>{snapshot?.projects.find(p => p.id === route.arg)?.name ?? NAMES.projects}</strong> : <strong>{TITLE[route.page]}</strong>}
      </span>
      {snapshot?.paperclip && <span className="ws-topbar-origin" title={snapshot.paperclip.stale ?? undefined}><span className="ws-conn-dot" data-live={snapshot.paperclip.live} data-stale={snapshot.paperclip.stale ? 'true' : undefined} aria-hidden="true"/>{NAMES.paperclip} · {snapshot.paperclip.company?.name ?? snapshot.paperclip.origin}{snapshot.paperclip.stale ? ' · offline' : ''}</span>}
    </header>
    <div className="ws-main">{body}</div>
  </section>;
}
