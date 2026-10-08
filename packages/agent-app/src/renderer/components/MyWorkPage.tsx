/**
 * My work (#117): everything assigned to the signed-in person and still open, across every ticked org, grouped org → project, with org and status filters and
 * a board view. Other people's tasks are never here (they stay on each project's page). "Checked out · this Mac" marks work being done locally.
 */
import { LayoutGrid, List } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { badgeText, type MyWorkTask } from '../../shared/domains/checkout-protocol';
import { StaleCheckout } from './CheckoutPanel';
import { loadMyWork } from '../orgStore';
import type { WorkspaceStatus } from '../../shared/domains/paperclip-protocol';
import { STATUS_LABEL } from '../../shared/domains/paperclip-protocol';
import { applyFilter, BOARD_COLUMNS } from '../../shared/org-work';
import { NAMES } from '../../shared/workspace-names';
import { openTaskInOrg, useMyWork } from '../orgStore';
import { agoLabel } from '../relativeTime';
import { OrgAvatar, taskDot } from './OrgSidebar';
import { PageHeader } from './HubPages';
import { StateChip } from './HubParts';
import { ResourceState } from './ResourceState';
import './my-work.css';

const STATUS_FILTERS: { id: WorkspaceStatus; label: string }[] = BOARD_COLUMNS.map(id => ({ id, label: STATUS_LABEL[id] }));
const tag = (t: MyWorkTask) => t.checkout ? `${badgeText(t.checkout)}${t.checkout.staleDays ? ' · idle' : t.checkout.stale ? ' · quiet' : ''}` : t.why === 'team' && t.assignee ? t.assignee : STATUS_LABEL[t.status];

export function MyWorkPage(): React.ReactElement {
  const { work, error } = useMyWork(true);
  const [orgs, setOrgs] = useState<ReadonlySet<string> | null>(null);
  const [statuses, setStatuses] = useState<ReadonlySet<WorkspaceStatus> | null>(null);
  const [view, setView] = useState<'list' | 'board'>('list');
  const all = useMemo(() => (work?.orgs ?? []).flatMap(o => o.tasks.map(t => ({ task: t, orgId: o.org.id, why: t.why }))), [work]);
  const rows = useMemo(() => applyFilter(all, { orgIds: orgs, statuses }).map(r => r.task), [all, orgs, statuses]);
  if (!work && error) return <ResourceState kind="error" message="Your work could not be read." detail={error}/>;
  if (!work) return <ResourceState kind="loading" label="Loading your work" rows={4}/>;
  if (!work.connected) return <div className="ws-page"><PageHeader title={NAMES.myWork}/><ResourceState kind="empty" message={`Connect ${NAMES.server} in Settings › ${NAMES.integrations} to see your work across orgs.`}/></div>;
  const toggle = <T,>(set: ReadonlySet<T> | null, value: T): ReadonlySet<T> | null => { const next = new Set(set ?? []); if (next.has(value)) next.delete(value); else next.add(value); return next.size ? next : null; };
  const byOrg = work.orgs.map(o => ({ org: o, rows: rows.filter(r => r.orgId === o.org.id) })).filter(g => g.rows.length);
  return <div className="ws-page my-work">
    <PageHeader title={NAMES.myWork} detail="Everything assigned to you and still open, across every org. Other people’s tasks stay on each project’s page.">
      <div className="ws-filters" role="radiogroup" aria-label="View">
        <button type="button" role="radio" aria-checked={view === 'list'} className="ws-filter" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={13} aria-hidden="true"/>List</button>
        <button type="button" role="radio" aria-checked={view === 'board'} className="ws-filter" aria-pressed={view === 'board'} onClick={() => setView('board')}><LayoutGrid size={13} aria-hidden="true"/>Board</button>
      </div>
    </PageHeader>
    <div className="ws-filters" role="toolbar" aria-label="Filter your work">
      <button type="button" className="ws-filter" aria-pressed={orgs === null} onClick={() => setOrgs(null)}>All orgs</button>
      {work.orgs.map(o => <button key={o.org.id} type="button" className="ws-filter" aria-pressed={orgs?.has(o.org.id) ?? false} onClick={() => setOrgs(toggle(orgs, o.org.id))}>{o.org.name}<span>{o.tasks.length}</span></button>)}
      <span className="my-work-sep" aria-hidden="true"/>
      <button type="button" className="ws-filter" aria-pressed={statuses === null} onClick={() => setStatuses(null)}>Active</button>
      {STATUS_FILTERS.map(s => <button key={s.id} type="button" className="ws-filter" aria-pressed={statuses?.has(s.id) ?? false} onClick={() => setStatuses(toggle(statuses, s.id))}>{s.label}</button>)}
    </div>
    {rows.length === 0 ? <ResourceState kind="empty" title="Nothing open for you" message="Tasks assigned to you that are to do, in progress, in review or blocked appear here."/>
      : view === 'board' ? <div className="my-board" role="list" aria-label="Board">{BOARD_COLUMNS.map(status => { const col = rows.filter(r => r.status === status); return <section key={status} className="my-board-col" aria-label={STATUS_LABEL[status]}>
          <h2 className="ws-group-title">{STATUS_LABEL[status]}<span>{col.length}</span></h2>
          {col.map(t => <button key={t.id} type="button" className="my-card" onClick={() => void openTaskInOrg(t.orgId, t.id)}><span className="my-card-title">{t.title}</span><span className="my-card-meta"><OrgAvatar name={t.orgName}/><span className="org-key">{t.key}</span>{t.checkout && <span className="ws-chip" data-tone="ok">{badgeText(t.checkout)}</span>}</span></button>)}
        </section>; })}</div>
      : byOrg.map(({ org, rows: orgRows }) => <section key={org.org.id} className="ws-section" aria-label={org.org.name}>
        <h2 className="ws-group-title"><OrgAvatar name={org.org.name}/>{org.org.name}<span>{orgRows.length}</span></h2>
        {[...new Set(orgRows.map(r => r.projectName ?? 'No project'))].sort().map(project => <div key={project} className="my-project">
          <h3 className="my-project-title">{project}</h3>
          <ul className="ws-rows">{orgRows.filter(r => (r.projectName ?? 'No project') === project).map(t => <li key={t.id}><button type="button" className="ws-row my-row" onClick={() => void openTaskInOrg(t.orgId, t.id)}>
            <span className="org-dot" data-state={taskDot(t.status)} aria-label={STATUS_LABEL[t.status]}/><span className="org-key">{t.key}</span><span className="ws-row-text"><span className="ws-row-title">{t.title}</span></span>
            <StateChip tone={t.checkout ? 'ok' : 'faint'}>{tag(t)}</StateChip><span className="ws-row-age">{agoLabel(t.updatedAt)}</span>
          </button>{t.checkout?.staleDays ? <div className="my-stale"><StaleCheckout lease={{ taskId: t.id, staleDays: t.checkout.staleDays }} onChanged={() => void loadMyWork()}/></div> : null}</li>)}</ul>
        </div>)}
      </section>)}
  </div>;
}
