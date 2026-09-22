import type {ScopedComputerRef} from '../shared/scoped-computer-protocol';
import {browserURL} from '../shared/browser-protocol';
export interface SavedTab {
  id: string;
  kind: 'files' | 'changes' | 'file' | 'diff' | 'subagents' | 'browser' | 'computer' | 'processes';
  scope?:ScopedComputerRef;
  browserProfileId?: string;
  url?: string;
  folderId?: string;
  path?: string;
  title: string;
  chatId?: string;
}
export interface SavedWorkspace { tabs: SavedTab[]; activeTabId: string | null }
export const MAX_TABS = 24;
const empty = (): SavedWorkspace => ({tabs: [], activeTabId: null});

function storageKey(scope: string): string {
  return `muster.workspace.v2:${encodeURIComponent(scope)}`;
}

/** Persist references only. File contents and provider output stay in the runtime. */
export function readWorkspace(storage: Pick<Storage, 'getItem'>, scope = 'personal'): SavedWorkspace {
  try {
    const raw = storage.getItem(storageKey(scope));
    if (!raw || raw.length > 262144) return empty();
    const parsed = JSON.parse(raw);
    if (parsed.version !== 2 || parsed.scope !== scope || !Array.isArray(parsed.tabs)) return empty();
    const tabs: SavedTab[] = [];
    for (const t of parsed.tabs.slice(0, MAX_TABS)) {
      if (t?.kind === 'computer' || t?.kind === 'processes') {
        const validId=(id:unknown):id is string=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
        if(typeof t.title!=='string'||t.title.length>4096)continue;
        if(t.kind==='computer' && ['chat','project'].includes(t.scope?.kind) && validId(t.scope?.id)){
          const scope:ScopedComputerRef={kind:t.scope.kind,id:t.scope.id}, id=`computer:${scope.kind}:${scope.id}`;
          if(!tabs.some(tab=>tab.id===id))tabs.push({id,kind:'computer',scope,title:t.title});
        }else if(t.kind==='processes' && validId(t.chatId)){
          const id=`processes:${t.chatId}`;if(!tabs.some(tab=>tab.id===id))tabs.push({id,kind:'processes',chatId:t.chatId,title:t.title});
        }
        continue;
      }
      if (t?.kind === 'browser') {
        if (typeof t.id==='string' && /^browser:[a-zA-Z0-9_-]{1,128}$/.test(t.id) && typeof t.browserProfileId==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.browserProfileId) && !tabs.some(tab=>tab.id===t.id)) {
          let url='about:blank';
          try {if(t.url!==undefined)url=browserURL(t.url);} catch {}
          tabs.push({id:t.id,kind:'browser',browserProfileId:t.browserProfileId,url,title:'Browser'});
        }
        continue;
      }
      if (!t || !['files','changes','file','diff','subagents'].includes(t.kind)) continue;
      const folderRequired = t.kind !== 'subagents';
      if (folderRequired && (typeof t.folderId !== 'string' || !t.folderId || t.folderId.length > 128)) continue;
      if (t.kind === 'subagents' && (typeof t.chatId !== 'string' || !t.chatId || t.chatId.length > 256)) continue;
      if (typeof t.title !== 'string' || t.title.length > 4096) continue;
      if (!['files','changes','subagents'].includes(t.kind) && (typeof t.path !== 'string' || !t.path || t.path.length > 8192)) continue;
      const id = t.kind === 'subagents' ? `subagents:${t.chatId}` : ['files','changes'].includes(t.kind) ? `${t.kind}:${t.folderId}` : `${t.kind}:${t.folderId}:${t.path}`;
      if (tabs.some(tab => tab.id === id)) continue;
      tabs.push({id, kind:t.kind, ...(typeof t.folderId==='string' ? {folderId:t.folderId}:{}), ...(!['files','changes','subagents'].includes(t.kind) ? {path:t.path}:{}), ...(typeof t.chatId==='string' ? {chatId:t.chatId.slice(0,256)}:{}), title:t.title});
    }
    return {tabs, activeTabId:tabs.some(t=>t.id===parsed.activeTabId) ? parsed.activeTabId : tabs[0]?.id ?? null};
  } catch { return empty(); }
}

export function saveWorkspace(storage: Pick<Storage, 'setItem'>, workspace: SavedWorkspace, scope = 'personal'): boolean {
  try {
    storage.setItem(storageKey(scope), JSON.stringify({version:2, scope, tabs:workspace.tabs.slice(0,MAX_TABS).map(tab=>{
      if(tab.kind!=='browser')return tab;
      let url='about:blank';
      try {if(tab.url!==undefined)url=browserURL(tab.url);} catch {}
      return {id:tab.id,kind:tab.kind,browserProfileId:tab.browserProfileId,url,title:'Browser'};
    }), activeTabId:workspace.activeTabId}));
    return true;
  } catch { return false; }
}
