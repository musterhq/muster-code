import React,{useMemo} from 'react';
import {FileText,GitCompare} from 'lucide-react';
import {useStoreSelector} from '../useStore';
import {openFile} from '../store';
import {collectFileChanges} from '../turnFileChanges';
import {resolveToolPath} from './toolPresentation';
import {FileChangeView} from './FileDiffEditor';
import {DiffStat} from './DiffStat';
import type {TimelineItem} from '../../shared/protocol';
import {Tip} from './Tooltip';

const NO_ITEMS:TimelineItem[]=[];

/**
 * The Diff tab for a folder that is not a Git repository. There is no HEAD to
 * compare with, so instead of a misleading "vs HEAD" diff (the whole file as
 * added) the tab shows what the agent changed in this file in the active chat:
 * the whole file with the edits in place, counted by the same model as the
 * transcript row and the pill. Without such edits it says plainly why there is
 * nothing to compare.
 */
export function AgentEditDiff({folderId,path}:{folderId:string;path:string}):React.ReactElement {
  const chatId=useStoreSelector(state=>state.activeChatId??undefined);
  const items=useStoreSelector(state=>chatId?state.timelines[chatId]?.value??NO_ITEMS:NO_ITEMS);
  const folders=useStoreSelector(state=>state.snapshot?.folders);
  const chatFolder=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.folderId);
  const entry=useMemo(()=>collectFileChanges(items).find(change=>{const to=resolveToolPath(change.movePath??change.path,folders??[],chatFolder??undefined);return to?.folderId===folderId&&to.path===path;}),[items,folders,chatFolder,folderId,path]);
  const patches=useMemo(()=>entry?.patches.map(patch=>({diff:patch.diff,adds:patch.adds,dels:patch.dels}))??[],[entry]);
  return <div className="diff-view agent-edit-diff">
    <header className="diff-head">
      <span className="file-path" title={path}>{path}</span>
      {entry&&<DiffStat adds={entry.adds} dels={entry.dels} className="diff-stats"/>}
      <span className="agent-edit-diff-scope">{entry?'Agent edits in this chat':'Not a Git repository'}</span>
      <Tip label="Open current file"><button className="icon-button" aria-label="Open current file" onClick={()=>void openFile(folderId,path)}><FileText size={14}/></button></Tip>
    </header>
    {entry
      ?<div className="agent-edit-diff-body"><FileChangeView path={path} kind={entry.kind} target={{folderId,path}} patches={patches} maxHeight={null} truncated={entry.patches.some(patch=>patch.truncated)}/></div>
      :<div className="resource-neutral" role="status"><GitCompare size={18} aria-hidden="true"/><strong>Not a Git repository</strong><span>There is no earlier version to compare with. Edits the agent makes in this chat appear here.</span></div>}
  </div>;
}
