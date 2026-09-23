import React,{memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Check,ChevronRight,Container,CornerLeftUp,Copy,Download,File,Folder,FolderOpen,Globe,Link2,Play,RefreshCw,Settings2,Square,Trash2,Upload} from 'lucide-react';
import {SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS,type ScopedComputerEvent,type ScopedComputerExecution,type ScopedComputerFile,type ScopedComputerRef,type ScopedComputerRun,type ScopedComputerStatus} from '../../shared/scoped-computer-protocol';
import {invoke,subscribe} from '../bridge';
import {COMPUTER_STATE_LABEL,formatBytes,runLabel,terminalText,TIMEOUTS} from '../scopedComputerText';
import {SandboxControls} from './SandboxControls';
import './scoped-computer.css';
import { plural } from '../../shared/wording.ts';

type Segment={stream:'stdout'|'stderr';text:string};
interface RunView {id:string;command:string;state:ScopedComputerExecution['state'];exitCode:number|null;segments:Segment[];reason?:string;restored?:boolean;truncated:boolean}
type Confirm='egress'|'none'|'remove'|'delete'|'dispose';
const MAX_RUN_TEXT=128*1024;
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
const fromExecution=(value:ScopedComputerExecution|ScopedComputerRun,command=value.command??''):RunView=>({id:value.executionId,command,state:value.state,exitCode:value.exitCode,reason:value.state==='running'?undefined:value.reason,restored:'restored' in value?value.restored:undefined,truncated:value.stdoutTruncated||value.stderrTruncated,
  segments:[...(value.stdout?[{stream:'stdout' as const,text:value.stdout}]:[]),...(value.stderr?[{stream:'stderr' as const,text:value.stderr}]:[])]});
function append(segments:Segment[],stream:Segment['stream'],text:string):Segment[] {
  const last=segments.at(-1),next=last?.stream===stream?[...segments.slice(0,-1),{stream,text:last.text+text}]:[...segments,{stream,text}];
  let total=next.reduce((sum,segment)=>sum+segment.text.length,0);
  while(total>MAX_RUN_TEXT&&next.length){const over=total-MAX_RUN_TEXT,first=next[0];if(first.text.length<=over){next.shift();total-=first.text.length;}else{next[0]={...first,text:first.text.slice(over)};total-=over;}}
  return next;
}

const MAX_RUNS=200;
/** Keyed by scope so a late reply for a previous scope can never land in this one. */
export function ScopedComputerTab({scope}:{scope:ScopedComputerRef}) {return <SandboxView key={`${scope.kind}:${scope.id}`} scope={scope}/>;}

function SandboxView({scope}:{scope:ScopedComputerRef}) {
  const [computer,setComputer]=useState<ScopedComputerStatus>();
  const [runs,setRuns]=useState<RunView[]>([]);
  const [command,setCommand]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState<string>(''),[progress,setProgress]=useState('');
  const [confirm,setConfirm]=useState<Confirm>(),[size,setSize]=useState<{bytes:number;files:number;truncated:boolean}>();
  const [timeoutMs,setTimeoutMs]=useState<number>(SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS);
  const [files,setFiles]=useState<{path:string;entries:ScopedComputerFile[];truncated:boolean}>({path:'',entries:[],truncated:false});
  const [filesOpen,setFilesOpen]=useState(true),[settingsOpen,setSettingsOpen]=useState(false);
  const alive=useRef(true),pending=useRef(false),request=useRef<{text:string;id:string}|undefined>(undefined),recall=useRef(-1),lastEvent=useRef(0);
  const early=useRef(new Map<string,{segments:Segment[];done?:ScopedComputerExecution}>()),known=useRef(new Set<string>());
  const computerId=useRef(''),filesPath=useRef(''),terminal=useRef<HTMLDivElement>(null),stick=useRef(true),input=useRef<HTMLTextAreaElement>(null);
  const scopeKey=`${scope.kind}:${scope.id}`;
  const active=runs.find(run=>run.state==='running');
  const fail=(cause:unknown)=>{if(alive.current)setError(message(cause));};
  const refresh=useCallback(async()=>{try{const value=await invoke('computer.inspect',{scope});if(alive.current){setComputer(value);computerId.current=value.id;}}catch(cause){fail(cause);}},[scopeKey]);
  const loadFiles=useCallback(async(path=filesPath.current)=>{try{const value=await invoke('computer.files.list',{scope,path});if(alive.current){filesPath.current=value.path;setFiles(value);}}catch(cause){if(path){filesPath.current='';void loadFiles('');}else fail(cause);}},[scopeKey]);
  useEffect(()=>{
    alive.current=true;setRuns([]);early.current.clear();known.current.clear();setComputer(undefined);setError('');filesPath.current='';
    void refresh();void loadFiles('');
    void invoke('computer.history',{scope}).then(history=>{for(const run of history)known.current.add(run.executionId);if(alive.current)setRuns(current=>[...history.map(run=>fromExecution(run)).filter(run=>!current.some(item=>item.id===run.id)),...current]);}).catch(()=>{});
    return()=>{alive.current=false;};
  },[scopeKey]);
  // Output streams as events; a slow poll covers a missed event or a main process without the event bridge.
  useEffect(()=>subscribe(raw=>{
    const event=raw as unknown as ScopedComputerEvent;
    if(!('computerId' in event)||event.computerId!==computerId.current)return;
    if(event.type==='computerProgress'){setProgress(event.phase==='done'?'':event.message);return;}
    if(event.type==='computerServices')return;
    lastEvent.current=Date.now();
    // A fast command can stream (or finish) before execStream resolves: hold its events until the run row exists.
    const id=event.type==='computerOutput'?event.execId:event.execution.executionId;
    if(!known.current.has(id)){const held=early.current.get(id)??{segments:[]};if(event.type==='computerOutput')held.segments=append(held.segments,event.stream,event.data);else held.done=event.execution;if(early.current.size<8||early.current.has(id))early.current.set(id,held);return;}
    if(event.type==='computerOutput')setRuns(current=>current.map(run=>run.id===event.execId?{...run,segments:append(run.segments,event.stream,event.data)}:run));
    if(event.type==='computerExecution'){const done=event.execution;setRuns(current=>current.map(run=>run.id===done.executionId?{...run,state:done.state,exitCode:done.exitCode,reason:done.reason,truncated:done.stdoutTruncated||done.stderrTruncated}:run));void refresh();void loadFiles();}
  }),[scopeKey]);
  useEffect(()=>{
    if(!active)return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(Date.now()-lastEvent.current>1200)try{
        const value=await invoke('computer.execution',{scope,executionId:active.id});if(cancelled)return;
        setRuns(current=>current.map(run=>run.id!==value.executionId?run:value.state==='running'&&run.segments.reduce((n,s)=>n+s.text.length,0)>=value.stdout.length+value.stderr.length?run:{...fromExecution(value,run.command)}));
        if(value.state!=='running'){void refresh();void loadFiles();return;}
      }catch(cause){if(!cancelled)fail(cause);return;}
      if(!cancelled)timer=setTimeout(()=>void poll(),1000);
    };
    timer=setTimeout(()=>void poll(),1000);return()=>{cancelled=true;clearTimeout(timer);};
  },[scopeKey,active?.id]);
  useLayoutEffect(()=>{const el=terminal.current;if(el&&stick.current)el.scrollTop=el.scrollHeight;},[runs]);

  const act=async<T,>(label:string,task:()=>Promise<T>,apply?:(value:T)=>void)=>{
    if(pending.current)return;pending.current=true;setBusy(label);setError('');
    try{const value=await task();if(alive.current)apply?.(value);}catch(cause){fail(cause);}
    finally{pending.current=false;if(alive.current){setBusy('');setProgress('');}}
  };
  const applyStatus=(value:ScopedComputerStatus)=>{setComputer(value);computerId.current=value.id;setConfirm(undefined);void loadFiles();};
  const lifecycle=(kind:'start'|'stop'|'destroy')=>act(kind,()=>invoke(`computer.${kind}`,{scope}),applyStatus);
  const run=async()=>{
    const submitted=command.trim()?command:'';
    if(!submitted||active||computer?.state!=='running')return;
    if(request.current?.text!==submitted)request.current={text:submitted,id:crypto.randomUUID()};
    const requestId=request.current.id;
    await act('run',()=>invoke('computer.execStream',{scope,command:submitted,requestId,timeoutMs}),({execId})=>{
      request.current=undefined;setCommand('');recall.current=-1;stick.current=true;lastEvent.current=Date.now();
      const held=early.current.get(execId),done=held?.done;early.current.delete(execId);known.current.add(execId);
      setRuns(current=>current.some(item=>item.id===execId)?current:[...current.slice(1-MAX_RUNS),{id:execId,command:submitted,state:done?.state??'running',exitCode:done?.exitCode??null,reason:done?.reason,segments:held?.segments??[],truncated:!!done&&(done.stdoutTruncated||done.stderrTruncated)}]);
      if(done){void refresh();void loadFiles();}
    });
  };
  const cancel=(executionId:string)=>act('cancel',()=>invoke('computer.cancel',{scope,executionId}),value=>{setRuns(current=>current.map(run=>run.id===value.executionId?{...run,state:value.state,exitCode:value.exitCode,reason:value.reason}:run));void refresh();});
  const send=(data?:string,eof?:boolean)=>{if(active)void invoke('computer.input',{scope,execId:active.id,...(data!==undefined?{data}:{}),...(eof?{eof:true}:{})}).catch(fail);};
  const openConfirm=async(kind:Confirm)=>{setConfirm(kind);setSize(undefined);if(kind==='remove'||kind==='delete'||kind==='dispose')try{const value=await invoke('computer.workspace.size',{scope});if(alive.current)setSize(value);}catch{}};
  const history=useMemo(()=>[...new Set(runs.map(run=>run.command).reverse())],[runs]);
  const onKey=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.nativeEvent.isComposing)return;
    const el=event.currentTarget;
    if(active){
      if(event.ctrlKey&&event.key==='c'&&el.selectionStart===el.selectionEnd){event.preventDefault();void cancel(active.id);return;}
      if(event.ctrlKey&&event.key==='d'){event.preventDefault();send(command||undefined,true);setCommand('');return;}
      if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send(`${command}\n`);setCommand('');}
      return;
    }
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void run();return;}
    const before=el.value.slice(0,el.selectionStart),after=el.value.slice(el.selectionEnd);
    if(event.key==='ArrowUp'&&!before.includes('\n')&&history.length){event.preventDefault();recall.current=Math.min(recall.current+1,history.length-1);setCommand(history[recall.current]);}
    else if(event.key==='ArrowDown'&&!after.includes('\n')&&recall.current>=0){event.preventDefault();recall.current--;setCommand(recall.current<0?'':history[recall.current]);}
  };
  useLayoutEffect(()=>{const el=input.current;if(el){el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,160)}px`;}},[command]);

  const state=computer?.state,scratch=(computer?.durability??(scope.kind==='chat'?'scratch':'durable'))==='scratch',network=computer?.limits.network??'none';
  const stateLabel=busy==='start'||busy==='repair'||busy==='network'?'Starting':active?'Running command':state?COMPUTER_STATE_LABEL[state]:'Checking…';
  const tone=busy==='start'||active?'busy':state==='running'?'ok':state==='unavailable'||state==='recovery-needed'||state==='unknown'?'warn':'idle';
  const created=state==='running'||state==='stopped';
  const limits=computer?.limits;
  const sizeText=size?`${formatBytes(size.bytes)}${size.truncated?'+':''} in ${plural(size.files, 'item')}`:'measuring…';
  return <section className="sbx" aria-label={`${scratch?'Scratch sandbox':'Sandbox'} ${computer?.label??''}`}>
    <header className="sbx-head">
      <Container size={16} aria-hidden="true"/>
      <div className="sbx-title"><h2>{scratch?'Scratch sandbox':'Sandbox'}{computer?.label?` · ${computer.label}`:''}</h2><p>Linux container (Docker) · not this Mac{scratch?' · disposable':''}</p></div>
      <span className={`sbx-state is-${tone}`} role="status"><span className="sbx-dot" aria-hidden="true"/>{stateLabel}</span>
      <button className={`sbx-net${network==='egress'?' is-on':''}`} disabled={!!busy||!!active||!computer||state==='recovery-needed'} title={network==='egress'?'Internet access is on. Click to turn it off (recreates the container).':'No network. Click to allow internet access (recreates the container).'} onClick={()=>void openConfirm(network==='egress'?'none':'egress')}><Globe size={12} aria-hidden="true"/>{network==='egress'?'Internet on':'No network'}</button>
      <button className="icon-button" aria-label="Refresh sandbox status" title="Refresh" disabled={!!busy} onClick={()=>{void refresh();void loadFiles();}}><RefreshCw size={13}/></button>
    </header>
    <div className="sbx-bar">
      {state==='running'
        ?<button disabled={!!busy} onClick={()=>void lifecycle('stop')}><Square size={12}/>{busy==='stop'?'Stopping…':'Stop'}</button>
        :<button className="is-primary" disabled={!!busy||!computer||state==='recovery-needed'||!!computer.repair} onClick={()=>void lifecycle('start')}><Play size={12}/>{busy==='start'?'Starting…':state==='stopped'?'Start':'Create and start'}</button>}
      {created&&<button disabled={!!busy||!!active} onClick={()=>void openConfirm(scratch?'dispose':'remove')}><Trash2 size={12}/>{scratch?'Dispose…':'Remove container…'}</button>}
      {!scratch&&<button disabled={!!busy||!!active||!files.entries.length&&!files.path} onClick={()=>void openConfirm('delete')}>Delete files…</button>}
      <span className="sbx-limits">{limits?`${limits.memoryMiB} MiB · ${limits.cpus} CPU · ${limits.processes} processes · user ${computer!.user.split(':')[0]} · up to ${limits.maxRunning} running`:''}</span>
      <button className={`sbx-toggle${settingsOpen?' is-on':''}`} aria-pressed={settingsOpen} title="Resources, services, read-only layers and export" onClick={()=>setSettingsOpen(open=>!open)}><Settings2 size={12}/>Settings</button>
      <button className={`sbx-toggle${filesOpen?' is-on':''}`} aria-pressed={filesOpen} onClick={()=>setFilesOpen(open=>!open)}><FolderOpen size={12}/>Files</button>
    </div>
    {progress&&<div className="sbx-banner is-progress" role="status"><span className="sbx-spinner" aria-hidden="true"/>{progress}</div>}
    {computer?.repair==='unregistered-container'&&<div className="sbx-banner is-warn" role="group" aria-label="Repair sandbox"><p>{computer.reason}</p><button disabled={!!busy} onClick={()=>void act('repair',()=>invoke('computer.repair',{scope,action:'adopt'}),applyStatus)}>Adopt</button><button disabled={!!busy} onClick={()=>void act('repair',()=>invoke('computer.repair',{scope,action:'recreate'}),applyStatus)}>Remove and recreate</button></div>}
    {computer?.repair==='workspace-missing'&&<div className="sbx-banner is-warn" role="group" aria-label="Repair sandbox"><p>{computer.reason}</p><button disabled={!!busy} onClick={()=>void act('repair',()=>invoke('computer.repair',{scope,action:'recreate'}),applyStatus)}>Recreate container</button></div>}
    {state==='recovery-needed'&&computer?.activeExecutionId&&!active&&<div className="sbx-banner is-warn" role="group" aria-label="Resolve interrupted command"><p>{computer.reason}</p><button disabled={!!busy} onClick={()=>void cancel(computer.activeExecutionId!)}>End that command</button><button disabled={!!busy} onClick={()=>void lifecycle('stop')}>Stop sandbox</button></div>}
    {computer?.reason&&!computer.repair&&state!=='recovery-needed'&&<div className={`sbx-banner${state==='unavailable'||state==='unknown'?' is-warn':''}`}><p>{computer.reason}</p>{(computer.problem==='daemon-down'||computer.problem==='image')&&<button disabled={!!busy} onClick={()=>void lifecycle('start')}>Try again</button>}</div>}
    {confirm&&<div className="sbx-banner is-confirm" role="alertdialog" aria-label="Confirm sandbox change">
      <p>{confirm==='egress'?'Allow internet access? The container is recreated: anything running stops, files in /workspace are kept. Commands in this sandbox can then reach the internet.'
        :confirm==='none'?'Turn off network access? The container is recreated without a network. Files in /workspace are kept.'
        :confirm==='remove'?`Remove the container? Its files stay on this Mac (${sizeText}).`
        :confirm==='delete'?`Delete every file in this sandbox’s workspace (${sizeText})? This cannot be undone.`
        :`Dispose this scratch sandbox? The container is removed and its files are deleted (${sizeText}). Export anything you need first.`}</p>
      <button className={confirm==='egress'||confirm==='none'?'is-primary':'is-danger'} disabled={!!busy} onClick={()=>{
        if(confirm==='egress'||confirm==='none')void act('network',()=>invoke('computer.setNetwork',{scope,network:confirm,confirmed:confirm==='egress'}),applyStatus);
        else if(confirm==='remove')void lifecycle('destroy');
        else void act('delete',()=>invoke('computer.workspace.delete',{scope,confirmed:true,removeContainer:confirm==='dispose'}),value=>{applyStatus(value);if(confirm==='dispose')setRuns([]);});
      }}>{confirm==='egress'?'Allow internet access':confirm==='none'?'Turn off network':confirm==='remove'?'Remove container':confirm==='delete'?'Delete files':'Dispose sandbox'}</button>
      <button disabled={!!busy} onClick={()=>setConfirm(undefined)}>Cancel</button>
    </div>}
    {error&&<p className="sbx-error" role="alert">{error}</p>}
    {settingsOpen&&<SandboxControls scope={scope} computer={computer} busy={!!busy||!!active} onStatus={applyStatus}/>}
    <div className="sbx-body">
      <div className="sbx-terminal" ref={terminal} role="log" aria-label="Sandbox output" onScroll={event=>{const el=event.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;}}>
        {runs.length?runs.map(run=><RunBlock key={run.id} run={run} busy={!!busy} onStop={()=>void cancel(run.id)}/>)
          :<p className="sbx-empty">{state==='running'?'Commands run as an unprivileged user in /workspace inside the container. Nothing runs on this Mac.':state==='not-created'?'Create the sandbox to get an isolated Linux shell. Its /workspace folder is kept on this Mac.':'Start the sandbox to run commands.'}</p>}
      </div>
      {filesOpen&&<FilesPane files={files} busy={!!busy} onOpen={path=>void loadFiles(path)} onImport={()=>void act('import',()=>invoke('computer.files.import',{scope,into:files.path}),()=>void loadFiles())} onExport={path=>void act('export',()=>invoke('computer.files.export',{scope,path}))}/>}
    </div>
    <form className={`sbx-input${active?' is-stdin':''}`} onSubmit={event=>{event.preventDefault();void run();}}>
      <span className="sbx-prompt" aria-hidden="true">{active?'›':'$'}</span>
      <textarea ref={input} rows={1} aria-label={active?'Input for the running command':'Sandbox command'} spellCheck={false} autoComplete="off" value={command} disabled={!active&&state!=='running'}
        placeholder={active?'Input for the running command · Enter sends · Ctrl+D ends input · Ctrl+C stops':state==='running'?'Run a command · Enter runs · Shift+Enter for a new line · ↑ for history':'Start the sandbox to run commands'}
        onChange={event=>{setCommand(event.target.value);recall.current=-1;}} onKeyDown={onKey}/>
      {active
        ?<button type="button" className="sbx-run-button is-stop" disabled={busy==='cancel'} onClick={()=>void cancel(active.id)} aria-label="Stop the running command"><Square size={11}/>Stop</button>
        :<>
          <select aria-label="Command time limit" value={timeoutMs} onChange={event=>setTimeoutMs(Number(event.target.value))}>{TIMEOUTS.filter(item=>item.ms<=(limits?.maxTimeoutMs??Infinity)).map(item=><option key={item.ms} value={item.ms}>{item.label}</option>)}</select>
          <button type="submit" className="sbx-run-button" disabled={!!busy||state!=='running'||!command.trim()} aria-label="Run command"><Play size={11}/>Run</button>
        </>}
    </form>
  </section>;
}

const RunBlock=memo(function RunBlock({run,busy,onStop}:{run:RunView;busy:boolean;onStop:()=>void}) {
  const [copied,setCopied]=useState(false);
  const text=useMemo(()=>run.segments.map(segment=>({...segment,text:terminalText(segment.text)})),[run.segments]);
  const copy=()=>{void navigator.clipboard?.writeText(`$ ${run.command}\n${text.map(segment=>segment.text).join('')}`).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1200);}).catch(()=>{});};
  const tone=run.state==='running'?'busy':run.state==='completed'?'ok':run.state==='failed'||run.state==='recovery-needed'?'warn':'idle';
  return <article className="sbx-run">
    <div className="sbx-run-head">
      <span className="sbx-prompt" aria-hidden="true">$</span><code>{run.command}</code>
      <span className={`sbx-run-state is-${tone}`}>{run.state==='running'&&<span className="sbx-spinner" aria-hidden="true"/>}{runLabel(run)}</span>
      {run.state==='running'&&<button className="icon-button" aria-label="Stop this command" title="Stop this command (the sandbox keeps running)" disabled={busy} onClick={onStop}><Square size={11}/></button>}
      <button className="icon-button" aria-label="Copy command and output" title={copied?'Copied':'Copy'} onClick={copy}>{copied?<Check size={12}/>:<Copy size={12}/>}</button>
    </div>
    {run.truncated&&<p className="sbx-run-note">Earlier output was trimmed; the latest output is shown.</p>}
    {text.some(segment=>segment.text)&&<pre>{text.map((segment,index)=><span key={index} className={segment.stream==='stderr'?'is-stderr':undefined}>{segment.text}</span>)}</pre>}
    {run.reason&&run.state!=='completed'&&<p className="sbx-run-note">{run.reason}</p>}
  </article>;
});

function FilesPane({files,busy,onOpen,onImport,onExport}:{files:{path:string;entries:ScopedComputerFile[];truncated:boolean};busy:boolean;onOpen:(path:string)=>void;onImport:()=>void;onExport:(path:string)=>void}) {
  const parts=files.path?files.path.split('/'):[];
  return <aside className="sbx-files" aria-label="Sandbox files">
    <div className="sbx-files-head">
      <nav aria-label="Folder" className="sbx-crumbs"><button onClick={()=>onOpen('')}>workspace</button>{parts.map((part,index)=><React.Fragment key={index}><ChevronRight size={10} aria-hidden="true"/><button onClick={()=>onOpen(parts.slice(0,index+1).join('/'))}>{part}</button></React.Fragment>)}</nav>
      <button className="icon-button" aria-label="Import files from this Mac" title="Import files from this Mac" disabled={busy} onClick={onImport}><Upload size={12}/></button>
    </div>
    <ul>
      {files.path&&<li><button className="sbx-file" onClick={()=>onOpen(parts.slice(0,-1).join('/'))}><CornerLeftUp size={12} aria-hidden="true"/><span>..</span></button></li>}
      {files.entries.map(entry=>{const Icon=entry.kind==='directory'?Folder:entry.kind==='symlink'?Link2:File;return <li key={entry.path}>
        <button className="sbx-file" disabled={entry.kind!=='directory'} title={entry.kind==='symlink'?'Links are not followed':entry.name} onClick={()=>onOpen(entry.path)}><Icon size={12} aria-hidden="true"/><span>{entry.name}</span>{entry.kind==='file'&&<small>{formatBytes(entry.size)}</small>}</button>
        {entry.kind!=='symlink'&&<button className="icon-button sbx-export" aria-label={`Export ${entry.name} to this Mac`} title="Export to this Mac" disabled={busy} onClick={()=>onExport(entry.path)}><Download size={12}/></button>}
      </li>;})}
    </ul>
    {!files.entries.length&&<p className="sbx-empty">{files.path?'This folder is empty.':'No files in /workspace yet. Import files or create them with a command.'}</p>}
    {files.truncated&&<p className="sbx-empty">Showing the first 1,000 items.</p>}
  </aside>;
}
