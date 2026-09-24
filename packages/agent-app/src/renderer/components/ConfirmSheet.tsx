import React, { useRef } from 'react';
import { ModalSheet } from './ModalSheet';

export interface ConfirmAction { label: string; primary?: boolean; run(): void }
/** Codex-style confirmation: title, one sentence, right-aligned actions (the primary last). Esc and outside click cancel. */
export function ConfirmSheet({ open, title, description, actions, busy = false, testId, onCancel }: { open: boolean; title: string; description: string; actions: readonly ConfirmAction[]; busy?: boolean; testId?: string; onCancel(): void }): React.ReactElement | null {
  const primary = useRef<HTMLButtonElement>(null);
  return <ModalSheet open={open} title={title} description={description} className="composer-confirm" testId={testId} initialFocus={primary} onClose={() => { if (!busy) onCancel(); }}>
    <div className="composer-confirm-actions">
      {actions.map(action => <button key={action.label} ref={action.primary ? primary : undefined} type="button" className={action.primary ? 'is-primary' : undefined} disabled={busy} onClick={action.run}>{action.label}</button>)}
    </div>
  </ModalSheet>;
}
