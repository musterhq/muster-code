/** The Inbox's Columns and Tidy menu (G36): which parts of a row show, and what the Inbox cleans up by itself. */
import { SlidersHorizontal } from 'lucide-react';
import React from 'react';
import { INBOX_COLUMNS, type InboxColumn, type TidyPolicy } from '../inboxModel';

export function InboxOptions({ columns, onColumns, tidy, onTidy }: { columns: Record<InboxColumn, boolean>; onColumns: (next: Record<InboxColumn, boolean>) => void; tidy: TidyPolicy; onTidy: (next: TidyPolicy) => void }): React.ReactElement {
  return <details className="ws-options">
    <summary className="ws-filter" aria-label="Columns and tidy"><SlidersHorizontal size={13} aria-hidden="true"/>Columns and tidy</summary>
    <div className="ws-options-panel" role="group" aria-label="Inbox options">
      <fieldset><legend>Show</legend>{(Object.keys(INBOX_COLUMNS) as InboxColumn[]).map(c => <label key={c} className="org-check"><input type="checkbox" checked={columns[c]} onChange={e => onColumns({ ...columns, [c]: e.target.checked })}/>{INBOX_COLUMNS[c]}</label>)}</fieldset>
      <fieldset><legend>Tidy up for me</legend>
        <label className="org-check"><input type="checkbox" checked={tidy.readAgentNotices} onChange={e => onTidy({ ...tidy, readAgentNotices: e.target.checked })}/>Mark my agents’ finished-work notices read as they arrive</label>
        <label className="ws-options-row">Clear finished items after<select className="ws-select" aria-label="Clear finished items after" value={tidy.dismissDoneAfterDays} onChange={e => onTidy({ ...tidy, dismissDoneAfterDays: Number(e.target.value) as TidyPolicy['dismissDoneAfterDays'] })}>
          <option value={0}>Never</option><option value={1}>1 day</option><option value={3}>3 days</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
        <span className="ws-faint">Questions, approvals, reviews and problems are never tidied. “u” brings back what you dismiss; tidied items return if they change.</span></fieldset>
    </div>
  </details>;
}
