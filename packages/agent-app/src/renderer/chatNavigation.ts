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
  if(chat.pinned)return 'pinned';
  if(chat.projectId&&snapshot.projects.some(project=>project.id===chat.projectId))return `project:${chat.projectId}`;
  if(chat.folderId&&snapshot.folders.some(folder=>folder.id===chat.folderId))return `folder:${chat.folderId}`;
  return 'chats';
}

/** A stateful selection guard keeps streaming snapshots from requesting scroll. */
export function selectionReveal(previous:string|null,chat:Chat|undefined,snapshot:Pick<Snapshot,'projects'|'folders'>):{id:string;group:string}|null {
  return chat&&chat.id!==previous?{id:chat.id,group:chatGroup(chat,snapshot)}:null;
}
