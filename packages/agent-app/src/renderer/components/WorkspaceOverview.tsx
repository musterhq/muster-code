import React, {useEffect, useMemo} from 'react';
import {Monitor, Terminal, Globe, Files, FolderOpen, GitCompare, RefreshCw} from 'lucide-react';
import {openComputerTab, openProcessesTab, openBrowserTab, loadGitChanges, openChangesTab, openFilesTab, openSubagentsTab, pickFolder} from '../store';
import {useStore} from '../useStore';
import {ToolCard} from './ToolCard';
import './workspace-overview.css';
import {GitActions} from './GitActions';
import {EMPTY_ACTIVITY_ITEMS, getSubagentActivity, subagentState} from '../subagentActivity';
import {SubagentCounts, SubagentStatus} from './SubagentsTab';

/** Empty pane and compact activity share real workspace state. */
export function WorkspaceOverview({compact=false, onNavigate=()=>{}}: {compact?:boolean; onNavigate?:()=>void}) {
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
  const latestTool = useMemo(() => items.findLast(item => item.kind === 'tool'), [items]);
  const run = (action:()=>void) => { action(); onNavigate(); };
  const openAgents = () => { if (chat) run(() => openSubagentsTab(chat.id, chat.folderId ?? folders[0]?.id, chat.title || 'Conversation')); };
  const loading = !!chat && (!loadable || loadable.phase === 'loading' || loadable.phase === 'idle');

  return <div className={`workspace-overview${compact ? ' is-compact' : ''}`}>
    <div className="workspace-launchers"><button onClick={() => run(() => openBrowserTab())}><Globe size={18} aria-hidden="true"/><span>Browser</span></button></div>
    {chat && <div className="workspace-launchers"><button onClick={()=>run(()=>openProcessesTab(chat.id,chat.title))}><Terminal size={18} aria-hidden="true"/><span>Background commands</span></button><button onClick={()=>run(()=>openComputerTab(project?{kind:'project',id:project.id}:{kind:'chat',id:chat.id},project?.name??chat.title))}><Monitor size={18} aria-hidden="true"/><span>Scoped computer</span></button></div>}
    {chat && <section className="workspace-overview-section workspace-chat-activity" aria-label="Conversation subagents">
      <header><span>Subagents</span><button className="workspace-inline-link" aria-label={`View all subagents for ${chat.title || 'this conversation'}`} onClick={openAgents}>View all</button></header>
      {agents.length > 0 && <>
        <SubagentCounts counts={counts} />
        <div className="workspace-subagent-summary">{visibleAgents.map(agent => <button key={agent.id} title={`${agent.name} · ${agent.threadId}`} className="workspace-subagent-chip" aria-label={`View ${agent.name}, ${subagentState(agent.state).label}, in subagents`} onClick={openAgents}>
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
      const adds = knownStats ? changes!.value!.reduce((n,change) => n + change.adds!, 0) : undefined;
      const dels = knownStats ? changes!.value!.reduce((n,change) => n + change.dels!, 0) : undefined;
      return <section key={folder.id} className="workspace-overview-section">
        <header title={folder.path}><span>On {folder.name}</span><button className="icon-button" aria-label={`Refresh ${folder.name} changes`} onClick={() => void loadGitChanges(folder.id)}><RefreshCw size={12} aria-hidden="true" /></button></header>
        <div className="workspace-launchers">
          <button onClick={() => run(() => openChangesTab(folder.id, folder.name))}><GitCompare size={18} aria-hidden="true" /><span>Changes</span>{count !== undefined && <span className="workspace-count">{adds !== undefined ? <><b>+{adds}</b> <em>−{dels}</em></> : count ? `${count} file${count === 1 ? '' : 's'}` : 'Clean'}</span>}</button>
          <button onClick={() => run(() => openFilesTab(folder.id, folder.name))}><Files size={18} aria-hidden="true" /><span>Files</span></button>
        </div>
        {changes?.phase === 'error' && <p className="workspace-status" role="status">Changes unavailable. Open Changes for details or retry.</p>}
        <GitActions folderId={folder.id} />
      </section>;
    })}
    {compact && latestTool && <section className="workspace-overview-section"><header>Last reported chat activity</header><ToolCard item={latestTool} /></section>}
  </div>;
}
