import {useSyncExternalStore} from 'react';
import {invoke} from './bridge';
import {newChatTarget,resolveTarget,reusableChat,type ChatTarget} from './chatNavigation';
import {focusComposer} from './focus';
import {activeChat,closeSettings,getState,notifyError,pickFolder,selectChat,sendMessage,setComposerDraft,subscribeStore} from './store';
import {sendWithCheckoutGuard} from './components/ParallelRunGuard';

/**
 * The Codex-style draft chat. "New chat" opens this instead of persisting a row; the chat is created
 * (or an unused one reused) only when the first message is sent.
 */
export interface NewChatDraft {open:boolean;target:ChatTarget;text:string;busy:boolean;error:string}
const closed:NewChatDraft={open:false,target:{},text:'',busy:false,error:''};
let draft:NewChatDraft=closed;
const listeners=new Set<()=>void>();
let openedOver:string|null=null,unwatch:(()=>void)|null=null;

function update(patch:Partial<NewChatDraft>):void {
  draft={...draft,...patch};
  for(const listener of listeners)listener();
}
export function getNewChatDraft():NewChatDraft {return draft;}
export function useNewChatDraft():NewChatDraft {
  return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getNewChatDraft,getNewChatDraft);
}

/** Picking any chat leaves the draft; the text is kept for the next New chat. */
function watchSelection():void {
  openedOver=getState().activeChatId;
  unwatch??=subscribeStore(()=>{
    const id=getState().activeChatId;
    if(draft.open&&id&&id!==openedOver)closeNewChat();
  });
}

/** Open (or just refocus) the draft. A second New chat never adds anything; an explicit target retargets it. */
export function openNewChat(target?:ChatTarget):void {
  if(getState().screen!=='work')closeSettings();
  if(!draft.open){watchSelection();update({open:true,target:target??newChatTarget(activeChat(),getState().snapshot),error:''});}
  else if(target)update({target});
  focusComposer();
}
/** F2: "Add folder" / "Open folder…" lands in a New-chat draft aimed at the folder just added (as Codex opens the
 *  new workspace), instead of leaving the draft on "No folder" or on whatever chat was on screen. */
export async function addFolderToDraft():Promise<void> {
  const folder=await pickFolder();
  if(folder)openNewChat({folderId:folder.id});
}
export function closeNewChat():void {
  if(draft.open)update({open:false,error:''}); // busy stays until an in-flight submit settles, so it cannot run twice
}
export function setNewChatText(text:string):void {update({text,error:''});}
export function setNewChatTarget(target:ChatTarget):void {update({target,error:''});}

const timelineLength=(id:string)=>getState().timelines[id]?.value?.length;
const composerText=(id:string)=>getState().composerDrafts[id]?.text;
/** An unused chat already in `target`, if any. */
export function unusedChatIn(target:ChatTarget):string|undefined {
  return reusableChat(getState().snapshot?.chats??[],target,timelineLength,composerText)?.id;
}

/**
 * Send the first message: reuse an unused chat in the chosen target or create exactly one, hand the text
 * to that chat's composer (so a failed send keeps it), select it and send.
 */
export async function submitNewChat():Promise<boolean> {
  const text=draft.text.trim();
  if(!text||draft.busy)return false;
  const target=resolveTarget(draft.target,getState().snapshot).target;
  update({busy:true,error:''});
  let id=unusedChatIn(target);
  if(!id){
    try {id=(await invoke('chat.create',{...(target.folderId?{folderId:target.folderId}:{}),...(target.projectId?{projectId:target.projectId}:{})})).id;}
    catch(cause){update({busy:false,error:cause instanceof Error?cause.message:String(cause)});notifyError(cause);return false;}
  }
  const chatId=id!;
  setComposerDraft(chatId,draft.text);
  draft={...closed};openedOver=chatId;
  for(const listener of listeners)listener();
  void selectChat(chatId);
  // CHAT-06: another chat running in this checkout asks first (worktree / queue / run anyway / cancel).
  const sent=await sendWithCheckoutGuard(chatId,{hasAttachments:false},target=>sendMessage(target,text));
  focusComposer();
  return sent;
}

/** Test seam: forget the draft between fixtures. */
export function resetNewChatDraft():void {unwatch?.();unwatch=null;openedOver=null;draft=closed;for(const listener of listeners)listener();}
