import React,{useEffect,useState} from 'react';
import {PreviewCard} from '@base-ui/react/preview-card';
import {Menu} from '@base-ui/react/menu';
import {Braces, Copy, Eye, ExternalLink, FileCode2, FileImage, FileSpreadsheet, FileText, FolderOpen, FolderPlus, Settings2, SquareTerminal} from 'lucide-react';
import {ArtifactViewer} from './ArtifactViewer';
import type {ExternalFileInfo, OpenWithApp} from '../../shared/domains/files-protocol';
import {notifyError, notifySuccess} from '../store';
import './resource-link.css';
import {activeChat,openFile,openBrowserTab} from '../store';
import {invoke} from '../bridge';
import {useStore} from '../useStore';
import {externalReference, resourceReference} from './resourceReference';
import {markdownFragmentId} from './markdownAnchors';
import {Tip} from './Tooltip';
export type ResourceContext = { folderId: string; path: string };
export function ResourceLink({href,children,context,auto=false}:{href?:string;children?:React.ReactNode;context?:ResourceContext;auto?:boolean}){
 const state=useStore(),chat=activeChat();
 const project=state.snapshot?.projects.find(p=>p.id===chat?.projectId);
 const ids=project?.folderIds??(chat?.folderId?[chat.folderId]:[]);
 const folders=(state.snapshot?.folders??[]).filter(f=>context ? f.id===context.folderId : ids.includes(f.id));
 // A path the reply mentioned (markdown-file-links.ts): a link only once it resolves to one real file here.
 if(auto&&href)return <AutoFileLink href={href} folders={folders}>{children}</AutoFileLink>;
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
  <PreviewCard.Trigger render={<button type="button"/>} className="md-resource-link md-file-link" aria-label={`${reference.path}${reference.line?':'+reference.line:''} — Open in adjoining pane`} delay={450} closeDelay={120} onClick={()=>{setOpen(false);void openFile(reference.folderId,reference.path,reference.line);}}><FileGlyph path={reference.path}/>{children}</PreviewCard.Trigger>
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
  <Tip label="Outside this conversation’s folders"><Menu.Trigger className="md-resource-link md-external-link" aria-label={`${label} — outside this conversation’s folders; choose an action`}>{children}<ExternalLink size={11} aria-hidden="true" className="md-external-glyph"/></Menu.Trigger></Tip>
  <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={4} className="file-action-positioner"><Menu.Popup className="ui-menu file-action-menu external-reference-menu" data-native-preview-overlay>
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

/** File-type glyph for a file link: an icon and a hue by extension (tokens in styles.css). */
const FILE_KINDS:Array<[RegExp,React.ComponentType<{size?:number}>,string]>=[
 [/\.(tsx?|go|c|h|cc|cpp|hpp|cs|sql|dart)$/i,FileCode2,'blue'],
 [/\.(py|pyi|ipynb)$/i,FileCode2,'teal'],
 [/\.(jsx?|mjs|cjs)$/i,FileCode2,'yellow'],
 [/\.(rs|rb|java|kts?|scala|erl|exs?|html?|php)$/i,FileCode2,'red'],
 [/\.(css|scss|less|swift|vue|svelte|graphql|gql|proto)$/i,FileCode2,'purple'],
 [/\.(sh|bash|zsh|fish|ps1)$/i,SquareTerminal,'green'],
 [/\.(jsonc?|lock)$/i,Braces,'yellow'],
 [/\.(ya?ml|toml|ini|cfg|conf|env|tf|tfvars|hcl|plist|xml)$/i,Settings2,'red'],
 [/(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Justfile|Caddyfile|Brewfile)$/,Settings2,'blue'],
 [/\.(csv|tsv|xlsx)$/i,FileSpreadsheet,'green'],
 [/\.(png|jpe?g|gif|svg)$/i,FileImage,'purple'],
];
export function FileGlyph({path}:{path:string}):React.ReactElement{
 const kind=FILE_KINDS.find(([test])=>test.test(path));
 const Icon=kind?.[1]??FileText;
 return <span className="md-file-glyph" data-hue={kind?.[2]??'text'} aria-hidden="true"><Icon size={13}/></span>;
}

/** Mentions resolved per folder and path, shared by every reply in the window. */
const autoResolved=new Map<string,Promise<string|null>>();
const clean=(path:string)=>path.replace(/^\.\//,'');
function resolveMention(folderId:string,path:string):Promise<string|null>{
 const key=`${folderId}\0${path}`;
 let pending=autoResolved.get(key);
 if(!pending){
  const target=clean(path),name=target.split('/').pop()!;
  pending=invoke('files.quickOpen',{folderId,query:name}).then(({results})=>{
   const exact=results.find(r=>r.path===target);if(exact)return exact.path;
   const suffix=results.filter(r=>r.path.endsWith('/'+target));if(suffix.length===1)return suffix[0]!.path;
   // A bare file name links only when exactly one file in the folder has it.
   const named=target.includes('/')?[]:results.filter(r=>r.path.split('/').pop()===name);
   return named.length===1?named[0]!.path:null;
  },()=>null);
  autoResolved.set(key,pending);
 }
 return pending;
}
/** A path the reply mentioned. It reads as plain text until it resolves to a single real file in this
 *  conversation's folders; a guess that matches nothing never turns into a dead link. */
function AutoFileLink({href,folders,children}:{href:string;folders:{id:string;path:string}[];children?:React.ReactNode}){
 const match=/^(.*?)(?::(\d+))?$/.exec(href),path=match?.[1]??href,line=match?.[2]?Number(match[2]):undefined;
 const [found,setFound]=useState<{folderId:string;path:string;absolute:string}|null>(null);
 const key=folders.map(f=>f.id).join(',');
 useEffect(()=>{
  let live=true;setFound(null);
  void (async()=>{for(const folder of folders){const hit=await resolveMention(folder.id,path);if(hit){if(live)setFound({folderId:folder.id,path:hit,absolute:`${folder.path}/${hit}`});return;}}})();
  return()=>{live=false;};
 },[path,key]);
 if(!found)return <>{children}</>;
 return <FileReference reference={{...found,...(line?{line}:{})}}>{children}</FileReference>;
}

