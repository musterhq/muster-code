import React,{useEffect,useState} from 'react';
import {PreviewCard} from '@base-ui/react/preview-card';
import {FileText} from 'lucide-react';
import './resource-link.css';
import {activeChat,openFile,notifyError} from '../store';
import {invoke} from '../bridge';
import {useStore} from '../useStore';
import {resourceReference} from './resourceReference';
export type ResourceContext = { folderId: string; path: string };
export function ResourceLink({href,children,context}:{href?:string;children?:React.ReactNode;context?:ResourceContext}){
 const state=useStore(),chat=activeChat();
 const project=state.snapshot?.projects.find(p=>p.id===chat?.projectId);
 const ids=project?.folderIds??(chat?.folderId?[chat.folderId]:[]);
 const folders=(state.snapshot?.folders??[]).filter(f=>context ? f.id===context.folderId : ids.includes(f.id));
 const ref=href?resourceReference(href,folders,context?.folderId??chat?.folderId,context?.path):null;
 if(ref)return <FileReference key={`${ref.folderId}:${ref.path}:${ref.line??0}`} reference={ref}>{children}</FileReference>;
 if(href&&/^https?:/i.test(href))return <a href={href} title={href} onClick={e=>{e.preventDefault();void invoke('link.open',{url:href}).catch(notifyError);}} rel="noreferrer noopener">{children}</a>;
 return <span className="md-unavailable-link" title="This reference is outside the conversation’s folders or is unsupported.">{children}</span>;
}

function FileReference({reference,children}:{reference:NonNullable<ReturnType<typeof resourceReference>>;children?:React.ReactNode}){
 const [open,setOpen]=useState(false);
 const [preview,setPreview]=useState<{text:string;note?:string}|null>(null);
 useEffect(()=>{
  if(!open)return;
  let live=true;setPreview(null);
  void invoke('files.read',{folderId:reference.folderId,path:reference.path}).then(file=>{
   if(!live)return;
   const lines=file.text.split('\n'),start=Math.max(0,(reference.line??1)-1);
   setPreview(start>=lines.length?{text:'',note:file.truncated?'This line is beyond the bounded preview. Open the file to inspect the available content.':'This line is no longer present in the file.'}:{text:lines.slice(start,start+10).join('\n').slice(0,4000),note:file.truncated?'File preview is truncated.':undefined});
  }).catch(()=>{if(live)setPreview({text:'',note:'Preview unavailable. Open the reference for details.'});});
  return()=>{live=false;};
 },[open,reference.folderId,reference.path,reference.line]);
 return <PreviewCard.Root open={open} onOpenChange={setOpen}>
  <PreviewCard.Trigger render={<button type="button"/>} className="md-resource-link" aria-label={`${reference.path}${reference.line?':'+reference.line:''} — Open in adjoining pane`} delay={450} closeDelay={120} onClick={()=>{setOpen(false);void openFile(reference.folderId,reference.path,reference.line);}}>{children}</PreviewCard.Trigger>
  <PreviewCard.Portal><PreviewCard.Positioner side="top" sideOffset={8} className="file-preview-positioner"><PreviewCard.Popup className="file-reference-preview">
   <header><FileText size={14}/><span>{reference.path}{reference.line?':'+reference.line:''}</span></header>
   {preview?.text&&<pre>{preview.text}</pre>}
   <p>{preview?preview.note??'Open in adjoining pane':'Loading preview…'}</p>
  </PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal>
 </PreviewCard.Root>;
}
