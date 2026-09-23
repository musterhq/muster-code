import type {Chat} from '../shared/protocol.ts';
import {invoke} from './bridge';
import {forkChat} from './messageActions';
import {openNewChat} from './newChatDraft';
import {openProject} from './projectFocus';
import {getState,notifyError,notifySuccess,openFilesTab,openProcessesTab,updateChat} from './store';

/** One native menu for a chat, shared by the sidebar row and the header ⋯. Main runs the data actions itself;
 *  only the ones that need renderer UI come back here. */
export async function openChatMenu(chat:Chat,x:number,y:number,surface:'sidebar'|'header',rename:()=>void):Promise<void> {
  try {
    const action=await invoke('chat.contextMenu',{id:chat.id,x,y,surface});
    const folder=getState().snapshot?.folders.find(item=>item.id===chat.folderId);
    if(action==='rename')rename();
    else if(action==='activity'||action==='terminal')openProcessesTab(chat.id,chat.title);
    else if(action==='files'&&folder)openFilesTab(folder.id,folder.name);
    else if(action==='pin')void updateChat(chat.id,{pinned:!chat.pinned});
    else if(action==='archive')void updateChat(chat.id,{archived:!chat.archived});
    else if(action==='fork')await forkChat(chat.id);
    else if(action==='snooze')window.dispatchEvent(new CustomEvent('muster:snooze-chat',{detail:{chatId:chat.id}}));
    else if(action==='share')window.dispatchEvent(new CustomEvent('muster:share-chat',{detail:{chatId:chat.id,title:chat.title}}));
  } catch(error){notifyError(error);}
}

/** UR-135 / S3-G: the native Project row menu. Main only shows it; every action is renderer UI. `edit` opens the sidebar's
 *  Edit project dialog (rename selects the name) or the archive confirmation; without it those fall back to the Projects screen. */
export async function openProjectMenu(projectId:string,x:number,y:number,edit?:(mode:'edit'|'rename'|'archive')=>void):Promise<void> {
  try {
    const action=await invoke('project.contextMenu',{id:projectId,x,y});
    if(action==='open')openProject(projectId);
    else if(action==='new-chat')openNewChat({projectId});
    else if(action==='export')await invoke('project.export.file',{projectId});
    else if(action==='rename'||action==='edit'||action==='archive'){if(edit)edit(action);else openProject(projectId);}
    else if(action==='restore'){const project=await invoke('project.restore',{id:projectId});notifySuccess(`Restored ${project.name}.`);}
  } catch(error){notifyError(error);}
}

/** ⇧⌘U: the Codex shortcut for Mark as unread, on the chat on screen. */
export function isMarkUnreadChord(event:Pick<KeyboardEvent,'key'|'metaKey'|'ctrlKey'|'shiftKey'|'altKey'|'repeat'|'isComposing'|'defaultPrevented'>):boolean {
  return !event.repeat&&!event.isComposing&&!event.defaultPrevented&&event.shiftKey&&!event.altKey&&event.metaKey!==event.ctrlKey&&event.key.toLowerCase()==='u';
}

export async function markUnread(chat:Chat,unread=!chat.unread):Promise<void> {
  try {await invoke('chat.markUnread',{id:chat.id,unread});}
  catch(error){notifyError(error);}
}

