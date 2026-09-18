import React, {useEffect} from 'react';
import {Files,FolderOpen,GitCompare,Activity,RefreshCw} from 'lucide-react';
import {activeChat,loadGitChanges,openChangesTab,openFilesTab,pickFolder} from '../store';
import {useStore} from '../useStore';
import {ToolCard} from './ToolCard';
import {classifyTool} from './toolPresentation';
import './workspace-overview.css';

/** Empty pane and compact activity share real workspace state. */
export function WorkspaceOverview({compact=false,onNavigate=()=>{}}:{compact?:boolean;onNavigate?:()=>void}){
 const state=useStore(),chat=activeChat();
 const project=state.snapshot?.projects.find(p=>p.id===chat?.projectId);
 const ids=project?.folderIds??(chat?.folderId?[chat.folderId]:[]);
 const folders=(state.snapshot?.folders??[]).filter(f=>ids.includes(f.id));
 const signature=folders.map(f=>f.id).join(',');
 useEffect(()=>{for(const folder of folders)void loadGitChanges(folder.id);},[signature]);
 const items=chat?state.timelines[chat.id]?.value??[]:[];
 const latestTool=items.findLast(item=>item.kind==='tool');
 const current=latestTool?classifyTool(latestTool.data):null;
 const run=(action:()=>void)=>{action();onNavigate();};
 return <div className={`workspace-overview${compact?' is-compact':''}`}>
  {!folders.length?<div className="workspace-empty"><FolderOpen size={24}/><p>Open a folder to browse files and changes.</p><button className="workspace-open-folder" onClick={()=>run(()=>{void pickFolder();})}>Open folder…</button></div>:folders.map(folder=>{
   const changes=state.gitChanges[folder.id],count=changes?.value?.length;
   const knownStats=changes?.value?.length&&changes.value.every(c=>typeof c.adds==='number'&&typeof c.dels==='number');
   const adds=knownStats?changes!.value!.reduce((n,c)=>n+c.adds!,0):undefined;
   const dels=knownStats?changes!.value!.reduce((n,c)=>n+c.dels!,0):undefined;
   return <section key={folder.id} className="workspace-overview-section">
    <header title={folder.path}><span>On {folder.name}</span><button className="icon-button" aria-label={`Refresh ${folder.name} changes`} onClick={()=>void loadGitChanges(folder.id)}><RefreshCw size={12}/></button></header>
    <div className="workspace-launchers">
     <button onClick={()=>run(()=>openChangesTab(folder.id,folder.name))}><GitCompare size={18}/><span>Changes</span>{count!==undefined&&<span className="workspace-count">{adds!==undefined?<><b>+{adds}</b> <em>−{dels}</em></>:count?`${count} file${count===1?'':'s'}`:'Clean'}</span>}</button>
     <button onClick={()=>run(()=>openFilesTab(folder.id,folder.name))}><Files size={18}/><span>Files</span></button>
    </div>
    {changes?.phase==='error'&&<p className="workspace-status" role="status">Changes unavailable. Open Changes for details or retry.</p>}
   </section>;
  })}
  {compact&&current&&<section className="workspace-overview-section"><header>Latest activity</header><ToolCard item={latestTool!}/></section>}
 </div>;
}
