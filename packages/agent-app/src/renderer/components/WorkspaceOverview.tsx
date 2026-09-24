import React, {useEffect, useMemo} from 'react';
import {Monitor, Terminal, Globe, Files, FolderOpen, GitCompare, RefreshCw, FileText, Pencil} from 'lucide-react';
import {openProcessesTab, openBrowserTab, loadGitChanges, openChangesTab, openFilesTab, openSubagentsTab, openFile, pickFolder} from '../store';
import {useStore} from '../useStore';
import {ToolCard} from './ToolCard';
import './workspace-overview.css';
import {GitActions} from './GitActions';
import {isNotGitRepository} from './resourceErrors';
import {WorktreeList} from './WorktreeList';
import {openSandbox, sandboxTarget} from '../sandboxScope';
import {EMPTY_ACTIVITY_ITEMS, getSubagentActivity, selectSubagent, subagentState} from '../subagentActivity';
import {SubagentCounts, SubagentStatus} from './SubagentsTab';
import {ProcessActivitySummary} from './ProcessActivitySummary';
import type {TimelineItem} from '../../shared/protocol';
import {classifyTool} from './toolPresentation';
import {splitChangeTotals} from '../changeCounts';
import {GeneratedChanges} from './DiffStat';
import { plural } from '../../shared/wording.ts';

/** Empty pane and compact activity share real workspace state. */
export function WorkspaceOverview({compact=false, onNavigate=()=>{}, className=''}: {compact?:boolean; onNavigate?:()=>void; className?:string}) {
  const state = useStore();
  const chat = state.snapshot?.chats.find(chat => chat.id === state.activeChatId);
  const project = state.snapshot?.projects.find(project => project.id === chat?.projectId);
  const folders = useMemo(() => {
    const ids = project?.folderIds ?? (chat?.folderId ? [chat.folderId] : []);
    return (state.snapshot?.folders ?? []).filter(folder => ids.includes(folder.id));
  }, [project?.folderIds, chat?.folderId, state.snapshot?.folders]);
  useEffect(() => { for (const folder of folders) void loadGitChanges(folder.id); }, [folders]);
  const loadable = chat ? state.timelines[chat.id] : undefined;
  const items = loadable?.value ?? EMPTY_ACTIVITY_ITEMS;
  const {agents, counts} = getSubagentActivity(items);
  const visibleAgents = useMemo(() => {
    const priority = {working:0, failed:1, waiting:2, unknown:3, done:4};
    return [...agents].sort((a,b) => priority[subagentState(a.state).kind] - priority[subagentState(b.state).kind]).slice(0,3);
  }, [agents]);
  const toolActivity = useMemo(() => {
    const all=items.filter(item=>item.kind==='tool');
    return {count:all.length,recent:all.slice(-8).reverse()};
  }, [items]);
  const activitySources = useMemo(() => {
    const latest = new Map<string,{path:string;action:'Read'|'Edited'}>();
    for (const item of items) {
      if (item.kind !== 'tool' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted') continue;
      const presentation = classifyTool(item.data);
      if (presentation.kind !== 'read' && presentation.kind !== 'edit') continue;
      for (const path of presentation.paths ?? [presentation.subject]) if (path) {
        latest.delete(path);
        latest.set(path,{path,action:presentation.kind==='read'?'Read':'Edited'});
      }
    }
    return [...latest.values()].slice(-8).reverse();
  }, [items]);
  const sourceTarget = (sourcePath:string):{folderId:string;path:string}|undefined => {
    const normalized=sourcePath.replaceAll('\\','/');
    for (const folder of folders) {
      const root=folder.path.replaceAll('\\','/').replace(/\/$/,'');
      if (normalized.startsWith(root+'/')) return {folderId:folder.id,path:normalized.slice(root.length+1)};
    }
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some(part=>part==='..' || part==='.' || part==='')) return undefined;
    const folderId=chat?.folderId ?? (folders.length===1?folders[0].id:undefined);
    return folderId ? {folderId,path:normalized} : undefined;
  };
  const run = (action:()=>void) => { action(); onNavigate(); };
  const openAgents = () => { if (chat) run(() => openSubagentsTab(chat.id, chat.folderId ?? folders[0]?.id, chat.title || 'Conversation')); };
  const loading = !!chat && (!loadable || loadable.phase === 'loading' || loadable.phase === 'idle');

  return <div className={`workspace-overview${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
    <div className="workspace-launchers"><button onClick={() => run(() => openBrowserTab())}><Globe size={18} aria-hidden="true"/><span>Browser</span></button></div>
    {chat && <div className="workspace-launchers"><button onClick={()=>run(()=>openProcessesTab(chat.id,'Terminal'))}><Terminal size={18} aria-hidden="true"/><span>Terminal</span></button><button title={`Linux container scoped to ${sandboxTarget(chat,project).label}`} onClick={()=>run(()=>openSandbox(chat,project))}><Monitor size={18} aria-hidden="true"/><span>Sandbox shell</span></button></div>}
    {chat && <ProcessActivitySummary chatId={chat.id} />}
    {chat && <section className="workspace-overview-section workspace-chat-activity" aria-label="Conversation subagents">
      <header><span>Subagents</span><button className="workspace-inline-link" aria-label={`View all subagents for ${chat.title || 'this conversation'}`} onClick={openAgents}>View all</button></header>
      {agents.length > 0 && <>
        <SubagentCounts counts={counts} />
        <div className="workspace-subagent-summary">{visibleAgents.map(agent => <button key={agent.id} title={agent.name} className="workspace-subagent-chip" aria-label={`View ${agent.name}, ${subagentState(agent.state).label}, in subagents`} onClick={()=>{if(chat)selectSubagent(chat.id,agent.threadId);openAgents();}}>
          <span className="workspace-subagent-name">{agent.name}</span><SubagentStatus state={agent.state} />
        </button>)}</div>
        {agents.length > visibleAgents.length && <button className="workspace-inline-link workspace-subagent-more" onClick={openAgents}>View {agents.length - visibleAgents.length} more</button>}
        <p className="workspace-status">Last reported states · includes saved history</p>
      </>}
      {loading && <p className="workspace-status" role="status">{agents.length ? 'Refreshing activity…' : 'Loading activity…'}</p>}
      {loadable?.phase === 'error' && <p className="workspace-status is-error" role="status">Activity unavailable.{agents.length ? ' Showing saved reports.' : ' Open Subagents for details.'}</p>}
      {!agents.length && !loading && loadable?.phase !== 'error' && <p className="workspace-status">No subagents reported yet.</p>}
    </section>}
    {!folders.length ? <div className="workspace-empty"><FolderOpen size={24} aria-hidden="true" /><p>Open a folder to browse files and changes.</p><button className="workspace-open-folder" onClick={() => run(() => {void pickFolder();})}>Open folder…</button></div> : folders.map(folder => {
      const changes = state.gitChanges[folder.id], count = changes?.value?.length;
      const knownStats = changes?.value?.length && changes.value.every(change => typeof change.adds === 'number' && typeof change.dels === 'number');
      // F59: lockfiles/generated output are counted apart from the headline numbers, as in every pill.
      const split = knownStats ? splitChangeTotals(changes!.value!.map(change => ({path: change.path, adds: change.adds!, dels: change.dels!}))) : undefined;
      const adds = split?.adds, dels = split?.dels;
      return <section key={folder.id} className="workspace-overview-section">
        <header title={folder.path}><span>On {folder.name}</span><button className="icon-button" aria-label={`Refresh ${folder.name} changes`} onClick={() => void loadGitChanges(folder.id)}><RefreshCw size={12} aria-hidden="true" /></button></header>
        <div className="workspace-launchers">
          <button onClick={() => run(() => openChangesTab(folder.id, folder.name))}><GitCompare size={18} aria-hidden="true" /><span>Changes</span>{count !== undefined && <span className="workspace-count">{adds !== undefined ? <><b>+{adds}</b> <em>−{dels}</em><GeneratedChanges generated={split!.generated}/></> : count ? plural(count, 'file') : 'Clean'}</span>}</button>
          <button onClick={() => run(() => openFilesTab(folder.id, folder.name))}><Files size={18} aria-hidden="true" /><span>Files</span></button>
        </div>
        {changes?.phase === 'error' && !isNotGitRepository(changes.error) && <p className="workspace-status" role="status">Changes unavailable. Open Changes for details or retry.</p>}
        <WorktreeList folderId={folder.id} />
        <GitActions folderId={folder.id} />
      </section>;
    })}
    {activitySources.length>0 && <section className="workspace-overview-section workspace-sources" aria-label="Sources"><header><span>Sources</span><span className="workspace-activity-count">{activitySources.length}</span></header><div className="workspace-source-list">{activitySources.map(source=>{
      const target=sourceTarget(source.path), Icon=source.action==='Edited'?Pencil:FileText;
      const label=target?.path||source.path;
      return <button key={`${source.action}:${source.path}`} className="workspace-source-row" disabled={!target} title={source.path} aria-label={target?`${source.action} ${source.path} — open in Resources`:`${source.action} ${source.path} — outside this chat’s attached folders`} onClick={()=>{if(target)openFile(target.folderId,target.path);}}><Icon size={13} aria-hidden="true"/><span className="workspace-source-action">{source.action}</span><span className="workspace-source-name">{label}</span></button>;
    })}</div></section>}
    {chat && <section className="workspace-overview-section workspace-recent-activity" aria-label="Chat activity"><header><span>Chat activity</span><span className="workspace-activity-count">{toolActivity.count} actions</span></header>{toolActivity.recent.length>0?<div className="workspace-activity-list">{toolActivity.recent.map(item=><ToolCard key={item.id} item={item}/>)}</div>:<p className="workspace-status">No tool activity yet.</p>}</section>}
  </div>;
}
