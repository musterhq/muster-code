import {useSyncExternalStore} from 'react';
import {hiddenSideChatIds} from './artifacts';
import {chatSlot,type MenuAction} from '../shared/menu-protocol.ts';
import {invoke} from './bridge';
import {readChatSort} from './chatNavigation';
import {closeNewChat,openNewChat} from './newChatDraft';
import {markUnread} from './chatMenu';
import {toggleTerminal} from './components/ProcessesTab';
import {isSpotlightSearchOpen,openCommandPalette} from './components/SpotlightSearch';
import {focusComposer} from './focus';
import {transitionLayout} from './layoutMotion';
import {chatOrder,installNavHistory,neighbourChat,type NavHistoryHandle} from './navHistory';
import {
  activeChat,closeTab,getState,notifyError,notifySuccess,openAppSettings,
  selectChat,setNavHidden,setResourcesHidden,subscribeStore,toggleSummary,updateChat,wakeChat,
} from './store';

// --- Back / forward --------------------------------------------------------
let navigation:NavHistoryHandle|null=null;
function nav():NavHistoryHandle {
  navigation??=installNavHistory({
    subscribe:subscribeStore,
    activeChatId:()=>getState().activeChatId,
    exists:id=>getState().snapshot?.chats.some(chat=>chat.id===id)??false,
    select:id=>{closeNewChat();void selectChat(id);},
  });
  return navigation;
}
export function goBack():boolean {return nav().goBack();}
export function goForward():boolean {return nav().goForward();}

interface HistoryState {canBack:boolean;canForward:boolean}
let historyState:HistoryState={canBack:false,canForward:false};
function readHistory():HistoryState {
  const {history}=nav();
  if(history.canBack!==historyState.canBack||history.canForward!==historyState.canForward)historyState={canBack:history.canBack,canForward:history.canForward};
  return historyState;
}
export function useNavHistory():HistoryState {
  return useSyncExternalStore(listener=>nav().history.subscribe(listener),readHistory,readHistory);
}

// --- Rename request (menu fallback when no surface claims the event) --------
let renameRequest:string|null=null;
const renameListeners=new Set<()=>void>();
export function requestRename(id:string|null):void {
  if(renameRequest===id)return;
  renameRequest=id;
  for(const listener of renameListeners)listener();
}
export function useRenameRequest():string|null {
  return useSyncExternalStore(listener=>{renameListeners.add(listener);return()=>{renameListeners.delete(listener);};},()=>renameRequest,()=>renameRequest);
}

// --- Actions ---------------------------------------------------------------
function announce(name:string,detail:Record<string,unknown>={}):boolean {
  return window.dispatchEvent(new CustomEvent(name,{detail,cancelable:true}));
}
function switchTo(step:1|-1):void {
  const {snapshot,activeChatId}=getState();
  if(!snapshot)return;
  const side=hiddenSideChatIds();
  const next=neighbourChat(chatOrder(snapshot,readChatSort(localStorage)).filter(chat=>!side.has(chat.id)),activeChatId,step);
  if(next&&next.id!==activeChatId)void selectChat(next.id).then(()=>focusComposer());
}
async function copyLink(id:string):Promise<void> {
  try {await invoke('clipboard.write',{text:`muster://chat/${encodeURIComponent(id)}`});notifySuccess('Local chat link copied');}
  catch(error){notifyError(error);}
}

/** Every native menu intent lands here; each maps onto an existing store action. */
export function runMenuAction(action:MenuAction):void {
  const state=getState();
  const chat=activeChat();
  const slot=chatSlot(action);
  if(slot){
    // The Spotlight palette handles Cmd+1-9 itself for its own filtered list while open;
    // let it win instead of also switching the active chat globally.
    if(isSpotlightSearchOpen())return;
    if(!state.snapshot)return;
    const target=chatOrder(state.snapshot,readChatSort(localStorage))[slot-1];
    if(target)closeNewChat();
    if(target&&target.id!==state.activeChatId)void selectChat(target.id).then(()=>focusComposer());
    return;
  }
  switch(action){
    case 'new-chat':openNewChat();return;
    case 'settings':openAppSettings();return;
    case 'toggle-sidebar':transitionLayout(()=>setNavHidden(!getState().navHidden));return;
    case 'toggle-resources':transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));return;
    case 'toggle-summary':toggleSummary();return;
    case 'search-chats':setNavHidden(false);announce('muster:search-chats');return;
    case 'command-palette':openCommandPalette();return;
    case 'focus-composer':if(state.screen==='work')focusComposer();return;
    case 'find-in-chat':announce('muster:find-in-chat',{chatId:chat?.id??null});return;
    case 'close-tab':{
      const tabOpen=state.screen==='work'&&!state.resourcesHidden&&state.rightPaneMode==='resources'&&state.activeTabId!==null&&state.tabs.some(tab=>tab.id===state.activeTabId);
      if(tabOpen)closeTab(state.activeTabId!);else window.musterMenu?.closeWindow();
      return;
    }
    case 'back':goBack();return;
    case 'forward':goForward();return;
    case 'open-terminal':if(chat)toggleTerminal(chat.id,chat.title);return;
    case 'rename-chat':if(chat&&announce('muster:rename-chat',{chatId:chat.id}))requestRename(chat.id);return;
    case 'mark-unread':if(chat)void markUnread(chat,true);return;
    case 'pin-chat':if(chat)void updateChat(chat.id,{pinned:!chat.pinned});return;
    // CHAT-15: a snoozed chat wakes; any other opens the snooze sheet (presets and a custom date and time).
    case 'snooze-chat':if(chat){if(chat.snoozedUntil||chat.snoozeUntilActivity)void wakeChat(chat.id);else announce('muster:snooze-chat',{chatId:chat.id});}return;
    case 'archive-chat':if(chat)void updateChat(chat.id,{archived:!chat.archived});return;
    case 'copy-link':if(chat)void copyLink(chat.id);return;
    case 'next-chat':switchTo(1);return;
    case 'prev-chat':switchTo(-1);return;
  }
}

/** Subscribe the renderer to the native menu; a no-op outside Electron (tests, shell-only mode). */
export function installMenuActions():()=>void {
  nav();
  return window.musterMenu?.onAction(runMenuAction)??(()=>{});
}
