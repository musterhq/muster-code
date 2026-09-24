import React, {useEffect, useState} from 'react';
import {invoke} from '../bridge';
import type {Commands} from '../../shared/protocol';
import type {WorkspaceTab} from '../store';
import {ImageFile} from './ImageFile';
import {StructuredFile} from './StructuredFile';
import {MessageBody} from './MessageBody';
import {PdfFile} from './PdfFile';
import {WorkbookFile} from './WorkbookFile';
import {HighlightedSourceTable} from './HighlightedCode';
import {codeLanguageFromPath} from './codeLanguage';
import {HtmlPreview} from './FilePreviews';
import {ResourceState} from './ResourceState';
import {FileTypeIcon} from './FileTypeIcon';
import {filePresentation, friendlyFileError, isLibreOfficeMissing} from './filePresentation';
import './file-preview.css';
import './markdown-document.css';

type Asset = Commands['attachments.asset']['output'];
type DocumentPreview = Commands['attachments.document']['output'];
type WorkbookPreview = Commands['attachments.workbook']['output'];
type Loaded =
  | {kind: 'text'; text: string; truncated: boolean}
  | {kind: 'asset'; asset: Asset}
  | {kind: 'document'; document: DocumentPreview}
  | {kind: 'workbook'; workbook: WorkbookPreview}
  | {kind: 'unsupported'; reason: string};
type LoadState = {phase: 'loading'} | {phase: 'ready'; value: Loaded} | {phase: 'error'; error: string};

/** Honest "cannot preview this" card for formats attachments do not render in place (binary, or macOS-Quick-Look-only). */
function UnsupportedCard({name, reason}: {name: string; reason: string}): React.ReactElement {
  return <div className="file-fallback" role="region" aria-label={`${name} cannot be previewed`}>
    <FileTypeIcon path={name} size={28} className="file-fallback-icon"/>
    <strong>{name}</strong>
    <p>{reason}</p>
  </div>;
}

/** Audio/video from a bounded data URL, mirroring FilePreviews.tsx's MediaFile without its folder-scoped fallback actions. */
function AttachmentMedia({asset, name}: {asset: Asset; name: string}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <UnsupportedCard name={name} reason="This media format cannot be played in Muster."/>;
  return <div className="media-file">
    {asset.mime.startsWith('video/')
      ? <video src={asset.dataUrl} controls preload="metadata" aria-label={name} onError={() => setFailed(true)}/>
      : <audio src={asset.dataUrl} controls preload="metadata" aria-label={name} onError={() => setFailed(true)}/>}
    <div className="image-file-meta">{(asset.size / 1024 / 1024).toFixed(1)} MiB · {asset.mime}</div>
  </div>;
}

const QUICKLOOK_REASON = 'This format is previewed with macOS Quick Look outside a workspace folder, which attachments do not support yet. Open it from a workspace folder instead, or drag it out to view it in its own app.';
const BINARY_REASON = 'This is a binary file, so Muster has no preview for it.';

/** A chat-scoped attachment opened in the resource pane: composer tiles, sent-message chips and queued-message chips all
 * route here (see attachmentOpen.ts). Content is fetched through the attachments.* commands, which confine every read to
 * this chat's attachment directory server-side (attachments.location/resolveInside) — the renderer never sees a path. */
export function AttachmentTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const chatId = tab.chatId ?? '';
  const attachmentId = tab.attachmentId ?? '';
  const name = tab.path || tab.title;
  const presentation = filePresentation(name);
  const richText = presentation === 'markdown' || presentation === 'json' || presentation === 'csv' || presentation === 'tsv' || presentation === 'html';
  const [mode, setMode] = useState<'source' | 'preview'>(richText ? 'preview' : 'source');
  const [state, setState] = useState<LoadState>({phase: 'loading'});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setMode(richText ? 'preview' : 'source'); }, [tab.id, richText]);

  useEffect(() => {
    if (!chatId || !attachmentId) { setState({phase: 'error', error: 'This attachment reference is incomplete.'}); return; }
    let live = true;
    setState({phase: 'loading'});
    (async () => {
      try {
        if (presentation === 'image' || presentation === 'media') {
          const asset = await invoke('attachments.asset', {chatId, id: attachmentId});
          if (live) setState({phase: 'ready', value: {kind: 'asset', asset}});
        } else if (presentation === 'document') {
          const document = await invoke('attachments.document', {chatId, id: attachmentId});
          if (live) setState({phase: 'ready', value: {kind: 'document', document}});
        } else if (presentation === 'workbook') {
          const workbook = await invoke('attachments.workbook', {chatId, id: attachmentId});
          if (live) setState({phase: 'ready', value: {kind: 'workbook', workbook}});
        } else if (presentation === 'quicklook') {
          if (live) setState({phase: 'ready', value: {kind: 'unsupported', reason: QUICKLOOK_REASON}});
        } else if (presentation === 'binary') {
          if (live) setState({phase: 'ready', value: {kind: 'unsupported', reason: BINARY_REASON}});
        } else {
          const body = await invoke('attachments.read', {chatId, id: attachmentId});
          if (live) setState({phase: 'ready', value: {kind: 'text', text: body.text, truncated: body.truncated}});
        }
      } catch (cause) {
        if (live) setState({phase: 'error', error: friendlyFileError(cause)});
      }
    })();
    return () => { live = false; };
  }, [chatId, attachmentId, presentation, attempt]);

  let content: React.ReactNode;
  let truncatedNotice: React.ReactNode = null;
  if (state.phase === 'loading') content = <ResourceState kind="loading" label={`Loading ${name}`} rows={6}/>;
  else if (state.phase === 'error') content = isLibreOfficeMissing(state.error)
    ? <UnsupportedCard name={name} reason="The in-app reader needs LibreOffice for this format, and this file lives outside a workspace folder so macOS preview is not available either. Install LibreOffice to preview it here."/>
    : <ResourceState kind="error" message={state.error} detail="This file was staged for this chat; retry if the runtime was briefly unavailable." onRetry={() => setAttempt(value => value + 1)}/>;
  else {
    const value = state.value;
    if (value.kind === 'unsupported') content = <UnsupportedCard name={name} reason={value.reason}/>;
    else if (value.kind === 'asset') content = presentation === 'image' ? <ImageFile asset={value.asset} name={name}/> : <AttachmentMedia asset={value.asset} name={name}/>;
    else if (value.kind === 'document') content = <PdfFile document={value.document} onLocation={() => {}}/>;
    else if (value.kind === 'workbook') content = <WorkbookFile workbook={value.workbook} onLocation={() => {}}/>;
    else {
      const {text, truncated} = value;
      if (truncated) truncatedNotice = <div className="pane-truncated file-truncated-notice"><span>Showing a preview of this file. It is larger than the in-app preview limit.</span></div>;
      const preview = richText && mode === 'preview';
      if (preview && presentation === 'html') content = <HtmlPreview html={text} name={name}/>;
      else if (preview && presentation === 'markdown') content = <div className="file-markdown" data-kind={presentation} role="region" aria-label={`Preview of ${name}`} tabIndex={0}>
        <MessageBody text={text}/>
        {!text && <p className="file-empty">This document is empty.</p>}
      </div>;
      else if (preview) content = <StructuredFile text={text} kind={presentation as 'json' | 'csv' | 'tsv'}/>;
      else content = <div className="code-scroll" role="region" aria-label={`Source of ${name}`} tabIndex={0}>
        <HighlightedSourceTable source={text} language={codeLanguageFromPath(name)}/>
        {!text && <p className="file-empty">This file is empty.</p>}
      </div>;
    }
  }

  return <div className="file-view">
    <div className="file-head">
      <div className="file-breadcrumbs-row"><span className="file-breadcrumbs" aria-label="Attachment"><FileTypeIcon path={name} size={13}/><span className="crumb-current" title={name}>{name}</span></span></div>
      {richText && <div className="file-view-switch" role="group" aria-label="Document view">
        {mode === 'preview'
          ? <button type="button" className="file-view-toggle" aria-label="View source" title="Show the raw file with syntax highlighting" onClick={() => setMode('source')}><span>Source</span></button>
          : <button type="button" className="file-view-toggle" aria-label={presentation === 'html' ? 'View rendered' : 'View preview'} title={presentation === 'html' ? 'Render without scripts' : 'Show the formatted document'} onClick={() => setMode('preview')}><span>{presentation === 'html' ? 'Rendered' : 'Preview'}</span></button>}
      </div>}
    </div>
    <div className="file-content-layout">
      <div className="file-document">
        {content}
        {truncatedNotice}
      </div>
    </div>
  </div>;
}
