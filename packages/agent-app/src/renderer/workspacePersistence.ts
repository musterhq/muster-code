import type {ScopedComputerRef} from '../shared/scoped-computer-protocol';
import {browserURL} from '../shared/browser-protocol.ts';
export interface SavedTab {
  id: string;
  kind: 'files' | 'git' | 'changes' | 'file' | 'diff' | 'subagents' | 'browser' | 'computer' | 'processes' | 'attachment' | 'pullRequest' | 'history' | 'conflict' | 'canvas' | 'sideChat' | 'pluginUi' | 'inbox';
  gitView?: 'changes' | 'history' | 'pullRequest';
  sha?: string;
  canvasId?: string;
  pluginId?: string;
  appName?: string;
  scope?:ScopedComputerRef;
  browserProfileId?: string;
  url?: string;
  folderId?: string;
  path?: string;
  title: string;
  chatId?: string;
  attachmentId?: string;
  prNumber?: number;
  pinned?: boolean;
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
    // Older workspaces saved separate Changes, History and Pull request tabs; they all restore into the folder's one Git tab.
    const aliases = new Map<string, string>();
    for (const t of parsed.tabs.slice(0, MAX_TABS)) {
      if (t?.kind === 'git' || t?.kind === 'changes' || t?.kind === 'history' || t?.kind === 'pullRequest') {
        const git = savedGitTab(t);
        if (!git) continue;
        if (typeof t.id === 'string') aliases.set(t.id, git.id);
        const existing = tabs.find(tab => tab.id === git.id);
        if (!existing) { tabs.push(git); continue; }
        // Keep the first tab's place and view; still carry a PR number or pin from the merged ones.
        if (!existing.prNumber && git.prNumber) existing.prNumber = git.prNumber;
        if (git.pinned) existing.pinned = true;
        if (parsed.activeTabId === t.id) { existing.gitView = git.gitView; if (git.sha) existing.sha = git.sha; }
        continue;
      }
      if (t?.kind === 'computer' || t?.kind === 'processes') {
        const validId=(id:unknown):id is string=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
        if(typeof t.title!=='string'||t.title.length>4096)continue;
        const pinned=t.pinned===true ? {pinned:true as const} : {};
        if(t.kind==='computer' && ['chat','project'].includes(t.scope?.kind) && validId(t.scope?.id)){
          const scope:ScopedComputerRef={kind:t.scope.kind,id:t.scope.id}, id=`computer:${scope.kind}:${scope.id}`;
          if(!tabs.some(tab=>tab.id===id))tabs.push({id,kind:'computer',scope,title:t.title,...pinned});
        }else if(t.kind==='processes' && validId(t.chatId)){
          const id=`processes:${t.chatId}`;if(!tabs.some(tab=>tab.id===id))tabs.push({id,kind:'processes',chatId:t.chatId,title:'Terminal',...pinned}); // S3-E: older saves said "Commands · …"
        }
        continue;
      }
      if (t?.kind === 'attachment') {
        const validId=(id:unknown):id is string=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
        if (validId(t.chatId) && validId(t.attachmentId) && typeof t.title==='string' && t.title.length<=4096 && typeof t.path==='string' && t.path.length>0 && t.path.length<=4096) {
          const id=`attachment:${t.chatId}:${t.attachmentId}`;
          if(!tabs.some(tab=>tab.id===id))tabs.push({id,kind:'attachment',chatId:t.chatId,attachmentId:t.attachmentId,path:t.path,title:t.title,...(t.pinned===true ? {pinned:true as const}:{})});
        }
        continue;
      }
      if (t?.kind === 'canvas' || t?.kind === 'sideChat' || t?.kind === 'pluginUi') {
        const saved = savedArtifactTab(t);
        if (saved && !tabs.some(tab => tab.id === saved.id)) tabs.push(saved);
        continue;
      }
      if (t?.kind === 'inbox') {
        // SBX-12/17: an Inbox tab restores from its chat reference; the mail itself reloads from the runtime.
        if (typeof t.chatId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(t.chatId) && typeof t.title === 'string' && t.title.length <= 4096 && !tabs.some(tab => tab.id === `inbox:${t.chatId}`)) tabs.push({id:`inbox:${t.chatId}`, kind:'inbox', chatId:t.chatId, title:t.title, ...(t.pinned === true ? {pinned:true} : {})});
        continue;
      }
      if (t?.kind === 'browser') {
        if (typeof t.id==='string' && /^browser:[a-zA-Z0-9_-]{1,128}$/.test(t.id) && typeof t.browserProfileId==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.browserProfileId) && !tabs.some(tab=>tab.id===t.id)) {
          let url='about:blank';
          try {if(t.url!==undefined)url=browserURL(t.url);} catch {}
          tabs.push({id:t.id,kind:'browser',browserProfileId:t.browserProfileId,url,title:'Browser',...(t.pinned===true ? {pinned:true}:{})});
        }
        continue;
      }
      if (!t || !['files','file','diff','subagents','conflict'].includes(t.kind)) continue;
      const folderRequired = t.kind !== 'subagents';
      if (folderRequired && (typeof t.folderId !== 'string' || !t.folderId || t.folderId.length > 128)) continue;
      if (t.kind === 'subagents' && (typeof t.chatId !== 'string' || !t.chatId || t.chatId.length > 256)) continue;
      if (typeof t.title !== 'string' || t.title.length > 4096) continue;
      if (!['files','subagents'].includes(t.kind) && (typeof t.path !== 'string' || !t.path || t.path.length > 8192)) continue;
      const id = t.kind === 'subagents' ? `subagents:${t.chatId}` : t.kind === 'files' ? `files:${t.folderId}` : `${t.kind}:${t.folderId}:${t.path}`;
      if (tabs.some(tab => tab.id === id)) continue;
      tabs.push({id, kind:t.kind, ...(typeof t.folderId==='string' ? {folderId:t.folderId}:{}), ...(!['files','subagents'].includes(t.kind) ? {path:t.path}:{}), ...(typeof t.chatId==='string' ? {chatId:t.chatId.slice(0,256)}:{}), ...(t.pinned===true ? {pinned:true}:{}), title:t.title});
    }
    const active = aliases.get(parsed.activeTabId) ?? parsed.activeTabId;
    return {tabs, activeTabId:tabs.some(t=>t.id===active) ? active : tabs[0]?.id ?? null};
  } catch { return empty(); }
}

const GIT_VIEWS = new Set(['changes', 'history', 'pullRequest']);
/** A Git tab (or a legacy Changes / History / Pull request tab) as the folder's one Git tab reference. */
function savedGitTab(t: Record<string, unknown>): SavedTab | null {
  if (typeof t.folderId !== 'string' || !t.folderId || t.folderId.length > 128 || typeof t.title !== 'string' || t.title.length > 4096) return null;
  const view = t.kind === 'git' ? (typeof t.gitView === 'string' && GIT_VIEWS.has(t.gitView) ? t.gitView as SavedTab['gitView'] : 'changes') : t.kind === 'changes' ? 'changes' : t.kind === 'history' ? 'history' : 'pullRequest';
  const prNumber = typeof t.prNumber === 'number' && Number.isInteger(t.prNumber) && t.prNumber > 0 && t.prNumber < 1e9 ? t.prNumber : undefined;
  const sha = typeof t.sha === 'string' && /^[0-9a-f]{4,64}$/i.test(t.sha) ? t.sha : undefined;
  // "Changes · Repo" / "History · Repo" keep their folder name; a PR title never named the folder.
  const named = /^(?:Git|Changes|History) · (.+)$/.exec(t.title)?.[1];
  return {id: `git:${t.folderId}`, kind: 'git', folderId: t.folderId, title: `Git · ${named ?? 'Repository'}`, gitView: view,
    ...(prNumber ? {prNumber} : {}), ...(sha && view === 'history' ? {sha} : {}), ...(t.pinned === true ? {pinned: true as const} : {})};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canvas (WRK-12), side chat (WRK-13) and plugin UI (EXT-10) tabs persist their reference only; bodies reload from the runtime. */
function savedArtifactTab(t: Record<string, unknown>): SavedTab | null {
  if (typeof t.title !== 'string' || t.title.length > 4096) return null;
  const pinned = t.pinned === true ? {pinned: true as const} : {};
  if (t.kind === 'canvas') return typeof t.canvasId === 'string' && UUID.test(t.canvasId) ? {id: `canvas:${t.canvasId}`, kind: 'canvas', canvasId: t.canvasId, title: t.title, ...pinned} : null;
  if (t.kind === 'sideChat') {
    if (typeof t.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(t.chatId)) return null;
    return {id: `sidechat:${t.chatId}`, kind: 'sideChat', chatId: t.chatId, title: t.title, ...(typeof t.folderId === 'string' && t.folderId.length <= 128 ? {folderId: t.folderId} : {}), ...pinned};
  }
  if (typeof t.pluginId !== 'string' || !t.pluginId || t.pluginId.length > 4096 || typeof t.appName !== 'string' || !t.appName || t.appName.length > 256) return null;
  return {id: `plugin:${t.pluginId}:${t.appName}`, kind: 'pluginUi', pluginId: t.pluginId, appName: t.appName, title: t.title, ...pinned};
}

/** BRW-06: query parameters and fragments that commonly carry credentials never reach plaintext localStorage.
 *  The full URL and history live only in main's encrypted browser session vault. */
const SENSITIVE_PARAM = /^(code|state|token|access_token|id_token|refresh_token|auth|authorization|key|api_?key|secret|client_secret|password|passwd|pwd|session|sessionid|sid|sig|signature|jwt|otp|ticket|saml(request|response)?|x-amz-[a-z-]+)$/i;
export function redactBrowserURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
  url.username = ''; url.password = '';
  for (const name of [...url.searchParams.keys()]) if (SENSITIVE_PARAM.test(name)) url.searchParams.delete(name);
  if (url.hash && /(^|[#&])(access_token|id_token|token|code|state|refresh_token)=/i.test(url.hash)) url.hash = '';
  return url.href;
}

export function saveWorkspace(storage: Pick<Storage, 'setItem'>, workspace: SavedWorkspace, scope = 'personal'): boolean {
  try {
    storage.setItem(storageKey(scope), JSON.stringify({version:2, scope, tabs:workspace.tabs.slice(0,MAX_TABS).map(tab=>{
      if(tab.kind!=='browser')return tab;
      let url='about:blank';
      try {if(tab.url!==undefined)url=redactBrowserURL(browserURL(tab.url));} catch {}
      return {id:tab.id,kind:tab.kind,browserProfileId:tab.browserProfileId,url,title:'Browser',...(tab.pinned===true ? {pinned:true as const}:{})};
    }), activeTabId:workspace.activeTabId}));
    return true;
  } catch { return false; }
}
