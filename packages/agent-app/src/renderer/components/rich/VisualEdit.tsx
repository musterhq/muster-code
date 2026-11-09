/**
 * #829: Edit for a visual in the chat (diagram, chart, report, page). The block's header gets Edit and, once an edit is saved,
 * an Original / Edited switch; the body swaps the drawing for the source beside a preview that redraws after a pause in
 * typing. Save keeps the edit as the next version of the visual's Canvas (visualEdits.ts); Cancel discards it. The preview
 * is the block's own renderer, so it looks exactly like the block; one that cannot draw the source reports its error and
 * keeps the last good drawing.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight, PenLine} from 'lucide-react';
import {notifyError} from '../../store';
import {saveVisualEdit, useVisualEdit, useVisualVersionContent, useVisualVersions} from '../../visualEdits';
import {Tip} from '../Tooltip';
import type {RichContext} from '../RichBlock';
import type {CanvasKind, CanvasVersion, CanvasVisual} from '../../../shared/domains/artifacts-protocol';

/** Redraw delay after the last keystroke. */
export const EDIT_PREVIEW_DELAY_MS = 250;

/** What a preview tells the editor: the source drew (null) or could not (its message). */
export type PreviewReport = (error: string | null) => void;
export type PreviewRenderer = (source: string, report: PreviewReport) => React.ReactNode;

export interface VisualEditOptions {
  /** The chat the visual is in; without one (a tab, a document) there is no Edit. */
  chatId?: string | undefined;
  visual: CanvasVisual;
  /** The visual as the reply drew it; undefined while it is still loading (a stored page). */
  original: string | undefined;
  title: string;
  canvasKind: CanvasKind;
  language?: string;
  variant: 'inline' | 'tab';
  /** #829 part 2: step through every version ("v2 of 3") instead of Original / Edited (a page the agent may update in place). */
  versions?: boolean;
}
/** The version a block shows when it steps through versions. `saved` is its entry in the list, once that has loaded. */
export interface ShownVersion { version: number; of: number; saved?: CanvasVersion }
export interface VisualEditing {
  enabled: boolean;
  editing: boolean;
  /** A saved edit exists and is the one shown. */
  showingEdit: boolean;
  /** What the block draws: the saved edit, unless Original (or an earlier version) is chosen. */
  source: string | undefined;
  /** With `versions`, once the visual has a canvas: which version is shown. */
  version?: ShownVersion;
  /** An Edit button for the block's error card: source that does not draw is the first thing to fix. */
  errorAction?: React.ReactNode;
  /** Header controls, placed before the block's own extras. */
  extras(context: RichContext): React.ReactNode;
  /** The editor for the block body, with the block's renderer as its preview. */
  editor(preview: PreviewRenderer): React.ReactElement;
}

export function useVisualEditing(options: VisualEditOptions): VisualEditing {
  const enabled = !!options.chatId && options.variant === 'inline';
  const {canvas} = useVisualEdit(enabled ? options.chatId : undefined, enabled ? options.visual.key : undefined);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'edited' | 'original'>('edited');
  // #829 part 2: the version picked with the switch; null follows the newest, and a new version (the agent's or a Save) shows at once.
  const stepping = !!options.versions && !!canvas;
  const [picked, setPicked] = useState<number | null>(null);
  const newest = canvas?.version;
  useEffect(() => { setPicked(null); }, [newest]);
  const savedVersions = useVisualVersions(stepping ? canvas : null);
  const shownNumber = stepping ? Math.min(picked ?? canvas!.version, canvas!.version) : undefined;
  const older = useVisualVersionContent(stepping && shownNumber! > 1 && shownNumber !== canvas!.version ? canvas!.id : undefined, shownNumber);
  const showingEdit = stepping ? shownNumber! > 1 : !!canvas && view === 'edited';
  const source = stepping ? (shownNumber === canvas!.version ? canvas!.content : shownNumber === 1 ? options.original : older) : showingEdit ? canvas!.content : options.original;
  const saved = savedVersions?.find(item => item.version === shownNumber);
  const version: ShownVersion | undefined = stepping ? {version: shownNumber!, of: canvas!.version, ...(saved ? {saved} : {})} : undefined;
  const oldest = savedVersions?.length ? Math.min(...savedVersions.map(item => item.version)) : 1;
  const latest = useRef(options);
  latest.current = options;
  const hasEdit = useRef(false);
  hasEdit.current = !!canvas;

  const save = useCallback(async (content: string) => {
    const current = latest.current;
    // The original is needed only for the first Save (it becomes version 1); a stored page may not have loaded when an edit already exists.
    if (!current.chatId || (current.original === undefined && !hasEdit.current)) return;
    await saveVisualEdit({chatId: current.chatId, visual: current.visual, title: current.title, original: current.original ?? '', content, kind: current.canvasKind, ...(current.language ? {language: current.language} : {})});
    setView('edited');
    setPicked(null);
    setEditing(false);
  }, []);

  const extras = (context: RichContext): React.ReactNode => {
    if (!enabled || context.mode !== 'inline' || (source === undefined && !version)) return null;
    return <>
      {source !== undefined && <Tip label={editing ? 'Close editor' : 'Edit'}>
        <button type="button" className="rich-action" aria-label="Edit" aria-pressed={editing} onClick={() => setEditing(value => !value)}><PenLine size={13} aria-hidden="true"/></button>
      </Tip>}
      {version && !editing && <span className="rich-switch rich-versions" role="group" aria-label="Version">
        <button type="button" aria-label="Previous version" disabled={version.version <= oldest} onClick={() => setPicked(version.version - 1)}><ChevronLeft size={12} aria-hidden="true"/></button>
        <span className="rich-versions-label" aria-live="polite">v{version.version} of {version.of}</span>
        <button type="button" aria-label="Next version" disabled={version.version >= version.of} onClick={() => setPicked(version.version + 1 >= version.of ? null : version.version + 1)}><ChevronRight size={12} aria-hidden="true"/></button>
      </span>}
      {canvas && !stepping && !editing && <span className="rich-switch" role="radiogroup" aria-label="Version">
        <button type="button" role="radio" aria-checked={view === 'original'} onClick={() => setView('original')}>Original</button>
        <button type="button" role="radio" aria-checked={view === 'edited'} onClick={() => setView('edited')}>Edited</button>
      </span>}
    </>;
  };
  const editor = (preview: PreviewRenderer) => <VisualEditor initial={source ?? ''} label={`${options.title} source`} preview={preview} onSave={save} onCancel={() => setEditing(false)}/>;
  const errorAction = enabled && source !== undefined && !editing ? <button type="button" onClick={() => setEditing(true)}><PenLine size={12} aria-hidden="true"/>Edit</button> : undefined;
  return {enabled, editing: enabled && editing, showingEdit, source, extras, editor, ...(version ? {version} : {}), ...(errorAction ? {errorAction} : {})};
}

function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return settled;
}

function VisualEditor({initial, label, preview, onSave, onCancel}: {initial: string; label: string; preview: PreviewRenderer; onSave(content: string): Promise<void>; onCancel(): void}): React.ReactElement {
  const [draft, setDraft] = useState(initial);
  const shown = useSettled(draft, EDIT_PREVIEW_DELAY_MS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const report = useCallback<PreviewReport>(message => setError(message), []);
  const pending = draft !== shown;
  const canSave = !saving && !pending && !error && draft !== initial && draft.trim() !== '';
  const save = () => {
    if (!canSave) return;
    setSaving(true);
    onSave(draft).catch(cause => { notifyError(cause); setSaving(false); });
  };
  return <div className="rich-edit">
    <div className="rich-edit-split">
      <textarea className="rich-edit-source" aria-label={label} spellCheck={false} value={draft} autoFocus
        onChange={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
          else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        }}/>
      <div className="rich-edit-preview" aria-label="Preview">{preview(shown, report)}</div>
    </div>
    {error && <p className="rich-edit-error" role="alert">{error}</p>}
    <div className="rich-edit-bar">
      <span role="status">{saving ? 'Saving…' : pending ? 'Updating preview…' : error ? 'The preview shows the last version that worked.' : draft === initial ? 'Edit the source; the preview follows.' : 'Save keeps this as a new version.'}</span>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="is-primary" disabled={!canSave} onClick={save}>Save</button>
    </div>
  </div>;
}
