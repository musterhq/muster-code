import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronRight,CircleCheck,CircleDot,CircleHelp,CircleX,FlaskConical,Globe,Hammer,Play,RefreshCw,Square,SquareTerminal,Wrench} from 'lucide-react';
import {Collapsible as Disclosure} from '@base-ui/react/collapsible';
import {invoke,subscribe} from '../bridge';
import {useStore} from '../useStore';
import {useDisclosure} from './useDisclosure';
import {isActiveProcess,mergeProcessSnapshot,type ProcessPurpose,type ProcessSnapshot} from '../../shared/process-protocol';
import './processes-tab.css';

const PURPOSES=[{id:'command',label:'Command',Icon:SquareTerminal},{id:'test',label:'Test',Icon:FlaskConical},{id:'build',label:'Build',Icon:Hammer},{id:'server',label:'Server',Icon:Globe},{id:'task',label:'Task',Icon:Wrench}] as const;
const STATUS={starting:'Starting',running:'Running',stopping:'Stopping',exited:'Finished',failed:'Failed',stopped:'Stopped',lost:'Connection lost'} as const;
function retained(items:ProcessSnapshot[]):ProcessSnapshot[]{
  const active=items.filter(item=>isActiveProcess(item.status));
  return [...active,...items.filter(item=>!isActiveProcess(item.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,32)];
}
function ProcessRow({session,onUpdate}:{session:ProcessSnapshot;onUpdate:(session:ProcessSnapshot)=>void}) {
  const [open,setOpen]=useDisclosure(JSON.stringify(['process',session.chatId,session.processId]),true);
  const [error,setError]=useState(''),[stopping,setStopping]=useState(false);
  const output=useRef<HTMLPreElement>(null),follow=useRef(true),pending=useRef(false),alive=useRef(true);
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
      <div className="process-row-header"><Disclosure.Trigger className="process-disclosure-trigger"><Icon size={15} aria-hidden="true"/><strong>{session.label}</strong><span className="process-state"><StatusIcon size={12} aria-hidden="true"/>{STATUS[session.status]}</span><ChevronRight className="process-chevron" size={12} aria-hidden="true"/></Disclosure.Trigger>
        {isActiveProcess(session.status)&&<button className="process-stop" disabled={stopping||(session.status==='stopping'&&!session.error)} aria-label={`Stop ${session.label}`} title="Stop this owned command and its process group" onClick={()=>void stop()}><Square size={11}/><span>{stopping?'Stopping…':session.status==='stopping'?session.error?'Retry Stop':'Stopping…':'Stop'}</span></button>}
      </div>
      <Disclosure.Panel className="activity-disclosure process-panel"><div className="process-details">
        {session.command&&<code className="process-command">{session.command}{session.args?.length?` ${session.args.map(argument=>JSON.stringify(argument)).join(' ')}`:''}</code>}
        <div className="process-metadata"><span>{PURPOSES.find(purpose=>purpose.id===session.purpose)?.label??'Command'}</span><time dateTime={session.startedAt}>{new Date(session.startedAt).toLocaleTimeString()}</time>{session.exitCode!==null&&<span>Exit {session.exitCode}</span>}{session.signal&&<span>{session.signal}</span>}</div>
        {session.truncated&&<p className="process-note">Earlier output was trimmed. Showing the retained tail.</p>}
        {session.output?<pre ref={output} className="process-output" tabIndex={0} aria-label={`Output from ${session.label}`} onScroll={()=>{const node=output.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<24;}}>{session.output}</pre>:<p className="process-note">{isActiveProcess(session.status)?'Waiting for command output…':'No output was retained.'}</p>}
        {session.error&&<p className="process-error">{session.error}</p>}
        {error&&<p className="process-error" role="alert">{error}</p>}
      </div></Disclosure.Panel>
    </Disclosure.Root>
  </article>;
}

/** An attached viewer, not a PTY. Unmounting releases only its event lease. */
export function ProcessesTab({chatId,active=true}:{chatId:string;active?:boolean}) {
  const app=useStore(),chat=app.snapshot?.chats.find(chat=>chat.id===chatId);
  const [sessions,setSessions]=useState<ProcessSnapshot[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const [command,setCommand]=useState(''),[label,setLabel]=useState(''),[purpose,setPurpose]=useState<ProcessPurpose>('command'),[starting,setStarting]=useState(false),[startError,setStartError]=useState('');
  const pending=useRef(false),request=useRef<{signature:string;id:string}|null>(null),epoch=useRef(0);
  const draft=useRef({command,label,purpose});draft.current={command,label,purpose};
  const report=useRef<(session:ProcessSnapshot)=>void>(()=>{});
  const full=chat?.mode==='agent'&&chat.permissionMode==='full';
  const busy=chat?.status==='running'||chat?.status==='stopping'||!!app.sending[chatId]||chat?.recovery?.kind==='recovery-needed';
  const canStart=active&&!!chat&&full&&!busy&&!chat.archived&&!starting;
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
  useEffect(()=>{setCommand('');setLabel('');setPurpose('command');setStartError('');request.current=null;},[chatId]);
  const start=async(event:React.FormEvent)=>{
    event.preventDefault();if(!canStart||pending.current||!command.trim())return;
    const saved={command,label,purpose},signature=JSON.stringify(saved),version=epoch.current;
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    pending.current=true;setStarting(true);setStartError('');
    try{
      const next=await invoke('processes.start',{chatId,requestId:request.current.id,command,label:label.trim()||undefined,purpose});
      if(version!==epoch.current)return;report.current(next);
      if(JSON.stringify(draft.current)===signature){setCommand('');setLabel('');}request.current=null;
    }catch(cause){if(version===epoch.current)setStartError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;setStarting(false);}
  };
  const activeCount=sessions.filter(session=>isActiveProcess(session.status)).length;
  return <section className="processes-tab" aria-label="Background commands">
    <header className="processes-header"><div><h2>Background commands</h2><p>{chat?.title??'Conversation commands'}</p></div><button aria-label="Refresh command history" disabled={loading} onClick={()=>setAttempt(value=>value+1)}><RefreshCw size={14}/></button></header>
    <p className="processes-explanation">Non-interactive commands with captured output. Closing this pane keeps commands running; Stop ends the owned process group.</p>
    <form className="process-launcher" onSubmit={event=>void start(event)}>
      <label className="process-command-label">Command<textarea aria-label="Command to run" placeholder="For example: npm test" value={command} maxLength={32768} rows={2} spellCheck={false} onChange={event=>setCommand(event.target.value)}/></label>
      <div className="process-launch-options"><input aria-label="Command label" placeholder="Label (optional)" value={label} maxLength={160} onChange={event=>setLabel(event.target.value)}/><select aria-label="Command purpose" value={purpose} onChange={event=>setPurpose(event.target.value as ProcessPurpose)}>{PURPOSES.map(purpose=><option key={purpose.id} value={purpose.id}>{purpose.label}</option>)}</select><button type="submit" disabled={!canStart||!command.trim()}><Play size={12}/>{starting?'Starting…':'Run command'}</button></div>
      {!full?<p className="process-note">Host commands require Full access in Agent mode. Workspace access cannot sandbox a host shell. Change access in the composer to enable Run.</p>:busy?<p className="process-note">Wait for the current agent attempt to finish or be reconciled before starting a host command.</p>:chat?.archived?<p className="process-note">Restore this conversation before starting a command.</p>:<p className="process-note">Full access · runs on this computer in the conversation’s workspace. No interactive input or terminal emulation.</p>}
      {startError&&<p className="process-error" role="alert">{startError} Retry uses the same request identity while the command is unchanged.</p>}
    </form>
    <div className="processes-count" role="status">{activeCount} active · {sessions.length-activeCount} finished or unavailable</div>
    {loading&&<p className="process-note" role="status">Loading command history…</p>}
    {error&&<p className="process-error" role="alert">{error}</p>}
    {!loading&&!error&&!sessions.length&&<div className="processes-empty"><SquareTerminal size={24} aria-hidden="true"/><p>No commands started in this conversation.</p></div>}
    <div className="processes-list">{sessions.map(session=><ProcessRow key={session.processId} session={session} onUpdate={next=>report.current(next)}/>)}</div>
  </section>;
}
