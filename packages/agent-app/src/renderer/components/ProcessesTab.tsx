import React,{useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {EarlierOutput} from './EarlierOutput';
import {Check,ChevronRight,CircleCheck,CircleDot,CircleHelp,CircleX,Copy,Eraser,FlaskConical,Globe,Hammer,MessageSquarePlus,PanelBottom,PanelRight,Pencil,Play,Plus,RefreshCw,Search,Square,SquareTerminal,Trash2,Wrench,X} from 'lucide-react';
import {Collapsible as Disclosure} from '@base-ui/react/collapsible';
import {invoke,subscribe} from '../bridge';
import {useStore,useStoreSelector} from '../useStore';
import {openBrowserTab,openTab,selectChat,stopChat} from '../store';
import {copyText} from '../clipboard';
import {addComposerContext,type ContextChipSource} from '../composerContext';
import {selectionWithin} from './ToolOutput';
import {agentCommands,portURL,refreshListeningPorts,setTerminalDock,setTerminalPaneView,subscribeTerminalDock,subscribeTerminalPaneView,terminalDock,terminalPaneView,useListeningPorts,type AgentCommand,type TerminalPaneView} from '../processSummary';
import {clearTerminal,disposeTerminal,openTerminalFind,reconcileTerminal,TerminalView,terminalText} from './TerminalView';
import {useDisclosure} from './useDisclosure';
import {TerminalAgentAccess} from './TerminalAgentAccess';
import {isActiveProcess,mergeProcessSnapshot,type ListeningPort,type ProcessPurpose,type ProcessSnapshot,type TerminalInfo} from '../../shared/process-protocol';
import type {FileRunAction} from '../../shared/domains/files-protocol';
import './processes-tab.css';
import './process-saved-actions.css';
import { ResourceState } from './ResourceState';
import {Tip} from './Tooltip';

const PURPOSES=[{id:'command',label:'Command',Icon:SquareTerminal},{id:'test',label:'Test',Icon:FlaskConical},{id:'build',label:'Build',Icon:Hammer},{id:'server',label:'Server',Icon:Globe},{id:'task',label:'Task',Icon:Wrench}] as const;
const STATUS={starting:'Starting',running:'Running',stopping:'Stopping',exited:'Finished',failed:'Failed',stopped:'Stopped',lost:'Connection lost'} as const;
function retained(items:ProcessSnapshot[]):ProcessSnapshot[]{
  const active=items.filter(item=>isActiveProcess(item.status));
  return [...active,...items.filter(item=>!isActiveProcess(item.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,32)];
}
/** Output kept for a chat excerpt: the newest lines, so a long log cannot flood the message. */
export function outputTail(text:string,lines=400):string{const all=text.replace(/\s+$/,'').split('\n');return all.slice(-lines).join('\n');}
/**
 * RUN-06 "Add to chat": the selected output (or its newest lines) goes to the composer as a
 * terminal chip naming the terminal, command or run and the time. Without a composer it is copied.
 */
function useAddToChat():[''|'added'|'copied',(label:string,text:string,source:ContextChipSource)=>void]{
  const [state,setState]=useState<''|'added'|'copied'>(''),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const done=(value:'added'|'copied')=>{setState(value);clearTimeout(timer.current);timer.current=setTimeout(()=>setState(''),1500);};
  return [state,(label,text,source)=>{
    const excerpt=outputTail(text);if(!excerpt.trim())return;
    if(addComposerContext({type:'terminal',label,text:excerpt,source:{...source,at:new Date().toISOString()}}))done('added');
    else void copyText(excerpt).then(()=>done('copied'),()=>{});
  }];
}
const addLabel=(state:''|'added'|'copied')=>state==='added'?'Added':state==='copied'?'Copied':'Add to chat';

function ProcessRow({session,ports=[],onUpdate}:{session:ProcessSnapshot;ports?:ListeningPort[];onUpdate:(session:ProcessSnapshot)=>void}) {
  const [open,setOpen]=useDisclosure(JSON.stringify(['process',session.chatId,session.processId]),true);
  const [error,setError]=useState(''),[stopping,setStopping]=useState(false);
  const output=useRef<HTMLPreElement>(null),follow=useRef(true),pending=useRef(false),alive=useRef(true);
  const [added,addToChat]=useAddToChat();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useLayoutEffect(()=>{if(follow.current&&output.current)output.current.scrollTop=output.current.scrollHeight;},[session.output,open]);
  const Icon=PURPOSES.find(purpose=>purpose.id===session.purpose)?.Icon??SquareTerminal;
  const StatusIcon=session.status==='lost'?CircleHelp:session.status==='failed'||session.status==='stopped'?CircleX:session.status==='exited'?CircleCheck:CircleDot;
  const stop=async()=>{
    if(pending.current)return;pending.current=true;setStopping(true);setError('');
    try{const next=await invoke('processes.stop',{chatId:session.chatId,processId:session.processId});if(alive.current)onUpdate(next);}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;if(alive.current)setStopping(false);}
  };
  return <article className={`process-row is-${session.status}`} aria-label={`${session.label}, ${STATUS[session.status]}`}>
    <Disclosure.Root open={open} onOpenChange={setOpen}>
      <div className="process-row-header"><Disclosure.Trigger className="process-disclosure-trigger"><Icon size={15} aria-hidden="true"/><strong>{session.label}</strong><Owner who={session.owner??'user'}/><span className="process-state"><StatusIcon size={12} aria-hidden="true"/>{session.queued?'Queued':STATUS[session.status]}</span><ChevronRight className="process-chevron" size={12} aria-hidden="true"/></Disclosure.Trigger>
        <PortChips ports={ports}/>
        {isActiveProcess(session.status)&&<button className="process-stop" disabled={stopping||(session.status==='stopping'&&!session.error)} aria-label={`Stop ${session.label}`} title="Stop this owned command and its process group" onClick={()=>void stop()}><Square size={11}/><span>{stopping?'Stopping…':session.status==='stopping'?session.error?'Retry Stop':'Stopping…':'Stop'}</span></button>}
      </div>
      <Disclosure.Panel className="activity-disclosure process-panel"><div className="process-details">
        {session.command&&<code className="process-command">{session.command}{session.args?.length?` ${session.args.map(argument=>JSON.stringify(argument)).join(' ')}`:''}</code>}
        <div className="process-metadata"><span>{PURPOSES.find(purpose=>purpose.id===session.purpose)?.label??'Command'}</span><time dateTime={session.startedAt}>{new Date(session.startedAt).toLocaleTimeString()}</time>{session.exitCode!==null&&<span>Exit {session.exitCode}</span>}{session.signal&&<span>{session.signal}</span>}</div>
        {session.output&&<div className="agent-command-actions"><button type="button" onMouseDown={event=>event.preventDefault()} onClick={()=>{const picked=selectionWithin(output.current);addToChat(`${session.label}${picked.trim()?' · selection':''}`,picked.trim()?picked:session.output,{kind:'process',chatId:session.chatId,processId:session.processId,title:session.label});}}>{added?<Check size={12}/>:<MessageSquarePlus size={12}/>}{addLabel(added)}</button></div>}
        {session.truncated&&<EarlierOutput chatId={session.chatId} processId={session.processId} tail={session.output}/>}
        {session.queued&&<p className="process-note" role="status">Queued: {session.queued}</p>}
        {session.output?<pre ref={output} className="process-output" tabIndex={0} aria-label={`Output from ${session.label}`} onScroll={()=>{const node=output.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<24;}}>{session.output}</pre>:<p className="process-note">{isActiveProcess(session.status)?'Waiting for command output…':'No output was retained.'}</p>}
        {session.error&&<p className="process-error">{session.error}</p>}
        {error&&<p className="process-error" role="alert">{error}</p>}
      </div></Disclosure.Panel>
    </Disclosure.Root>
  </article>;
}

/** WRK-18: saved per-folder named commands (Run/Test/Dev, or custom), stored in files domain settings.
 * The first run of a saved action confirms the exact command; if it is already running, re-running just reveals it. */
function SavedActions({folderId,command,canStart,onRun,onFill}:{folderId?:string;command:string;canStart:boolean;onRun:(action:FileRunAction)=>void;onFill:(action:FileRunAction)=>void}) {
  const [actions,setActions]=useState<FileRunAction[]>([]);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    if(!folderId){setActions([]);return;}
    let live=true;
    void invoke('files.runActions.list',{folderId}).then(value=>{if(live)setActions(value.actions);},()=>{if(live)setActions([]);});
    return()=>{live=false;};
  },[folderId]);
  const persist=async(next:FileRunAction[])=>{
    if(!folderId)return;
    setActions(next);
    await invoke('files.runActions.set',{folderId,actions:next}).catch(()=>{});
  };
  const save=async()=>{
    if(!folderId||!command.trim()||saving)return;
    const label=window.prompt('Name this command (for example Run, Test, Dev):','');
    if(!label||!label.trim())return;
    setSaving(true);
    try{await persist([...actions.filter(a=>a.label!==label.trim()),{id:crypto.randomUUID(),label:label.trim(),command}]);}
    finally{setSaving(false);}
  };
  const remove=(action:FileRunAction)=>void persist(actions.filter(a=>a.id!==action.id));
  if(!folderId)return null;
  return <div className="process-saved-actions" role="group" aria-label="Saved commands">
    {actions.map(action=><span key={action.id} className="process-saved-action">
      <button type="button" disabled={!canStart} title={action.command} onClick={()=>onRun(action)}>{action.label}</button>
      <Tip label="Fill into the command box"><button type="button" className="process-saved-action-edit" aria-label={`Edit ${action.label} before running`} onClick={()=>onFill(action)}><Pencil size={11}/></button></Tip>
      <button type="button" className="process-saved-action-remove" aria-label={`Remove saved command ${action.label}`} onClick={()=>remove(action)}><Trash2 size={11}/></button>
    </span>)}
    <button type="button" className="process-saved-action-add" disabled={!command.trim()||saving} title="Save the current command" onClick={()=>void save()}><Plus size={11}/>Save as…</button>
  </div>;
}

/** Owned non-interactive commands of a conversation (the attach lease stream). Unmounting releases only its event lease. */
function useOwnedCommands(chatId:string,active:boolean) {
  const [sessions,setSessions]=useState<ProcessSnapshot[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const epoch=useRef(0),report=useRef<(session:ProcessSnapshot)=>void>(()=>{});
  useEffect(()=>{
    if(!active)return;
    let disposed=false;const leaseId=crypto.randomUUID();const version=++epoch.current;
    setSessions([]);setLoading(true);setError('');
    const apply=(session:ProcessSnapshot)=>{if(!disposed&&session.chatId===chatId)setSessions(current=>retained(mergeProcessSnapshot(current,session)));};report.current=apply;
    // Subscribe first. Full reports are merged by generation/sequence when the
    // attachment snapshot resolves, so neither ordering loses or repeats output.
    const unsubscribe=subscribe(event=>{if(event.type==='processSession'&&event.leaseId===leaseId)apply(event.session);});
    void invoke('processes.attach',{chatId,leaseId}).then(snapshot=>{
      if(disposed){void invoke('processes.detach',{chatId,leaseId}).catch(()=>{});return;}
      setSessions(current=>retained(snapshot.sessions.reduce((rows,session)=>mergeProcessSnapshot(rows,session),current)));setLoading(false);
    }).catch(cause=>{if(!disposed){setError(cause instanceof Error?cause.message:String(cause));setLoading(false);}});
    return()=>{disposed=true;if(epoch.current===version)epoch.current++;report.current=()=>{};unsubscribe();void invoke('processes.detach',{chatId,leaseId}).catch(()=>{});};
  },[chatId,active,attempt]);
  return {sessions,loading,error,epoch,retry:()=>setAttempt(value=>value+1),report:(session:ProcessSnapshot)=>report.current(session)};
}
type OwnedCommands=ReturnType<typeof useOwnedCommands>;

/** "Run a command": a non-interactive command with captured output (Full access only). */
function CommandLauncher({chatId,active,commands}:{chatId:string;active:boolean;commands:OwnedCommands}) {
  const app=useStore(),chat=app.snapshot?.chats.find(chat=>chat.id===chatId);
  const [command,setCommand]=useState(''),[label,setLabel]=useState(''),[purpose,setPurpose]=useState<ProcessPurpose>('command'),[starting,setStarting]=useState(false),[startError,setStartError]=useState('');
  const pending=useRef(false),request=useRef<{signature:string;id:string}|null>(null);
  const draft=useRef({command,label,purpose});draft.current={command,label,purpose};
  const full=chat?.mode==='agent'&&chat.permissionMode==='full';
  const busy=chat?.status==='running'||chat?.status==='stopping'||!!app.sending[chatId]||chat?.recovery?.kind==='recovery-needed';
  const canStart=active&&!!chat&&full&&!busy&&!chat.archived&&!starting;
  useEffect(()=>{setCommand('');setLabel('');setPurpose('command');setStartError('');request.current=null;},[chatId]);
  const start=async(event:React.FormEvent)=>{
    event.preventDefault();if(!canStart||pending.current||!command.trim())return;
    const saved={command,label,purpose},signature=JSON.stringify(saved),version=commands.epoch.current;
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    pending.current=true;setStarting(true);setStartError('');
    try{
      const next=await invoke('processes.start',{chatId,requestId:request.current.id,command,label:label.trim()||undefined,purpose});
      if(version!==commands.epoch.current)return;commands.report(next);
      if(JSON.stringify(draft.current)===signature){setCommand('');setLabel('');}request.current=null;
    }catch(cause){if(version===commands.epoch.current)setStartError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;setStarting(false);}
  };
  const runSaved=(action:FileRunAction)=>{
    // "Re-running reveals the existing process": the same command already running (or finished, most recent first) just gets opened.
    const existing=commands.sessions.find(session=>session.command===action.command);
    if(existing){commands.report(existing);return;}
    if(!window.confirm(`Run “${action.label}”?\n\n${action.command}`))return;
    setCommand(action.command);setLabel(action.label);
    void invoke('processes.start',{chatId,requestId:crypto.randomUUID(),command:action.command,label:action.label,purpose}).then(next=>commands.report(next)).catch(cause=>setStartError(message(cause)));
  };
  return <div className="terminal-launcher">
    <SavedActions folderId={chat?.folderId} command={command} canStart={canStart} onRun={runSaved} onFill={action=>{setCommand(action.command);setLabel(action.label);}}/>
    <form className="process-launcher" onSubmit={event=>void start(event)}>
      <label className="process-command-label">Command<textarea aria-label="Command to run" placeholder="For example: npm test" value={command} maxLength={32768} rows={2} spellCheck={false} onChange={event=>setCommand(event.target.value)}/></label>
      <div className="process-launch-options"><input aria-label="Command label" placeholder="Label (optional)" value={label} maxLength={160} onChange={event=>setLabel(event.target.value)}/><select aria-label="Command purpose" value={purpose} onChange={event=>setPurpose(event.target.value as ProcessPurpose)}>{PURPOSES.map(purpose=><option key={purpose.id} value={purpose.id}>{purpose.label}</option>)}</select><button type="submit" disabled={!canStart||!command.trim()}><Play size={12}/>{starting?'Starting…':'Run command'}</button></div>
      {!full?<p className="process-note">Host commands require Full access in Agent mode. Workspace access cannot sandbox a host shell. Change access in the composer to enable Run.</p>:busy?<p className="process-note">Wait for the current agent attempt to finish or be reconciled before starting a host command.</p>:chat?.archived?<p className="process-note">Restore this conversation before starting a command.</p>:<p className="process-note">Full access · runs on this computer in the conversation’s workspace with captured output. Closing Terminal keeps it running; Stop ends its process group. For interactive work use a shell.</p>}
      {startError&&<p className="process-error" role="alert">{startError} Retry uses the same request identity while the command is unchanged.</p>}
    </form>
  </div>;
}

const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
function Owner({who}:{who:'user'|'agent'}) {
  return <span className={`terminal-owner is-${who}`} title={who==='agent'?'Started by the agent':'Started by you'}>{who==='agent'?'Agent':'You'}</span>;
}
function useCopied():[boolean,(text:string)=>void] {
  const [copied,setCopied]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return [copied,text=>{void copyText(text).then(()=>{setCopied(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1400);},()=>setCopied(false));}];
}
/** Stopping something the agent started needs an explicit yes (it may be mid-task). */
const confirmAgentStop=(text:string)=>typeof window.confirm==='function'&&window.confirm(text);
/** S3-E: the ports a row listens on; each opens its local URL in the in-app browser. */
function PortChips({ports}:{ports:readonly ListeningPort[]}) {
  if(!ports.length)return null;
  return <span className="terminal-ports">{ports.map(port=><button key={port.id} type="button" className="terminal-port" aria-label={`Open port ${port.port} in the browser`} title={`Open ${portURL(port)} (${port.name})`} onClick={()=>openBrowserTab(portURL(port))}><Globe size={10} aria-hidden="true"/>:{port.port}</button>)}</span>;
}

/** Menu/shortcut entry point: toggles the bottom panel when terminals live there,
 * otherwise opens the right-pane Terminal tab. */
export function toggleTerminal(chatId:string,label:string):void {
  const dock=terminalDock();
  if(dock.placement==='panel')setTerminalDock({open:!dock.open});else openTerminalTab(chatId,label,'terminals');
}
/** Open (or focus) the chat's Terminal resource, optionally revealing a kind of row. */
export function openTerminalTab(chatId:string,label:string,view?:TerminalPaneView):void {
  void label; // one resource, one name: "Terminal"
  // Shells shown in the bottom panel open there rather than in a second right-pane copy.
  if(view==='terminals'&&terminalDock().placement==='panel'){setTerminalDock({open:true});return;}
  if(view)setTerminalPaneView(chatId,view);
  openTab({id:`processes:${chatId}`,kind:'processes',chatId,title:'Terminal'});
}

const chosen=new Map<string,string>(),autoOpened=new Set<string>();
/** Interactive PTYs for a conversation. Each emulator lives in a module registry,
 * so switching tabs or placements re-attaches it instead of replaying or restarting it. */
function useTerminals(chatId:string,active:boolean,autoStart:boolean) {
  const archived=useStoreSelector(state=>!!state.snapshot?.chats.find(chat=>chat.id===chatId)?.archived);
  const [terminals,setTerminals]=useState<TerminalInfo[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[creating,setCreating]=useState(false);
  const [selected,setSelected]=useState<string|undefined>(()=>chosen.get(chatId));
  const body=useRef<HTMLDivElement>(null),pending=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const select=(id:string)=>{chosen.set(chatId,id);setSelected(id);};
  const create=async()=>{
    if(pending.current||archived)return;pending.current=true;setCreating(true);setError('');
    const box=body.current,cols=Math.max(20,Math.floor(((box?.clientWidth||640)-12)/7.25)),rows=Math.max(5,Math.floor(((box?.clientHeight||360)-8)/15));
    try{const info=await invoke('terminal.create',{chatId,cols:Math.min(cols,1000),rows:Math.min(rows,500)});if(!alive.current)return;setTerminals(rows=>[...rows,info]);select(info.id);}
    catch(cause){if(alive.current)setError(message(cause));}
    finally{pending.current=false;if(alive.current)setCreating(false);}
  };
  useEffect(()=>{
    if(!active)return;
    let disposed=false;setLoading(true);setError('');
    const unsubscribe=subscribe(event=>{if(event.type==='terminalExit')setTerminals(rows=>rows.map(row=>row.id===event.id?{...row,status:'exited',exitCode:event.code}:row));});
    const load=()=>invoke('terminal.list',{chatId}).then(value=>{
      const list=Array.isArray(value)?value:[];
      if(disposed)return list;
      setTerminals(list);for(const row of list)reconcileTerminal(row.id,row.end);return list;
    });
    void load().then(list=>{
      if(disposed)return;setLoading(false);
      // Opening Terminal on a conversation with no terminal starts one, once per window.
      if(autoStart&&!list.length&&!autoOpened.has(chatId)&&!archived){autoOpened.add(chatId);void create();}
    },cause=>{if(!disposed){setError(message(cause));setLoading(false);}});
    // A hidden window receives no events; catch up any stream that moved on meanwhile.
    const returned=()=>{if(document.visibilityState!=='hidden')void load().catch(()=>{});};
    document.addEventListener('visibilitychange',returned);window.addEventListener('focus',returned);
    return()=>{disposed=true;unsubscribe();document.removeEventListener('visibilitychange',returned);window.removeEventListener('focus',returned);};
  },[chatId,active,autoStart]);
  const current=terminals.find(row=>row.id===selected)??[...terminals].reverse().find(row=>row.status==='running')??terminals[terminals.length-1];
  const close=async(row:TerminalInfo)=>{
    setError('');
    try{
      await invoke('terminal.kill',{id:row.id});disposeTerminal(row.id);
      if(!alive.current)return;
      const index=terminals.findIndex(item=>item.id===row.id),rest=terminals.filter(item=>item.id!==row.id);
      setTerminals(rows=>rows.filter(item=>item.id!==row.id));
      if(current?.id===row.id&&rest.length)select(rest[Math.min(index,rest.length-1)].id);
    }catch(cause){if(alive.current)setError(message(cause));}
  };
  const labelOf=(row:TerminalInfo)=>`${row.title} ${terminals.findIndex(item=>item.id===row.id)+1}`;
  return {archived,terminals,loading,error,setError,creating,create,close,current,select,body,labelOf};
}
type Shells=ReturnType<typeof useTerminals>;

/** Find / add to chat / copy / clear for the selected shell. */
function ShellTools({chatId,shells}:{chatId:string;shells:Shells}) {
  const [copied,copy]=useCopied(),[added,addToChat]=useAddToChat();
  const current=shells.current;if(!current)return null;
  return <>
    <Tip label="Find" shortcut="⌘F"><button type="button" className="terminal-tool" aria-label="Find in terminal" onClick={()=>openTerminalFind(current.id)}><Search size={13}/></button></Tip>
    <Tip label="Add the selection, or recent output, to the chat"><button type="button" className="terminal-tool" aria-label={added==='added'?'Added to chat':added==='copied'?'Copied: no chat composer open':'Add to chat'} onClick={()=>{const output=terminalText(current.id);if(!output.trim()){shells.setError('No output yet to add');return;}shells.setError('');const label=shells.labelOf(current);addToChat(label,output,{kind:'terminal',chatId,terminalId:current.id,title:label,...(current.cwd?{cwd:current.cwd}:{})});}}>{added?<Check size={13}/>:<MessageSquarePlus size={13}/>}</button></Tip>
    <Tip label="Copy selection, or all output"><button type="button" className="terminal-tool" aria-label={copied?'Copied':'Copy output'} onClick={()=>copy(terminalText(current.id))}>{copied?<Check size={13}/>:<Copy size={13}/>}</button></Tip>
    <Tip label="Clear" shortcut="⌘K"><button type="button" className="terminal-tool" aria-label="Clear terminal" onClick={()=>clearTerminal(current.id)}><Eraser size={13}/></button></Tip>
    <TerminalAgentAccess chatId={chatId}/>
  </>;
}
function ShellBody({shells,active}:{shells:Shells;active:boolean}) {
  const {current,creating,archived,loading}=shells;
  return <>
    {current&&current.status!=='running'&&<p className="terminal-ended" role="status">{current.status==='ended'?'Terminal ended when Muster quit. Its last output is shown below; shells do not outlive the app.':`Process exited${current.exitCode!==null?` with code ${current.exitCode}`:''}.`} <button type="button" disabled={creating||archived} onClick={()=>void shells.create()}>Start a new terminal</button></p>}
    {shells.error&&<p className="process-error terminal-error" role="alert">{shells.error}</p>}
    <div className="terminal-body" ref={shells.body}>
      {current?<TerminalView key={current.id} id={current.id} readOnly={current.status!=='running'} visible={active}/>
        :creating?<p className="process-note terminal-empty" role="status">Starting terminal…</p>
        :loading?<ResourceState kind="loading" label="Loading terminals" rows={3}/>
        :<div className="processes-empty"><SquareTerminal size={24} aria-hidden="true"/><p>{archived?'Restore this conversation to open a terminal.':'No terminal is open.'}</p>{!archived&&<button type="button" className="terminal-start" onClick={()=>void shells.create()}><Plus size={12}/>New terminal</button>}</div>}
    </div>
  </>;
}
/** The bottom-panel form of the shells (TerminalDock): a chip strip over the emulator. */
export function TerminalsPanel({chatId,active,actions}:{chatId:string;active:boolean;actions?:React.ReactNode}) {
  const shells=useTerminals(chatId,active,true),{terminals,current,creating,archived}=shells;
  return <div className="terminal-panel">
    <div className="terminal-strip">
      <div className="terminal-chips" role="tablist" aria-label="Terminals">
        {terminals.map(row=>{const label=shells.labelOf(row);return <div key={row.id} className={`terminal-chip is-${row.status}${row.id===current?.id?' is-active':''}`}>
          <button type="button" role="tab" aria-selected={row.id===current?.id} title={`${row.cwd}${row.status==='running'?'':row.status==='ended'?' · ended when Muster quit':` · exited ${row.exitCode??''}`}`} onClick={()=>shells.select(row.id)}>
            <SquareTerminal size={12} aria-hidden="true"/><span>{label}</span>{row.status!=='running'&&<span className="terminal-chip-state">{row.status==='ended'?'Ended':'Exited'}</span>}
          </button>
          <Tip label={row.status==='running'?'Close and end this shell':'Remove'}><button type="button" className="terminal-chip-close" aria-label={`Close ${label}`} onClick={()=>void shells.close(row)}><X size={11}/></button></Tip>
        </div>;})}
        <Tip label={archived?'Restore this conversation to open a terminal':'New terminal'}><button type="button" className="terminal-tool" aria-label="New terminal" disabled={creating||archived} onClick={()=>void shells.create()}><Plus size={13}/></button></Tip>
      </div>
      {current&&<div className="terminal-tools"><Owner who={current.owner}/><ShellTools chatId={chatId} shells={shells}/></div>}
      {actions&&<div className="terminal-tools">{actions}</div>}
    </div>
    <ShellBody shells={shells} active={active}/>
  </div>;
}

function AgentCommandRow({row,chatId,stopping}:{row:AgentCommand;chatId:string;stopping:boolean}) {
  const [open,setOpen]=useDisclosure(JSON.stringify(['agent-command',row.item.id]),row.running);
  const [copiedCommand,copyCommand]=useCopied(),[copiedOutput,copyOutput]=useCopied(),[added,addToChat]=useAddToChat();
  const output=useRef<HTMLPreElement>(null),follow=useRef(true);
  useLayoutEffect(()=>{if(follow.current&&output.current)output.current.scrollTop=output.current.scrollHeight;},[row.output,open]);
  const exit=typeof row.item.data?.exitCode==='number'?row.item.data.exitCode:null;
  const failed=row.item.status==='failed'||(exit!==null&&exit!==0);
  const state=row.running?'Running':failed?`Failed${exit!==null?` (exit ${exit})`:''}`:row.item.status==='interrupted'||row.item.status==='cancelled'?'Stopped':'Finished';
  const StatusIcon=row.running?CircleDot:failed?CircleX:CircleCheck;
  const shown=row.output.length>65536?row.output.slice(-65536):row.output;
  return <article className={`process-row is-${row.running?'running':failed?'failed':'exited'}`} aria-label={`${row.command}, ${state}`}>
    <Disclosure.Root open={open} onOpenChange={setOpen}>
      <div className="process-row-header"><Disclosure.Trigger className="process-disclosure-trigger"><SquareTerminal size={15} aria-hidden="true"/><code className="agent-command-text">{row.command}</code><Owner who="agent"/><span className="process-state"><StatusIcon size={12} aria-hidden="true"/>{state}</span><ChevronRight className="process-chevron" size={12} aria-hidden="true"/></Disclosure.Trigger>
        {row.running&&<button className="process-stop" disabled={stopping} aria-label={`Stop the agent run for ${row.command}`} title="Stops the agent’s current run, which ends this command" onClick={()=>{if(confirmAgentStop(`Stop the agent’s current run?\n\nThis ends “${row.command}” and interrupts what the agent is doing.`))void stopChat(chatId);}}><Square size={11}/><span>{stopping?'Stopping…':'Stop'}</span></button>}
      </div>
      <Disclosure.Panel className="activity-disclosure process-panel"><div className="process-details">
        <div className="agent-command-actions">
          <button type="button" onClick={()=>copyCommand(row.command)}>{copiedCommand?<Check size={12}/>:<Copy size={12}/>}{copiedCommand?'Copied':'Copy command'}</button>
          <button type="button" disabled={!row.output} onClick={()=>copyOutput(row.output)}>{copiedOutput?<Check size={12}/>:<Copy size={12}/>}{copiedOutput?'Copied':'Copy output'}</button>
          <button type="button" disabled={!row.output} onMouseDown={event=>event.preventDefault()} onClick={()=>{const picked=selectionWithin(output.current);addToChat(`${row.command.length>48?`${row.command.slice(0,47)}…`:row.command}${picked.trim()?' · selection':''}`,picked.trim()?picked:row.output,{kind:'agent',chatId,itemId:row.item.id,title:row.command});}}>{added?<Check size={12}/>:<MessageSquarePlus size={12}/>}{addLabel(added)}</button>
        </div>
        {shown!==row.output&&<p className="process-note">Showing the newest 64 KB. Copy output includes everything the provider reported.</p>}
        {row.output?<pre ref={output} className="process-output" tabIndex={0} aria-label={`Output from ${row.command}`} onScroll={()=>{const node=output.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<24;}}>{shown}</pre>:<p className="process-note">{row.running?'Waiting for output…':'No output was reported.'}</p>}
      </div></Disclosure.Panel>
    </Disclosure.Root>
  </article>;
}
/** DF-F38: a server the agent left listening (its own verification dev server, say). Stop asks first. */
function AgentServerRow({chatId,port}:{chatId:string;port:ListeningPort}) {
  const [stopping,setStopping]=useState(false),[error,setError]=useState('');
  const stop=async()=>{
    if(!confirmAgentStop(`Stop the agent’s ${port.name} server on port ${port.port}?\n\nThe agent started it; it may still be using it.`))return;
    setStopping(true);setError('');
    try{await invoke('processes.stopListener',{chatId,id:port.id});await refreshListeningPorts(chatId);}
    catch(cause){setError(message(cause));}
    finally{setStopping(false);}
  };
  return <article className="process-row terminal-server is-running" aria-label={`${port.name} on port ${port.port}, listening`}>
    <div className="process-row-header"><span className="process-disclosure-trigger"><Globe size={15} aria-hidden="true"/><strong>{port.name}</strong><Owner who="agent"/><span className="process-state"><CircleDot size={12} aria-hidden="true"/>Listening</span></span>
      <PortChips ports={[port]}/>
      <button className="process-stop" disabled={stopping} aria-label={`Stop the agent’s server on port ${port.port}`} title="Stop this server the agent started" onClick={()=>void stop()}><Square size={11}/><span>{stopping?'Stopping…':'Stop'}</span></button>
    </div>
    {error&&<p className="process-error terminal-row-error" role="alert">{error}</p>}
  </article>;
}
function ShellRow({row,label,selected,ports,onSelect,onClose}:{row:TerminalInfo;label:string;selected:boolean;ports:ListeningPort[];onSelect:()=>void;onClose:()=>void}) {
  const state=row.status==='running'?'Running':row.status==='ended'?'Ended':`Exited${row.exitCode!==null?` (${row.exitCode})`:''}`;
  return <article className={`process-row terminal-shell-row is-${row.status==='running'?'running':'exited'}${selected?' is-selected':''}`} aria-label={`${label}, ${state}`}>
    <div className="process-row-header">
      <button type="button" className="process-disclosure-trigger" aria-pressed={selected} title={row.cwd} onClick={onSelect}><SquareTerminal size={15} aria-hidden="true"/><strong>{label}</strong><Owner who={row.owner}/><span className="process-state">{row.status==='running'?<CircleDot size={12} aria-hidden="true"/>:<CircleX size={12} aria-hidden="true"/>}{state}</span></button>
      <PortChips ports={ports}/>
      <Tip label={row.status==='running'?'Close and end this shell':'Remove'}><button type="button" className="process-stop" aria-label={`Close ${label}`} onClick={onClose}><X size={11}/></button></Tip>
    </div>
  </article>;
}

/** S3-E: the right-pane Terminal is ONE level — a compact list of shells, your commands, and the agent's
 * commands and servers (owner, status, listening ports, actions), with the selected shell below it. */
export function ProcessesTab({chatId,active=true}:{chatId:string;active?:boolean}) {
  const focus=useSyncExternalStore(subscribeTerminalPaneView,()=>terminalPaneView(chatId));
  const dock=useSyncExternalStore(subscribeTerminalDock,terminalDock);
  const inPane=dock.placement==='pane';
  const shells=useTerminals(chatId,active,inPane);
  const commands=useOwnedCommands(chatId,active);
  const items=useStoreSelector(state=>state.timelines[chatId]?.value);
  const loaded=!!items;
  const agent=useMemo(()=>agentCommands(items),[items]);
  const stopping=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.status==='stopping');
  const {ports}=useListeningPorts(active?chatId:undefined);
  const [launcher,setLauncher]=useState(false);
  const list=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const kind=focus==='terminals'?'shell':focus==='commands'?'command':'agent';
    (list.current?.querySelector(`[data-kind="${kind}"]`) as HTMLElement|null)?.scrollIntoView?.({block:'nearest'});
  },[focus,commands.sessions.length,agent.length]);
  const portsFor=(match:(port:ListeningPort)=>boolean)=>ports.filter(match);
  const agentPorts=ports.filter(port=>port.owner==='agent');
  const running=shells.terminals.filter(row=>row.status==='running').length+commands.sessions.filter(session=>isActiveProcess(session.status)).length+agent.filter(row=>row.running).length+agentPorts.length;
  const total=shells.terminals.length+commands.sessions.length+agent.length+agentPorts.length;
  const newShell=()=>{if(inPane)void shells.create();else setTerminalDock({open:true});};
  return <section className="processes-tab terminal-pane" aria-label="Terminal">
    <header className="terminal-pane-head">
      <h2>Terminal</h2><span className="terminal-pane-count" role="status">{running} running{total>running?` · ${total-running} finished`:''}</span>
      <div className="terminal-tools">
        <Tip label={shells.archived?'Restore this conversation to open a terminal':'New shell'}><button type="button" className="terminal-tool" aria-label="New terminal" disabled={shells.creating||shells.archived} onClick={newShell}><Plus size={13}/></button></Tip>
        <Tip label="Run a command with captured output"><button type="button" className="terminal-tool" aria-label="Run a command" aria-expanded={launcher} onClick={()=>setLauncher(value=>!value)}><Play size={13}/></button></Tip>
        <Tip label="Refresh commands and ports"><button type="button" className="terminal-tool" aria-label="Refresh" disabled={commands.loading} onClick={()=>{commands.retry();void refreshListeningPorts(chatId);}}><RefreshCw size={13}/></button></Tip>
        {inPane?<Tip label="Move shells to the bottom panel" shortcut="⌃`"><button type="button" className="terminal-tool" aria-label="Move terminals to the bottom panel" onClick={()=>setTerminalDock({placement:'panel',open:true})}><PanelBottom size={13}/></button></Tip>
          :<Tip label="Show shells here instead of the bottom panel"><button type="button" className="terminal-tool" aria-label="Show terminals here" onClick={()=>setTerminalDock({placement:'pane',open:false})}><PanelRight size={13}/></button></Tip>}
      </div>
    </header>
    {agentPorts.length>0&&<p className="terminal-port-note" role="status">The agent is listening on {agentPorts.map(port=>`:${port.port}`).join(', ')}. A server you start on the same port will fail or move to another one.</p>}
    {launcher&&<CommandLauncher chatId={chatId} active={active} commands={commands}/>}
    <div className="terminal-list" ref={list} role="list" aria-label="Shells and commands">
      {shells.terminals.map(row=><div role="listitem" key={row.id} data-kind="shell"><ShellRow row={row} label={shells.labelOf(row)} selected={inPane&&row.id===shells.current?.id} ports={portsFor(port=>port.source.kind==='terminal'&&port.source.id===row.id)} onSelect={()=>{if(inPane)shells.select(row.id);else setTerminalDock({open:true});}} onClose={()=>void shells.close(row)}/></div>)}
      {commands.sessions.map(session=><div role="listitem" key={session.processId} data-kind="command"><ProcessRow session={session} ports={portsFor(port=>port.source.kind==='process'&&port.source.processId===session.processId)} onUpdate={commands.report}/></div>)}
      {agentPorts.map(port=><div role="listitem" key={port.id} data-kind="agent"><AgentServerRow chatId={chatId} port={port}/></div>)}
      {agent.map(row=><div role="listitem" key={row.item.id} data-kind="agent"><AgentCommandRow row={row} chatId={chatId} stopping={stopping}/></div>)}
      {!loaded&&<p className="process-note terminal-list-note">Agent commands appear once this conversation is open. <button type="button" onClick={()=>void selectChat(chatId)}>Open conversation</button></p>}
      {commands.loading&&<ResourceState kind="loading" compact label="Loading command history" rows={1}/>}
      {commands.error&&<ResourceState kind="error" compact message="Command history could not be loaded." detail={commands.error} onRetry={commands.retry}/>}
    </div>
    <div className="terminal-pane-body">
      {inPane?<>{shells.current&&<div className="terminal-shell-tools" aria-label="Shell tools"><span className="terminal-shell-name">{shells.labelOf(shells.current)}</span><ShellTools chatId={chatId} shells={shells}/></div>}<ShellBody shells={shells} active={active}/></>
        :<div className="processes-empty"><PanelBottom size={24} aria-hidden="true"/><p>Terminals are shown in the bottom panel under the conversation.</p><div className="terminal-placement-actions"><button type="button" className="terminal-start" onClick={()=>setTerminalDock({open:true})}><PanelBottom size={12}/>Show panel</button><button type="button" className="terminal-start" onClick={()=>setTerminalDock({placement:'pane',open:false})}><PanelRight size={12}/>Show here instead</button></div></div>}
    </div>
  </section>;
}
