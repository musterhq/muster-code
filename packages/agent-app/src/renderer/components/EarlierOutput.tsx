import React, {useRef, useState} from 'react';
import {invoke} from '../bridge';

const PAGE_BYTES = 64 * 1024;
/** Earlier text is capped in the view too; the durable log keeps everything. */
const MAX_SHOWN_BYTES = 4 * 1024 * 1024;

/** PER-05: pages backwards through the durable output log, above the retained in-memory tail. */
export function EarlierOutput({chatId, processId, itemId, tail}: {chatId: string; processId?: string; itemId?: string; tail: string}): React.ReactElement {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const load = async () => {
    if (busy || done) return;
    setBusy(true); setError('');
    try {
      const target = processId ? {chatId, processId} : {chatId, itemId};
      if (cursor.current === undefined) {
        // Start just before the tail already on screen.
        const head = await invoke('processes.outputPage', {...target, bytes: 1});
        cursor.current = Math.max(0, head.size - new TextEncoder().encode(tail).length);
      }
      if (cursor.current <= 0) { setDone(true); return; }
      const page = await invoke('processes.outputPage', {...target, before: cursor.current, bytes: PAGE_BYTES});
      cursor.current = page.start;
      setText(previous => { const next = page.text + previous; return next.length > MAX_SHOWN_BYTES ? next.slice(0, MAX_SHOWN_BYTES) : next; });
      if (page.start <= 0 || !page.text) setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="earlier-output">
    {text && <pre className="process-output earlier-output-text" tabIndex={0} aria-label="Earlier output">{text}</pre>}
    <p className="process-note">
      {done ? 'Showing the complete saved output.' : text ? 'More earlier output is saved.' : 'Earlier output was trimmed from this view. The full output is saved.'}
      {!done && <> <button type="button" className="workspace-inline-link" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Load earlier output'}</button></>}
    </p>
    {error && <p className="process-error" role="alert">{error}</p>}
  </div>;
}
