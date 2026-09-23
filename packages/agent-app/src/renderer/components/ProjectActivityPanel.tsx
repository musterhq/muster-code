import React, { useEffect, useRef, useState } from 'react';
import type { ProjectActivity } from '../../shared/protocol';
import { ACTIVITY_CATEGORIES, ACTIVITY_WINDOWS, type ActivityCategory, type ActivityWindow } from '../../shared/domains/project-team-protocol.ts';
import { invoke } from '../bridge';
import { actorLabel } from '../project-rollup';
import { getState } from '../store';
import { ProjectActivityList } from './ProjectTasks';
import { ResourceState } from './ResourceState';
import { cleanIpcError } from './resourceErrors';

const PAGE = 50;

/**
 * PRJ-11: the Project's audit timeline with type, actor and time filters. Reads only stored events (no UI-polling
 * rows), reloads its first page when the Project changes, and pages older rows with a stable cursor.
 */
export function ProjectActivityPanel({ projectId, resolveRef, onOpenRef }: { projectId: string; resolveRef: (refId: string) => string | null; onOpenRef: (refId: string) => void }) {
  const [categories, setCategories] = useState<ActivityCategory[]>([]);
  const [actor, setActor] = useState('');
  const [timeWindow, setTimeWindow] = useState<ActivityWindow>('any');
  const [items, setItems] = useState<ProjectActivity[] | null>(null);
  const [actors, setActors] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const filters = { projectId, ...(categories.length ? { categories } : {}), ...(actor ? { actors: [actor] } : {}), window: timeWindow, limit: PAGE };

  useEffect(() => {
    const token = ++request.current;
    setError('');
    invoke('project.activity.query', filters).then(page => {
      if (token !== request.current) return;
      setItems(page.items); setCursor(page.nextCursor); setActors(page.actors); setMore('idle');
    }).catch(err => { if (token === request.current) { setError(cleanIpcError(err) || 'Could not load activity.'); } });
  }, [projectId, categories.join(','), actor, timeWindow, reload]);
  useEffect(() => subscribeProject(projectId, () => setReload(n => n + 1)), [projectId]);

  const loadOlder = () => {
    if (!cursor || more === 'loading') return;
    const token = request.current;
    setMore('loading');
    invoke('project.activity.query', { ...filters, before: cursor }).then(page => {
      if (token !== request.current) return;
      setItems(current => [...(current ?? []), ...page.items.filter(item => !current?.some(existing => existing.id === item.id))]);
      setCursor(page.nextCursor); setMore('idle');
    }).catch(() => { if (token === request.current) setMore('error'); });
  };
  const toggle = (id: ActivityCategory) => setCategories(list => list.includes(id) ? list.filter(c => c !== id) : [...list, id]);
  const filtered = categories.length > 0 || Boolean(actor) || timeWindow !== 'any';
  const clear = () => { setCategories([]); setActor(''); setTimeWindow('any'); };
  const chats = getState().snapshot?.chats;

  return <section aria-label="Activity" className="project-section project-activity-panel">
    <div className="project-activity-filters" role="group" aria-label="Filter activity">
      <div className="project-filter" role="group" aria-label="Activity type">
        <button type="button" className="project-filter-chip" aria-pressed={categories.length === 0} onClick={() => setCategories([])}>All types</button>
        {ACTIVITY_CATEGORIES.map(c => <button key={c.id} type="button" className="project-filter-chip" aria-pressed={categories.includes(c.id)} onClick={() => toggle(c.id)}>{c.label}</button>)}
      </div>
      <div className="project-activity-selects">
        <label><span className="sr-only">Actor</span>
          <select value={actor} onChange={e => setActor(e.target.value)} aria-label="Actor">
            <option value="">Anyone</option>
            {actors.map(a => <option key={a} value={a}>{actorLabel(a, chats)}</option>)}
          </select></label>
        <label><span className="sr-only">Time</span>
          <select value={timeWindow} onChange={e => setTimeWindow(e.target.value as ActivityWindow)} aria-label="Time">
            {ACTIVITY_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select></label>
        {filtered && <button type="button" className="project-link" onClick={clear}>Clear filters</button>}
      </div>
    </div>
    {error && !items ? <ResourceState kind="error" message="Activity could not be loaded." detail={error} onRetry={() => setReload(n => n + 1)}/>
      : !items ? <ResourceState kind="loading" label="Loading activity" rows={4}/>
      : items.length === 0 ? <ResourceState kind="empty" message={filtered ? 'Nothing matches these filters.' : 'No activity recorded yet. Task runs, decisions, memory, environments and edits show up here.'}>{filtered && <button type="button" className="settings-button secondary" onClick={clear}>Clear filters</button>}</ResourceState>
      : <>
          {error && <ResourceState kind="error" compact message="Showing the last loaded activity." detail={error} onRetry={() => setReload(n => n + 1)}/>}
          <ProjectActivityList items={items} resolveRef={resolveRef} onOpenRef={onOpenRef}/>
          {cursor && <div className="project-activity-more">
            {more === 'error' ? <ResourceState kind="error" compact message="Older activity could not be loaded." onRetry={loadOlder}/>
              : <button type="button" className="settings-button secondary" disabled={more === 'loading'} onClick={loadOlder}>{more === 'loading' ? 'Loading older…' : 'Show older'}</button>}
          </div>}
        </>}
  </section>;
}

/** Re-runs `fn` whenever the runtime reports a change to this Project. */
function subscribeProject(projectId: string, fn: () => void): (() => void) | undefined {
  return window.muster?.subscribe(event => { if (event.type === 'projectChanged' && event.projectId === projectId) fn(); });
}
