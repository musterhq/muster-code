import type {Chat,Folder,Project,Snapshot} from '../shared/protocol.ts';
import {isChatRunning} from './chatNavigation.ts';

/** Chats untouched for this long, with nothing waiting on the user, count as settled. */
export const ACTIVE_WINDOW_MS=3*24*60*60*1000;
/** How many settled chats show before 'Show more'. */
export const SETTLED_PAGE=10;

export type StatusSection='working'|'pinned'|'active'|'settled';

/** Everything a row needs besides the chat itself, derived once per snapshot (no per-row lookups). */
export interface RowMeta {
  /** Project or folder name, shown as a chip where rows are not already grouped under it. */
  chip?:string;
  /** Extra text that tells two same-named chips or chats apart (a parent path or a suffix). */
  hint?:string;
  branch?:string;
  prs?:number;
  providerId?:string;
  attention:number;
  processes:number;
  folderLabel:string;
  /** The chat finished while the user was elsewhere and has not been opened since. */
  unseen:boolean;
}
export const EMPTY_META:RowMeta={attention:0,processes:0,folderLabel:'Personal chat',unseen:false};

export function sameMeta(a:RowMeta|undefined,b:RowMeta|undefined):boolean {
  if(a===b)return true;
  if(!a||!b)return false;
  return a.chip===b.chip&&a.hint===b.hint&&a.branch===b.branch&&a.prs===b.prs&&a.providerId===b.providerId&&a.attention===b.attention&&a.processes===b.processes&&a.folderLabel===b.folderLabel&&a.unseen===b.unseen;
}

/** Last two path segments: '/Users/me/work/redis-automation' -> 'work/redis-automation' minus the name itself. */
export function parentHint(path:string,name:string):string {
  const parts=(path??'').replace(/[\\/]+$/,'').split(/[\\/]/).filter(Boolean);
  if(parts.at(-1)===name||parts.at(-1)?.toLowerCase()===name.toLowerCase())parts.pop();
  return parts.slice(-2).join('/');
}

/**
 * Hints for entries that share a name. Unique names get none. A duplicate gets its parent path; if that still
 * collides (same parent, or no path), a numeric suffix keeps them apart in listing order.
 */
export function disambiguate(entries:readonly {id:string;name:string;path?:string}[]):Map<string,string> {
  const byName=new Map<string,typeof entries[number][]>();
  for(const entry of entries){const key=(entry.name??'').trim().toLowerCase();const list=byName.get(key);if(list)list.push(entry);else byName.set(key,[entry]);}
  const hints=new Map<string,string>();
  for(const group of byName.values()){
    if(group.length<2)continue;
    const parents=group.map(entry=>entry.path?parentHint(entry.path,entry.name):'');
    const distinct=new Set(parents).size===group.length&&parents.every(Boolean);
    group.forEach((entry,index)=>{hints.set(entry.id,distinct?parents[index]:parents[index]?`${parents[index]} · #${index+1}`:`#${index+1}`);});
  }
  return hints;
}

export interface Sections {working:Chat[];pinned:Chat[];active:Chat[];settled:Chat[];snoozed:Chat[];archived:Chat[]}

/** Which section owns a chat. A running chat is always Working, even when pinned, snoozed or inside a collapsed folder. */
export function sectionOf(chat:Chat,now:number,needsYou:boolean):StatusSection|'snoozed'|'archived' {
  if(chat.archived)return 'archived';
  if(isChatRunning(chat))return 'working';
  if(chat.snoozedUntil||chat.snoozeUntilActivity)return 'snoozed';
  if(chat.pinned)return 'pinned';
  if(chat.unread||needsYou||chat.status==='waiting'||chat.status==='queued'||chat.status==='failed'||chat.queue?.length)return 'active';
  const updated=Date.parse(chat.updatedAt);
  return Number.isFinite(updated)&&now-updated<ACTIVE_WINDOW_MS?'active':'settled';
}

/** One pass over the chats; `compare` orders each bucket. */
export function buildSections(chats:readonly Chat[],attention:ReadonlySet<string>,now:number,compare:(a:Chat,b:Chat)=>number):Sections {
  const out:Sections={working:[],pinned:[],active:[],settled:[],snoozed:[],archived:[]};
  for(const chat of chats)out[sectionOf(chat,now,attention.has(chat.id))].push(chat);
  for(const key of Object.keys(out) as (keyof Sections)[])out[key].sort(compare);
  return out;
}

export interface GitFacts {branch?:string;prs?:number}
/** Lookup maps built once per snapshot so rows never scan the folder, project or attention lists. */
export interface SidebarLookups {
  folders:Map<string,Folder>;
  projects:Map<string,Project>;
  attention:Map<string,number>;
  folderHints:Map<string,string>;
  projectHints:Map<string,string>;
  chatHints:Map<string,string>;
}
export function buildLookups(snapshot:Pick<Snapshot,'chats'|'folders'|'projects'|'attention'>):SidebarLookups {
  const folders=new Map(snapshot.folders.map(folder=>[folder.id,folder] as const));
  const projects=new Map(snapshot.projects.map(project=>[project.id,project] as const));
  const attention=new Map<string,number>();
  for(const item of snapshot.attention?.chats??[])attention.set(item.chatId,item.requests.length);
  const folderHints=disambiguate(snapshot.folders.map(folder=>({id:folder.id,name:folder.name,path:folder.path})));
  const projectHints=disambiguate(snapshot.projects.map(project=>({id:project.id,name:project.name,path:project.primaryFolderId?folders.get(project.primaryFolderId)?.path:undefined})));
  // Chats with the same title are told apart by where they live; a repeat in the same place gets a suffix.
  const place=(chat:Chat)=>{const project=chat.projectId?projects.get(chat.projectId):undefined;const folder=chat.folderId?folders.get(chat.folderId):undefined;return project?.name??(folder?(folderHints.get(folder.id)?`${folder.name} · ${folderHints.get(folder.id)}`:folder.name):'');};
  const titled=new Map<string,Chat[]>();
  for(const chat of snapshot.chats){if(chat.archived)continue;const key=(chat.title??'').trim().toLowerCase();const list=titled.get(key);if(list)list.push(chat);else titled.set(key,[chat]);}
  const chatHints=new Map<string,string>();
  for(const group of titled.values()){
    if(group.length<2)continue;
    const places=group.map(place);
    const distinct=new Set(places).size===group.length&&places.every(Boolean);
    group.forEach((chat,index)=>chatHints.set(chat.id,distinct?places[index]:places[index]?`${places[index]} · #${index+1}`:`#${index+1}`));
  }
  return {folders,projects,attention,folderHints,projectHints,chatHints};
}

export function rowMeta(chat:Chat,lookups:SidebarLookups,processes:number,git?:GitFacts):RowMeta {
  const project=chat.projectId?lookups.projects.get(chat.projectId):undefined;
  const folder=chat.folderId?lookups.folders.get(chat.folderId):undefined;
  const chipId=project?lookups.projectHints.get(project.id):folder?lookups.folderHints.get(folder.id):undefined;
  const chipName=project?.name??folder?.name;
  const hint=lookups.chatHints.get(chat.id)??chipId;
  return {
    ...(chipName?{chip:chipName}:{}),
    ...(hint?{hint}:{}),
    ...(git?.branch?{branch:git.branch}:{}),
    ...(git?.prs?{prs:git.prs}:{}),
    ...(chat.providerId?{providerId:chat.providerId}:{}),
    attention:lookups.attention.get(chat.id)??0,
    processes,
    folderLabel:folder?(folder.missing?`${folder.name} (missing)`:folder.name):'Personal chat',
    unseen:Boolean(chat.unread)&&!isChatRunning(chat),
  };
}

/** 'Working 20s' / '3m 05s' / '1h 02m'. */
export function elapsedLabel(ms:number):string {
  const s=Math.max(0,Math.floor(ms/1000));
  if(s<60)return `${s}s`;
  if(s<3600)return `${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`;
  return `${Math.floor(s/3600)}h ${String(Math.floor(s%3600/60)).padStart(2,'0')}m`;
}

/** The settled list: `shown` rows (default one page) and how many remain behind 'Show more'. */
export function pageSettled<T>(items:readonly T[],shown:number=SETTLED_PAGE):{visible:T[];more:number} {
  const count=Math.max(SETTLED_PAGE,shown);
  return {visible:items.slice(0,count),more:Math.max(0,items.length-count)};
}

/**
 * Where a New chat lands when the open chat gives no usable folder: the last folder you started a chat in, else the
 * folder of the most recently updated chat. A broad folder (home, Documents, Desktop, Downloads) is never chosen.
 */
export function defaultNewChatFolder(snapshot:Pick<Snapshot,'chats'|'folders'>,lastUsed:string|undefined,isBroad:(path:string)=>boolean):string|undefined {
  const usable=(id:string|undefined)=>{const folder=id?snapshot.folders.find(item=>item.id===id):undefined;return folder&&!folder.missing&&!isBroad(folder.path)?folder.id:undefined;};
  const direct=usable(lastUsed);
  if(direct)return direct;
  const recent=[...snapshot.chats].filter(chat=>!chat.archived&&chat.folderId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  for(const chat of recent){const id=usable(chat.folderId);if(id)return id;}
  return undefined;
}
