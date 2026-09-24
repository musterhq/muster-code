import React,{useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw,Trash2} from 'lucide-react';
import type {CleanableCategory,CleanupPreview,StorageReport} from '../../../shared/domains/settings-protocol';
import {invoke} from '../../bridge';
import {notifyError,notifySuccess} from '../../store';
import {formatBytes} from './sections';

type Cleanup = {category:CleanableCategory; preview?:CleanupPreview; busy:boolean; error?:string};

/** Sizes by category; cleanup previews exactly what it would remove and asks before deleting. */
export function StoragePanel():React.ReactElement {
  const [report,setReport]=useState<StorageReport|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [cleanup,setCleanup]=useState<Cleanup|null>(null);
  const ticket=useRef(0);
  const load=useCallback(async()=>{
    const mine=++ticket.current;setBusy(true);setError('');
    try{const next=await invoke('settings.storage',{});if(mine===ticket.current)setReport(next);}
    catch(cause){if(mine===ticket.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(mine===ticket.current)setBusy(false);}
  },[]);
  useEffect(()=>{void load();return()=>{ticket.current++;};},[load]);
  const review=async(category:CleanableCategory)=>{
    setCleanup({category,busy:true});
    try{const preview=await invoke('settings.storage.preview',{category});setCleanup(current=>current?.category===category?{category,preview,busy:false}:current);}
    catch(cause){setCleanup(current=>current?.category===category?{category,busy:false,error:cause instanceof Error?cause.message:String(cause)}:current);}
  };
  const remove=async()=>{
    if(!cleanup?.preview)return;
    const {category,preview}=cleanup;
    setCleanup({...cleanup,busy:true});
    try{
      const result=await invoke('settings.storage.cleanup',{category,names:preview.items.map(item=>item.name),confirm:true});
      setCleanup(null);
      notifySuccess(result.removed?`Removed ${result.removed} ${result.removed===1?'item':'items'} · ${formatBytes(result.bytes)} freed`:'Nothing was removed; those items are in use again');
      void load();
    }catch(cause){setCleanup({category,preview,busy:false});notifyError(cause);}
  };
  const largest=Math.max(1,...(report?.categories.map(row=>row.bytes)??[1]));
  return <div className="settings-panel" aria-busy={busy}>
    <div className="settings-panel-actions">
      <span className="settings-panel-meta" role="status">{busy?'Measuring…':report?`${formatBytes(report.total)} in app data`:''}</span>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/>Refresh</button>
    </div>
    {error&&<p className="settings-error" role="alert">{error}</p>}
    {report&&<section className="preference-group" aria-label="Storage by category">
      {report.categories.map(row=><React.Fragment key={row.id}>
        <div className="preference-row storage-row">
          <span className="preference-copy">
            <strong>{row.label}</strong>
            <span className="storage-bar" aria-hidden="true"><span style={{width:`${Math.max(1.5,row.bytes/largest*100)}%`}}/></span>
            <span className="preference-scope">{formatBytes(row.bytes)}{row.truncated?'+':''} · {row.files.toLocaleString()} {row.files===1?'file':'files'}{row.truncated?' · very large, count stopped early':''}</span>
          </span>
          {row.cleanable&&<button type="button" className="settings-button secondary" aria-expanded={cleanup?.category===row.id} disabled={cleanup?.busy||row.bytes===0} title={row.bytes===0?'Nothing stored here yet':undefined} onClick={()=>cleanup?.category===row.id?setCleanup(null):void review(row.id as CleanableCategory)}>Clean up…</button>}
        </div>
        {cleanup?.category===row.id&&<div className="storage-confirm" role="group" aria-label={`Clean up ${row.label}`}>
          {cleanup.busy&&!cleanup.preview?<p role="status">Checking what can be removed…</p>
          :cleanup.error?<p className="settings-error" role="alert">{cleanup.error}</p>
          :cleanup.preview&&!cleanup.preview.items.length?<><p>Nothing to remove. Only {row.id==='scratch'?'scratch folders of deleted chats':'files of deleted chats and attachments discarded from drafts'} are eligible.</p><div className="storage-confirm-actions"><button type="button" className="settings-button secondary" onClick={()=>setCleanup(null)}>Close</button></div></>
          :cleanup.preview&&<>
            <p>These {cleanup.preview.items.length} {cleanup.preview.items.length===1?'item':'items'} will be permanently deleted:</p>
            <ul className="storage-items">{cleanup.preview.items.slice(0,6).map(item=><li key={item.name}><code>{item.name}</code><span>{formatBytes(item.bytes)} · {item.reason}</span></li>)}{cleanup.preview.items.length>6&&<li className="settings-muted">and {cleanup.preview.items.length-6} more</li>}</ul>
            <div className="storage-confirm-actions">
              <button type="button" className="settings-button danger" disabled={cleanup.busy} onClick={()=>void remove()}><Trash2 size={14}/>{cleanup.busy?'Removing…':`Remove ${formatBytes(cleanup.preview.bytes)}`}</button>
              <button type="button" className="settings-button secondary" disabled={cleanup.busy} onClick={()=>setCleanup(null)}>Cancel</button>
            </div>
          </>}
        </div>}
      </React.Fragment>)}
    </section>}
    <p className="settings-footnote">Chat history, memory, worktrees and scoped computers are never cleaned from here. Remove chats or worktrees where you manage them.</p>
  </div>;
}
