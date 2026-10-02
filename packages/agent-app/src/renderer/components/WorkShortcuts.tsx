/**
 * Keyboard shortcuts for the work surfaces (C3): the listener, the cheatsheet (`?`) and the "new task" sheet (`c`). The rules
 * are in `shortcuts.ts`. Nothing runs until a key is pressed on the Inbox, task, Roster, Outputs, Ledger or Projects screens.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ModalSheet } from './ModalSheet';
import { NewTaskSheet } from './HubSetup';
import { openSpotlightSearch } from './SpotlightSearch';
import { currentProject } from '../projectFocus';
import { hubRoute, openHub, undoInbox, useWorkspace } from '../hubStore';
import { notifyError, notifySuccess } from '../store';
import { runMenuAction } from '../menuActions';
import { CHEATSHEET, IDLE, resolveShortcut, setShortcutsEnabled, shortcutsApplyOn, shortcutsEnabled, stepRow, subscribeShortcutsPref, type ChordState, type ShortcutAction } from '../shortcuts';
import { getState, openProjectsScreen } from '../store';
import { useStore } from '../useStore';
import './work-shortcuts.css';

const ROWS = '.task-row-main, .ws-inbox-row .ws-row-link:not(:disabled), .roster-row, .pp-list-row, .dash-task';
const BLOCKERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]';

// ── the cheatsheet and the preference ──────────────────────────────────────────
const listeners = new Set<() => void>();
let sheetOpen = false;
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function openShortcutsCheatsheet(): void { sheetOpen = true; emit(); }
const useSheet = () => useSyncExternalStore(subscribe, () => sheetOpen);
const useEnabled = () => useSyncExternalStore(subscribeShortcutsPref, shortcutsEnabled);

let newTaskListener: (() => void) | null = null;
/** Opens the new-task sheet from anywhere (the command palette). */
export function openNewTask(): void { newTaskListener?.(); }

/** Moves focus to the next or previous row of whatever list is on screen. */
export function moveRow(action: 'next-row' | 'prev-row', root: ParentNode = document): HTMLElement | null {
  const rows = [...root.querySelectorAll<HTMLElement>(ROWS)].filter(r => r.getClientRects().length > 0 || r.isConnected);
  const at = rows.findIndex(r => r === document.activeElement || r.contains(document.activeElement));
  const next = rows[stepRow(rows.length, at, action)];
  if (next) { next.focus({ preventScroll: true }); next.scrollIntoView?.({ block: 'nearest' }); }
  return next ?? null;
}

function run(action: ShortcutAction): void {
  switch (action) {
    case 'search': { const field = document.querySelector<HTMLInputElement>('.ws-main .task-search input, .project-main .task-search input, [data-page-search]'); if (field) field.focus(); else openSpotlightSearch(); return; }
    case 'cheatsheet': openShortcutsCheatsheet(); return;
    case 'new-task': newTaskListener?.(); return;
    case 'toggle-sidebar': runMenuAction('toggle-sidebar'); return;
    case 'go-inbox': openHub('inbox'); return;
    case 'go-dashboard': openHub('dashboard'); return;
    case 'go-tasks': openHub('tasks'); return;
    case 'go-roster': openHub('roster'); return;
    case 'go-outputs': openHub('outputs'); return;
    case 'go-ledger': openHub('ledger'); return;
    case 'go-projects': openProjectsScreen(); return;
    case 'focus-comment': document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"], textarea[aria-label^="Message "]')?.focus(); return;
    case 'next-row': case 'prev-row': moveRow(action); return;
    case 'toggle-properties': window.dispatchEvent(new CustomEvent('muster:toggle-properties')); return;
    case 'undo': void undoInbox().then(said => { if (said) notifySuccess(said); }, notifyError); return;
  }
}

/** Mount once near the app root. Renders the cheatsheet and the new-task sheet while they are open, nothing otherwise. */
export function WorkShortcutsHost(): React.ReactElement | null {
  const screen = useStore().screen;
  const on = useEnabled();
  const state = useRef<ChordState>(IDLE);
  const active = on && shortcutsApplyOn(screen);
  useEffect(() => {
    if (!active) { state.current = IDLE; return; }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const result = resolveShortcut(state.current, {
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing, repeat: e.repeat, defaultPrevented: e.defaultPrevented,
        // The focused element counts too: a key pressed while a field has focus is typing, whatever the event's target says.
        typing: Boolean(target?.closest(TYPING) || document.activeElement?.closest?.(TYPING)), blocked: Boolean(document.querySelector(BLOCKERS)),
      }, Date.now());
      state.current = result.next;
      if (!result.consume) return;
      e.preventDefault();
      if (result.action) run(result.action);
    };
    window.addEventListener('keydown', onKey);
    const disarm = () => { state.current = IDLE; };
    window.addEventListener('pointerdown', disarm);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', disarm); };
  }, [active]);
  const open = useSheet();
  const [creating, setCreating] = useState(false);
  useEffect(() => { newTaskListener = () => setCreating(true); return () => { newTaskListener = null; }; }, []);
  return <>
    {open && <Cheatsheet onClose={() => { sheetOpen = false; emit(); }}/>}
    {creating && <NewTaskHost onClose={() => setCreating(false)}/>}
  </>;
}

/** The project a new task should start in: the open project, the open task's project, else the sheet's own default. */
function NewTaskHost({ onClose }: { onClose: () => void }): React.ReactElement {
  const ws = useWorkspace();
  const route = hubRoute();
  const snapshot = ws.snapshot;
  const fromTask = route.page === 'task' && route.arg ? snapshot?.tasks.find(t => t.id === route.arg || t.key === route.arg)?.projectId ?? null : null;
  const project = getState().screen === 'projects' ? currentProject() : route.page === 'project' ? route.arg : fromTask;
  return <NewTaskSheet open snapshot={snapshot} projectId={project} onClose={onClose} onCreated={id => openHub('task', id)}/>;
}

function Cheatsheet({ onClose }: { onClose: () => void }): React.ReactElement {
  const on = useEnabled();
  const done = useRef<HTMLButtonElement>(null);
  return <ModalSheet open title="Keyboard shortcuts" description="Single keys work on the Inbox, Tasks, Roster, Outputs, Ledger and Projects screens. They never fire while you type." className="project-edit-dialog work-cheatsheet" testId="shortcuts" initialFocus={done} onClose={onClose}>
    <div className="work-cheat-grid">
      {CHEATSHEET.map(section => <section key={section.title} aria-label={section.title}>
        <h3>{section.title}</h3>
        <dl>{section.entries.map(entry => <div key={entry.keys.join('+') + entry.label}>
          <dt>{entry.keys.map((k, i) => <React.Fragment key={k}>{i > 0 && <span className="work-cheat-then">{entry.then ? 'then' : '+'}</span>}<kbd>{k}</kbd></React.Fragment>)}</dt>
          <dd>{entry.label}</dd>
        </div>)}</dl>
      </section>)}
    </div>
    <label className="pp-check work-cheat-toggle"><input type="checkbox" checked={on} onChange={e => setShortcutsEnabled(e.target.checked)}/>Single-key shortcuts <span className="ws-faint">{on ? 'on' : 'off: the ⌘ shortcuts of the app menu still work'}</span></label>
    <div className="project-edit-actions"><button ref={done} type="button" className="settings-button" onClick={onClose}>Done</button></div>
  </ModalSheet>;
}
