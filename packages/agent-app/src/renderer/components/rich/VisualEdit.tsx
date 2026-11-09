/**
 * #829: Edit for a visual in the chat (diagram, chart, report, page). The block's header gets Edit and, once an edit is saved,
 * an Original / Edited switch; the body swaps the drawing for the source beside a preview that redraws after a pause in
 * typing. Save keeps the edit as the next version of the visual's Canvas (visualEdits.ts); Cancel discards it. The preview
 * is the block's own renderer, so it looks exactly like the block; one that cannot draw the source reports its error and
 * keeps the last good drawing.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {PenLine} from 'lucide-react';
import {notifyError} from '../../store';
import {saveVisualEdit, useVisualEdit} from '../../visualEdits';
import {Tip} from '../Tooltip';
import type {RichContext} from '../RichBlock';
import type {CanvasKind, CanvasVisual} from '../../../shared/domains/artifacts-protocol';

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
}
export interface VisualEditing {
  enabled: boolean;
  editing: boolean;
  /** A saved edit exists and is the one shown. */
  showingEdit: boolean;
  /** What the block draws: the saved edit, unless Original is chosen. */
  source: string | undefined;
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
  const showingEdit = !!canvas && view === 'edited';
  const source = showingEdit ? canvas.content : options.original;
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
    setEditing(false);
  }, []);

  const extras = (context: RichContext): React.ReactNode => {
    if (!enabled || context.mode !== 'inline' || source === undefined) return null;
    return <>
      <Tip label={editing ? 'Close editor' : 'Edit'}>
        <button type="button" className="rich-action" aria-label="Edit" aria-pressed={editing} onClick={() => setEditing(value => !value)}><PenLine size={13} aria-hidden="true"/></button>
      </Tip>
      {canvas && !editing && <span className="rich-switch" role="radiogroup" aria-label="Version">
        <button type="button" role="radio" aria-checked={view === 'original'} onClick={() => setView('original')}>Original</button>
        <button type="button" role="radio" aria-checked={view === 'edited'} onClick={() => setView('edited')}>Edited</button>
      </span>}
    </>;
  };
  const editor = (preview: PreviewRenderer) => <VisualEditor initial={source ?? ''} label={`${options.title} source`} preview={preview} onSave={save} onCancel={() => setEditing(false)}/>;
  const errorAction = enabled && source !== undefined && !editing ? <button type="button" onClick={() => setEditing(true)}><PenLine size={12} aria-hidden="true"/>Edit</button> : undefined;
  return {enabled, editing: enabled && editing, showingEdit, source, extras, editor, ...(errorAction ? {errorAction} : {})};
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
