import React, {useEffect, useRef, useState} from 'react';
import {Code, Eye, ChevronRight, Folder, PanelRightClose, PanelRightOpen} from 'lucide-react';
import {openFile, type WorkspaceTab} from '../store';
import {useStore} from '../useStore';
import {MessageBody} from './MessageBody';
import {ImageFile} from './ImageFile';
import {StructuredFile} from './StructuredFile';
import {filePresentation} from './filePresentation';
import {FileSearch} from './FileSearch';
import './file-preview.css';

// Keep Markdown parsing bounded independently of the host's file-read limit.
const MARKDOWN_LIMIT = 64 * 1024;

export function FileTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const state = useStore();
  const body = state.fileBodies[tab.id];
  const folder = state.snapshot?.folders.find(item => item.id === tab.folderId);
  const [filesVisible, setFilesVisible] = useState(() => {try{return localStorage.getItem('muster.fileNavigator') === 'true';}catch{return false;}});
  useEffect(() => {try{localStorage.setItem('muster.fileNavigator',String(filesVisible));}catch{}}, [filesVisible]);
  const [browsePath, setBrowsePath] = useState('');
  const kind = filePresentation(tab.path ?? '');
  const richText = ['markdown','json','csv','tsv'].includes(kind);
  const [mode, setMode] = useState<'source' | 'preview'>(richText && !tab.line ? 'preview' : 'source');
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
  const {text, truncated, asset} = body.value!;
  const previewAllowed = richText && text.length <= MARKDOWN_LIMIT && !truncated;
  const preview = previewAllowed && mode === 'preview';
  return <div className="file-view" ref={code}>
    <div className="file-head">
      <nav className="file-breadcrumbs" aria-label="File location">
        <button title={folder?.path} onClick={() => {setBrowsePath(''); setFilesVisible(true);}}>{folder?.name ?? 'Files'}</button>
        {(tab.path ?? '').split('/').map((part, index, parts) => <React.Fragment key={index}>
          <ChevronRight size={12}/>
          {index === parts.length - 1 ? <span aria-current="page" title={tab.path}>{part}</span> :
            <button onClick={() => {setBrowsePath(parts.slice(0,index+1).join('/')); setFilesVisible(true);}}>{part}</button>}
        </React.Fragment>)}
      </nav>
      {richText && <div className="file-view-switch" role="group" aria-label="Document view">
        <button type="button" aria-pressed={preview} disabled={!previewAllowed} title={previewAllowed ? 'Preview document' : 'Large or truncated documents open as source'} onClick={() => setMode('preview')}><Eye size={13}/>Preview</button>
        <button type="button" aria-pressed={!preview} onClick={() => setMode('source')}><Code size={13}/>Source</button>
      </div>}
      <button className="icon-button file-tree-toggle" aria-label={filesVisible ? 'Hide file navigator' : 'Show file navigator'} aria-expanded={filesVisible} onClick={() => setFilesVisible(value => !value)}>
        {filesVisible ? <PanelRightClose size={15}/> : <PanelRightOpen size={15}/>}
      </button>
    </div>
    <div className="file-content-layout">
    <div className="file-document">
    {asset ? <ImageFile asset={asset} name={tab.title}/> : preview ? <div className="file-markdown" role="region" aria-label={`Preview of ${tab.path}`} tabIndex={0}>
      {kind === 'markdown' ? <MessageBody text={text} resourceContext={{folderId: tab.folderId!, path: tab.path!}}/> : <StructuredFile text={text} kind={kind as 'json'|'csv'|'tsv'}/>}
      {!text && <p className="file-empty">This document is empty.</p>}
    </div> : <div className="code-scroll" role="region" aria-label={`Source of ${tab.path}`} tabIndex={0}>
      <table className="code-table"><tbody>{(text === '' ? [] : text.split('\n')).map((line, i) =>
        <tr key={i} data-line={i+1} className={i+1 === tab.line ? 'file-line-target' : undefined}>
          <td className="code-no">{i+1}</td><td className="code-line">{line}</td>
        </tr>)}</tbody></table>
      {!text && <p className="file-empty">This file is empty.</p>}
    </div>}
    {richText && !previewAllowed && !truncated && <div className="pane-truncated">Showing source: Document preview is limited to 65,536 characters.</div>}
    {truncated && <div className="pane-truncated">File truncated by the host.</div>}
    </div>
    {filesVisible && <aside className="file-navigator" aria-label="File navigator" onKeyDown={event => {if(event.key === 'Escape'){setFilesVisible(false); code.current?.querySelector<HTMLButtonElement>('.file-tree-toggle')?.focus();}}}>
      <header><Folder size={14}/><button title="Browse folder root" onClick={() => setBrowsePath('')}>{folder?.name ?? 'Files'}</button></header>
      {browsePath && <button className="file-navigator-parent" onClick={() => setBrowsePath(browsePath.split('/').slice(0,-1).join('/'))}>‹ {browsePath}</button>}
      <FileSearch folderId={tab.folderId!} path={browsePath} activePath={tab.path}/>
    </aside>}
    </div>
  </div>;
}
