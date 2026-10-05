/**
 * The sidebar's organisations (#117): one row per ticked org with the person's own open count, an accordion (opening one closes the others unless pinned),
 * and inside an org the person's active tasks (at most five, newest first, then "See all mine") and the org's projects with their own open-count badge.
 * Other people's tasks never appear here. Local projects, chats and folders are untouched: this only replaces the old per-server project tree.
 */
import { ChevronRight, Laptop, Pin } from 'lucide-react';
import React, { useState } from 'react';
import type { MyWorkTask, OrgWork } from '../../shared/domains/checkout-protocol';
import { sidebarRows } from '../../shared/org-work';
import { NAMES } from '../../shared/workspace-names';
import { useHubRoute } from '../hubStore';
import { openMyWork, openProjectInOrg, openTaskInOrg, readAccordion, toggleOrg, togglePin, useMyWork, writeAccordion, type Accordion } from '../orgStore';
import { useStoreSelector } from '../useStore';
import { Tip } from './Tooltip';
import './org-sidebar.css';

const HUES = ['var(--info)', 'var(--warn)', 'var(--violet)', 'var(--pink)', 'var(--ok)', 'var(--file-teal)'];
const hueOf = (name: string) => HUES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length]!;
/** The state glyph of a task row: an open circle (todo), half (in progress), filled amber (in review), outlined red (blocked). */
export const taskDot = (status: MyWorkTask['status']): 'todo' | 'prog' | 'rev' | 'blocked' => status === 'in_progress' ? 'prog' : status === 'in_review' ? 'rev' : status === 'blocked' ? 'blocked' : 'todo';

export function OrgAvatar({ name }: { name: string }): React.ReactElement {
  return <span className="org-avatar" aria-hidden="true" style={{ background: hueOf(name) }}>{name.trim().slice(0, 1).toUpperCase() || '?'}</span>;
}

export function OrgSidebar(): React.ReactElement | null {
  const { work } = useMyWork(true);
  const route = useHubRoute();
  const screen = useStoreSelector(state => state.screen);
  const [acc, setAcc] = useState<Accordion>(() => readAccordion(globalThis.localStorage));
  const change = (next: Accordion) => { setAcc(next); writeAccordion(globalThis.localStorage, next); };
  const orgs = (work?.orgs ?? []).filter(o => o.sidebar !== 'none');
  if (!work?.connected || !orgs.length) return null;
  return <section className="nav-block org-nav" aria-label="Organisations">
    {orgs.map(org => <OrgBlock key={org.org.id} org={org} open={acc.open.includes(org.org.id)} pinned={acc.pinned.includes(org.org.id)} onToggle={() => change(toggleOrg(acc, org.org.id))} onPin={() => change(togglePin(acc, org.org.id))}
      activeTask={screen === 'hub' && route.page === 'task' ? route.arg : null} activeProject={screen === 'hub' && route.page === 'project' ? route.arg : null}/>)}
  </section>;
}

function OrgBlock({ org, open, pinned, onToggle, onPin, activeTask, activeProject }: { org: OrgWork; open: boolean; pinned: boolean; onToggle: () => void; onPin: () => void; activeTask: string | null; activeProject: string | null }): React.ReactElement {
  const rows = sidebarRows(org.tasks);
  const panel = `org-panel-${org.org.id}`;
  return <div className="org-block" data-open={open || undefined}>
    <div className="org-head">
      <button type="button" className="org-toggle" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ChevronRight size={12} className="org-chev" aria-hidden="true"/><OrgAvatar name={org.org.name}/><span className="org-name" title={`${org.org.name} · ${org.org.server}`}>{org.org.name}</span>
        {org.stale && <span className="org-stale" title={org.stale} aria-label="Offline: showing the last copy">·</span>}
        <span className={`org-count${org.open ? ' is-hot' : ''}`} aria-label={`${org.open} open for you`}>{org.open}</span>
      </button>
      <Tip label={pinned ? 'Unpin: opening another org will close this one' : 'Pin open while you open other orgs'}><button type="button" className="icon-button org-pin" aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${org.org.name}`} onClick={onPin}><Pin size={12}/></button></Tip>
    </div>
    {open && <div className="org-body" id={panel}>
      <p className="org-mini">{org.sidebar === 'team' ? 'My work and team' : NAMES.myWork}</p>
      {rows.shown.length === 0 && <p className="org-empty">Nothing is open for you here.</p>}
      {rows.shown.map(task => <button key={task.id} type="button" className={`org-task${activeTask === task.id || activeTask === task.key ? ' is-active' : ''}`} title={`${task.key} · ${task.title}${task.assignee ? ` · ${task.assignee}` : ''}`} onClick={() => void openTaskInOrg(task.orgId, task.id)}>
        <span className="org-dot" data-state={taskDot(task.status)} aria-label={task.status.replace('_', ' ')}/><span className="org-key">{task.key}</span><span className="org-title">{task.title}</span>
        {task.checkout && <Laptop size={11} className="org-here" aria-label={`Checked out · ${task.checkout.thisMac ? 'this Mac' : task.checkout.device}`}/>}
      </button>)}
      {rows.more > 0 && <button type="button" className="org-more" onClick={openMyWork}>See all mine ({rows.total})</button>}
      {org.projects.length > 0 && <p className="org-mini">Projects</p>}
      {org.projects.map(p => <button key={p.id} type="button" className={`org-project${activeProject === p.id ? ' is-active' : ''}`} onClick={() => void openProjectInOrg(org.org.id, p.id)}>
        <span className="org-project-name">{p.name}</span>{p.open > 0 && <span className="org-count">{p.open}</span>}
      </button>)}
    </div>}
  </div>;
}
