import React, {useEffect, useRef, useState} from 'react';
import {Code, Eye} from 'lucide-react';
import {openFile, type WorkspaceTab} from '../store';
import {useStore} from '../useStore';
import {MessageBody} from './MessageBody';
import './file-preview.css';

// Keep Markdown parsing bounded independently of the host's file-read limit.
const MARKDOWN_LIMIT = 64 * 1024;

export function FileTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const body = useStore().fileBodies[tab.id];
  const markdown = /\.(md|markdown)$/i.test(tab.path ?? '');
  const [mode, setMode] = useState<'source' | 'preview'>(markdown && !tab.line ? 'preview' : 'source');
  const code = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tab.line) setMode('source'); }, [tab.id, tab.line]);
  useEffect(() => {
    if (tab.line && body?.phase === 'ready' && mode === 'source') {
      code.current?.querySelector(`[data-line="${tab.line}"]`)?.scrollIntoView({block: 'center'});
    }
  }, [tab.line, body?.phase, mode]);
  if (!body || body.phase === 'loading' || body.phase === 'idle') {
    return <div className="pane-loading">Loading {tab.path}…</div>;
  }
  if (body.phase === 'error') return <div className="pane-error">
    <p>{body.error}</p>
    <button type="button" onClick={() => void openFile(tab.folderId!, tab.path!, tab.line)}>Retry</button>
  </div>;
  const {text, truncated} = body.value!;
  const previewAllowed = markdown && text.length <= MARKDOWN_LIMIT && !truncated;
  const preview = previewAllowed && mode === 'preview';
  return <div className="file-view" ref={code}>
    <div className="file-head">
      <span className="file-path" title={tab.path}>{tab.path}</span>
      {markdown && <div className="file-view-switch" role="group" aria-label="Document view">
        <button type="button" aria-pressed={preview} disabled={!previewAllowed} title={previewAllowed ? 'Preview Markdown' : 'Large or truncated documents open as source'} onClick={() => setMode('preview')}><Eye size={13}/>Preview</button>
        <button type="button" aria-pressed={!preview} onClick={() => setMode('source')}><Code size={13}/>Source</button>
      </div>}
    </div>
    {preview ? <div className="file-markdown" role="region" aria-label={`Preview of ${tab.path}`} tabIndex={0}>
      <MessageBody text={text} resourceContext={{folderId: tab.folderId!, path: tab.path!}}/>
      {!text && <p className="file-empty">This document is empty.</p>}
    </div> : <div className="code-scroll" role="region" aria-label={`Source of ${tab.path}`} tabIndex={0}>
      <table className="code-table"><tbody>{(text === '' ? [] : text.split('\n')).map((line, i) =>
        <tr key={i} data-line={i+1} className={i+1 === tab.line ? 'file-line-target' : undefined}>
          <td className="code-no">{i+1}</td><td className="code-line">{line}</td>
        </tr>)}</tbody></table>
      {!text && <p className="file-empty">This file is empty.</p>}
    </div>}
    {markdown && !previewAllowed && !truncated && <div className="pane-truncated">Showing source: Markdown preview is limited to 65,536 characters.</div>}
    {truncated && <div className="pane-truncated">File truncated by the host.</div>}
  </div>;
}
