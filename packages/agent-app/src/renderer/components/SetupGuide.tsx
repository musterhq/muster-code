import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Check,CircleAlert,CircleDashed,Copy,ExternalLink,FolderPlus,GitBranch,KeyRound,LoaderCircle,MessageSquarePlus,RefreshCw,SquareTerminal} from 'lucide-react';
import type {ProviderInfo} from '../../shared/protocol';
import type {ComputerPermissions} from '../../shared/domains/computer-protocol';
import type {CliTool} from '../../shared/domains/providers-protocol';
import {connectedNotice,SETUP_STEPS,type SetupCli,type SetupProgress,type SetupStatus,type SetupStep} from '../../shared/domains/setup-protocol';
import {invoke,subscribe} from '../bridge';
import {copyText} from '../clipboard';
import {openNewChat,setNewChatText} from '../newChatDraft';
import {setTerminalDock,setTerminalPaneView,terminalDock} from '../processSummary';
import {applyProviders,getState,loadProviders,notifyError,notifySuccess,openAppSettings,openProcessesTab,pickFolder,setSetting} from '../store';
import {useStore} from '../useStore';
import {closeSetupGuide,nextStep,openSetupGuide,previousStep,resumeStep,setSetupStep,setupChecklist,SETUP_SUGGESTIONS,shouldAutoOpenSetup,skipStep,stepIndex,useSetupGuide,type ChecklistItem} from '../setupFlow';
import {openCloneSheet} from './CloneRepositorySheet';
import {ModalSheet} from './ModalSheet';
import {ProviderLogo} from './ProviderLogo';
import {ResourceState} from './ResourceState';
import './setup-guide.css';

const errorText=(cause: unknown)=>cause instanceof Error?cause.message:String(cause);
const DOCKER_URL='https://www.docker.com/products/docker-desktop/';
const PROVIDER_FOR: Record<CliTool,string>={codex:'openai-direct',claude:'claude-code',opencode:'opencode'};

/** Latest detection result, shared by the guide, the Settings checklist and the inline prompt. */
let lastStatus: SetupStatus|null=null;
const statusListeners=new Set<(status: SetupStatus)=>void>();
export async function refreshSetupStatus(): Promise<SetupStatus> {
  const status=await invoke('setup.status',{});
  lastStatus=status;
  for(const listener of statusListeners)listener(status);
  return status;
}
function useSetupStatus(): [SetupStatus|null,string,()=>void] {
  const [status,setStatus]=useState<SetupStatus|null>(lastStatus);
  const [error,setError]=useState('');
  const reload=useCallback(()=>{setError('');void refreshSetupStatus().catch(cause=>setError(errorText(cause)));},[]);
  useEffect(()=>{statusListeners.add(setStatus);if(!lastStatus)reload();return()=>{statusListeners.delete(setStatus);};},[reload]);
  return [status,error,reload];
}
const saveProgress=(patch: Partial<SetupProgress>)=>invoke('setup.saveProgress',patch).catch(()=>undefined);

/**
 * Sign in with a CLI's own login. With a chat open the command is typed (not run) in its Terminal tab, as
 * Settings › Providers does; with none yet it opens in Terminal. Either way detection picks the sign-in up by itself.
 */
export async function startSignIn(tool: CliTool, command?: string): Promise<string> {
  const state=getState(), chatId=state.activeChatId;
  if(chatId&&command){
    const info=await invoke('terminal.create',{chatId,cols:120,rows:30});
    await invoke('terminal.input',{id:info.id,data:command});
    if(terminalDock().placement==='panel')setTerminalDock({open:true});
    else {setTerminalPaneView(chatId,'terminals');openProcessesTab(chatId,state.snapshot?.chats.find(chat=>chat.id===chatId)?.title??'Chat');}
    return 'Press Return in the terminal to sign in. Muster notices the sign-in on its own.';
  }
  const result=await invoke('setup.openTerminal',{tool});
  if(result.opened)return 'Terminal opened. Finish signing in there; Muster notices the sign-in on its own.';
  await copyText(result.command);
  return `Copied \`${result.command}\`. Run it in a terminal to sign in.`;
}

/** Mounted once in App: automatic detection results, the launch decision, focus re-probe, and the guide itself. */
export function SetupGuideHost(): React.ReactElement|null {
  const phase=useStore().boot.phase;
  const guide=useSetupGuide();
  const decided=useRef(false);
  useEffect(()=>subscribe(event=>{
    if(event.type!=='providersChanged')return;
    applyProviders(event.providers);
    if(event.connected.length)notifySuccess(connectedNotice(event.connected));
    if(event.reason!=='launch'||lastStatus)void refreshSetupStatus().catch(()=>undefined);
  }),[]);
  useEffect(()=>{
    const onFocus=()=>{void invoke('setup.refresh',{}).catch(()=>undefined);};
    window.addEventListener('focus',onFocus);
    return()=>window.removeEventListener('focus',onFocus);
  },[]);
  useEffect(()=>{
    if(phase!=='ready'||decided.current)return;
    decided.current=true;
    void Promise.all([invoke('setup.progress',{}),refreshSetupStatus()]).then(([progress,status])=>{
      if(shouldAutoOpenSetup(status,progress)){
        if(!progress.startedAt)void saveProgress({startedAt:new Date().toISOString()});
        openSetupGuide(resumeStep(progress,status));
      }
    }).catch(()=>undefined);
  },[phase]);
  return guide.open?<SetupGuide/>:null;
}

const STEP_TITLES: Record<SetupStep,string>={welcome:'Welcome to Muster',connect:'Connect a model',folder:'Add a folder',capabilities:'Optional capabilities',done:'You’re ready'};

export function SetupGuide(): React.ReactElement {
  const guide=useSetupGuide();
  const state=useStore();
  const [status,statusError,reload]=useSetupStatus();
  const [progress,setProgress]=useState<SetupProgress|null>(null);
  const primary=useRef<HTMLButtonElement>(null);
  useEffect(()=>{let live=true;void invoke('setup.progress',{}).then(value=>{if(live)setProgress(value);}).catch(()=>undefined);return()=>{live=false;};},[]);
  const step=guide.step;
  const go=(next: SetupStep, extra: Partial<SetupProgress>={})=>{setSetupStep(next);setProgress(current=>current?{...current,...extra,step:next}:current);void saveProgress({...extra,step:next});};
  const later=()=>{void saveProgress({dismissedAt:new Date().toISOString(),step});closeSetupGuide();};
  const skip=()=>{if(!progress)return go(nextStep(step));const next=skipStep({...progress,step});go(next.step,{skipped:next.skipped});};
  const finish=()=>{void saveProgress({completedAt:new Date().toISOString(),step:'done'});closeSetupGuide();};
  const folders=state.snapshot?.folders??[];
  return <ModalSheet open title={STEP_TITLES[step]} className="setup-guide" testId="setup-guide" initialFocus={primary} onClose={()=>{void saveProgress({step});closeSetupGuide();}}>
    <ol className="setup-steps" aria-label={`Step ${stepIndex(step)+1} of ${SETUP_STEPS.length}`}>
      {SETUP_STEPS.map((id,index)=><li key={id} data-state={index<stepIndex(step)?'done':id===step?'current':'next'} aria-current={id===step?'step':undefined}><span className="visually-hidden">{STEP_TITLES[id]}</span></li>)}
    </ol>
    {statusError&&<ResourceState kind="error" compact message="Setup status could not be checked." detail={statusError} onRetry={reload}/>}
    <div className="setup-body" data-step={step}>
      {step==='welcome'&&<WelcomeStep status={status} folders={folders.length}/>}
      {step==='connect'&&<ConnectStep status={status} reload={reload} addConnection={guide.addConnection}/>}
      {step==='folder'&&<FolderStep status={status} folders={folders.map(folder=>folder.name)}/>}
      {step==='capabilities'&&<CapabilitiesStep status={status} reload={reload}/>}
      {step==='done'&&<DoneStep status={status} onDone={finish} folderId={folders[0]?.id}/>}
    </div>
    <footer className="setup-footer">
      {step!=='done'?<button type="button" className="setup-later" onClick={later}>Set up later</button>:<span/>}
      <span className="setup-footer-actions">
        {step!=='welcome'&&<button type="button" onClick={()=>go(previousStep(step))}>Back</button>}
        {step==='capabilities'&&<button type="button" onClick={skip}>Skip</button>}
        {step==='welcome'&&<button ref={primary} type="button" className="is-primary" onClick={()=>go(status&&status.readyProviders.length?'folder':'connect')}>Get started</button>}
        {step==='connect'&&<button ref={primary} type="button" className="is-primary" onClick={()=>go('folder')}>{status?.readyProviders.length?'Continue':'Continue without a model'}</button>}
        {step==='folder'&&<button ref={primary} type="button" className="is-primary" onClick={()=>folders.length?go('capabilities'):skip()}>{folders.length?'Continue':'Skip for now'}</button>}
        {step==='capabilities'&&<button ref={primary} type="button" className="is-primary" onClick={()=>go('done')}>Continue</button>}
        {step==='done'&&<button ref={primary} type="button" className="is-primary" onClick={()=>{finish();openNewChat(folders[0]?{folderId:folders[0].id}:undefined);}}>Start a chat</button>}
      </span>
    </footer>
  </ModalSheet>;
}

function WelcomeStep({status,folders}:{status:SetupStatus|null;folders:number}): React.ReactElement {
  return <>
    <p className="setup-lede">Muster runs coding agents on your own folders using the model accounts you already have. A few steps get you to your first chat; you can skip any of them and come back from Settings › General.</p>
    <ul className="setup-summary" aria-label="Current setup">
      <SummaryLine ok={Boolean(status?.readyProviders.length)} pending={!status} text={!status?'Looking for signed-in models…':status.readyProviders.length?`${status.readyProviders.map(p=>p.name).join(', ')} ready`:'No model is connected yet'}/>
      <SummaryLine ok={folders>0} text={folders?`${folders} ${folders===1?'folder':'folders'} added`:'No folder added yet'}/>
    </ul>
  </>;
}
function SummaryLine({ok,pending,text}:{ok:boolean;pending?:boolean;text:string}): React.ReactElement {
  return <li data-state={pending?'pending':ok?'done':'todo'}>{pending?<LoaderCircle size={14} className="composer-spin" aria-hidden="true"/>:ok?<Check size={14} aria-hidden="true"/>:<CircleDashed size={14} aria-hidden="true"/>}{text}</li>;
}

function cliState(cli: SetupCli): {label:string;tone:'ok'|'warn'|'muted'} {
  if(cli.ready)return {label:'Ready',tone:'ok'};
  if(!cli.installed)return {label:'Not installed',tone:'muted'};
  if(cli.signedIn)return {label:'Signed in · not ready',tone:'warn'};
  if(cli.signInUnknown)return {label:'Sign-in not detected',tone:'warn'};
  return {label:'Not signed in',tone:'warn'};
}

function ConnectStep({status,reload,addConnection}:{status:SetupStatus|null;reload:()=>void;addConnection:boolean}): React.ReactElement {
  const [busy,setBusy]=useState<string|null>(null);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [adding,setAdding]=useState(addConnection);
  const defaultModel=useStore().settings['general.defaultModel'];
  const act=async(key: string, work: ()=>Promise<string|void>)=>{setBusy(key);setError('');setMessage('');try{const text=await work();if(text)setMessage(text);}catch(cause){setError(errorText(cause));}finally{setBusy(null);}};
  const install=(cli: SetupCli)=>act(`install:${cli.tool}`,async()=>{const result=await invoke('providers.cli.update',{tool:cli.tool});reload();if(result.outcome==='failed')throw new Error(result.status.lastError??`${cli.label} could not be installed.`);return result.outcome==='deferred'?`${cli.label} installs when running chats finish.`:`${cli.label} ${result.status.installed.version??''} installed. Sign in next.`;});
  const use=(providerId: string)=>act(`use:${providerId}`,async()=>{const provider=(getState().providers.value??[]).find(p=>p.id===providerId&&p.available);const model=provider?.models[0];if(!provider||!model)throw new Error('That provider is not ready any more. Check again.');await setSetting('general.defaultModel',{providerId:provider.id,model:model.id});return `New chats use ${provider.name} · ${model.name}.`;});
  if(!status)return <ResourceState kind="loading" label="Looking for signed-in models" rows={3}/>;
  const readyIds=new Set(status.readyProviders.map(provider=>provider.id));
  return <>
    <p className="setup-lede">{status.readyProviders.length?'A model is ready. Pick which one new chats use, or connect another.':'Sign in with a CLI you use, or add an API connection. Muster detects the sign-in automatically.'}</p>
    <ul className="setup-list" aria-label="Model providers">
      {status.clis.map(cli=>{const tone=cliState(cli);const providerId=status.readyProviders.find(p=>p.id===PROVIDER_FOR[cli.tool])?.id??status.readyProviders.find(p=>cli.tool==='codex'?/^(openai-direct|hybrow)/.test(p.id):p.id===PROVIDER_FOR[cli.tool])?.id;
        const isDefault=Boolean(providerId&&defaultModel&&typeof defaultModel==='object'&&(defaultModel as {providerId:string}).providerId===providerId);
        return <li key={cli.tool} className="setup-row" data-tool={cli.tool}>
          <ProviderLogo id={PROVIDER_FOR[cli.tool]} name={cli.label} size={18}/>
          <span className="setup-row-copy"><strong>{cli.tool==='codex'?'ChatGPT (Codex CLI)':cli.label}</strong><small>{cli.installed&&cli.version?`${cli.version} · `:''}{cli.account||cli.detail}</small></span>
          <span className={`setup-badge is-${tone.tone}`}>{tone.label}</span>
          <span className="setup-row-actions">
            {!cli.installed&&<button type="button" disabled={busy!==null} onClick={()=>void install(cli)}>{busy===`install:${cli.tool}`?'Installing…':'Install'}</button>}
            {cli.installed&&!cli.ready&&<button type="button" disabled={busy!==null} onClick={()=>void act(`login:${cli.tool}`,()=>startSignIn(cli.tool,cli.loginCommand))}><SquareTerminal size={13} aria-hidden="true"/>Sign in</button>}
            {cli.ready&&providerId&&(isDefault?<span className="setup-default"><Check size={13} aria-hidden="true"/>Default</span>:<button type="button" disabled={busy!==null} onClick={()=>void use(providerId)}>Use for new chats</button>)}
          </span>
          {cli.installed&&!cli.ready&&<code className="setup-command">{cli.loginCommand}<button type="button" className="icon-button" aria-label={`Copy ${cli.loginCommand}`} onClick={()=>void copyText(cli.loginCommand).then(()=>setMessage('Copied.'))}><Copy size={12}/></button></code>}
        </li>;})}
      {status.connections.map(row=><li key={row.id} className="setup-row">
        <ProviderLogo id={row.id} name={row.name} size={18}/>
        <span className="setup-row-copy"><strong>{row.name}</strong><small>{row.kind==='gateway'?'Gateway':row.kind==='env'?'API key in your shell environment':'Connection added in Muster'} · {row.detail}</small></span>
        <span className={`setup-badge is-${row.ready?'ok':'warn'}`}>{row.ready?'Ready':'Not ready'}</span>
        <span className="setup-row-actions">{row.ready&&readyIds.has(row.id)&&<button type="button" disabled={busy!==null} onClick={()=>void use(row.id)}>Use for new chats</button>}</span>
      </li>)}
    </ul>
    {adding?<ApiConnectionForm onDone={text=>{setAdding(false);setMessage(text);reload();}} onCancel={()=>setAdding(false)}/>
      :<div className="setup-inline-actions"><button type="button" onClick={()=>setAdding(true)}><KeyRound size={13} aria-hidden="true"/>Add an API connection</button>
        <button type="button" disabled={busy!==null} onClick={()=>void act('refresh',async()=>{await invoke('setup.refresh',{});reload();})}><RefreshCw size={13} aria-hidden="true"/>{busy==='refresh'?'Checking…':'Check again'}</button>
        <button type="button" onClick={()=>{closeSetupGuide();openAppSettings('providers');void loadProviders(true);}}>All provider options</button></div>}
    {message&&<p className="setup-note" role="status">{message}</p>}
    {error&&<p className="setup-error" role="alert">{error}</p>}
  </>;
}

/** An OpenAI-compatible endpoint (a gateway, a local server or a hosted API) with an optional key kept in the Keychain. */
function ApiConnectionForm({onDone,onCancel}:{onDone:(message: string)=>void;onCancel:()=>void}): React.ReactElement {
  const [name,setName]=useState('');const [endpoint,setEndpoint]=useState('');const [key,setKey]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const first=useRef<HTMLInputElement>(null);
  useEffect(()=>{first.current?.focus();},[]);
  const submit=async(event: React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const saved=await invoke('providers.save',{name:name.trim(),endpoint:endpoint.trim()});
      if(key.trim())await invoke('providers.secret.set',{providerId:saved.id,value:key});
      setKey('');
      const checked=await invoke('providers.check',{id:saved.id}).catch(cause=>({...saved,available:false,error:errorText(cause)}) as ProviderInfo);
      await invoke('setup.refresh',{}).catch(()=>undefined);
      onDone(checked.available?`${saved.name} connected · ${checked.models.length} ${checked.models.length===1?'model':'models'} available.`:`${saved.name} saved, but it is not ready: ${checked.error??'no models were reported.'}`);
    }catch(cause){setError(errorText(cause));}finally{setBusy(false);}
  };
  return <form className="setup-form" aria-label="Add an API connection" onSubmit={event=>void submit(event)}>
    <label>Name<input ref={first} required maxLength={100} value={name} onChange={event=>setName(event.target.value)} placeholder="My gateway"/></label>
    <label>API base URL<input required type="url" maxLength={2048} value={endpoint} onChange={event=>setEndpoint(event.target.value)} placeholder="https://api.example.com/v1"/></label>
    <label>API key <span className="setup-optional">optional</span><input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event=>setKey(event.target.value)}/></label>
    <p className="setup-help">OpenAI-compatible endpoints only. The key is encrypted with the macOS Keychain and never shown again.</p>
    {error&&<p className="setup-error" role="alert">{error}</p>}
    <div className="setup-inline-actions"><button type="submit" className="is-primary" disabled={busy}>{busy?'Connecting…':'Connect'}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function FolderStep({status,folders}:{status:SetupStatus|null;folders:string[]}): React.ReactElement {
  const [busy,setBusy]=useState(false);
  return <>
    <p className="setup-lede">Agents read and change files inside a folder you choose. Add a project folder, or clone a repository.</p>
    {folders.length>0&&<ul className="setup-summary" aria-label="Folders">{folders.slice(0,4).map(name=><SummaryLine key={name} ok text={name}/>)}{folders.length>4&&<li>and {folders.length-4} more</li>}</ul>}
    <div className="setup-inline-actions">
      <button type="button" className={folders.length?undefined:'is-primary'} disabled={busy} onClick={()=>{setBusy(true);void pickFolder().finally(()=>setBusy(false));}}><FolderPlus size={13} aria-hidden="true"/>{busy?'Choosing…':folders.length?'Add another folder…':'Add a folder…'}</button>
      <button type="button" disabled={status?.git.available===false} title={status?.git.available===false?status.git.detail:undefined} onClick={()=>{void saveProgress({step:'folder'});closeSetupGuide();reopenAfterClone();openCloneSheet();}}><GitBranch size={13} aria-hidden="true"/>Clone a repository…</button>
    </div>
    {status&&!status.git.available&&<p className="setup-note">{status.git.detail}</p>}
  </>;
}
/** Cloning uses its own sheet; the guide comes back on the folder step once the clone adds a folder. */
function reopenAfterClone(): void {
  const before=getState().snapshot?.folders.length??0;
  let tries=0;
  const timer=setInterval(()=>{
    tries++;
    if((getState().snapshot?.folders.length??0)>before){clearInterval(timer);openSetupGuide('folder');}
    else if(tries>600)clearInterval(timer);
  },1000);
}

function CapabilitiesStep({status,reload}:{status:SetupStatus|null;reload:()=>void}): React.ReactElement {
  const permissions=usePermissions();
  const notifications=useStore().settings['notifications.runs'];
  const [error,setError]=useState('');
  const open=(pane: 'screen'|'accessibility'|'notifications')=>{setError('');void invoke('setup.openSystemSettings',{pane}).catch(cause=>setError(errorText(cause)));};
  const perm=(value: string|undefined)=>value==='granted'?{label:'On',tone:'ok'}:value==='denied'?{label:'Off',tone:'warn'}:value==='restricted'?{label:'Restricted',tone:'warn'}:{label:'Not checked',tone:'muted'};
  const docker=status?.docker;
  return <>
    <p className="setup-lede">None of these are needed to chat. Each shows its real status; Muster never turns a permission on for you.</p>
    <ul className="setup-list" aria-label="Optional capabilities">
      <li className="setup-row"><span className="setup-row-copy"><strong>Sandbox (Docker)</strong><small>{docker?.detail??'Checking Docker…'}</small></span>
        <span className={`setup-badge is-${docker?.running?'ok':docker?.installed?'warn':'muted'}`}>{!docker?'Checking':docker.running?'Running':docker.installed?'Not running':'Not installed'}</span>
        <span className="setup-row-actions">{docker&&!docker.installed&&<button type="button" onClick={()=>void invoke('link.open',{url:DOCKER_URL}).catch(cause=>setError(errorText(cause)))}><ExternalLink size={13} aria-hidden="true"/>Get Docker Desktop</button>}
          {docker&&!docker.running&&<button type="button" onClick={reload}><RefreshCw size={13} aria-hidden="true"/>Check again</button>}</span></li>
      {(['screen','accessibility'] as const).map(pane=>{const state=perm(permissions?.[pane]);return <li key={pane} className="setup-row">
        <span className="setup-row-copy"><strong>{pane==='screen'?'Screen Recording':'Accessibility'}</strong><small>{pane==='screen'?'Lets the agent see windows during computer use.':'Lets the agent click and type during computer use.'}</small></span>
        <span className={`setup-badge is-${state.tone}`}>{state.label}</span>
        <span className="setup-row-actions">{permissions?.platform==='darwin'&&permissions[pane]!=='granted'&&<button type="button" onClick={()=>open(pane)}>Open System Settings</button>}</span></li>;})}
      <li className="setup-row"><span className="setup-row-copy"><strong>Notifications</strong><small>{notifications==='off'?'Run notifications are off in Muster (Settings › General).':'macOS asks the first time Muster notifies. Muster cannot read the answer without asking, so review it in System Settings.'}</small></span>
        <span className="setup-badge is-muted">{notifications==='off'?'Off in Muster':'Asked on first use'}</span>
        <span className="setup-row-actions">{permissions?.platform==='darwin'&&<button type="button" onClick={()=>open('notifications')}>Open System Settings</button>}</span></li>
    </ul>
    {error&&<p className="setup-error" role="alert">{error}</p>}
  </>;
}
function usePermissions(): ComputerPermissions|null {
  const [value,setValue]=useState<ComputerPermissions|null>(null);
  useEffect(()=>{
    let live=true;
    const read=()=>void invoke('computer.permissions',undefined).then(result=>{if(live)setValue(result);}).catch(()=>undefined);
    read();window.addEventListener('focus',read);
    return()=>{live=false;window.removeEventListener('focus',read);};
  },[]);
  return value;
}

function DoneStep({status,onDone,folderId}:{status:SetupStatus|null;onDone:()=>void;folderId?:string}): React.ReactElement {
  const start=(prompt: string)=>{onDone();openNewChat(folderId?{folderId}:undefined);setNewChatText(prompt);};
  return <>
    <p className="setup-lede">{status?.readyProviders.length?'Pick a starter or write your own. The draft waits for you to send it.':'You can draft now; connect a model before sending (Settings › General › Setup checklist).'}</p>
    <div className="setup-chips" role="group" aria-label="Starter prompts">
      {SETUP_SUGGESTIONS.map(item=><button key={item.label} type="button" className="setup-chip" onClick={()=>start(item.prompt)}><MessageSquarePlus size={13} aria-hidden="true"/>{item.label}</button>)}
    </div>
  </>;
}

/** Settings › General: live status per item, and the way back into the guide. */
export function SetupChecklist(): React.ReactElement {
  const [status,error,reload]=useSetupStatus();
  const state=useStore();
  const permissions=usePermissions();
  useEffect(()=>subscribe(event=>{if(event.type==='providersChanged')reload();}),[reload]);
  const items=setupChecklist(status,{folders:state.snapshot?.folders.length??0,permissions,notifications:state.settings['notifications.runs']});
  const icon=(item: ChecklistItem)=>item.state==='done'?<Check size={14} aria-hidden="true"/>:item.state==='todo'?<CircleAlert size={14} aria-hidden="true"/>:<CircleDashed size={14} aria-hidden="true"/>;
  return <div className="setup-checklist" data-testid="setup-checklist">
    {error&&<ResourceState kind="error" compact message="Setup status could not be checked." detail={error} onRetry={reload}/>}
    <ul aria-label="Setup checklist">{items.map(item=><li key={item.id} data-state={item.state}>{icon(item)}<span><strong>{item.label}</strong><small>{item.detail}</small></span>
      {item.state!=='done'&&<button type="button" className="settings-button secondary" onClick={()=>openSetupGuide(item.step)}>{item.state==='todo'?'Set up':'Review'}</button>}</li>)}</ul>
    <div className="setup-inline-actions"><button type="button" className="settings-button" onClick={()=>{void saveProgress({dismissedAt:null});openSetupGuide(resumeStep({step:'welcome',startedAt:null,completedAt:null,dismissedAt:null,skipped:[]}));}}>Open setup guide</button>
      <button type="button" className="settings-button secondary" onClick={reload}><RefreshCw size={13} aria-hidden="true"/>Check again</button></div>
  </div>;
}

/** Shown in place of a raw send error when no provider can run a chat. */
export function ConnectModelPrompt({emphasis=false}:{emphasis?:boolean}): React.ReactElement {
  const [busy,setBusy]=useState(false);
  const [note,setNote]=useState('');
  const signIn=async()=>{
    setBusy(true);setNote('');
    try{
      const codex=(lastStatus??await refreshSetupStatus()).clis.find(cli=>cli.tool==='codex');
      if(!codex?.installed){openSetupGuide('connect');return;}
      setNote(await startSignIn('codex',codex.loginCommand));
    }catch(cause){notifyError(cause);}finally{setBusy(false);}
  };
  return <div className="connect-model-prompt" role="status" data-testid="connect-model-prompt" data-emphasis={emphasis||undefined}>
    <span className="connect-model-copy"><strong>Connect a model to start</strong><small>{note||'Sign in with ChatGPT through the Codex CLI, or add an API connection. Your draft is kept.'}</small></span>
    <span className="connect-model-actions">
      <button type="button" className="is-primary" disabled={busy} onClick={()=>void signIn()}>{busy?'Opening…':'Sign in with ChatGPT'}</button>
      <button type="button" onClick={()=>openSetupGuide('connect',{addConnection:true})}>Add API connection</button>
      <button type="button" onClick={()=>openSetupGuide('connect')}>More options</button>
    </span>
  </div>;
}
/** True once providers loaded and none can run a chat. */
export function useNoProvider(): boolean {
  const providers=useStore().providers;
  return providers.phase==='ready'&&!(providers.value??[]).some(provider=>provider.available);
}
