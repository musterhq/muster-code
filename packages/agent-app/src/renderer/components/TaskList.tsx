/**
 * Tasks, laid out like Paperclip's (#193, #122): New task and search on the left; List/Board, Filter, Sort and Group on
 * the right. The list nests subtasks under their parent (collapsible) and is virtualised; the board has a column per
 * status and moves a card by dragging it. Used by every project's Tasks tab and by the app-wide Tasks page.
 */
import { Menu } from '@base-ui/react/menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownUp, Check, ChevronDown, ChevronRight, Columns3, Filter, Layers, List, Plus, Search } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceSnapshot, WorkspaceStatus, WorkspaceTask } from '../../shared/domains/paperclip-protocol';
import { PRIORITY_NAME, STATUS_LABEL, WORKSPACE_STATUSES } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError } from '../store';
import { activeFilters, boardColumns, buildRows, filterTasks, GROUP_LABEL, loadView, ownerOptions, PRIORITIES, QUICK_LABEL, saveView, SORT_LABEL, type QuickFilter, type TaskGroup, type TaskRow, type TaskSort, type TaskViewState } from '../taskView';
import { Monogram, TaskStatusIcon } from './HubParts';
import { ResourceState } from './ResourceState';
import { Tip } from './Tooltip';

const ROW_H = 36, GROUP_H = 34, BOARD_CAP = 50;
const toggle = <T,>(list: readonly T[], value: T): T[] => list.includes(value) ? list.filter(v => v !== value) : [...list, value];

export interface TaskListProps {
  snapshot: WorkspaceSnapshot;
  tasks: readonly WorkspaceTask[];
  /** Remembers the view per list: a project id, or 'all' for the app-wide page. */
  scope: string;
  /** App-wide: tasks name their project and can be grouped by it. */
  showProject?: boolean;
  onOpenTask: (id: string) => void;
  onNewTask?: () => void;
  emptyMessage?: string;
}

export function TaskList({ snapshot, tasks, scope, showProject = false, onOpenTask, onNewTask, emptyMessage }: TaskListProps): React.ReactElement {
  const [view, setView] = useState<TaskViewState>(() => loadView(scope));
  useEffect(() => { saveView(scope, view); }, [scope, view]);
  const update = (patch: Partial<TaskViewState>) => setView(v => ({ ...v, ...patch }));
  const projectName = useMemo(() => { const names = new Map(snapshot.projects.map(p => [p.id, p.name])); return (id: string | null) => (id && names.get(id)) || ''; }, [snapshot.projects]);
  const visible = tasks;
  const filtered = useMemo(() => filterTasks(visible, view), [visible, view.query, view.quick, view.statuses, view.owners, view.priorities]);
  const owners = useMemo(() => ownerOptions(visible), [visible]);
  const count = activeFilters(view);
  const groups: TaskGroup[] = showProject ? ['none', 'status', 'owner', 'priority', 'parent', 'project'] : ['none', 'status', 'owner', 'priority', 'parent'];
  return <div className="task-list" data-layout={view.layout}>
    <div className="task-toolbar" role="toolbar" aria-label="Tasks">
      {onNewTask && <button type="button" className="settings-button secondary task-new" onClick={onNewTask}><Plus size={14}/>{NAMES.newTask}</button>}
      <label className="task-search"><Search size={14} aria-hidden="true"/><span className="sr-only">Search tasks</span>
        <input type="search" placeholder="Search tasks…" value={view.query} onChange={e => update({ query: e.target.value })} onKeyDown={e => { if (e.key === 'Escape' && view.query) { e.preventDefault(); e.stopPropagation(); update({ query: '' }); } }}/></label>
      <span className="task-toolbar-spacer"/>
      <div className="task-toggle" role="radiogroup" aria-label="Layout">
        <Tip label="List"><button type="button" role="radio" aria-checked={view.layout === 'list'} aria-label="List" className="icon-button" onClick={() => update({ layout: 'list' })}><List size={15}/></button></Tip>
        <Tip label="Board"><button type="button" role="radio" aria-checked={view.layout === 'board'} aria-label="Board" className="icon-button" onClick={() => update({ layout: 'board' })}><Columns3 size={15}/></button></Tip>
      </div>
      <Menu.Root>
        <Tip label="Filter"><Menu.Trigger className="icon-button task-tool" aria-label={count ? `Filter (${count} active)` : 'Filter'} data-active={count ? 'true' : undefined}><Filter size={15}/>{count > 0 && <span className="task-tool-count">{count}</span>}</Menu.Trigger></Tip>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} className="ui-menu-positioner"><Menu.Popup className="ui-menu task-filter-menu">
          <Menu.Group><Menu.GroupLabel className="ui-menu-label">Quick filters</Menu.GroupLabel>
            <div className="task-quick">{(Object.keys(QUICK_LABEL) as QuickFilter[]).map(q => <button key={q} type="button" className="ws-filter" aria-pressed={view.quick === q} onClick={() => update({ quick: q })}>{QUICK_LABEL[q]}</button>)}</div>
          </Menu.Group>
          <Menu.Separator/>
          <div className="task-filter-cols">
            <Menu.Group><Menu.GroupLabel className="ui-menu-label">Status</Menu.GroupLabel>
              {WORKSPACE_STATUSES.map(s => <Menu.CheckboxItem key={s} closeOnClick={false} checked={view.statuses.includes(s)} onCheckedChange={() => update({ statuses: toggle(view.statuses, s) })}><Check size={13} className="task-check" data-on={view.statuses.includes(s) || undefined}/><TaskStatusIcon status={s} size={13}/>{STATUS_LABEL[s]}</Menu.CheckboxItem>)}
            </Menu.Group>
            <Menu.Group><Menu.GroupLabel className="ui-menu-label">Owner</Menu.GroupLabel>
              {owners.length === 0 ? <p className="task-filter-empty">No owners yet</p> : owners.map(o => <Menu.CheckboxItem key={o.id} closeOnClick={false} checked={view.owners.includes(o.id)} onCheckedChange={() => update({ owners: toggle(view.owners, o.id) })}><Check size={13} className="task-check" data-on={view.owners.includes(o.id) || undefined}/>{o.id === 'user:local' ? 'Me' : o.label}</Menu.CheckboxItem>)}
            </Menu.Group>
            <Menu.Group><Menu.GroupLabel className="ui-menu-label">Priority</Menu.GroupLabel>
              {PRIORITIES.map(p => <Menu.CheckboxItem key={p} closeOnClick={false} checked={view.priorities.includes(p)} onCheckedChange={() => update({ priorities: toggle(view.priorities, p) })}><Check size={13} className="task-check" data-on={view.priorities.includes(p) || undefined}/>{PRIORITY_NAME[p]}</Menu.CheckboxItem>)}
            </Menu.Group>
          </div>
          {count > 0 && <><Menu.Separator/><Menu.Item onClick={() => update({ quick: 'all', statuses: [], owners: [], priorities: [] })}>Clear filters</Menu.Item></>}
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>
      <Menu.Root>
        <Tip label={`Sort: ${SORT_LABEL[view.sort]}`}><Menu.Trigger className="icon-button task-tool" aria-label={`Sort: ${SORT_LABEL[view.sort]}`}><ArrowDownUp size={15}/></Menu.Trigger></Tip>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} className="ui-menu-positioner"><Menu.Popup className="ui-menu">
          <Menu.GroupLabel className="ui-menu-label">Sort by</Menu.GroupLabel>
          <Menu.RadioGroup value={view.sort} onValueChange={value => update({ sort: value as TaskSort })}>{(Object.keys(SORT_LABEL) as TaskSort[]).map(s => <Menu.RadioItem key={s} value={s}><Check size={13} className="task-check" data-on={view.sort === s || undefined}/>{SORT_LABEL[s]}</Menu.RadioItem>)}</Menu.RadioGroup>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>
      {view.layout === 'list' && <Menu.Root>
        <Tip label={`Group: ${GROUP_LABEL[view.group]}`}><Menu.Trigger className="icon-button task-tool" aria-label={`Group: ${GROUP_LABEL[view.group]}`} data-active={view.group !== 'none' ? 'true' : undefined}><Layers size={15}/></Menu.Trigger></Tip>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} className="ui-menu-positioner"><Menu.Popup className="ui-menu">
          <Menu.GroupLabel className="ui-menu-label">Group by</Menu.GroupLabel>
          <Menu.RadioGroup value={view.group} onValueChange={value => update({ group: value as TaskGroup, collapsed: [] })}>{groups.map(g => <Menu.RadioItem key={g} value={g}><Check size={13} className="task-check" data-on={view.group === g || undefined}/>{GROUP_LABEL[g]}</Menu.RadioItem>)}</Menu.RadioGroup>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>}
    </div>
    {visible.length === 0 ? <ResourceState kind="empty" message={emptyMessage ?? 'No tasks yet.'}>{onNewTask && <button type="button" className="settings-button" onClick={onNewTask}><Plus size={14}/>{NAMES.newTask}</button>}</ResourceState>
      : filtered.length === 0 ? <ResourceState kind="empty" compact message="No tasks match these filters."><button type="button" className="settings-button secondary" onClick={() => update({ query: '', quick: 'all', statuses: [], owners: [], priorities: [] })}>Clear filters</button></ResourceState>
      : view.layout === 'board' ? <TaskBoard tasks={filtered} sort={view.sort} showProject={showProject} projectName={projectName} onOpenTask={onOpenTask}/>
      : <TaskRows rows={buildRows(visible, filtered, view, projectName)} showProject={showProject} projectName={projectName} onOpenTask={onOpenTask} onToggle={id => update({ collapsed: toggle(view.collapsed, id) })}/>}
  </div>;
}

function TaskRows({ rows, showProject, projectName, onOpenTask, onToggle }: { rows: TaskRow[]; showProject: boolean; projectName: (id: string | null) => string; onOpenTask: (id: string) => void; onToggle: (id: string) => void }): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: i => rows[i]?.kind === 'group' ? GROUP_H : ROW_H, getItemKey: i => rows[i]?.id ?? i, overscan: 12 });
  return <div ref={scroller} className="task-rows" role="treegrid" aria-label="Tasks" aria-rowcount={rows.length}>
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map(item => {
        const row = rows[item.index];
        const style = { transform: `translateY(${item.start}px)`, height: row.kind === 'group' ? GROUP_H : ROW_H };
        if (row.kind === 'group') return <div key={row.id} role="row" className="task-group-row" style={style} aria-rowindex={item.index + 1}>
          <button type="button" className="task-group-head" aria-expanded={!row.collapsed} onClick={() => onToggle(row.id)}>
            {row.collapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}{row.status && <TaskStatusIcon status={row.status} size={13}/>}<span>{row.label}</span><span className="task-group-count">{row.count}</span>
          </button></div>;
        const t = row.task;
        return <div key={row.id} role="row" className="task-row" style={style} aria-rowindex={item.index + 1} aria-level={row.depth + 1} data-depth={row.depth}>
          <span className="task-indent" style={{ width: row.depth * 24 }} aria-hidden="true"/>
          {row.children ? <button type="button" className="task-caret" aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${t.key} (${row.children} subtasks)`} aria-expanded={!row.collapsed} onClick={() => onToggle(t.id)}>{row.collapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</button> : <span className="task-caret" aria-hidden="true"/>}
          <button type="button" className="task-row-main" onClick={() => onOpenTask(t.id)} title={`${t.key} · ${t.title}`}>
            <TaskStatusIcon status={t.status}/><span className="ws-key">{t.key}</span><span className="task-row-title">{t.title}</span>
            {row.parentKey && <span className="task-parent-key">in {row.parentKey}</span>}
            {row.collapsed && row.children > 0 && <span className="task-sub-count">{row.children} subtasks</span>}
            {t.live && <span className="ws-live"><span className="ws-live-dot"/>live</span>}
            {showProject && <span className="task-row-project">{projectName(t.projectId)}</span>}
            <span className="task-row-owner">{t.assigneeLabel ? <><Monogram name={t.assigneeLabel} kind={t.assigneeId === 'user:local' ? 'user' : 'agent'}/>{t.assigneeLabel}</> : <span className="ws-faint">No owner</span>}</span>
            <span className="ws-row-age" title={exactTime(t.updatedAt)}>{agoLabel(t.updatedAt)}</span>
          </button>
        </div>;
      })}
    </div>
  </div>;
}

/** Board: a column per status; drag a card to another column to move it (Muster tasks accept the moves they allow). */
function TaskBoard({ tasks, sort, showProject, projectName, onOpenTask }: { tasks: WorkspaceTask[]; sort: TaskSort; showProject: boolean; projectName: (id: string | null) => string; onOpenTask: (id: string) => void }): React.ReactElement {
  const columns = useMemo(() => boardColumns(tasks, sort), [tasks, sort]);
  const [more, setMore] = useState<Set<WorkspaceStatus>>(new Set());
  const [over, setOver] = useState<WorkspaceStatus | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const drop = async (status: WorkspaceStatus, taskId: string) => {
    setOver(null);
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === status) return;
    setMoving(taskId);
    try { await invoke('paperclip.task.update', { taskId, status }); await refreshWorkspace(); } catch (cause) { notifyError(cause); } finally { setMoving(null); }
  };
  return <div className="task-board" role="list" aria-label="Board">{columns.map(col => {
    const shown = more.has(col.status) ? col.tasks : col.tasks.slice(0, BOARD_CAP);
    return <section key={col.status} role="listitem" className="task-col" data-status={col.status} data-over={over === col.status || undefined} aria-label={`${STATUS_LABEL[col.status]}, ${col.tasks.length}`}
      onDragOver={e => { if (e.dataTransfer.types.includes('text/x-muster-task')) { e.preventDefault(); setOver(col.status); } }} onDragLeave={() => setOver(o => o === col.status ? null : o)}
      onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/x-muster-task'); if (id) void drop(col.status, id); }}>
      <h3 className="task-col-head"><TaskStatusIcon status={col.status} size={13}/><span>{STATUS_LABEL[col.status]}</span><span className="task-col-count">{col.tasks.length}</span></h3>
      <div className="task-col-body">
        {shown.map(t => <button key={t.id} type="button" className="task-card" draggable data-moving={moving === t.id || undefined} onDragStart={e => { e.dataTransfer.setData('text/x-muster-task', t.id); e.dataTransfer.effectAllowed = 'move'; }} onClick={() => onOpenTask(t.id)}>
          <span className="task-card-top"><span className="ws-key">{t.key}</span>{t.live && <span className="ws-live"><span className="ws-live-dot"/>live</span>}</span>
          <span className="task-card-title">{t.title}</span>
          <span className="task-card-foot">{t.assigneeLabel ? <><Monogram name={t.assigneeLabel} kind={t.assigneeId === 'user:local' ? 'user' : 'agent'}/><span>{t.assigneeLabel}</span></> : <span className="ws-faint">No owner</span>}{showProject && <span className="task-row-project">{projectName(t.projectId)}</span>}</span>
        </button>)}
        {col.tasks.length > shown.length && <button type="button" className="ws-link task-col-more" onClick={() => setMore(m => new Set(m).add(col.status))}>Show {col.tasks.length - shown.length} more</button>}
      </div>
    </section>;
  })}</div>;
}
