import React, { useEffect } from 'react';
import { CalendarClock, PauseCircle, TriangleAlert } from 'lucide-react';
import { automationsForFolders, scheduledDetail } from '../scheduledAutomations';
import { loadAutomations, openAutomationsScreen } from '../store';
import { useStoreSelector } from '../useStore';

/** IMG-2026-09-18T1224: summary card "Scheduled" — automations that target this chat's folder(s). Hidden when there are none. */
export function SummaryScheduled({ folderIds, projectId }: { folderIds: readonly string[]; projectId?: string }): React.ReactElement | null {
  const automations = useStoreSelector(state => state.automations);
  const chats = useStoreSelector(state => state.snapshot?.chats);
  useEffect(() => { if (folderIds.length && automations.phase === 'idle') void loadAutomations(); }, [folderIds.length, automations.phase]);
  const rows = automationsForFolders(automations.value ?? [], folderIds, chats ?? [], projectId);
  if (!rows.length) return null;
  const shown = rows.slice(0, 4);
  return <section className="summary-section" aria-label="Scheduled">
    <header className="summary-section-head"><span>Scheduled</span></header>
    {shown.map(automation => {
      const detail = scheduledDetail(automation);
      const icon = automation.paused ? <PauseCircle size={15}/> : automation.issues.length ? <TriangleAlert size={15}/> : <CalendarClock size={15}/>;
      return <button key={automation.id} type="button" className="summary-row" data-automation={automation.id} title={[automation.summary, ...automation.issues].join('\n')} onClick={openAutomationsScreen}>
        <span className="summary-row-icon" aria-hidden="true">{icon}</span>
        <span className="summary-row-label">{automation.name}</span>
        <span className="summary-row-detail"><span className="summary-muted">{detail}</span></span>
      </button>;
    })}
    {rows.length > shown.length && <button type="button" className="summary-row summary-more" onClick={openAutomationsScreen}><span className="summary-row-icon"/><span className="summary-row-label">View all {rows.length}</span></button>}
  </section>;
}
