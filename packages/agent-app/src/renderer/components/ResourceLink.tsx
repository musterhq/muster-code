import React,{useEffect,useState} from 'react';
import {PreviewCard} from '@base-ui/react/preview-card';
import {Menu} from '@base-ui/react/menu';
import {Copy, Eye, ExternalLink, FileText, FolderOpen, FolderPlus} from 'lucide-react';
import {ArtifactViewer} from './ArtifactViewer';
import type {ExternalFileInfo, OpenWithApp} from '../../shared/domains/files-protocol';
import {notifyError, notifySuccess} from '../store';
import './resource-link.css';
import {activeChat,openFile,openBrowserTab} from '../store';
import {invoke} from '../bridge';
import {useStore} from '../useStore';
import {externalReference, resourceReference} from './resourceReference';
import {markdownFragmentId} from './markdownAnchors';
export type ResourceContext = { folderId: string; path: string };
export function ResourceLink({href,children,context}:{href?:string;children?:React.ReactNode;context?:ResourceContext}){
 const state=useStore(),chat=activeChat();
 const project=state.snapshot?.projects.find(p=>p.id===chat?.projectId);
 const ids=project?.folderIds??(chat?.folderId?[chat.folderId]:[]);
 const folders=(state.snapshot?.folders??[]).filter(f=>context ? f.id===context.folderId : ids.includes(f.id));
 const fragment=href?.startsWith('#') ? markdownFragmentId(href) : null;
 if(fragment && context)return <a className="md-resource-link" href={`#${fragment}`} onClick={event=>{
  event.preventDefault();
  document.getElementById(fragment)?.scrollIntoView({block:'start',behavior:'smooth'});
 }} title="Jump to this section">{children}</a>;
 const ref=href?resourceReference(href,folders,context?.folderId??chat?.folderId,context?.path):null;
 if(ref)return <FileReference key={`${ref.folderId}:${ref.path}:${ref.line??0}`} reference={ref}>{children}</FileReference>;
 if(href&&/^(https?|mailto):/i.test(href))return <a href={href} title={href} onClick={e=>{if(/^https?:/i.test(href)){e.preventDefault();openBrowserTab(href);}}} rel="noreferrer noopener">{children}</a>;
 const outside=href?externalReference(href):null;
 if(outside)return <ExternalFileReference key={outside.path} path={outside.path} line={outside.line} chatId={chat?.id}>{children}</ExternalFileReference>;
 return <span className="md-unavailable-link" title="This reference is relative to a folder this conversation does not have, or is unsupported.">{children}</span>;
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
  <PreviewCard.Portal><PreviewCard.Positioner side="top" sideOffset={8} className="file-preview-positioner"><PreviewCard.Popup className="file-reference-preview" data-native-preview-overlay>
   <header><FileText size={14}/><span>{reference.path}{reference.line?':'+reference.line:''}</span></header>
   {preview?.text&&<pre>{preview.text}</pre>}
   <p>{preview?preview.note??'Open in adjoining pane':'Loading preview…'}</p>
  </PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal>
 </PreviewCard.Root>;
}

/** TRN-12: a path outside the conversation's folders. Nothing is read; the menu offers Reveal, Open with an
 *  allowlisted app, Add the folder to Muster, or Copy path. The host re-validates every action. */
function ExternalFileReference({path,line,chatId,children}:{path:string;line?:number;chatId?:string;children?:React.ReactNode}){
 const [viewing,setViewing]=useState(false);
 const [info,setInfo]=useState<ExternalFileInfo|null>(null);
 const [apps,setApps]=useState<OpenWithApp[]>([]);
 const [failed,setFailed]=useState<string|null>(null);
 const onOpenChange=(open:boolean)=>{
  if(!open||info)return;
  void invoke('files.external.inspect',{path}).then(result=>{
   setInfo(result);
   if(result.kind==='file')void invoke('files.openWith.apps',{path:result.path}).then(list=>setApps(list.apps.filter(app=>app.id!=='finder')),()=>setApps([]));
  },error=>setFailed(error instanceof Error?error.message:String(error)));
 };
 const act=(work:()=>Promise<unknown>)=>()=>void work().catch(notifyError);
 const addFolder=act(async()=>{if(!info)return;const folder=await invoke('folder.add',{path:info.folderPath});notifySuccess(`Added ${folder.name} to Muster`);});
 const label=`${path}${line?`:${line}`:''}`;
 return <>{viewing&&chatId&&<ArtifactViewer chatId={chatId} path={info?.path??path} line={line} onClose={()=>setViewing(false)}/>}<Menu.Root onOpenChange={onOpenChange}>
  <Menu.Trigger className="md-resource-link md-external-link" aria-label={`${label} — outside this conversation’s folders; choose an action`} title="Outside this conversation’s folders">{children}<ExternalLink size={11} aria-hidden="true" className="md-external-glyph"/></Menu.Trigger>
  <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={4} className="file-action-positioner"><Menu.Popup className="file-action-menu external-reference-menu" data-native-preview-overlay>
   <div className="external-reference-head" title={label}>{info?.path ?? path}{line?`:${line}`:''}</div>
   {failed&&<div className="external-reference-note" role="alert">{failed}</div>}
   {!info&&!failed&&<div className="external-reference-note">Checking…</div>}
   {info&&!info.exists&&<div className="external-reference-note">This path no longer exists.</div>}
   {info?.kind==='file'&&chatId&&<Menu.Item onClick={()=>setViewing(true)}><Eye size={13}/>View read-only</Menu.Item>}
   {info?.exists&&<Menu.Item onClick={act(()=>invoke('files.external.reveal',{path:info.path}))}><FolderOpen size={13}/>Reveal in Finder</Menu.Item>}
   {info?.kind==='file'&&apps.map(app=><Menu.Item key={app.id} onClick={act(()=>invoke('files.external.openWith',{path:info.path,app:app.id}))}>{app.icon?<img className="open-in-icon" src={app.icon} alt="" aria-hidden="true" draggable={false}/>:<ExternalLink size={13}/>}Open with {app.name}</Menu.Item>)}
   {info?.exists&&<Menu.Item onClick={addFolder}><FolderPlus size={13}/>Add folder “{info.folderPath.split('/').filter(Boolean).pop() ?? info.folderPath}” to Muster</Menu.Item>}
   <Menu.Item onClick={act(()=>invoke('clipboard.write',{text:info?.path ?? path}))}><Copy size={13}/>Copy path</Menu.Item>
  </Menu.Popup></Menu.Positioner></Menu.Portal>
 </Menu.Root></>;
}
