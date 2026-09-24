import React,{memo,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUp,Check,Copy,GitBranch,LoaderCircle,Pencil,RotateCcw,TriangleAlert} from 'lucide-react';
import type {EditRestoreFile,EditRestorePreview,EditResendMode,EditResendOptions} from '../../shared/protocol';
import {copyText} from '../clipboard';
import './message-meta.css';
import {Tip} from './Tooltip';

const clock=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const fullDate=new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'long'});
/** Result actions (Codex/Cursor): prompts get Edit and Fork; answers get Fork and, on the latest turn, Retry. Each returns when done. */
export interface MessageActions {onEdit?:()=>void;onFork?:()=>Promise<unknown>;onRetry?:()=>Promise<unknown>}
function ActionButton({label,icon,run}:{label:string;icon:React.ReactNode;run:()=>unknown}) {
  const [busy,setBusy]=useState(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const click=async()=>{if(busy)return;setBusy(true);try{await run();}finally{if(alive.current)setBusy(false);}};
  return <Tip label={label}><button type="button" className="message-copy" aria-label={label} disabled={busy} aria-busy={busy||undefined} onClick={()=>void click()}>{busy?<LoaderCircle size={13}/>:icon}</button></Tip>;
}
export const MessageMeta=memo(function MessageMeta({text,createdAt,label='Copy message',actions}:{text:string;createdAt:string;label?:string;actions?:MessageActions}) {
  const [status,setStatus]=useState<'idle'|'pending'|'copied'|'error'>('idle');
  const alive=useRef(true),pending=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const stamp=useMemo(()=>{const date=new Date(createdAt);return Number.isNaN(date.getTime())?null:{iso:date.toISOString(),clock:clock.format(date),full:fullDate.format(date)};},[createdAt]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(timer.current);};},[]);
  const copy=async()=>{
    if(pending.current)return;
    pending.current=true;clearTimeout(timer.current);setStatus('pending');
    try {await copyText(text);if(alive.current)setStatus('copied');}
    catch {if(alive.current)setStatus('error');}
    finally {pending.current=false;if(alive.current)timer.current=setTimeout(()=>setStatus('idle'),2000);}
  };
  const feedback=status==='copied'?'Copied':status==='error'?'Could not copy. Try again.':status==='pending'?'Copying…':'';
  return <div className="message-meta" data-feedback={status==='copied'||status==='error'?true:undefined}>
    {stamp&&<time dateTime={stamp.iso} title={stamp.full} aria-label={stamp.full}>{stamp.clock}</time>}
    <button type="button" className="message-copy" aria-label={status==='copied'?`${label} — copied`:label} title={feedback||label} disabled={status==='pending'} onClick={()=>void copy()}>
      {status==='copied'?<Check size={13}/>:status==='error'?<TriangleAlert size={13}/>:status==='pending'?<LoaderCircle size={13}/>:<Copy size={13}/>}
    </button>
    {actions?.onEdit&&<Tip label="Edit message"><button type="button" className="message-copy" aria-label="Edit message" onClick={actions.onEdit}><Pencil size={13}/></button></Tip>}
    {actions?.onRetry&&<ActionButton label="Retry" icon={<RotateCcw size={13}/>} run={actions.onRetry}/>}
    {actions?.onFork&&<ActionButton label="Fork from here" icon={<GitBranch size={13}/>} run={actions.onFork}/>}
    <span className="message-copy-feedback" role="status" aria-live="polite">{feedback}</span>
  </div>;
});

/** Inline Edit of an earlier prompt. Resend branches a fork from just before it (this chat stays as it was); Replace in this chat
 *  appears only when the runtime allows it and never rewinds files. When later agent turns edited files, "Restore files…" previews
 *  the Muster-owned files it would put back (CHAT-18) and asks for an explicit confirm. `onSubmit` resolves true when the edit was sent. */
export function MessageEditor({text,loadOptions,loadRestore,onSubmit,onCancel}:{text:string;loadOptions:()=>Promise<EditResendOptions>;loadRestore?:()=>Promise<EditRestorePreview>;onSubmit:(text:string,mode:EditResendMode,restoreFiles?:Array<{path:string;afterHash:string}>)=>Promise<boolean>;onCancel:()=>void}) {
  const [value,setValue]=useState(text),[options,setOptions]=useState<EditResendOptions|null>(null),[busy,setBusy]=useState<EditResendMode|null>(null);
  const [restore,setRestore]=useState<{state:'loading'}|{state:'ready';preview:EditRestorePreview}|{state:'error';message:string}|null>(null);
  const field=useRef<HTMLTextAreaElement>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;const el=field.current;if(el){el.focus();el.setSelectionRange?.(el.value.length,el.value.length);}
    loadOptions().then(result=>{if(alive.current)setOptions(result);},()=>{if(alive.current)setOptions({canReplace:false,dirtyFiles:0});});
    return()=>{alive.current=false;};},[]);
  useEffect(()=>{const el=field.current;if(!el?.style)return;el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight||0,320)}px`;},[value]);
  const empty=!value.trim();
  const submit=async(mode:EditResendMode,files?:EditRestoreFile[])=>{if(empty||busy)return;setBusy(mode);try{const sent=await onSubmit(value,mode,files?.map(file=>({path:file.path,afterHash:file.afterHash})));
    // A refused restore (files changed since the preview) keeps the text and asks for a fresh preview.
    if(!sent&&mode==='restore'&&alive.current)setRestore(null);}finally{if(alive.current)setBusy(null);}};
  const previewRestore=()=>{if(!loadRestore||restore?.state==='loading')return;setRestore({state:'loading'});
    loadRestore().then(preview=>{if(alive.current)setRestore({state:'ready',preview});},error=>{if(alive.current)setRestore({state:'error',message:error instanceof Error?error.message:String(error)});});};
  const dirty=options?.dirtyFiles??0;
  // Replace is refused exactly when later work touched files or a run is active; only then is restoring worth offering.
  const offerRestore=!!loadRestore&&!!options&&!options.canReplace;
  const ready=restore?.state==='ready'&&restore.preview.available?restore.preview:null;
  const hint=['Resend starts a fork from before this message; this chat stays as it is.',options&&!options.canReplace&&options.replaceBlockedReason?options.replaceBlockedReason:''].filter(Boolean).join(' ');
  return <form className="message-editor" aria-label="Edit message" onSubmit={event=>{event.preventDefault();void submit('fork');}}>
    <textarea ref={field} value={value} rows={1} aria-label="Edited message" disabled={!!busy} onChange={event=>setValue(event.target.value)}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();if(restore)setRestore(null);else onCancel();}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void submit('fork');}}}/>
    {restore&&<RestorePreviewPanel restore={restore}/>}
    <div className="message-editor-footer">
      <span className="message-editor-hint" title={hint}><GitBranch size={12} aria-hidden="true"/>Sends as a new branch</span>
      {dirty>0&&<span className="message-editor-warn" title="Resending does not undo uncommitted file changes"><TriangleAlert size={12} aria-hidden="true"/>{dirty===1?'1 uncommitted change':`${dirty.toLocaleString()} uncommitted changes`}</span>}
      <span className="message-editor-spacer"/>
      <button type="button" className="message-editor-button" onClick={restore?()=>setRestore(null):onCancel} disabled={!!busy}>{restore?'Back':'Cancel'}</button>
      {options?.canReplace&&<button type="button" className="message-editor-button" disabled={empty||!!busy} onClick={()=>void submit('replace')} title="Drop this message and everything after it here, then send the edit. Files are not rewound.">{busy==='replace'?'Replacing…':'Replace in this chat'}</button>}
      {offerRestore&&!restore&&<button type="button" className="message-editor-button" disabled={empty||!!busy} onClick={previewRestore} title="Preview the files Muster changed after this message, then replace here and put them back">Restore files…</button>}
      {ready&&<button type="button" className="message-editor-button is-danger" disabled={empty||!!busy} onClick={()=>void submit('restore',ready.files)}
        title="Put these files back as they were before this message, drop it and everything after it here, then send the edit">{busy==='restore'?'Restoring…':ready.files.length?`Restore ${ready.files.length===1?'1 file':`${ready.files.length} files`} and replace`:'Replace in this chat'}</button>}
      {!restore&&<button type="submit" className="message-editor-send" disabled={empty||!!busy} aria-label="Resend (⌘↩)" title="Resend in a new branch (⌘↩)">{busy==='fork'?<LoaderCircle size={15} className="message-editor-spin" aria-hidden="true"/>:<ArrowUp size={16} strokeWidth={2.2} aria-hidden="true"/>}</button>}
    </div>
  </form>;
}

/** The restore preview: what goes back, what is left alone, and what cannot be undone. */
function RestorePreviewPanel({restore}:{restore:{state:'loading'}|{state:'ready';preview:EditRestorePreview}|{state:'error';message:string}}) {
  if(restore.state==='loading')return <div className="message-restore" role="status"><LoaderCircle size={12} aria-hidden="true"/> Checking which files Muster changed after this message…</div>;
  if(restore.state==='error')return <div className="message-restore is-blocked" role="alert"><TriangleAlert size={12} aria-hidden="true"/> {restore.message}</div>;
  const {preview}=restore;
  if(!preview.available)return <div className="message-restore is-blocked" role="alert"><TriangleAlert size={12} aria-hidden="true"/> {preview.reason??'Files cannot be restored.'} Resend it as a fork instead.</div>;
  return <div className="message-restore" aria-label="Files to restore">
    <p className="message-restore-lead">{preview.files.length?`Muster changed ${preview.files.length===1?'this file':`these ${preview.files.length} files`} after this message. They go back to how they were before it:`:'The files Muster changed after this message already match how they were before it. Only the conversation is replaced.'}</p>
    {preview.files.length>0&&<ul className="message-restore-files">{preview.files.map(file=><li key={file.path}>
      <span className="message-restore-action" data-action={file.action}>{file.action==='delete'?'Delete':'Restore'}</span>
      <span className="message-restore-path" title={file.path}>{file.path}</span>
      {(file.adds>0||file.dels>0)&&<span className="message-restore-stat"><span className="is-add">+{file.adds}</span> <span className="is-del">−{file.dels}</span></span>}
    </li>)}</ul>}
    {preview.left.length>0&&<p className="message-restore-note">{preview.left.length===1?'1 other changed file was':`${preview.left.length} other changed files were`} not made by this chat and {preview.left.length===1?'is':'are'} left as {preview.left.length===1?'it is':'they are'}: <span title={preview.left.join('\n')}>{preview.left.slice(0,3).join(', ')}{preview.left.length>3?`, +${preview.left.length-3} more`:''}</span></p>}
    {preview.external>0&&<p className="message-restore-note is-warn"><TriangleAlert size={12} aria-hidden="true"/> {preview.external===1?'1 command or tool call':`${preview.external} commands or tool calls`} ran after this message. Their effects (installs, network calls, files outside this list) are not undone.</p>}
  </div>;
}

/** Links a fork back to the chat it came from. */
export function ForkOrigin({title,onOpen}:{title?:string;onOpen?:()=>void}) {
  return <div className="fork-origin" role="note"><GitBranch size={12} aria-hidden="true"/>
    {title&&onOpen?<>Forked from <button type="button" onClick={onOpen} title={`Open “${title}”`}>{title}</button></>:'Forked from a chat that no longer exists'}
  </div>;
}
