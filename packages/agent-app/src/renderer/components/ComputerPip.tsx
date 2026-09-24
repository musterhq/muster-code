/** Codex-style computer-use picture-in-picture (CUA-01/02/03/07/09) and the right-pane screenshot viewer (CUA-06). */
import React,{useEffect,useMemo,useState} from 'react';
import {AppWindow,Download,ExternalLink,Eye,Globe,Hand,Minimize2,Paperclip,Play,Square,X} from 'lucide-react';
import {invoke} from '../bridge';
import {getState,notifyError,notifySuccess,openTab,stopChat} from '../store';
import {useStoreSelector} from '../useStore';
import {stageAttachment} from '../composerBridge';
import {rememberProfile} from './BrowserTab';
import {ImageFile} from './ImageFile';
import type {ComputerPermissions} from '../../shared/domains/computer-protocol';
import {PIP_STACK_MAX,STACK_PEEK,STACK_WIDTH,closeViewer,formatAge,frameFreshness,hostOf,mergeSources,openViewer,pipShouldShow,recentComputerSources,screenshotName,setDocked,setMinimized,sourceKey,stackAnchor,stackHeight,stackWidth,toolImageUrl,useComputerUi,wireComputerEvents,type Box,type Freshness,type PipSource} from '../computerUse';
import {AppGlyph} from './AppGlyph';
import './pip.css';
import {Tip} from './Tooltip';

const loadImage=(id:string)=>invoke('computer.image',{id});
const FRESH_LABEL:Record<Freshness,string>={live:'Live',stale:'Stale',disconnected:'Disconnected',ended:'Ended'};

/** The data URL of a source's picture; undefined while it loads or when there is none. */
function useShotUrl(source:PipSource|undefined):string|undefined {
  const shot=source?.image,key=shot?.dataUrl??shot?.id;
  const [url,setUrl]=useState<string>();
  useEffect(()=>{
    if(!shot){setUrl(undefined);return;}
    let live=true;
    toolImageUrl(shot,loadImage).then(value=>{if(live)setUrl(value);},()=>{if(live)setUrl(undefined);});
    return()=>{live=false;};
  },[key]);
  return shot?.dataUrl??url;
}
/** The chat's recently used apps and pages (pushed browser frames and transcript steps), newest first. */
function useChatSources(chatId:string|null):{sources:PipSource[];source?:PipSource;running:boolean} {
  const ui=useComputerUi();
  const items=useStoreSelector(state=>chatId?state.timelines[chatId]?.value:undefined);
  const status=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.status);
  const steps=useMemo(()=>items?recentComputerSources(items):[],[items]);
  const recent=chatId?ui.recentFrames[chatId]:undefined,latest=chatId?ui.frames[chatId]:undefined;
  const frames=useMemo(()=>recent??(latest?[latest]:[]),[recent,latest]);
  const sources=useMemo(()=>chatId?mergeSources(frames,steps):[],[chatId,frames,steps]);
  return {sources,source:sources[0],running:status==='running'||status==='stopping'};
}
/** The newest source of one chat, for the right-pane live viewer. */
function useChatSource(chatId:string|null):{source?:PipSource;running:boolean} {
  const {source,running}=useChatSources(chatId);
  return {source,running};
}
function useNow(active:boolean,everyMs=1000):number {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active)return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),everyMs);return()=>window.clearInterval(timer);},[active,everyMs]);
  return now;
}

/** Opens the page the agent is looking at in the in-app browser: its own tab when one exists, else a new tab. */
export function visitSource(source:PipSource):void {
  const state=getState();
  if(source.owner&&source.profileId){
    rememberProfile(source.owner,source.profileId);
    const existing=state.tabs.find(tab=>tab.id===source.owner);
    openTab(existing??{id:source.owner,kind:'browser',browserProfileId:source.profileId,url:source.url??'about:blank',title:source.app||'Agent browser',chatId:source.chatId});
    return;
  }
  if(source.url) openTab({id:`browser:${crypto.randomUUID()}`,kind:'browser',browserProfileId:'personal',url:source.url,title:hostOf(source.url)||'Browser',chatId:source.chatId});
}
async function focusApp(app:string):Promise<void> { try{await invoke('computer.focusApp',{app});}catch(cause){notifyError(cause);} }
async function attachShot(source:PipSource,dataUrl:string):Promise<void> {
  const mime=source.image?.mime||dataUrl.slice(5,dataUrl.indexOf(';'))||'image/png',name=screenshotName(source,mime);
  try {
    const ref=await stageAttachment({chatId:source.chatId,name,mime,dataBase64:dataUrl.slice(dataUrl.indexOf(',')+1)});
    const taken=!window.dispatchEvent(new CustomEvent('muster:composer-add-context',{detail:{id:`computer-shot:${ref.id}`,chatId:source.chatId,type:'image',label:`Screenshot · ${source.app||source.label}`,source:{kind:'computer',app:source.app,url:source.url??''},attachment:ref,dataUrl},cancelable:true}));
    notifySuccess(taken?'Screenshot added to the chat.':'Screenshot saved to this chat. It appears in the composer when you reopen the chat.');
  } catch(cause){notifyError(cause);}
}
function exportShot(source:PipSource,dataUrl:string):void {
  const a=document.createElement('a');a.href=dataUrl;a.download=screenshotName(source,source.image?.mime);a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
}
/** CUA-07: what macOS lets the computer-use helpers do; polled only while a desktop target is in view. */
function usePermissions(active:boolean):ComputerPermissions|undefined {
  const [perms,setPerms]=useState<ComputerPermissions>();
  useEffect(()=>{
    if(!active)return;let live=true;
    const probe=()=>void invoke('computer.permissions',undefined).then(value=>{if(live)setPerms(value);},()=>{});
    probe();const timer=window.setInterval(probe,15_000);
    return()=>{live=false;window.clearInterval(timer);};
  },[active]);
  return perms;
}
function PermissionNotice({perms}:{perms:ComputerPermissions|undefined}) {
  if(!perms||perms.platform!=='darwin')return null;
  const denied=(['accessibility','screen'] as const).filter(pane=>perms[pane]==='denied'||perms[pane]==='restricted');
  if(!denied.length)return null;
  return <div className="pip-permission" role="alert">
    <span>{denied.map(pane=>pane==='screen'?'Screen Recording':'Accessibility').join(' and ')} {denied.length>1?'are':'is'} off for Muster, so the agent cannot {denied.includes('screen')?'see':'control'} the screen.</span>
    {denied.map(pane=><button key={pane} type="button" className="pip-link" onClick={()=>void invoke('computer.openPermissionSettings',{pane}).catch(notifyError)}>Open {pane==='screen'?'Screen Recording':'Accessibility'} settings</button>)}
  </div>;
}

function ControlButtons({source,owner,running,compact=false}:{source:PipSource;owner:'agent'|'user';running:boolean;compact?:boolean}) {
  const [busy,setBusy]=useState(false);
  const setOwner=async(next:'agent'|'user')=>{setBusy(true);try{await invoke('computer.control',{chatId:source.chatId,owner:next});}catch(cause){notifyError(cause);}finally{setBusy(false);}};
  return <>
    {owner==='agent'
      ?<button type="button" className="pip-action" disabled={busy} title="Pause the agent's input and drive the browser yourself" onClick={()=>void setOwner('user')}><Hand size={12}/>{compact?null:'Take control'}</button>
      :<button type="button" className="pip-action is-primary" disabled={busy} title="Hand control back to the agent" onClick={()=>void setOwner('agent')}><Play size={12}/>{compact?null:'Hand back'}</button>}
    {running&&<button type="button" className="pip-action" title="Stop this run" onClick={()=>void stopChat(source.chatId)}><Square size={12}/>{compact?null:'Stop'}</button>}
  </>;
}

/** Where the stack sits now: measured from the summary card and the conversation (see stackAnchor). */
const rectOf=(el:Element|null|undefined):Box|undefined=>{
  if(!el)return undefined;const r=el.getBoundingClientRect();
  return r.width>0&&r.height>0?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:undefined;
};
function measureStack(count:number):{right:number;top:number;width:number} {
  if(typeof document==='undefined')return {right:14,top:56,width:STACK_WIDTH};
  const center=document.querySelector<HTMLElement>('main.center')??document.querySelector<HTMLElement>('.center');
  const card=rectOf(center?.querySelector('.summary-card:not([hidden])')),box=rectOf(center);
  const css=center?getComputedStyle(center):undefined;
  const px=(name:string,fallback:number)=>{const value=parseFloat(css?.getPropertyValue(name)??'');return Number.isFinite(value)?value:fallback;};
  const width=stackWidth(card);
  return {...stackAnchor(box,card,{top:px('--summary-top',56),bottom:px('--summary-bottom',16)},{width,height:stackHeight(width,count)},window.innerWidth),width};
}
function useStackAnchor(active:boolean,count:number) {
  const [anchor,setAnchor]=useState(()=>measureStack(count));
  useEffect(()=>{
    if(!active)return;
    const update=()=>setAnchor(prev=>{const next=measureStack(count);return prev.right===next.right&&prev.top===next.top&&prev.width===next.width?prev:next;});
    update();
    window.addEventListener('resize',update);
    // The summary card folds, grows and hides without a window resize; a light poll follows it.
    const timer=window.setInterval(update,700);
    const center=document.querySelector('main.center');
    const observer=typeof ResizeObserver==='undefined'||!center?undefined:new ResizeObserver(update);
    if(center)observer?.observe(center);
    return()=>{window.removeEventListener('resize',update);window.clearInterval(timer);observer?.disconnect();};
  },[active,count]);
  return anchor;
}

/** One live thumbnail in the stack: frameless, the newest in front, older ones peeking above it. */
function PipCard({source,depth,count,freshness,owner,now}:{source:PipSource;depth:number;count:number;freshness:Freshness;owner:'agent'|'user';now:number}) {
  const url=useShotUrl(source);
  const front=depth===0,title=sourceTitle(source);
  const age=source.at?formatAge(now-source.at):'';
  const status=front&&source.failed?'failed':front&&(freshness==='stale'||freshness==='disconnected')?freshness:undefined;
  const tip=[title,source.failed?`Failed: ${source.failed}`:source.label,front&&age?`Last frame ${age}`:''].filter(Boolean).join(' · ');
  const open=()=>{if(front){openViewer({chatId:source.chatId,live:true});setDocked(true);}else openViewer({chatId:source.chatId,live:false,source});};
  return <button type="button" className={`pip-card${front?' is-front':''}${front&&owner==='user'?' is-user':''}`} style={{'--depth':depth,zIndex:count-depth} as React.CSSProperties}
    title={tip} aria-label={`Open ${title} full size: ${source.failed?`failed, ${source.failed}`:source.label}`} data-status={status} onClick={open}>
    {url?<img src={url} alt="" draggable={false} decoding="async"/>:<span className="pip-empty"><AppGlyph app={source.app} target={source.target} size={26}/></span>}
    {status&&<span className={`pip-card-status is-${status}`} aria-hidden="true"/>}
  </button>;
}
const sourceTitle=(source:PipSource)=>source.target==='browser'?(source.url?hostOf(source.url):source.app&&source.app!=='Browser'?source.app:'Browser'):source.app||'Computer';

/** Codex-style picture-in-picture: a frameless stack of live window thumbnails at the conversation's right,
 *  under the summary card; one card per app or page the agent used lately, the newest in front. */
export function ComputerPip() {
  const chatId=useStoreSelector(state=>state.activeChatId);
  const screen=useStoreSelector(state=>state.screen);
  const ui=useComputerUi();
  const {sources,source,running}=useChatSources(chatId);
  // RUN-X1: the agent's browser tab shows in the right pane as soon as it opens, for the chat the user is looking at.
  useEffect(()=>wireComputerEvents(event=>{
    if(event.type!=='computerBrowserOpened'||event.chatId!==getState().activeChatId)return;
    visitSource({chatId:String(event.chatId),target:'browser',app:hostOf(String(event.url)),label:'',at:Date.now(),owner:String(event.owner),profileId:String(event.profileId),url:String(event.url)});
  }),[]);
  const now=useNow(!!source);
  const shown=screen==='work'&&!ui.docked&&pipShouldShow(source,running,now);
  const perms=usePermissions(shown&&sources.some(card=>card.target==='computer'));
  const cards=useMemo(()=>sources.slice(0,PIP_STACK_MAX),[sources]);
  const anchor=useStackAnchor(shown,ui.minimized?1:cards.length);
  const [busy,setBusy]=useState(false);
  if(!shown||!source)return null;
  const owner=ui.control[source.chatId]??'agent';
  const freshness=frameFreshness(now-source.at,running);
  const title=sourceTitle(source);
  const setOwner=async(next:'agent'|'user')=>{setBusy(true);try{await invoke('computer.control',{chatId:source.chatId,owner:next});}catch(cause){notifyError(cause);}finally{setBusy(false);}};
  if(ui.minimized) return <button type="button" className={`pip-pill is-${freshness}`} style={{top:anchor.top,right:anchor.right}} title={`Show the live view · ${source.label}`} aria-label={`Show computer use: ${source.label}`} onClick={()=>setMinimized(false)}>
    <span className="pip-dot" aria-hidden="true"/><AppGlyph app={source.app} target={source.target} size={14}/><span className="pip-pill-title">{title}</span>{cards.length>1&&<span className="pip-pill-count">+{cards.length-1}</span>}
  </button>;
  const peek=STACK_PEEK*(cards.length-1);
  return <div className={`pip-stack is-${freshness}`} style={{top:anchor.top,right:anchor.right,width:anchor.width}} role="region" aria-label={`Computer use: ${cards.map(sourceTitle).join(', ')}`} data-owner={owner} data-count={cards.length}>
    <div className="pip-cards" style={{height:stackHeight(anchor.width,cards.length)}}>
      {cards.map((card,depth)=><PipCard key={sourceKey(card)} source={card} depth={depth} count={cards.length} freshness={freshness} owner={owner} now={now}/>)}
    </div>
    <div className="pip-controls" style={{top:peek+6}}>
      <Tip label="Hide the live view"><button type="button" className="pip-control" aria-label="Hide the live view" onClick={()=>setMinimized(true)}><X size={12} strokeWidth={2.2}/></button></Tip>
      {owner==='agent'
        ?<Tip label="Take control"><button type="button" className="pip-control" aria-label="Take control" disabled={busy} onClick={()=>void setOwner('user')}><Hand size={12} strokeWidth={2.2}/></button></Tip>
        :<Tip label="Hand control back to the agent"><button type="button" className="pip-control is-user" aria-label="Hand control back" disabled={busy} onClick={()=>void setOwner('agent')}><Play size={12} strokeWidth={2.2}/></button></Tip>}
    </div>
    <PermissionNotice perms={perms}/>
  </div>;
}

/** Right-pane viewer: the live feed (docked PiP) or one transcript screenshot, with zoom, Visit/Open app, attach and export. */
export function ComputerViewer() {
  const ui=useComputerUi();
  const target=ui.viewer;
  const live=useChatSource(target?.live?target.chatId:null);
  const source=target?.live?live.source:target?.source;
  const url=useShotUrl(source);
  const now=useNow(!!target?.live);
  useEffect(()=>wireComputerEvents(),[]);
  const perms=usePermissions(!!source&&source.target==='computer');
  if(!target)return null;
  const owner=source?ui.control[source.chatId]??'agent':'agent';
  const freshness=source&&target.live?frameFreshness(now-source.at,live.running):'ended';
  const title=source?.app||(source?.target==='browser'?'Browser':'Computer');
  return <section className="computer-viewer" aria-label={target.live?'Live computer use':'Screenshot'}>
    <header className="computer-viewer-head">
      {source?.target==='browser'?<Globe size={13} aria-hidden="true"/>:<AppWindow size={13} aria-hidden="true"/>}
      <span className="computer-viewer-title" title={source?.url||title}>{title}</span>
      {target.live&&<span className={`pip-fresh is-${freshness}`}>{FRESH_LABEL[freshness]}{source&&(freshness==='stale'||freshness==='disconnected')?` · ${formatAge(now-source.at)}`:''}</span>}
      <span className="computer-viewer-spacer"/>
      {target.live&&source&&<ControlButtons source={source} owner={owner} running={live.running} compact/>}
      {target.live&&<Tip label="Back to picture-in-picture"><button type="button" className="icon-button" aria-label="Undock to picture-in-picture" onClick={()=>{setDocked(false);closeViewer();}}><Minimize2 size={13}/></button></Tip>}
      <Tip label="Close"><button type="button" className="icon-button" aria-label="Close" onClick={closeViewer}><X size={13}/></button></Tip>
    </header>
    {source&&<div className="computer-viewer-bar">
      <span className={`computer-viewer-label${source.failed?' is-error':''}`}>{source.failed?`Failed: ${source.failed}`:source.label}</span>
      {(source.url||source.owner)&&<button type="button" className="pip-action" onClick={()=>visitSource(source)} title={source.url}><ExternalLink size={12}/>Visit</button>}
      {source.target==='computer'&&source.app&&<button type="button" className="pip-action" onClick={()=>void focusApp(source.app)}><AppWindow size={12}/>Open {source.app}</button>}
      <button type="button" className="pip-action" disabled={!url} onClick={()=>url&&void attachShot(source,url)}><Paperclip size={12}/>Attach</button>
      <button type="button" className="pip-action" disabled={!url} onClick={()=>url&&exportShot(source,url)}><Download size={12}/>Export</button>
    </div>}
    <PermissionNotice perms={perms}/>
    {source&&url
      ?<ImageFile key={url.length+':'+(source.image?.id??source.at)} asset={{dataUrl:url,mime:source.image?.mime||'image/png',size:source.image?.bytes??Math.round((url.length-url.indexOf(','))*0.75),width:source.image?.width??0,height:source.image?.height??0}} name={source.label}/>
      :<div className="computer-viewer-empty" role="status"><Eye size={16} aria-hidden="true"/>{source?'Loading the screenshot…':'No computer-use activity in this chat yet.'}</div>}
  </section>;
}
