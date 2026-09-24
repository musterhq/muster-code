import React,{useEffect,useState} from 'react';
import {Dialog} from '@base-ui/react/dialog';
import {FileText, X} from 'lucide-react';
import type {ArtifactFile} from '../../shared/domains/artifacts-protocol';
import {invoke} from '../bridge';
import './file-actions.css';
import './artifact-viewer.css';

type Load={state:'loading'}|{state:'ready';file:ArtifactFile}|{state:'error';message:string};

/** The viewer's body: authorizes, reads by handle, and renders the text read-only. Exported for tests. */
export function ArtifactContents({chatId,path,line}:{chatId:string;path:string;line?:number}){
 const [load,setLoad]=useState<Load>({state:'loading'});
 useEffect(()=>{
  let live=true;setLoad({state:'loading'});
  void invoke('artifacts.authorize',{chatId,path}).then(grant=>invoke('artifacts.read',{handle:grant.handle})).then(file=>{if(live)setLoad({state:'ready',file});},error=>{if(live)setLoad({state:'error',message:error instanceof Error?error.message:String(error)});});
  return()=>{live=false;};
 },[chatId,path]);
 const lines=load.state==='ready'&&!load.file.binary?load.file.text.split('\n'):[];
 useEffect(()=>{if(line&&lines.length)document.getElementById(`artifact-line-${line}`)?.scrollIntoView?.({block:'center'});},[line,lines.length]);
 return <>
  <p className="artifact-viewer-note">Read-only · outside this conversation’s folders{load.state==='ready'&&load.file.truncated?' · showing the first 2 MB':''}</p>
  {load.state==='loading'&&<div role="status" className="artifact-viewer-status">Loading…</div>}
  {load.state==='error'&&<div role="alert" className="artifact-viewer-status">{load.message}</div>}
  {load.state==='ready'&&load.file.binary&&<div className="artifact-viewer-status">This is a binary file. Use Open with or Reveal in Finder to view it.</div>}
  {load.state==='ready'&&!load.file.binary&&<pre className="artifact-viewer-body" tabIndex={0} aria-label="File contents">{lines.slice(0,20000).map((text,index)=><span key={index} id={`artifact-line-${index+1}`} className="artifact-viewer-line" data-current={line===index+1||undefined}>{text}{'\n'}</span>)}</pre>}
 </>;
}

/** W5-E.b2: shows a file outside the chat's folders, read-only. The host authorizes it against the chat's tool
 *  items (the agent wrote or used it) and re-verifies it on read; nothing here can write. */
export function ArtifactViewer({chatId,path,line,onClose}:{chatId:string;path:string;line?:number;onClose:()=>void}){
 return <Dialog.Root open onOpenChange={next=>{if(!next)onClose();}}>
  <Dialog.Portal>
   <Dialog.Backdrop className="file-dialog-backdrop"/>
   <Dialog.Popup className="file-dialog artifact-viewer" aria-label={`${path} (read-only)`}>
    <div className="file-dialog-heading"><Dialog.Title className="artifact-viewer-title"><FileText size={14} aria-hidden="true"/><span title={path}>{path}</span></Dialog.Title><Dialog.Close className="artifact-viewer-close" aria-label="Close"><X size={14}/></Dialog.Close></div>
    <ArtifactContents chatId={chatId} path={path} line={line}/>
   </Dialog.Popup>
  </Dialog.Portal>
 </Dialog.Root>;
}
