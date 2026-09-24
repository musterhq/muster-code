import {ArrowUp,Brain,Check,ChevronDown,CircleAlert,Cpu,FolderKanban,FolderOpen,Goal as GoalGlyph,Layers,Lightbulb,LoaderCircle,MessageCircle,Mic,PenLine,Plus,Search,SquareTerminal} from 'lucide-react';
import {Menu} from '@base-ui/react/menu';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ComputerCaptureSource} from '../../shared/domains/computer-protocol';
import {type FileEntry,type PluginEntry,type Project,type ReasoningEffort,type SkillEntry} from '../../shared/protocol';
import {invoke,subscribe} from '../bridge';
import {resolveTarget,targetOptions,type TargetOption} from '../chatNavigation';
import {readFileBase64,stageAttachment} from '../composerBridge';
import {focusComposer} from '../focus';
import {closeNewChat,getNewChatDraft,setNewChatTarget,setNewChatText,submitNewChat,unusedChatIn,useNewChatDraft} from '../newChatDraft';
import {loadPlugins,loadProviders,loadSkills,notifyError,notifySuccess,openPluginsScreen,selectChat,sendMessage,setComposerDraft,type SendExtras} from '../store';
import {useStore} from '../useStore';
import {AttachmentStrip,type ComposerAttachment} from './AttachmentStrip';
import {baseFileName,buildAddRows,buildMentionRows,buildSlashRows,ComposerMenuList,firstRow,nextRow,pluginLabel,skillUsable,type MenuRow} from './ComposerMenu';
import {ChipMirror} from './ComposerTokens';
import {seedChatEffort,useMentionEntries} from './Composer';
import {CaptureSourcePicker,type CaptureResult} from './CaptureSourcePicker';
import {accessibilityAttachment} from '../captureRegion';
import {ACCESS_OPTIONS,FullAccessConfirm} from './FullAccessConfirm';
import {attachmentKey,attachmentName,imageBlindModel,imageBlindWarning,chipPayload,chipToken,COMPOSER_COMMANDS,EFFORT_LABELS,findTokenRanges,formatBytes,insertToken,MAX_ATTACHMENT_BYTES,MAX_ATTACHMENTS,readFolderAccess,readMentionQuery,readSlashQuery,saveFolderAccess,scoreItem,setFullAccessSkip,skipsFullAccessConfirm,SKILL_RECORDER_PROMPT,type ComposerAccess,type ComposerChip,type ComposerCommandId} from './composerMenus';
import {ProjectPicker} from './ProjectPicker';
import {openImportConversations} from './ImportConversations';
import {SKETCH_FILE_NAME,SketchPad,type SketchStroke} from './SketchPad';
import './composer.css';
import './sidebar-disclosure.css';
import './new-chat.css';
import {sendWithCheckoutGuard} from './ParallelRunGuard';
import {ConnectModelPrompt,useNoProvider} from './SetupGuide';
import {Tip} from './Tooltip';
import {MenuPopup} from './AppMenu';

const KIND_ICON={none:MessageCircle,folder:FolderOpen,project:Layers} as const;
/** Same access options (and Full-access confirmation) an in-chat Composer uses, so the toolbars match. */
const ACCESS=ACCESS_OPTIONS;
/** Minimal Web Speech dictation, same shape Composer uses; kept local since Composer's type is not exported. */
type Recognition={continuous:boolean;interimResults:boolean;lang:string;start():void;stop():void;abort():void;
  onresult:((event:{resultIndex:number;results:ArrayLike<ArrayLike<{transcript:string}>&{isFinal:boolean}>})=>void)|null;onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null};
// CMP-14: no speech service inside Electron; hide the mic rather than show a control that always fails.
const speechRecognition=():(new()=>Recognition)|undefined=>typeof window==='undefined'||/\bElectron\//.test(navigator.userAgent??'')?undefined:(window as unknown as Record<string,new()=>Recognition>).SpeechRecognition??(window as unknown as Record<string,new()=>Recognition>).webkitSpeechRecognition;
const MENU_LIMIT=8;
/** Last-resort mirror of runtime/provider.ts's MODEL/providerId, used only until (or if) `chat.defaults` answers. */
const RUNTIME_DEFAULT={providerId:'hybrow',id:'claude/claude-fable-5'} as const;
/** The `/` commands that make sense before a chat exists (mirrors Composer's COMMAND_ICONS, not exported there). */
const COMMAND_ICONS:Partial<Record<ComposerCommandId,typeof Lightbulb>>={plan:Lightbulb,goal:GoalGlyph,project:FolderKanban,sketch:PenLine,model:Cpu,reasoning:Brain,access:CircleAlert};
/** Small duplicates of Composer's own pure row helpers (not exported there) so the draft's / and @ menus match. */

function TargetMenu({current,options,variant}:{current:TargetOption;options:TargetOption[];variant:'title'|'chip'}):React.ReactElement {
  const Icon=KIND_ICON[current.kind];
  const groups=[['','none'],['Folders','folder'],['Projects','project']] as const;
  // F4: controlled, so choosing a target always closes the picker (Base UI radio items stay open by default).
  const [open,setOpen]=useState(false);
  return <Menu.Root open={open} onOpenChange={setOpen}>
    <Menu.Trigger className={variant==='title'?'new-chat-target-title':'new-chat-target-chip'} aria-label={`Start in: ${current.label}`} title={current.detail?`${current.label} · ${current.detail}`:current.label}>
      {variant==='chip'&&<Icon size={13} aria-hidden="true"/>}<span>{current.label}</span>{variant==='chip'&&<ChevronDown size={12} aria-hidden="true"/>}
    </Menu.Trigger>
    <Menu.Portal><Menu.Positioner side={variant==='title'?'bottom':'top'} align="center" sideOffset={6} className="chat-menu-positioner"><Menu.Popup className="ui-menu chat-menu new-chat-target-menu">
      <Menu.RadioGroup value={current.key} onValueChange={value=>{const next=options.find(option=>option.key===value);if(next)setNewChatTarget(next.target);setOpen(false);}}>
        {groups.map(([label,kind])=>{
          const rows=options.filter(option=>option.kind===kind);
          if(!rows.length)return null;
          return <Menu.Group key={kind}>
            {label&&<Menu.GroupLabel className="new-chat-target-group">{label}</Menu.GroupLabel>}
            {rows.map(option=>{const RowIcon=KIND_ICON[option.kind];return <Menu.RadioItem key={option.key} value={option.key} title={option.detail} closeOnClick>
              <RowIcon aria-hidden="true"/><span className="new-chat-target-label"><span>{option.label}</span>{option.detail&&<small>{option.detail}</small>}</span><span className="chat-sort-check">{current.key===option.key&&<Check size={14}/>}</span>
            </Menu.RadioItem>;})}
          </Menu.Group>;
        })}
      </Menu.RadioGroup>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

/** Codex-style draft chat: nothing is persisted until the first message is sent. */
export function NewChatScreen():React.ReactElement {
  const state=useStore();
  const draft=useNewChatDraft();
  const input=useRef<HTMLTextAreaElement>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const mirror=useRef<HTMLDivElement>(null);
  const composerRoot=useRef<HTMLDivElement>(null);
  const options=targetOptions(state.snapshot);
  const current=resolveTarget(draft.target,state.snapshot);
  const modEnter=state.settings['general.sendKey']==='mod-enter';
  const mounted=useRef(true);
  /** CHAT-17: the (chat, message) a background start last tried, so a retry reuses its requestId. */
  const backgroundAttempt=useRef<{key:string;chatId:string;requestId:string}|null>(null);
  useEffect(()=>()=>{mounted.current=false;},[]);

  // Draft-only toolbar state: applied to the chat once it exists (on submit), since none exists yet.
  const [toolMenu,setToolMenu]=useState<'plus'|'access'|'model'|null>(null);
  const [access,setAccessState]=useState<ComposerAccess>(()=>readFolderAccess(current.target.folderId)??'workspace');
  const accessTouched=useRef(false);
  const [fullConfirm,setFullConfirm]=useState(false);
  const cancelFull=useRef<HTMLButtonElement>(null);
  const [chosenModel,setChosenModel]=useState<{providerId:string;id:string}|null>(null);
  const [resolvedDefault,setResolvedDefault]=useState<{providerId:string;id:string;effort?:ReasoningEffort}|null>(null);
  const [effort,setEffort]=useState<ReasoningEffort|null>(null);
  const [attachments,setAttachments]=useState<ComposerAttachment[]>([]);
  const [starting,setStarting]=useState(false);
  const [startError,setStartError]=useState('');
  const [listening,setListening]=useState(false);
  const recognition=useRef<Recognition|null>(null);
  // Same features an in-chat composer has: Plan mode and a Goal are deferred (applied right after the chat is
  // created, before the first send); a Sketch attaches immediately, same as any other file.
  const [planMode,setPlanMode]=useState(false);
  const [goalOpen,setGoalOpen]=useState(false);
  const [goalText,setGoalText]=useState('');
  const [sketchOpen,setSketchOpen]=useState(false);
  const [sketchEditing,setSketchEditing]=useState<string|undefined>(undefined);
  const sketches=useRef(new Map<string,SketchStroke[]>());
  // / and @: the same chip mechanics Composer uses (token in the text, chip drawn over it, id travels structurally).
  const [chips,setChips]=useState<ComposerChip[]>([]);
  const [caret,setCaret]=useState(0);
  const [selection,setSelection]=useState<{start:number;end:number}>({start:0,end:0});
  const [popoverActive,setPopoverActive]=useState(0);
  const [dismissed,setDismissed]=useState<string|null>(null);
  const [plusQuery,setPlusQuery]=useState('');
  const [projectPickerOpen,setProjectPickerOpen]=useState(false);
  const [captureSources,setCaptureSources]=useState<ComputerCaptureSource[]>([]);
  const [capturePickerOpen,setCapturePickerOpen]=useState(false);

  const noProvider=useNoProvider();
  const [connectAsk,setConnectAsk]=useState(false);
  const busy=draft.busy||starting;
  const canSend=!!draft.text.trim()&&!busy;
  const providers=(state.providers.value??[]).filter(provider=>provider.available);
  const modelOptions=providers.flatMap(provider=>provider.models.map(model=>({...model,provider:provider.name,providerId:provider.id})));
  // F9: with nothing picked, show exactly what chat.create will resolve for this target (user/project default,
  // else the runtime default) — never the first list entry, which the created chat would not use.
  const createdModel=chosenModel??resolvedDefault??RUNTIME_DEFAULT;
  const displayModel=modelOptions.find(model=>model.providerId===createdModel.providerId&&model.id===createdModel.id);
  const modelName=displayModel?.name??(state.providers.phase==='loading'?'Loading…':createdModel.id.split('/').pop()||'No model');
  const modelEfforts=displayModel?.efforts??[];
  const defaultEffort:ReasoningEffort=(!chosenModel&&resolvedDefault?.effort)||displayModel?.defaultEffort||'medium';
  const accessOption=ACCESS.find(option=>option.id===access)!;
  const Speech=speechRecognition();
  const hasExtras=access!=='workspace'||Boolean(chosenModel)||Boolean(effort)||attachments.length>0||planMode||Boolean(goalText.trim())||chips.length>0;

  const skills=state.skills.value??[];
  const plugins=state.plugins.value??[];
  const folderId=current.target.folderId;
  const folderPath=state.snapshot?.folders.find(folder=>folder.id===folderId)?.path;
  const text=draft.text;
  const vocabulary={commands:[],skills:skills.filter(skillUsable).map(skill=>({name:skill.name,id:skill.id,label:skill.displayName??skill.name})),plugins:plugins.map(plugin=>({name:plugin.name,id:plugin.id,label:pluginLabel(plugin)}))};
  const tokenRanges=findTokenRanges(text,chips,vocabulary);
  const slash=popoverBlockedFor(dismissed,text)?null:readSlashQuery(text,caret);
  const mention=slash||popoverBlockedFor(dismissed,text)?null:readMentionQuery(text,caret);
  const mentionEntries=useMentionEntries(folderId,mention?.query??'',Boolean(mention));

  useEffect(()=>{if(state.providers.phase==='idle')void loadProviders();},[state.providers.phase]);
  const projectId=current.target.projectId;
  // F9: chat.defaults is exactly what chat.create resolves (Project → user default → built-in); re-asked when the
  // target or the user's default-model setting changes, or once providers load (a gone provider is skipped).
  const userDefaultModel=JSON.stringify(state.settings['general.defaultModel']??null);
  const providersReady=state.providers.phase;
  const [defaultsRevision,setDefaultsRevision]=useState(0);
  useEffect(()=>subscribe(event=>{if(event.type==='chatDefaultsChanged'&&(!event.projectId||event.projectId===projectId))setDefaultsRevision(value=>value+1);}),[projectId]);
  useEffect(()=>{
    let live=true;
    invoke('chat.defaults',{...(folderId?{folderId}:{}),...(projectId?{projectId}:{})})
      .then(defaults=>{if(live)setResolvedDefault({providerId:defaults.providerId,id:defaults.model,...(defaults.effort?{effort:defaults.effort}:{})});})
      .catch(()=>{if(live)setResolvedDefault(null);});
    return ()=>{live=false;};
  },[folderId,projectId,userDefaultModel,providersReady,defaultsRevision]);
  useLayoutEffect(()=>{
    const field=input.current;if(!field)return;
    field.style.height='0px';
    const height=Math.max(52,field.scrollHeight);
    field.style.height=`${Math.min(200,height)}px`;field.style.overflowY=height>200?'auto':'hidden';
  },[draft.text]);
  // A folder picked (or preselected) before the user touches Access seeds it from that folder's last choice.
  useEffect(()=>{
    if(accessTouched.current)return;
    const remembered=readFolderAccess(folderId);
    if(remembered)setAccessState(remembered);
  },[folderId]);
  // Outside click or Escape closes whichever toolbar popover is open (mirrors Composer's popovers).
  useEffect(()=>{
    if(!toolMenu)return;
    const inside=(target:EventTarget|null)=>Boolean((target as Element)?.closest?.('.composer-plus,.composer-access,.composer-access-menu,.composer-model-button,.composer-popover'));
    const onPointer=(event:PointerEvent)=>{if(!inside(event.target))setToolMenu(null);};
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setToolMenu(null);}};
    document.addEventListener('pointerdown',onPointer);document.addEventListener('keydown',onKey);
    return ()=>{document.removeEventListener('pointerdown',onPointer);document.removeEventListener('keydown',onKey);};
  },[toolMenu]);
  useEffect(()=>()=>{recognition.current?.abort();recognition.current=null;},[]);
  useEffect(()=>{setPopoverActive(0);},[slash?.query,slash?.start,mention?.query,mention?.start]);

  const addFiles=(files:File[])=>{
    setAttachments(current=>{
      const next=[...current];let duplicate=0;
      for(const file of files){
        const key=attachmentKey(file);
        if(next.some(item=>item.key===key)){duplicate++;continue;}
        if(file.size>MAX_ATTACHMENT_BYTES){notifyError(`${file.name||'File'} is ${formatBytes(file.size)}; attachments are limited to 20 MB each.`);continue;}
        if(next.length>=MAX_ATTACHMENTS){notifyError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);break;}
        const kind=file.type.startsWith('image/')?'image' as const:'file' as const;
        const previewUrl=kind==='image'&&typeof URL.createObjectURL==='function'?URL.createObjectURL(file):undefined;
        next.push({localId:crypto.randomUUID(),key,name:attachmentName(file,kind),mime:file.type||'application/octet-stream',size:file.size,kind,state:'ready',previewUrl,file});
      }
      if(duplicate&&next.length===current.length)notifyError(duplicate===1?'That file is already attached':'Those files are already attached');
      return next;
    });
  };
  const removeAttachment=(localId:string)=>{
    setAttachments(current=>{
      const item=current.find(entry=>entry.localId===localId);
      if(item?.previewUrl?.startsWith('blob:'))URL.revokeObjectURL(item.previewUrl);
      sketches.current.delete(localId);
      return current.filter(entry=>entry.localId!==localId);
    });
  };
  const chooseAccess=(id:ComposerAccess)=>{
    accessTouched.current=true;
    // CS-B7-3: a folder where the user chose "Don't ask again" takes Full access without the confirmation.
    if(id==='full'&&!skipsFullAccessConfirm(folderId)){setToolMenu(null);setFullConfirm(true);return;}
    setAccessState(id);setToolMenu(null);
  };
  const toggleDictation=()=>{
    if(recognition.current){recognition.current.stop();return;}
    if(!Speech)return;
    let engine:Recognition;
    try{engine=new Speech();}catch(cause){notifyError(cause);return;}
    engine.continuous=true;engine.interimResults=true;engine.lang=navigator.language||'en-US';
    engine.onresult=event=>{
      let final='';
      for(let index=event.resultIndex;index<event.results.length;index++){const result=event.results[index];if(result.isFinal)final+=result[0].transcript;}
      if(final.trim()){
        const text=getNewChatDraft().text;
        const lead=text&&!/\s$/.test(text)?' ':'';
        setNewChatText(`${text}${lead}${final.trim()}`);
      }
    };
    engine.onerror=event=>{if(event.error!=='aborted')notifyError(`Dictation stopped (${event.error})`);};
    engine.onend=()=>{if(recognition.current===engine){recognition.current=null;setListening(false);}};
    recognition.current=engine;
    try{engine.start();setListening(true);}catch(cause){recognition.current=null;notifyError(cause);}
  };

  /* / and @ chip mechanics — same shape as Composer's (insertToken replaces the query, a chip is remembered). */
  const replaceRange=(start:number,end:number,insert:string,caretAfter=start+insert.length)=>{
    setNewChatText(`${text.slice(0,start)}${insert}${text.slice(end)}`);
    setCaret(caretAfter);setSelection({start:caretAfter,end:caretAfter});
    requestAnimationFrame(()=>{if(input.current){input.current.focus();input.current.setSelectionRange(caretAfter,caretAfter);}});
  };
  const insertChip=(chip:ComposerChip,range:{start:number;end:number})=>{
    const start=Math.min(range.start,text.length),end=Math.min(Math.max(range.end,start),text.length);
    const next=insertToken(text,chip.token,start,end);
    setToolMenu(null);setDismissed(null);
    setChips(current=>[...current.filter(entry=>entry.token!==chip.token),chip]);
    replaceRange(next.start,next.end,next.insert,next.caret);
  };
  const skillChip=(skill:SkillEntry):ComposerChip=>({token:chipToken('skill',skill.name),kind:'skill',id:skill.id,label:skill.displayName??skill.name});
  const pluginChip=(plugin:PluginEntry):ComposerChip=>({token:chipToken('plugin',plugin.name),kind:'plugin',id:plugin.id,label:pluginLabel(plugin)});

  /* / and @ and + rows all come from ComposerMenu.tsx's shared builders — the exact same ones an
   * in-chat Composer uses — so the draft can never drift back out of parity with it (CHAT-05/23). */
  const DRAFT_COMMANDS=new Set<ComposerCommandId>(['plan','goal','project','sketch','model','reasoning','access']);
  const commandRows:MenuRow[]=!slash?[]:COMPOSER_COMMANDS.filter(command=>DRAFT_COMMANDS.has(command.id)).flatMap(command=>{
    const score=scoreItem(command.command,`${command.description} ${command.keywords}`,slash.query);if(score===null)return [];
    const Icon=COMMAND_ICONS[command.id]!;
    return [{key:`command:${command.id}`,section:'Commands',label:`/${command.command}`,mono:true,description:command.id==='plan'?(planMode?'Turn plan mode off':'Turn plan mode on'):command.description,
      icon:<span className={`composer-command-tile is-${command.id}`}><Icon size={12}/></span>,score,
      run:()=>{
        replaceRange(slash.start,caret,'');
        if(command.id==='plan')setPlanMode(value=>!value);
        else if(command.id==='goal')setGoalOpen(true);
        else if(command.id==='project')setProjectPickerOpen(true);
        else if(command.id==='sketch')openSketch();
        else if(command.id==='model'||command.id==='reasoning')setToolMenu('model');
        else if(command.id==='access')setToolMenu('access');
      }}];
  });
  const slashRows:MenuRow[]=!slash?[]:buildSlashRows(slash.query,skills,skill=>insertChip(skillChip(skill),{start:slash.start,end:caret}),commandRows);
  const mentionRange=mention?{start:mention.start,end:caret}:undefined;
  const mentionRows:MenuRow[]=!mention?[]:buildMentionRows({
    query:mention.query,files:mentionEntries.entries??[],plugins,
    onFile:entry=>insertChip({token:chipToken(entry.kind==='directory'?'folder':'file',entry.path),kind:entry.kind==='directory'?'folder':'file',id:entry.path,label:baseFileName(entry.path)},mentionRange!),
    onPlugin:plugin=>insertChip(pluginChip(plugin),mentionRange!),
  });
  const caretRows=slash?slashRows:mention?mentionRows:[];
  const caretActive=caretRows[popoverActive]?.disabled?firstRow(caretRows):Math.min(popoverActive,caretRows.length-1);
  const caretPopoverId=slash?'new-chat-slash-options':'new-chat-mention-options';

  /* + menu ------------------------------------------------------------------ */
  const openSketch=(editing?:string)=>{setToolMenu(null);setSketchEditing(editing);setSketchOpen(true);};
  const attachSketch=(file:File,strokes:SketchStroke[],editing?:string)=>{
    if(editing)removeAttachment(editing);
    setAttachments(current=>{
      const kind='image' as const;
      const previewUrl=typeof URL.createObjectURL==='function'?URL.createObjectURL(file):undefined;
      const localId=crypto.randomUUID();
      sketches.current.set(localId,strokes);
      return [...current,{localId,key:attachmentKey(file),name:file.name,mime:file.type||'image/png',size:file.size,kind,state:'ready',previewUrl,file}];
    });
  };
  const openGoal=()=>{setToolMenu(null);setGoalOpen(true);};
  // "Capture window" needs no chat id (the capture itself is OS-level); its screenshot is staged the exact
  // same way any other file attachment is here — locally, as a real chat only exists once the draft sends.
  const captureWindow=async()=>{
    setToolMenu(null);
    if(attachments.length>=MAX_ATTACHMENTS){notifyError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);return;}
    try{
      const sources=await invoke('computer.captureSources',undefined);
      if(!sources.length){notifyError('No windows or screens available to capture');return;}
      setCaptureSources(sources);setCapturePickerOpen(true);
    }catch(cause){notifyError(cause);}
  };
  // CUA-08: the picker returns the capture (whole or a region) and, when permitted, the window's text.
  const chooseCapture=(capture:CaptureResult)=>{
    setCapturePickerOpen(false);
    try{
      const bytes=Uint8Array.from(atob(capture.dataUrl.slice(capture.dataUrl.indexOf(',')+1)),char=>char.charCodeAt(0));
      const files=[new File([bytes],capture.name,{type:'image/png',lastModified:Date.now()})];
      if(capture.accessibility){const text=accessibilityAttachment(capture.name,capture.accessibility);files.push(new File([text.text],text.name,{type:'text/plain',lastModified:Date.now()}));}
      addFiles(files);
    }catch(cause){notifyError(cause);}
  };
  // "Work in a project" retargets the draft itself (its own target picker already covers a plain folder/project
  // pick); "Record a skill" seeds the draft's own text, since the draft already *is* the new chat it would start.
  const chooseProjectTarget=(project:Project|null)=>{
    setProjectPickerOpen(false);
    if(!project){setNewChatTarget({folderId:current.target.folderId});return;}
    const primary=project.primaryFolderId&&project.folderIds.includes(project.primaryFolderId)?project.primaryFolderId:project.folderIds[0];
    if(primary)setNewChatTarget({folderId:primary,projectId:project.id});
  };
  const projects=state.snapshot?.projects??[];
  const plusRows:MenuRow[]=toolMenu!=='plus'?[]:buildAddRows({
    query:plusQuery,
    onFiles:()=>{setToolMenu(null);fileInput.current?.click();},
    onCapture:()=>void captureWindow(),
    onProject:()=>{setToolMenu(null);setProjectPickerOpen(true);},
    goalDescription:goalText.trim()?'Edit the goal this chat pursues':'Set a goal to keep pursuing',onGoal:openGoal,
    planMode,onPlan:()=>{setToolMenu(null);setPlanMode(value=>!value);},
    onRecordSkill:()=>{setToolMenu(null);setNewChatText(SKILL_RECORDER_PROMPT);},
    // "Save as skill" drafts a skill from THIS conversation's approach; the draft has no conversation yet
    // (nothing sent), so it is left out here and appears once this becomes a real, running chat.
    onSketch:()=>openSketch(),
    backgroundDescription:text.trim()?'Start this as a new chat and stay here · ⌥Enter':'Write a message first · ⌥Enter',backgroundDisabled:!text.trim()||busy,
    onBackground:()=>{setToolMenu(null);void handleSubmit(true);},
    onMention:()=>{setToolMenu(null);const at=input.current?.selectionStart??text.length;const lead=at>0&&!/\s/.test(text[at-1])?' ':'';replaceRange(at,at,`${lead}@`);},
    plugins,onPlugin:plugin=>insertChip(pluginChip(plugin),{start:text.length,end:text.length}),onBrowsePlugins:()=>{setToolMenu(null);openPluginsScreen('plugins');},
    skills,onSkill:skill=>insertChip(skillChip(skill),{start:text.length,end:text.length}),
  });
  const plusIndex=plusRows[popoverActive]?.disabled?firstRow(plusRows):Math.min(popoverActive,plusRows.length-1);
  const onPlusKeyDown=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    if(event.nativeEvent.isComposing)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=nextRow(plusRows,plusIndex,event.key==='ArrowDown'?1:-1);if(next>=0)setPopoverActive(next);}
    else if(event.key==='Enter'){event.preventDefault();const row=plusRows[plusIndex];if(row&&!row.disabled)row.run();}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setToolMenu(null);setPlusQuery('');}
    else if(event.key==='Backspace'){event.preventDefault();setPlusQuery(value=>value.slice(0,-1));setPopoverActive(0);}
    else if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();setPlusQuery(value=>value+event.key);setPopoverActive(0);}
  };

  /** With no toolbar overrides this behaves exactly as before; overrides need the chat to exist first. */
  const handleSubmit=async(background=false)=>{
    const text=draft.text.trim();
    if(!text||busy)return;
    // R9: with no model connected, point at the connect actions instead of creating a chat that cannot run.
    if(noProvider){setConnectAsk(true);return;}
    const target=resolveTarget(draft.target,state.snapshot).target;
    // CHAT-17: retrying the same background message reuses the chat (and requestId) its failed attempt created. If that
    // send really landed (only the reply was lost), the runtime answers the same requestId with the original run.
    const attemptKey=`${target.folderId??''}\0${target.projectId??''}\0${text}`;
    const prior=background&&backgroundAttempt.current?.key===attemptKey&&state.snapshot?.chats.some(chat=>chat.id===backgroundAttempt.current!.chatId&&!chat.archived)?backgroundAttempt.current:null;
    let chatId=prior?.chatId??unusedChatIn(target);
    // F9: a reused (unused) chat may predate the current default; it must still start on the model the draft shows.
    const reused=chatId?state.snapshot?.chats.find(chat=>chat.id===chatId):undefined;
    const modelToApply=chosenModel??(reused&&resolvedDefault&&(reused.model!==resolvedDefault.id||(reused.providerId??'hybrow')!==resolvedDefault.providerId)?resolvedDefault:null);
    // The effort the draft shows (explicit pick, else the resolved default's) is seeded into the new chat's composer.
    const seedEffort=effort??(!chosenModel?resolvedDefault?.effort:undefined);
    if(!hasExtras&&!modelToApply&&!background&&!seedEffort){void submitNewChat();return;}
    setStartError('');setStarting(true);
    if(!chatId){
      try{
        chatId=(await invoke('chat.create',{...(target.folderId?{folderId:target.folderId}:{}),...(target.projectId?{projectId:target.projectId}:{})})).id;
      }catch(cause){
        setStarting(false);setStartError(cause instanceof Error?cause.message:String(cause));notifyError(cause);return;
      }
    }
    const id=chatId!;
    if(background&&prior?.chatId!==id)backgroundAttempt.current={key:attemptKey,chatId:id,requestId:crypto.randomUUID()};
    const tasks:Promise<unknown>[]=[];
    // CHAT-08: Full access must carry acknowledgeFullAccess, and a rejection must reach the user, not vanish.
    if(access!=='workspace')tasks.push(invoke('chat.setPermissionMode',{id,permissionMode:access,...(access==='full'?{acknowledgeFullAccess:true}:{})}).catch(cause=>{notifyError(cause);throw cause;}));
    if(modelToApply)tasks.push(invoke('chat.selectProvider',{id,providerId:modelToApply.providerId,model:modelToApply.id}).catch(cause=>{notifyError(cause);throw cause;}));
    if(planMode)tasks.push(invoke('chat.update',{id,mode:'plan'}).catch(cause=>{notifyError(cause);throw cause;}));
    if(tasks.length){const settled=await Promise.allSettled(tasks);for(const result of settled)if(result.status==='rejected'){setStarting(false);setStartError(result.reason instanceof Error?result.reason.message:String(result.reason));return;}}
    if(target.folderId)saveFolderAccess(target.folderId,access);
    if(goalText.trim())void invoke('goals.set',{chatId:id,text:goalText.trim()}).catch(cause=>notifyError(cause));
    const attachmentIds:string[]=[];
    for(const item of attachments){
      if(!item.file)continue;
      try{
        const ref=await stageAttachment({chatId:id,name:item.name,mime:item.mime,dataBase64:await readFileBase64(item.file)});
        if(ref?.id)attachmentIds.push(ref.id);
      }catch(cause){notifyError(cause);}
    }
    const revokePreviews=()=>{for(const item of attachments)if(item.previewUrl?.startsWith('blob:'))URL.revokeObjectURL(item.previewUrl);};
    if(!background)revokePreviews();
    const {skillIds,pluginIds}=chipPayload(text,chips,vocabulary);
    const extras:SendExtras={...(effort?{effort}:{}),...(skillIds.length?{skillIds}:{}),...(pluginIds.length?{pluginIds}:{})};
    if(seedEffort)seedChatEffort(id,seedEffort);
    const reset=()=>{if(mounted.current){setAttachments([]);setAccessState(readFolderAccess(folderId)??'workspace');setChosenModel(null);setEffort(null);setPlanMode(false);setGoalText('');setChips([]);setStarting(false);}};
    if(background){
      // CHAT-17 "Start in background": the chat starts and a fresh draft stays open with the same folder, model,
      // access, effort and plan choices. One requestId per (chat, message) so a retry after a lost reply replays
      // the original run instead of starting a second one; a failure puts the exact input back.
      const saved={raw:draft.text,chips,goal:goalText,attachments};
      // Re-staged attachments get new ids, so a retry carrying files is a new request (the runtime would refuse the old id).
      if(attachmentIds.length&&backgroundAttempt.current)backgroundAttempt.current={...backgroundAttempt.current,requestId:crypto.randomUUID()};
      const requestId=backgroundAttempt.current?.requestId??crypto.randomUUID();
      setNewChatText('');if(mounted.current){setAttachments([]);setGoalText('');setChips([]);setStarting(false);}
      try{
        await invoke('chat.send',{id,text,requestId,...extras,...(attachmentIds.length?{attachmentIds}:{})});
        backgroundAttempt.current=null;revokePreviews();
        notifySuccess('Started in a new chat',{label:'Open',run:()=>void selectChat(id)});
      }catch(cause){
        // Only an untouched draft gets the input back: anything typed since the failure wins.
        if(!getNewChatDraft().text){setNewChatText(saved.raw);if(mounted.current){setChips(saved.chips);setGoalText(saved.goal);setAttachments(saved.attachments);}}
        if(mounted.current)setStartError(cause instanceof Error?cause.message:String(cause));
        notifyError(cause);
      }
      focusComposer();return;
    }
    setComposerDraft(id,text);
    setNewChatText('');closeNewChat();
    void selectChat(id);
    // CHAT-06: a second run in a checkout where another chat is working asks first (worktree / queue / run / cancel).
    await sendWithCheckoutGuard(id,{hasAttachments:attachmentIds.length>0},target=>sendMessage(target,text,extras,target===id?attachmentIds:[]));
    reset();
    focusComposer();
  };
  const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key==='Escape'&&draft.open&&!draft.text&&!slash&&!mention){event.preventDefault();closeNewChat();return;}
    if(caretRows.length&&(slash||mention)){
      if(event.key==='Escape'){event.preventDefault();setDismissed(text);return;}
      if((event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();const next=nextRow(caretRows,caretActive,event.key==='ArrowDown'?1:-1);if(next>=0)setPopoverActive(next);return;}
      if((event.key==='Enter'||event.key==='Tab')&&caretRows[caretActive]&&!caretRows[caretActive].disabled){event.preventDefault();if(!event.repeat)caretRows[caretActive].run();return;}
    }
    if(event.key==='Enter'&&event.altKey&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!event.repeat)void handleSubmit(true);return;}
    if(event.key!=='Enter'||event.shiftKey||event.altKey||event.nativeEvent.isComposing)return;
    if(modEnter&&!(event.metaKey||event.ctrlKey))return;
    event.preventDefault();
    if(!event.repeat)void handleSubmit();
  };
  return <div className="chat new-chat" data-testid="new-chat">
    <header className="chat-head"><span className="chat-head-title">New chat</span></header>
    <div className="chat-empty chat-empty-timeline new-chat-hero">
      <SquareTerminal size={40} strokeWidth={1.25} className="new-chat-mark" aria-hidden="true"/>
      <h2 className="chat-empty-prompt">What should we build{current.kind!=='none'&&<> in <TargetMenu current={current} options={options} variant="title"/></>}?</h2>
      {/* W6-E: on first run (no chats yet) bring existing Codex / Claude Code sessions in from here, not only from Settings or ⌘K. */}
      {state.snapshot&&state.snapshot.chats.length===0&&<button type="button" className="new-chat-import" data-testid="new-chat-import" onClick={()=>openImportConversations()}>Import conversations from Codex or Claude Code…</button>}
    </div>
    {noProvider&&<ConnectModelPrompt emphasis={connectAsk}/>}
    <div ref={composerRoot} className="composer new-chat-composer" aria-busy={busy}>
      {attachments.length>0&&<div className="composer-attachments"><AttachmentStrip chatId={undefined} items={attachments} onRemove={removeAttachment} onRetry={()=>{}}
        onOpen={item=>{if(!sketches.current.has(item.localId))return false;openSketch(item.localId);return true;}}/></div>}
      {attachments.some(item=>item.kind==='image')&&imageBlindModel(providers,createdModel.providerId,createdModel.id)&&<p className="composer-image-warning" role="status" data-testid="image-blind-warning">{imageBlindWarning(imageBlindModel(providers,createdModel.providerId,createdModel.id)!)}</p>}
      <div className={`composer-field${tokenRanges.length?' has-chips':''}`}>
        {tokenRanges.length>0&&<ChipMirror text={text} ranges={tokenRanges} selected={selection} plugins={plugins} mirror={mirror}/>}
        <textarea ref={input} autoFocus className="composer-input" aria-label="Message" rows={1} value={draft.text} readOnly={busy}
          aria-keyshortcuts={modEnter?'Meta+Enter':'Enter'} placeholder={listening?'Listening…':planMode?'Describe your task to generate a plan…':'Do anything'}
          aria-controls={slash||mention?caretPopoverId:undefined} aria-expanded={slash||mention?true:undefined}
          onChange={event=>{setCaret(event.target.selectionStart);setSelection({start:event.target.selectionStart,end:event.target.selectionEnd});setDismissed(null);setNewChatText(event.target.value);}}
          onSelect={event=>{const {selectionStart:start,selectionEnd:end}=event.currentTarget;setCaret(start===end?start:-1);setSelection({start,end});}}
          onScroll={event=>{if(mirror.current)mirror.current.scrollTop=event.currentTarget.scrollTop;}}
          onKeyDown={onKeyDown}/>
      </div>
      <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event=>{addFiles(Array.from(event.target.files??[]));event.target.value='';}}/>
      {(slash||mention)&&<div data-testid="new-chat-popover" className={`composer-popover composer-caret-popover is-${slash?'slash':'mention'}`}>
        <ComposerMenuList id={caretPopoverId} label={slash?'Skills':'Mention'} rows={caretRows} active={caretActive} onActive={setPopoverActive}
          empty={slash?(state.skills.phase==='loading'?'Loading skills…':'No matching skill'):mentionEntries.error?mentionEntries.error:mentionEntries.loading?'Searching…':'No matching files, folders or plugins.'}/>
      </div>}
      {toolMenu==='plus'&&<div data-testid="composer-popover" className="composer-popover composer-plus-popover" role="dialog" aria-label="Add files and more" tabIndex={-1} onKeyDown={onPlusKeyDown}>
        {plusQuery&&<p className="composer-plus-filter"><Search size={12} aria-hidden="true"/>{plusQuery}</p>}
        <ComposerMenuList id="new-chat-plus-options" label="Add" rows={plusRows} active={plusIndex} onActive={setPopoverActive}/>
      </div>}
      {projectPickerOpen&&<ProjectPicker projects={projects} currentId={current.target.projectId} moves={true}
        onChoose={project=>chooseProjectTarget(project)} onCreate={()=>{setProjectPickerOpen(false);}} onClose={()=>setProjectPickerOpen(false)}/>}
      {capturePickerOpen&&<CaptureSourcePicker sources={captureSources} onCapture={chooseCapture} onClose={()=>setCapturePickerOpen(false)}/>}
      {toolMenu==='model'&&<div className="composer-popover composer-model-popover" role="dialog" aria-label="Select model">
        <div className="composer-model-pane">
          <div className="composer-model-list" role="listbox" aria-label="Available models">
            {state.providers.phase==='loading'&&!modelOptions.length?<p className="composer-model-note" role="status">Loading models…</p>
              :!modelOptions.length?<p className="composer-model-note">No runnable models reported.</p>
              :providers.map(provider=>{
                const models=modelOptions.filter(model=>model.providerId===provider.id);
                if(!models.length)return null;
                return <React.Fragment key={provider.id}>
                  <div className="composer-menu-section" role="presentation">{provider.name}</div>
                  {models.map(model=>{
                    const selected=createdModel.providerId===model.providerId&&createdModel.id===model.id;
                    return <div className="composer-model-row" key={`${model.providerId}:${model.id}`}>
                      <button type="button" role="option" aria-selected={selected} onClick={()=>{setChosenModel({providerId:model.providerId,id:model.id});setEffort(null);}}>
                        <span className="composer-row-label">{model.name}</span>{selected&&<Check size={13} aria-hidden="true"/>}
                      </button>
                    </div>;
                  })}
                </React.Fragment>;
              })}
          </div>
          {modelEfforts.length>0&&<div className="composer-effort">
            <span className="composer-effort-title">Reasoning</span>
            <div className="composer-effort-segments" role="radiogroup" aria-label="Reasoning effort">
              {modelEfforts.map(value=><button key={value} type="button" role="radio" aria-checked={(effort??defaultEffort)===value} onClick={()=>setEffort(value)}>{EFFORT_LABELS[value]}</button>)}
            </div>
          </div>}
        </div>
      </div>}
      {goalOpen&&<div className="composer-popover new-chat-goal-popover" role="dialog" aria-label="Goal">
        <p className="composer-menu-note">Muster keeps working when the chat is idle until the goal is achieved.</p>
        <textarea data-testid="new-chat-goal" autoFocus placeholder="Describe your goal, define measurable outcomes for best results" value={goalText}
          onChange={event=>setGoalText(event.target.value)}
          onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();setGoalOpen(false);focusComposer();}else if(event.key==='Escape'){event.preventDefault();setGoalOpen(false);}}}/>
        <div className="composer-plus-filter"><button type="button" onClick={()=>{setGoalText('');setGoalOpen(false);}}>Clear</button><button type="button" className="is-primary" onClick={()=>{setGoalOpen(false);focusComposer();}}>Done</button></div>
      </div>}
      <div className="composer-options" role="toolbar" aria-label="Message options">
        <div className="composer-toolbar-left">
          <Tip label="Add files and more"><button type="button" className="composer-plus" aria-label="Add files and more" aria-haspopup="menu" aria-expanded={toolMenu==='plus'} disabled={busy}
            onClick={()=>{setToolMenu(current=>current==='plus'?null:'plus');setPopoverActive(0);setPlusQuery('');void loadSkills();void loadPlugins();}}><Plus size={16}/></button></Tip>
          <Menu.Root open={toolMenu==='access'} onOpenChange={open=>setToolMenu(current=>open?'access':current==='access'?null:current)}>
            <Menu.Trigger className={`composer-access is-${access}`} aria-label={`Access: ${accessOption.label}`} title="Change permissions" disabled={busy}><accessOption.Icon size={14} aria-hidden="true"/><span className="composer-access-label">{accessOption.label}</span></Menu.Trigger>
            <MenuPopup side="top" align="start" sideOffset={6} className="composer-access-menu" aria-label="Permissions">
              <Menu.RadioGroup value={access}>{ACCESS.map(option=><Menu.RadioItem key={option.id} value={option.id} render={<button type="button"/>} nativeButton closeOnClick className={`is-${option.id}`} onClick={()=>chooseAccess(option.id)}>
                <option.Icon size={15} aria-hidden="true"/><span><strong>{option.label}</strong><small>{option.description}</small></span>{access===option.id&&<Check size={13} aria-hidden="true"/>}
              </Menu.RadioItem>)}</Menu.RadioGroup>
            </MenuPopup>
          </Menu.Root>
          <TargetMenu current={current} options={options} variant="chip"/>
          {planMode&&<span className="composer-plan-chip"><Lightbulb size={12} aria-hidden="true"/>Plan mode</span>}
        </div>
        <div className="composer-toolbar-right">
          <div className="composer-model-picker">
            <button type="button" className="composer-model-button" aria-label={`Model: ${modelName}`} aria-haspopup="dialog" aria-expanded={toolMenu==='model'} disabled={busy||(!modelOptions.length&&state.providers.phase!=='loading')}
              title="Select model" onClick={()=>setToolMenu(current=>current==='model'?null:'model')}>
              <span className="composer-model">{modelName}</span>{modelEfforts.length>0&&<span className="composer-effort-label">{EFFORT_LABELS[effort??defaultEffort]}</span>}<ChevronDown size={12} aria-hidden="true"/>
            </button>
          </div>
          {Speech&&<Tip label={listening?'Stop dictation':'Dictate'}><button type="button" className={`composer-mic${listening?' is-listening':''}`} aria-label={listening?'Stop dictation':'Dictate'} aria-pressed={listening} disabled={busy} onClick={toggleDictation}><Mic size={15}/></button></Tip>}
          <Tip label={busy?'Starting chat…':modEnter?'Start chat (⌘Enter) · Start in background and stay here (⌥Enter)':'Start chat (Enter) · Start in background and stay here (⌥Enter)'}><button type="button" className="composer-send" aria-label={busy?'Starting chat':modEnter?'Send (⌘Enter)':'Send (Enter)'} disabled={!canSend} onClick={()=>void handleSubmit()}>
            {busy?<LoaderCircle size={15} className="composer-spin"/>:<ArrowUp size={15} strokeWidth={2.25}/>}
          </button></Tip>
        </div>
      </div>
      {(draft.error||startError)&&<div className="composer-error" role="alert">Chat could not start: {draft.error||startError} Your message is kept.</div>}
    </div>
    <SketchPad open={sketchOpen} initial={sketchEditing?sketches.current.get(sketchEditing):undefined} onClose={()=>{setSketchOpen(false);requestAnimationFrame(()=>input.current?.focus());}}
      onAttach={(file,strokes)=>attachSketch(file,strokes,sketchEditing)}/>
    <FullAccessConfirm open={fullConfirm} folderName={state.snapshot?.folders.find(folder=>folder.id===folderId)?.name} cancelRef={cancelFull} canRemember={Boolean(folderId)}
      onOpenChange={setFullConfirm} onConfirm={remember=>{setAccessState('full');setFullConfirm(false);if(remember)setFullAccessSkip(folderId,true);}}/>
  </div>;
}
/** A menu already dismissed for this exact text stays closed until the text changes (mirrors Composer). */
function popoverBlockedFor(dismissed:string|null,text:string):boolean { return dismissed!==null&&dismissed===text; }
