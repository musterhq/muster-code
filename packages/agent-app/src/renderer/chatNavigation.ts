import type {Chat,Snapshot} from '../shared/protocol.ts';

export type ChatSort = 'recent' | 'name' | 'active';
const SORT_KEY='muster.chatSort.v1';
export function isChatSort(value:unknown):value is ChatSort {return value==='recent'||value==='name'||value==='active';}
export function readChatSort(storage:Pick<Storage,'getItem'>):ChatSort {
  try {const value=storage.getItem(SORT_KEY);return isChatSort(value)?value:'recent';} catch {return 'recent';}
}
export function saveChatSort(storage:Pick<Storage,'setItem'>,sort:ChatSort):boolean {
  try {storage.setItem(SORT_KEY,sort);return true;} catch {return false;}
}
export function isChatRunning(chat:Pick<Chat,'status'>):boolean {return chat.status==='running'||chat.status==='stopping';}
/** Pins keep their explicit order regardless of the sort chosen for other chats. */
export function compareChats(sort:ChatSort):(a:Chat,b:Chat)=>number {
  return (a,b)=>{
    if(a.pinned!==b.pinned)return a.pinned?-1:1;
    if(a.pinned&&b.pinned){
      const order=(a.pinOrder??Number.MAX_SAFE_INTEGER)-(b.pinOrder??Number.MAX_SAFE_INTEGER);
      if(order)return order;
    } else if(sort==='active'&&isChatRunning(a)!==isChatRunning(b))return isChatRunning(a)?-1:1;
    if(sort==='name'&&!a.pinned){const name=a.title.localeCompare(b.title,undefined,{sensitivity:'base',numeric:true});if(name)return name;}
    return b.updatedAt.localeCompare(a.updatedAt)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id);
  };
}
/** Exactly one visible group owns each chat, including stale project/folder references. */
export function chatGroup(chat:Chat,snapshot:Pick<Snapshot,'projects'|'folders'>):string {
  if(chat.archived)return 'archived';
  // CHAT-15: a snoozed chat (pinned or not) waits in Snoozed until it wakes.
  if(chat.snoozedUntil||chat.snoozeUntilActivity)return 'snoozed';
  if(chat.pinned)return 'pinned';
  if(chat.projectId&&snapshot.projects.some(project=>project.id===chat.projectId))return `project:${chat.projectId}`;
  if(chat.folderId&&snapshot.folders.some(folder=>folder.id===chat.folderId))return `folder:${chat.folderId}`;
  return 'chats';
}

/** UX-12/UX-23/NAV-05 reorder: `ids` with `id` moved to insertion slot `slot` (0..ids.length, measured in the original
 *  list, as an insertion marker shows it). Null when the drop would not change the order, so nothing is sent or animated. */
export function reorderedIds(ids:readonly string[],id:string,slot:number):string[]|null {
  const from=ids.indexOf(id);
  if(from<0||!Number.isInteger(slot)||slot<0||slot>ids.length)return null;
  const to=slot>from?slot-1:slot;
  if(to===from)return null;
  const next=ids.filter(item=>item!==id);next.splice(to,0,id);return next;
}
/** The keyboard/menu equivalent of a one-step drag (⌥⇧↑/⌥⇧↓): same result as dropping on the neighbour's far side. */
export function stepReorder(ids:readonly string[],id:string,direction:'up'|'down'):string[]|null {
  const from=ids.indexOf(id);
  return from<0?null:reorderedIds(ids,id,direction==='up'?from-1:from+2);
}
/** Insertion slot for a pointer over row `index`: the upper half inserts before it, the lower half after. */
export function dropSlot(index:number,pointerY:number,rect:{top:number;height:number}):number {
  return pointerY<rect.top+rect.height/2?index:index+1;
}
/** Bounded edge autoscroll while dragging: pixels per frame (negative = up) inside a 40px band, capped at 14px. */
export function edgeScrollStep(pointerY:number,rect:{top:number;bottom:number},band=40,max=14):number {
  if(pointerY<rect.top+band)return -Math.ceil(max*Math.min(1,(rect.top+band-pointerY)/band));
  if(pointerY>rect.bottom-band)return Math.ceil(max*Math.min(1,(pointerY-(rect.bottom-band))/band));
  return 0;
}

/** Where a new chat should land: the active chat's folder/project, dropping stale or mismatched references the runtime would reject. */
export function newChatTarget(chat:Pick<Chat,'folderId'|'projectId'>|null|undefined,snapshot:Pick<Snapshot,'projects'|'folders'>|null|undefined):{folderId?:string;projectId?:string} {
  if(!chat||!snapshot)return {};
  const folderId=chat.folderId&&snapshot.folders.some(folder=>folder.id===chat.folderId)?chat.folderId:undefined;
  const project=chat.projectId?snapshot.projects.find(item=>item.id===chat.projectId):undefined;
  if(project&&(folderId?project.folderIds.includes(folderId):project.folderIds.length===1))return {folderId,projectId:project.id};
  return folderId?{folderId}:{};
}

/** A stateful selection guard keeps streaming snapshots from requesting scroll. */
export function selectionReveal(previous:string|null,chat:Chat|undefined,snapshot:Pick<Snapshot,'projects'|'folders'>):{id:string;group:string}|null {
  return chat&&chat.id!==previous?{id:chat.id,group:chatGroup(chat,snapshot)}:null;
}

/** Roving focus through visible chat rows: Up/Down step (clamped), Home/End jump; null for other keys or no rows. */
export function rovingTarget(ids:readonly string[],current:string|null,key:string):string|null {
  if(!ids.length)return null;
  const index=current?ids.indexOf(current):-1;
  if(key==='Home')return ids[0];
  if(key==='End')return ids.at(-1)!;
  if(key==='ArrowDown')return ids[index<0?0:Math.min(ids.length-1,index+1)];
  if(key==='ArrowUp')return ids[index<0?ids.length-1:Math.max(0,index-1)];
  return null;
}
/** The row that owns the single tab stop: last focused, else selected, else first visible. */
export function rovingStop(ids:readonly string[],focused:string|null,active:string|null|undefined):string|null {
  if(focused&&ids.includes(focused))return focused;
  if(active&&ids.includes(active))return active;
  return ids[0]??null;
}

/** Where a draft new chat will land. An empty target is a plain chat with no folder. */
export interface ChatTarget {folderId?:string;projectId?:string}
export const targetKey=(target:ChatTarget):string=>target.projectId?`project:${target.projectId}`:target.folderId?`folder:${target.folderId}`:'none';
export function sameTarget(chat:Pick<Chat,'folderId'|'projectId'>,target:ChatTarget):boolean {
  return (chat.folderId||undefined)===(target.folderId||undefined)&&(chat.projectId||undefined)===(target.projectId||undefined);
}
export interface TargetOption {key:string;kind:'none'|'folder'|'project';label:string;detail?:string;target:ChatTarget}
/** Every place a new chat can start: no folder, each available folder, then each live project that has a folder. */
export function targetOptions(snapshot:Pick<Snapshot,'projects'|'folders'>|null|undefined):TargetOption[] {
  const options:TargetOption[]=[{key:'none',kind:'none',label:'No folder',detail:'Plain chat',target:{}}];
  if(!snapshot)return options;
  for(const folder of snapshot.folders)if(!folder.missing)options.push({key:`folder:${folder.id}`,kind:'folder',label:folder.name,detail:folder.path,target:{folderId:folder.id}});
  for(const project of snapshot.projects){
    if(project.archived)continue;
    const live=project.folderIds.filter(id=>snapshot.folders.some(folder=>folder.id===id&&!folder.missing));
    const folderId=project.primaryFolderId&&live.includes(project.primaryFolderId)?project.primaryFolderId:live[0];
    if(folderId)options.push({key:`project:${project.id}`,kind:'project',label:project.name,detail:project.goal||undefined,target:{folderId,projectId:project.id}});
  }
  return options;
}
/** The option a target resolves to, falling back to a plain chat when its folder or project is gone. */
export function resolveTarget(target:ChatTarget,snapshot:Pick<Snapshot,'projects'|'folders'>|null|undefined):TargetOption {
  const options=targetOptions(snapshot);
  return options.find(option=>option.key===targetKey(target))??(target.folderId?options.find(option=>option.key===`folder:${target.folderId}`):undefined)??options[0];
}

/** A chat nobody has used: default title, idle, no provider thread, queue, goal or draft, and no timeline items when known. */
export function isUnusedChat(chat:Chat,items?:number,draft?:string):boolean {
  if(chat.archived||chat.pinned||chat.title!=='New chat'||chat.status!=='idle')return false;
  if(chat.providerThreadId||chat.queue?.length||chat.goal||(draft??chat.draft).trim())return false;
  return !items;
}
/** The newest unused chat already sitting in `target`, so a new-chat action reuses it instead of adding another row. */
export function reusableChat(chats:readonly Chat[],target:ChatTarget,items:(id:string)=>number|undefined=()=>undefined,draft:(id:string)=>string|undefined=()=>undefined):Chat|undefined {
  return chats.filter(chat=>sameTarget(chat,target)&&isUnusedChat(chat,items(chat.id),draft(chat.id))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
}
