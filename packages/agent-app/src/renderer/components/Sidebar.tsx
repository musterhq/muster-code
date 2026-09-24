import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowDownWideNarrow,
  Blocks,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  Files,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Layers,
  LayoutGrid,
  MailOpen,
  MessageCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { requestNewProject } from '../projectIntent';
import {Collapsible} from '@base-ui/react/collapsible';
import {Menu} from '@base-ui/react/menu';
import {PreviewCard} from '@base-ui/react/preview-card';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {ensureArtifactSync, useHiddenSideChats} from '../artifacts';
import { ARCHIVE_RUNNING_WARNING, type Chat, type Folder } from '../../shared/protocol';
import {
  activeChat,
  openFilesTab,
  openProvidersTab,
  openAppSettings,
  openPluginsScreen,
  openProjectsScreen,
  openMemoryScreen,
  openAutomationsScreen,
  selectChat,
  updateChat,
  notifyError,
  notifySuccess,
  pushNotice,
  reorderPins,
  reorderFolders,
  wakeChat,
} from '../store';
import { useStore } from '../useStore';
import { isChord } from '../focus';
import { readCollapsed, saveCollapsed } from '../sidebarDisclosure';
import { StatusDot } from './StatusDot';
import { displayStatus } from './runStatus';
import {chatGroup,compareChats,isChatRunning,isChatSort,newChatTarget,readChatSort,rovingStop,rovingTarget,saveChatSort,selectionReveal,stepReorder,type ChatSort} from '../chatNavigation';
import {isSnoozed,snoozeLabel} from '../../shared/snooze';
import {SnoozeSheet} from './SnoozeSheet';
import {ShareSheet} from './ShareSheet';
import {FolderDefaultModelSheet,requestFolderDefaultModel} from './settings/FolderDefaultModelSheet';
import {useDragReorder,useReorderAutoscroll,type ItemDragProps} from './useDragReorder';
import {compactAge,exactTime,relativeLabel} from '../relativeTime';
import './sidebar-disclosure.css';
import {useProcessSummary} from '../processSummary';
import {isActiveProcess} from '../../shared/process-protocol';
import {invoke} from '../bridge';
import {isMarkUnreadChord,markUnread,openChatMenu,openProjectMenu} from '../chatMenu';
import {openProject} from '../projectFocus';
import {addFolderToDraft,closeNewChat,openNewChat,useNewChatDraft} from '../newChatDraft';
import {CloneRepositorySheet,openCloneSheet} from './CloneRepositorySheet';
import {BrandMark} from './BrandMark';
import {openSpotlightSearch} from './SpotlightSearch';
import {ConfirmSheet} from './ConfirmSheet';
import {clearSelection,extendSelectionByArrow,isSelected,isToggleClick,keepSelected,pruneSelection,selectAll,selectionKeyAction,selectRange,toggleSelection,withFallbackAnchor,type MultiSelectState} from '../multiSelect';
import {archiveChats,archiveSummary} from '../batchArchive';
import { plural } from '../../shared/wording.ts';
import { ResourceState } from './ResourceState';
import { ProjectHoverCard } from './ProjectHoverCard';
import { ConfirmProjectAction, EditProjectDialog, toProjectDetails } from './ProjectEditDialog';
import {Tip} from './Tooltip';

const snapshotChats=(snapshot:ReturnType<typeof useStore>['snapshot']):Chat[]=>snapshot?.chats.filter(chat=>!chat.archived)??[];
const IS_MAC=typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||navigator.userAgent||'');

type RowProps = { chat: Chat; now: number; tabbable: boolean; onFocusRow: (id: string) => void; selected: boolean; selectionMode: boolean; onRowClick: (id: string, event: React.MouseEvent) => void; drag?: ItemDragProps };

function ChatRow({ chat, now, tabbable, onFocusRow, selected, selectionMode, onRowClick, drag }: RowProps): React.ReactElement {
  const state = useStore();
  const {summary: processSummary} = useProcessSummary();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [renameError,setRenameError]=useState('');
  const [renameBusy,setRenameBusy]=useState(false);
  const rowButton=useRef<HTMLElement|null>(null),renameInput=useRef<HTMLInputElement>(null);
  const renameCancelled=useRef(false),renamePending=useRef(false);
  const drafting = useNewChatDraft().open;
  const active = !drafting && state.activeChatId === chat.id;
  const activeProcesses = processSummary?.sessions.filter(session => session.chatId === chat.id && isActiveProcess(session.status)).length ?? 0;
  const pendingAttention = state.snapshot?.attention?.chats.find(item => item.chatId === chat.id)?.requests.length ?? 0;
  const folder=state.snapshot?.folders.find(item=>item.id===chat.folderId);
  // Timeline items are only kept live for the active chat (and a couple of open-tab edge cases);
  // everywhere else this stays undefined and the row just shows the chat's plain status.
  const timelineItems=state.timelines[chat.id]?.value;
  const rowStatus=timelineItems?displayStatus(chat,timelineItems):chat.status;
  const age=compactAge(chat.updatedAt,now),exact=exactTime(chat.updatedAt),updated=relativeLabel(chat.updatedAt,now);
  const togglePin=()=>void updateChat(chat.id,{pinned:!chat.pinned});
  const snoozed=isSnoozed(chat),wakes=snoozed?snoozeLabel(chat,new Date(now)):'';
  const toggleArchive=()=>void updateChat(chat.id,{archived:!chat.archived});

  const showNativeMenu=(x:number,y:number)=>openChatMenu(chat,x,y,'sidebar',beginRename);
  const openNativeMenuAtPointer=(event:React.MouseEvent<HTMLButtonElement>)=>{
    event.preventDefault();event.stopPropagation();
    const rect=event.currentTarget.getBoundingClientRect();
    void showNativeMenu(rect.right,rect.bottom);
  };

  const beginRename=()=>{renameCancelled.current=false;setTitle(chat.title);setRenameError('');setRenaming(true);};
  const finishRename=()=>{renameCancelled.current=true;setRenaming(false);requestAnimationFrame(()=>rowButton.current?.focus());};
  // Work ▸ Rename Chat: the visible row claims the menu event and renames inline.
  useEffect(()=>{
    const onRename=(event:Event)=>{if((event as CustomEvent<{chatId?:string}>).detail?.chatId!==chat.id||!rowButton.current?.isConnected)return;event.preventDefault();beginRename();};
    window.addEventListener('muster:rename-chat',onRename);return()=>window.removeEventListener('muster:rename-chat',onRename);
  });
  const commitRename = async () => {
    if(renamePending.current||renameCancelled.current)return;
    const next = title.trim();
    if(!next){setRenameError('Enter a chat title.');renameInput.current?.focus();return;}
    if(next===chat.title){finishRename();return;}
    renamePending.current=true;setRenameBusy(true);
    try {if(await updateChat(chat.id,{title:next}))finishRename();else {setRenameError('The title was not saved. Try again.');renameInput.current?.focus();}}
    finally {renamePending.current=false;setRenameBusy(false);}
  };
  const tab=tabbable?0:-1;
  return (
    <PreviewCard.Root><div className={`chat-row${active ? ' is-active' : ''}${chat.unread ? ' is-unread' : ''}${selected ? ' is-selected' : ''}`} data-chat-id={chat.id} data-running={isChatRunning(chat)||undefined} {...(renaming?{}:drag)} onContextMenu={event=>{event.preventDefault();void showNativeMenu(event.clientX,event.clientY);}}>
      {renaming ? (
        <input
          ref={renameInput}
          className="chat-rename"
          value={title}
          autoFocus
          disabled={renameBusy}
          maxLength={256}
          aria-invalid={!!renameError}
          aria-label="Chat title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={()=>void commitRename()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {e.preventDefault();void commitRename();}
            else if (e.key === 'Escape') {
              e.preventDefault();setTitle(chat.title);finishRename();
            }
          }}
        />
      ) : (
        <PreviewCard.Trigger
          ref={(element:HTMLAnchorElement|null)=>{rowButton.current=element;}}
          render={<button/>}
          type="button"
          className="chat-row-main"
          delay={520}
          closeDelay={80}
          tabIndex={tab}
          aria-current={active?'page':undefined}
          aria-pressed={selectionMode?selected:undefined}
          onFocus={()=>onFocusRow(chat.id)}
          onKeyDown={event=>{
            if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();void showNativeMenu(rect.left,rect.bottom);}
            else if(event.key==='F2'){event.preventDefault();beginRename();}
          }}
          onClick={event => { if(event.metaKey||event.ctrlKey||event.shiftKey){event.preventDefault();onRowClick(chat.id,event);return;} onRowClick(chat.id,event); closeNewChat(); if(state.activeChatId!==chat.id)void selectChat(chat.id); }}
          onDoubleClick={event=>{event.preventDefault();beginRename();}}
        >
          <StatusDot status={rowStatus} unread={chat.unread} />
          <span className="chat-title" title={chat.title}>
            {chat.title}
          </span>
          {(activeProcesses > 0 || pendingAttention > 0) && <span className="chat-row-status" aria-label={[activeProcesses ? `${plural(activeProcesses, 'local command')} running` : '', pendingAttention ? `${plural(pendingAttention, 'request')} need input` : ''].filter(Boolean).join(', ')} title={[activeProcesses ? `${activeProcesses} running` : '', pendingAttention ? `${pendingAttention} need input` : ''].filter(Boolean).join(' · ')}>
            {activeProcesses > 0 && <span className="chat-running-badge" aria-hidden="true">{activeProcesses}</span>}
            {pendingAttention > 0 && <span className="chat-attention-badge" aria-hidden="true">{pendingAttention}</span>}
          </span>}
          {chat.draft && <span className="chat-draft-dot" title="Unsent draft" />}
        </PreviewCard.Trigger>
      )}
      {renameError&&renaming&&<span className="chat-rename-error" role="alert">{renameError}</span>}
      {!renaming&&<span className="chat-row-trail">
        {snoozed
          ? <span className="chat-row-wake" title={wakes}><AlarmClock size={11} aria-hidden="true"/> {chat.snoozedUntil?compactAge(chat.snoozedUntil,now)||'soon':'activity'}</span>
          : age&&<time className="chat-row-age" dateTime={chat.updatedAt} title={exact}>{age}</time>}
        <span className="chat-row-actions">
          {snoozed
            ? <Tip label={`${wakes} · Wake now`}><button type="button" className="icon-button" tabIndex={tab} aria-label={`Wake ${chat.title} now`} onClick={()=>void wakeChat(chat.id)}><AlarmClockOff size={14}/></button></Tip>
            : <Tip label={chat.pinned?'Unpin':'Pin'}><button type="button" className="icon-button" tabIndex={tab} aria-label={chat.pinned?`Unpin ${chat.title}`:`Pin ${chat.title}`} onClick={togglePin}>{chat.pinned?<PinOff size={14}/>:<Pin size={14}/>}</button></Tip>}
          <Tip label={chat.archived?'Unarchive':'Archive'}><button type="button" className="icon-button" tabIndex={tab} aria-label={chat.archived?`Unarchive ${chat.title}`:`Archive ${chat.title}`} onClick={toggleArchive}>{chat.archived?<ArchiveRestore size={14}/>:<Archive size={14}/>}</button></Tip>
          <Tip label="More actions"><button type="button" className="icon-button" tabIndex={tab} aria-label={`Actions for ${chat.title}`} onClick={openNativeMenuAtPointer}><MoreHorizontal size={15}/></button></Tip>
        </span>
      </span>}
    </div>
    {!renaming&&<PreviewCard.Portal><PreviewCard.Positioner side="right" align="start" sideOffset={8} className="chat-preview-positioner"><PreviewCard.Popup className="chat-preview-card">
      <div className="chat-preview-title"><span>{chat.title}</span><StatusDot status={rowStatus} showLabel={isChatRunning(chat)}/></div>
      <div className="chat-preview-meta"><span>{folder?(folder.missing?`${folder.name} (missing)`:folder.name):'Personal chat'}</span><time dateTime={chat.updatedAt} title={exact}>{updated?`Updated ${updated}`:'Updated recently'}</time></div>
      {snoozed&&<div className="chat-preview-activity"><span>{wakes}</span></div>}
      {(activeProcesses>0||pendingAttention>0)&&<div className="chat-preview-activity">{activeProcesses>0&&<span>{plural(activeProcesses, 'command')} running</span>}{pendingAttention>0&&<span>{plural(pendingAttention, 'request')} need input</span>}</div>}
    </PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal>}
    </PreviewCard.Root>
  );
}

function GroupHead({ title, tooltip, chats=[], children, icon, nested=false, onContextMenu, className='', draggable }: {
  title: string;
  tooltip?: string;
  chats?: Chat[];
  children?: React.ReactNode;
  icon?: React.ReactNode;
  nested?: boolean;
  onContextMenu?: (event:React.MouseEvent<HTMLElement>)=>void;
  className?: string;
  /** NAV-05: folder headers are the drag handle for folder reorder. */
  draggable?: boolean;
}): React.ReactElement {
  const running=chats.filter(isChatRunning).length;
  const unread=chats.filter(chat=>chat.unread).length;
  return (
    <header className={`nav-section-head${nested?' is-nested':''}${className?` ${className}`:''}`} onContextMenu={onContextMenu} draggable={draggable||undefined}>
      <Collapsible.Trigger className="nav-disclosure">
        <ChevronRight size={13} className="nav-chevron"/>
        {icon&&<span className="nav-section-icon" aria-hidden="true">{icon}</span>}
        <span className="nav-section-title" title={tooltip ?? title}>
          {title}
        </span>
        {running>0&&<span className="nav-running-count" title={`${running} working or stopping`} aria-label={`${running} active chats`}>{running}</span>}
        {unread>0&&<span className="nav-unread-dot" title={`${unread} unread`} aria-label={`${plural(unread, 'unread chat')}`}/>}
      </Collapsible.Trigger>
      {children && <span className="nav-section-actions">{children}</span>}
    </header>
  );
}

/** Inline folder label edit; the path and every chat binding stay as they are. */
function FolderRename({folder,done}:{folder:Folder;done:()=>void}):React.ReactElement {
  const [name,setName]=useState(folder.name),finished=useRef(false);
  const commit=async()=>{
    if(finished.current)return;
    const next=name.trim();
    if(!next||next===folder.name){finished.current=true;done();return;}
    finished.current=true;
    try{await invoke('folder.rename',{id:folder.id,name:next});}catch(error){notifyError(error);}
    done();
  };
  return <header className="nav-section-head is-nested"><input type="text" className="chat-rename" autoFocus value={name} maxLength={256} aria-label={`Folder name for ${folder.path}`} onFocus={event=>event.currentTarget.select()} onChange={event=>setName(event.target.value)} onBlur={()=>void commit()} onKeyDown={event=>{
    event.stopPropagation();
    if(event.key==='Enter'){event.preventDefault();void commit();}
    else if(event.key==='Escape'){event.preventDefault();finished.current=true;done();}
  }}/></header>;
}

type RowContext = { now: number; stop: string | null; onFocusRow: (id: string) => void; selection: MultiSelectState; selectionMode: boolean; onRowClick: (id: string, event: React.MouseEvent) => void };
const rows=(chats:Chat[],context:RowContext,drag?:(id:string)=>ItemDragProps)=>chats.map(chat=><ChatRow key={chat.id} chat={chat} now={context.now} tabbable={context.stop===chat.id} onFocusRow={context.onFocusRow} selected={isSelected(context.selection,chat.id)} selectionMode={context.selectionMode} onRowClick={context.onRowClick} drag={drag?.(chat.id)}/>);

/** Re-render row ages once a minute without touching the store. */
function useMinuteClock():number {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);
  return now;
}

export function Sidebar(): React.ReactElement {
  const state = useStore();
  const draft = useNewChatDraft();
  const now = useMinuteClock();
  const runningAutomations = state.automations.value?.filter(automation => automation.activeRun?.status === 'running').length ?? 0;
  const [showArchived, setShowArchived] = useState(false);
  const [focusedRow, setFocusedRow] = useState<string|null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string|null>(null);
  const [selection,setSelection] = useState<MultiSelectState>(clearSelection());
  const [confirmDelete,setConfirmDelete] = useState(false);
  const [deleteBusy,setDeleteBusy] = useState(false);
  /** Batch archive: how many selected chats are still working (0: no confirmation open). */
  const [confirmArchive,setConfirmArchive] = useState(0);
  const [archiveBusy,setArchiveBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(localStorage));
  const [sort,setSort]=useState<ChatSort>(()=>readChatSort(localStorage));
  const nav=useRef<HTMLDivElement>(null);
  // UX-12/UX-23 pinned-chat and NAV-05 folder drag reorder; ⌥⇧↑/⌥⇧↓ is the keyboard equivalent.
  const liveChats=snapshotChats(state.snapshot);
  const pinIds=liveChats.filter(chat=>chatGroup(chat,state.snapshot!)==='pinned').sort(compareChats('recent')).map(chat=>chat.id);
  const folderIds=state.snapshot?.folders.map(folder=>folder.id)??[];
  const titleOf=(id:string)=>state.snapshot?.chats.find(chat=>chat.id===id)?.title??'chat';
  const pinDrag=useDragReorder({kind:'pin',ids:pinIds,attr:'data-chat-id',label:titleOf,commit:next=>void reorderPins(next)});
  const folderDrag=useDragReorder({kind:'folder',ids:folderIds,attr:'data-folder-id',label:id=>state.snapshot?.folders.find(folder=>folder.id===id)?.name??'folder',commit:next=>void reorderFolders(next)});
  const autoscroll=useReorderAutoscroll(nav);
  const lastSelection=useRef<string|null>(state.activeChatId),revealPending=useRef<string|null>(null);
  // WRK-13: side chats live in the right pane until promoted; the sidebar leaves them out.
  const hiddenSide = useHiddenSideChats();
  useEffect(ensureArtifactSync, []);
  const snapshot = useMemo(() => state.snapshot && hiddenSide.size && state.snapshot.chats.some(chat => hiddenSide.has(chat.id)) ? {...state.snapshot, chats: state.snapshot.chats.filter(chat => !hiddenSide.has(chat.id))} : state.snapshot, [state.snapshot, hiddenSide]);

  useLayoutEffect(()=>{
    if(!snapshot)return;
    const reveal=selectionReveal(lastSelection.current,snapshot.chats.find(chat=>chat.id===state.activeChatId),snapshot);
    if(!reveal)return;
    lastSelection.current=reveal.id;revealPending.current=reveal.id;
    if(reveal.group==='archived')setShowArchived(true);
    else setCollapsed(previous=>{if(!previous.has(reveal.group))return previous;const next=new Set(previous);next.delete(reveal.group);return next;});
  },[state.activeChatId,snapshot]);
  useLayoutEffect(()=>{
    if(!revealPending.current)return;
    const selectedId=revealPending.current;
    const frame=requestAnimationFrame(()=>{
      const row=rowElement(selectedId);
      if(row){row.scrollIntoView?.({block:'nearest',inline:'nearest'});revealPending.current=null;}
    });
    return()=>cancelAnimationFrame(frame);
  });

  const rowElement=(id:string)=>Array.from(nav.current?.querySelectorAll<HTMLElement>('[data-chat-id]')??[]).find(element=>element.dataset.chatId===id);
  const focusRow=(id:string)=>{const main=rowElement(id)?.querySelector<HTMLElement>('.chat-row-main');if(main){main.focus();main.scrollIntoView?.({block:'nearest',inline:'nearest'});}};
  // One search surface: ⌘K and "Search chats" open the Spotlight panel, never an inline sidebar field.
  const openSearch=()=>{ openSpotlightSearch(); };
  const folderMenu=async(folder:Folder,x:number,y:number,run?:'relink')=>{
    try {
      const action=await invoke('folder.contextMenu',{id:folder.id,x,y,...(run?{run}:{})});
      if(action==='new-chat')openNewChat({folderId:folder.id});
      else if(action==='files')openFilesTab(folder.id,folder.name);
      else if(action==='rename')setRenamingFolder(folder.id);
      else if(action==='default-model')requestFolderDefaultModel(folder.id);
    } catch(error){notifyError(error);}
  };
  // New chat opens the draft; nothing is created until its first message is sent.
  const newChatHere=()=>openNewChat();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isChord(e, 'n')) {e.preventDefault();newChatHere();}
      else if (isChord(e, 'k')) {e.preventDefault();openSearch();}
      else if (isMarkUnreadChord(e)) {const chat=activeChat();if(chat){e.preventDefault();void markUnread(chat);}}
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('muster:search-chats', openSearch);
    return () => {window.removeEventListener('keydown', onKey);window.removeEventListener('muster:search-chats', openSearch);};
  }, []);

  useEffect(() => { saveCollapsed(localStorage, collapsed); }, [collapsed]);
  useEffect(()=>{saveChatSort(localStorage,sort);},[sort]);
  const toggleGroup = (id: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id); else next.add(id);
      return next;
    });
  };
  const isOpen = (id: string) => !collapsed.has(id);
  // A selected chat deleted (or archived away) from anywhere else leaves the selection: the count, the confirm
  // title and every batch action only ever see chats that still exist.
  useEffect(()=>{if(snapshot){const ids=new Set(snapshot.chats.map(chat=>chat.id));setSelection(previous=>pruneSelection(previous,id=>ids.has(id)));}},[snapshot]);

  // Every hook sits above the loading return (Rules of Hooks): a hook below it crashed the app on boot.
  const [projectEdit,setProjectEdit]=useState<{id:string;mode:'edit'|'rename'|'archive'}|null>(null);
  if (!snapshot) {
    return <ResourceState kind="loading" compact label="Loading chats" rows={5}/>;
  }

  const live = snapshot.chats.filter((c) => !c.archived).sort(compareChats(sort));
  const snoozedChats = live.filter(chat=>chatGroup(chat,snapshot)==='snoozed').sort((a,b)=>(a.snoozedUntil??'\uffff').localeCompare(b.snoozedUntil??'\uffff')||a.title.localeCompare(b.title));
  const archived = snapshot.chats.filter((c) => c.archived).sort(compareChats(sort));
  const inGroup=(group:string)=>live.filter(chat=>chatGroup(chat,snapshot)===group);
  const pinned = inGroup('pinned');
  // S3-G: the project hover card, the native row menu and the Edit project dialog share one piece of state.
  const editedProject=projectEdit?snapshot.projects.find(project=>project.id===projectEdit.id):undefined;
  const projectGroups = snapshot.projects.map(project=>({project,gid:`project:${project.id}`,chats:inGroup(`project:${project.id}`)})).filter(group=>!group.project.archived||group.chats.length>0);
  const folderGroups = snapshot.folders.map(folder=>({folder,gid:`folder:${folder.id}`,chats:inGroup(`folder:${folder.id}`)}));
  const orphanChats = inGroup('chats');
  const archivedOpen = showArchived;
  // Visible row order drives roving focus; it mirrors the render order below.
  const visible=[
    ...(isOpen('pinned')?pinned:[]),
    ...folderGroups.flatMap(group=>isOpen(group.gid)?group.chats:[]),
    ...projectGroups.flatMap(group=>isOpen(group.gid)?group.chats:[]),
    ...(isOpen('chats')?orphanChats:[]),
    ...(isOpen('snoozed')?snoozedChats:[]),
    ...(archivedOpen?archived:[]),
  ].map(chat=>chat.id);
  // UX-22: Cmd/Ctrl-click toggles a row, Shift-click ranges from the last anchor; a plain click keeps
  // opening the chat (below) and drops any selection.
  const handleRowClick=(id:string,event:React.MouseEvent)=>{
    if(isToggleClick(event,IS_MAC)){setSelection(previous=>toggleSelection(previous,id));return;}
    // No anchor yet: the range starts at the chat that is open (the row the user is "on").
    if(event.shiftKey){setSelection(previous=>selectRange(withFallbackAnchor(previous,state.activeChatId,visible),visible,id));return;}
    setSelection(previous=>previous.selected.size?clearSelection():previous);
  };
  const selectedChats=()=>snapshot.chats.filter(chat=>selection.selected.has(chat.id));
  // One confirmation for the batch (when any selected chat is still working), every archive awaited, one summary notice.
  const archiveTargets=()=>selectedChats().filter(chat=>!chat.archived);
  const archiveSelected=()=>{const busyChats=archiveTargets().filter(chat=>isChatRunning(chat)||!!snapshot.attention?.chats.some(item=>item.chatId===chat.id));if(busyChats.length)setConfirmArchive(busyChats.length);else void runArchive();};
  const runArchive=async()=>{
    const ids=archiveTargets().map(chat=>chat.id);
    setConfirmArchive(0);
    if(!ids.length){setSelection(clearSelection());return;}
    setArchiveBusy(true);
    const result=await archiveChats(ids,id=>invoke('chat.update',{id,archived:true,acknowledgeRunning:true}));
    setArchiveBusy(false);
    const summary=archiveSummary(result);
    if(summary.kind==='success')notifySuccess(summary.message,{label:'Undo',run:()=>{for(const id of result.archived)void updateChat(id,{archived:false},{undoable:false});}});
    else pushNotice(summary.message,{kind:'error'});
    setSelection(previous=>keepSelected(previous,result.failed.map(item=>item.id)));
  };
  const markSelectedRead=()=>{for(const chat of selectedChats())if(chat.unread)void markUnread(chat,false);setSelection(clearSelection());};
  const moveSelectedToProject=(projectId:string|null)=>{for(const chat of selectedChats())void updateChat(chat.id,{projectId});setSelection(clearSelection());};
  // Partial failure (a running chat refuses delete) keeps exactly the chats that were not deleted selected, so the
  // user sees what is left and can stop or retry them; the rest leave the selection.
  const deleteSelected=async()=>{
    setDeleteBusy(true);
    const failed:string[]=[];
    for(const chat of selectedChats()){try{await invoke('chat.delete',{id:chat.id});}catch(error){failed.push(chat.id);notifyError(error);}}
    setDeleteBusy(false);setConfirmDelete(false);setSelection(previous=>keepSelected(previous,failed));
  };
  const context:RowContext={now,stop:rovingStop(visible,focusedRow,state.activeChatId),onFocusRow:setFocusedRow,selection,selectionMode:selection.selected.size>0,onRowClick:handleRowClick};
  const onNavKey=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement;
    // ⌥⇧↑/⌥⇧↓: the keyboard equivalent of dragging a pinned chat or a folder one step (same result as the drop).
    if(event.altKey&&event.shiftKey&&!event.metaKey&&!event.ctrlKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
      const direction=event.key==='ArrowUp'?'up':'down';
      const folderId=target.classList?.contains('nav-disclosure')?target.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId:undefined;
      const chatId=target.classList?.contains('chat-row-main')?target.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId:undefined;
      const next=folderId?stepReorder(folderIds,folderId,direction):chatId&&pinIds.includes(chatId)?stepReorder(pinIds,chatId,direction):null;
      if(folderId||(chatId&&pinIds.includes(chatId))){event.preventDefault();event.stopPropagation();}
      if(next&&folderId)void reorderFolders(next).then(()=>requestAnimationFrame(()=>Array.from(nav.current?.querySelectorAll<HTMLElement>('[data-folder-id]')??[]).find(element=>element.dataset.folderId===folderId)?.querySelector<HTMLElement>('.nav-disclosure')?.focus()));
      else if(next&&chatId)void reorderPins(next).then(()=>requestAnimationFrame(()=>focusRow(chatId)));
      return;
    }
    // Selection keys act only while focus is in this list: Esc clears, Cmd/Ctrl+A selects every visible chat, Space toggles the row.
    const action=selectionKeyAction(event,IS_MAC);
    const typing=target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.isContentEditable;
    if(action==='clear'){if(selection.selected.size){event.preventDefault();event.stopPropagation();setSelection(clearSelection());}return;}
    if(action==='all'&&!typing){event.preventDefault();setSelection(selectAll(visible,target.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId));return;}
    if(!target.classList?.contains('chat-row-main'))return;
    const id=target.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId??null;
    if(action==='toggle'&&id){event.preventDefault();setSelection(previous=>toggleSelection(previous,id));return;}
    if(event.shiftKey&&id&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
      const extended=extendSelectionByArrow(selection,visible,id,event.key==='ArrowDown'?'down':'up');
      event.preventDefault();setSelection(extended.state);focusRow(extended.focus);
      return;
    }
    const next=rovingTarget(visible,id,event.key);
    if(!next)return;
    event.preventDefault();focusRow(next);
  };
  const activeFolder=draft.open?undefined:snapshot.folders.find(folder=>folder.id===newChatTarget(activeChat(),snapshot).folderId);

  return (
    <div className="nav-inner">
      <CloneRepositorySheet/>
      <button type="button" className="nav-brand" aria-label="Muster home" title="Home" onClick={newChatHere}>
        <BrandMark size={18} />
        <span className="nav-brand-word">Muster</span>
      </button>
      <div className="nav-toolbar">
        <button type="button" className={`tool-button${draft.open?' is-active':''}`} title={activeFolder?`New chat in ${activeFolder.name} (⌘N)`:'New chat (⌘N)'} aria-keyshortcuts="Meta+N Control+N" aria-current={draft.open?'page':undefined} onClick={newChatHere}>
          <SquarePen size={15} /><span>New chat</span>
        </button>
        <button type="button" className="tool-button" title="Search chats (⌘K)" aria-keyshortcuts="Meta+K Control+K" onClick={() => openSpotlightSearch()} aria-haspopup="dialog">
          <Search size={15} /><span>Search chats</span>
        </button>
        <button type="button" className="tool-button" title="Memory for the current folder" onClick={() => openMemoryScreen(activeChat()?.folderId)}><Brain size={15}/><span>Memory</span></button>
        <button type="button" className={`tool-button${state.screen==='automations'?' is-active':''}`} title="Scheduled and file-triggered agent runs" aria-current={state.screen==='automations'?'page':undefined} onClick={openAutomationsScreen}><CalendarClock size={15}/><span>Automations</span>{runningAutomations>0&&<span className="nav-tool-count" aria-label={`${runningAutomations} running`}>{runningAutomations}</span>}</button>
      </div>
      <div className="visually-hidden" aria-live="polite">{selection.selected.size>0?`${plural(selection.selected.size, 'chat')} selected`:''}</div>
      {selection.selected.size>0 && (
        <div className="nav-selection-bar" role="toolbar" aria-label="Selected chats" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setSelection(clearSelection());}}}>
          <span className="nav-selection-count">{selection.selected.size} selected</span>
          <span className="nav-selection-actions">
            <Tip label="Mark read"><button type="button" className="icon-button" aria-label="Mark selected chats as read" onClick={markSelectedRead}><MailOpen size={14}/></button></Tip>
            <Menu.Root>
              <Tip label="Move to project"><Menu.Trigger className="icon-button" aria-label="Move selected chats to a project"><FolderKanban size={14}/></Menu.Trigger></Tip>
              <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={4} className="chat-menu-positioner"><Menu.Popup className="ui-menu chat-menu">
                <Menu.Item onClick={()=>moveSelectedToProject(null)}>No project</Menu.Item>
                {snapshot.projects.map(project=><Menu.Item key={project.id} onClick={()=>moveSelectedToProject(project.id)}>{project.name}</Menu.Item>)}
              </Menu.Popup></Menu.Positioner></Menu.Portal>
            </Menu.Root>
            <Tip label="Archive"><button type="button" className="icon-button" aria-label="Archive selected chats" onClick={archiveSelected}><Archive size={14}/></button></Tip>
            <Tip label="Delete"><button type="button" className="icon-button nav-selection-danger" aria-label="Delete selected chats" onClick={()=>setConfirmDelete(true)}><Trash2 size={14}/></button></Tip>
          </span>
          <Tip label="Clear selection" shortcut="Esc"><button type="button" className="icon-button" aria-label="Clear selection" onClick={()=>setSelection(clearSelection())}><X size={14}/></button></Tip>
        </div>
      )}
      <SnoozeSheet/>
      <ShareSheet/>
      <FolderDefaultModelSheet/>
      {autoscroll.rejected&&<div className="nav-drag-hint" role="status">{autoscroll.rejected}</div>}
      <div className="nav-scroll" ref={nav} tabIndex={-1} onKeyDown={onNavKey} onKeyUp={event=>{if(event.key===' '&&(event.target as HTMLElement).classList?.contains('chat-row-main'))event.preventDefault();}} onDragOver={autoscroll.onDragOver} onDragLeave={autoscroll.onDragLeave}>
        {pinned.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('pinned')} onOpenChange={value=>toggleGroup('pinned',value)}>
            <GroupHead title="Pinned" tooltip="Pinned · drag or ⌥⇧↑/⌥⇧↓ to reorder" chats={pinned} icon={<Pin size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel" {...pinDrag.containerProps}>{rows(pinned,context,pinDrag.itemProps)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
        <section className="nav-block" aria-label="Folders" {...folderDrag.containerProps}>
          <div className="nav-heading">
            <span className="nav-heading-title">Folders</span>
            <Menu.Root><Tip label={`Sort chats: ${sort==='recent'?'Recent activity':sort==='name'?'Name':'Active first'}`}><Menu.Trigger className="icon-button nav-sort-trigger" aria-label="Sort chats"><ArrowDownWideNarrow size={14}/></Menu.Trigger></Tip><Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="chat-menu-positioner"><Menu.Popup className="ui-menu chat-menu"><Menu.RadioGroup value={sort} onValueChange={value=>{if(isChatSort(value))setSort(value);}}>{([['recent','Recent activity'],['name','Name'],['active','Active first']] as const).map(([value,label])=><Menu.RadioItem key={value} value={value}><span className="chat-sort-check">{sort===value&&<Check size={14}/>}</span><span>{label}</span></Menu.RadioItem>)}</Menu.RadioGroup></Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>
            <Tip label="Clone repository…"><button type="button" className="icon-button" aria-label="Clone repository" onClick={() => openCloneSheet()}><GitBranch size={14} strokeWidth={1.75} /></button></Tip>
            <Tip label="Add folder"><button type="button" className="icon-button" aria-label="Add folder" onClick={() => void addFolderToDraft()}><Plus size={15} strokeWidth={1.75} /></button></Tip>
          </div>
          {folderGroups.map(({folder,gid,chats}) => {
            const mark=folderDrag.itemProps(folder.id),dropMark={'data-drop':mark['data-drop'],'data-dragging':mark['data-dragging']};
            return (
            <Collapsible.Root className="nav-section" key={folder.id} open={isOpen(gid)} onOpenChange={value=>toggleGroup(gid,value)} data-folder-id={folder.id} {...dropMark}>
              {renamingFolder===folder.id
                ? <FolderRename folder={folder} done={()=>setRenamingFolder(null)}/>
                : <GroupHead nested draggable={folderIds.length>1} title={folder.name} tooltip={folder.missing?`${folder.path} — not found`:`${folder.path}${folderIds.length>1?' · drag or ⌥⇧↑/⌥⇧↓ to reorder':''}`} chats={chats} className={folder.missing?'is-missing':''} icon={folder.missing?<TriangleAlert size={13}/>:<FolderOpen size={13}/>} onContextMenu={event=>{event.preventDefault();void folderMenu(folder,event.clientX,event.clientY);}}>
                {folder.missing
                  ? <button type="button" className="nav-relink" title={`${folder.path} was moved or deleted. Choose its new location.`} onClick={()=>void folderMenu(folder,0,0,'relink')}>Relink</button>
                  : <>
                    <Tip label="Browse files"><button type="button" className="icon-button" aria-label={`Browse files in ${folder.name}`} onClick={() => openFilesTab(folder.id, folder.name)}><Files size={13} /></button></Tip>
                    <Tip label={`New chat in ${folder.name}`}><button type="button" className="icon-button" aria-label={`New chat in ${folder.name}`} onClick={() => openNewChat({folderId:folder.id})}><SquarePen size={13} /></button></Tip>
                  </>}
                <Tip label="Folder actions"><button type="button" className="icon-button" aria-label={`Actions for folder ${folder.name}`} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();void folderMenu(folder,rect.left,rect.bottom+4);}}><MoreHorizontal size={14}/></button></Tip>
              </GroupHead>}
              <Collapsible.Panel className="nav-group-panel is-nested-chats">{chats.length?rows(chats,context):<p className="nav-folder-empty">No chats</p>/* QA-#7 */}</Collapsible.Panel>
            </Collapsible.Root>
          );})}
          {snapshot.folders.length === 0 && (
            <div className="nav-empty">
              <p>No folders yet.</p>
              <p>Add a folder to start a chat grounded in real files.</p>
            </div>
          )}
        </section>
        <section className="nav-block" aria-label="Projects">
          <div className="nav-heading">
            <span className="nav-heading-title">Projects</span>
            <span className="nav-heading-actions"><Tip label="Open projects"><button type="button" className="icon-button" aria-label="Open projects" onClick={openProjectsScreen}><LayoutGrid size={14}/></button></Tip><Tip label="New project"><button type="button" className="icon-button" aria-label="New project" onClick={()=>requestNewProject(openProjectsScreen)}><Plus size={15} strokeWidth={1.75}/></button></Tip></span>
          </div>
          {projectGroups.map(({project,gid,chats}) => (
            <Collapsible.Root className="nav-section" key={project.id} open={isOpen(gid)} onOpenChange={value=>toggleGroup(gid,value)}>
              <PreviewCard.Root><PreviewCard.Trigger render={<div/>} className="nav-project-hover" delay={600} closeDelay={120}>
              <GroupHead nested title={project.name} tooltip={project.name} chats={chats} icon={<Layers size={13}/>} onContextMenu={event=>{event.preventDefault();void openProjectMenu(project.id,event.clientX,event.clientY,mode=>setProjectEdit({id:project.id,mode}));}}>
                <Tip label={project.folderIds.length ? `New chat in ${project.name}` : 'Add a folder in Projects'}><button
                  type="button"
                  className="icon-button"
                  aria-label={`New chat in project ${project.name}`}
                 
                  onClick={() => project.folderIds.length
                    ? openNewChat({folderId:project.primaryFolderId ?? project.folderIds[0], projectId:project.id})
                    : openProject(project.id)}
                >
                  <SquarePen size={13} />
                </button></Tip>
              </GroupHead>
              </PreviewCard.Trigger>
              <PreviewCard.Portal><PreviewCard.Positioner side="right" align="start" sideOffset={8} className="chat-preview-positioner"><PreviewCard.Popup className="chat-preview-card project-hover-card">
                <ProjectHoverCard project={project} folders={snapshot.folders} chats={snapshot.chats.filter(chat=>chat.projectId===project.id)} onOpen={()=>openProject(project.id)} onEdit={()=>setProjectEdit({id:project.id,mode:'edit'})}/>
              </PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal></PreviewCard.Root>
              <Collapsible.Panel className="nav-group-panel is-nested-chats">{chats.length?rows(chats,context):<p className="nav-folder-empty">No chats</p>/* QA-#7 */}</Collapsible.Panel>
            </Collapsible.Root>
          ))}
          {snapshot.projects.length === 0 && <button type="button" className="nav-quiet-row" onClick={()=>requestNewProject(openProjectsScreen)}><Layers size={14} aria-hidden="true"/><span>Create a project</span></button>}
        </section>
        {orphanChats.length === 0 && (
          <section className="nav-block" aria-label="Chats">
            <div className="nav-heading"><span className="nav-heading-title">Chats</span></div>
            <button type="button" className="nav-quiet-row" onClick={()=>openNewChat({})}><MessageCircle size={14} aria-hidden="true"/><span>Start a chat without a folder</span></button>
          </section>
        )}
        {orphanChats.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('chats')} onOpenChange={value=>toggleGroup('chats',value)}>
            <GroupHead title="Chats" chats={orphanChats} icon={<MessageCircle size={12}/>}>
              <Tip label="New chat without a folder"><button type="button" className="icon-button" aria-label="New chat without a folder" onClick={()=>openNewChat({})}><SquarePen size={13}/></button></Tip>
            </GroupHead>
            <Collapsible.Panel className="nav-group-panel">{rows(orphanChats,context)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
        {snoozedChats.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('snoozed')} onOpenChange={value=>toggleGroup('snoozed',value)}>
            <GroupHead title={`Snoozed (${snoozedChats.length})`} tooltip="Snoozed chats come back unread, with one notification, when they wake" chats={snoozedChats} icon={<AlarmClock size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel">{rows(snoozedChats,context)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
        {archived.length > 0 && (
          <Collapsible.Root className="nav-section" open={archivedOpen} onOpenChange={setShowArchived}>
            <GroupHead title={`Archived (${archived.length})`} icon={<Archive size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel">{rows(archived,context)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
      </div>
      <footer className="nav-footer">
        <button type="button" className="nav-footer-action" onClick={()=>openAppSettings('general')}>
          <SlidersHorizontal size={15} aria-hidden="true"/><span>Settings</span>
        </button>
        <button type="button" className="nav-footer-action" onClick={()=>openPluginsScreen('skills')}>
          <Blocks size={15} aria-hidden="true"/><span>Skills &amp; plugins</span>
        </button>
        <button type="button" className="nav-footer-action" onClick={openProvidersTab}>
          <Settings2 size={15} aria-hidden="true"/><span>Accounts &amp; providers</span>
        </button>
      </footer>
      {editedProject&&<EditProjectDialog project={toProjectDetails(editedProject)} allFolders={snapshot.folders} open={projectEdit?.mode==='edit'||projectEdit?.mode==='rename'} selectName={projectEdit?.mode==='rename'}
        onClose={()=>setProjectEdit(current=>current?.mode==='archive'?current:null)} onSaved={project=>notifySuccess(`Saved ${project.name}.`)} onArchive={()=>setProjectEdit({id:editedProject.id,mode:'archive'})}/>}
      {editedProject&&<ConfirmProjectAction project={toProjectDetails(editedProject)} action={projectEdit?.mode==='archive'?'archive':null} onClose={()=>setProjectEdit(null)} onArchived={project=>notifySuccess(`Archived ${project.name}. Task runs are paused.`)} onDeleted={()=>setProjectEdit(null)}/>}
      <ConfirmSheet
        open={confirmDelete}
        title={`Permanently delete ${plural(selection.selected.size, 'chat')}?`}
        description="Their messages, queued follow-ups and attached files are removed from this Mac. Files in the folder are not touched. This cannot be undone."
        busy={deleteBusy}
        testId="sidebar-delete-confirm"
        onCancel={()=>{if(!deleteBusy)setConfirmDelete(false);}}
        actions={[
          {label:'Cancel', run:()=>setConfirmDelete(false)},
          {label:'Delete', primary:true, run:()=>void deleteSelected()},
        ]}
      />
      <ConfirmSheet
        open={confirmArchive>0}
        title={`Archive ${plural(archiveTargets().length, 'chat')}?`}
        description={`${plural(confirmArchive, 'selected chat')} ${confirmArchive===1?'is':'are'} still working. ${ARCHIVE_RUNNING_WARNING} Stop a run first if you want it to end.`}
        busy={archiveBusy}
        testId="sidebar-archive-confirm"
        onCancel={()=>{if(!archiveBusy)setConfirmArchive(0);}}
        actions={[
          {label:'Cancel', run:()=>setConfirmArchive(0)},
          {label:'Archive', primary:true, run:()=>void runArchive()},
        ]}
      />
    </div>
  );
}
