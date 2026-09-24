/** Codex-style computer-use picture-in-picture (CUA-01/02/03/07/09) and the right-pane screenshot viewer (CUA-06). */
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AppWindow,Download,ExternalLink,Eye,EyeOff,Globe,Hand,Maximize2,Minimize2,PanelRight,Paperclip,Play,Square,X} from 'lucide-react';
import {invoke} from '../bridge';
import {getState,notifyError,notifySuccess,openTab,stopChat} from '../store';
import {useStoreSelector} from '../useStore';
import {stageAttachment} from '../composerBridge';
import {rememberProfile} from './BrowserTab';
import {ImageFile} from './ImageFile';
import type {ComputerPermissions} from '../../shared/domains/computer-protocol';
import {PIP_MAX,PIP_MIN,clampPipWidth,closeViewer,cornerPosition,formatAge,frameFreshness,hostOf,latestComputerShot,openViewer,pickSource,pipShouldShow,screenshotName,setDocked,setMinimized,setPlacement,snapCorner,toolImageUrl,useComputerUi,wireComputerEvents,type Freshness,type PipSource} from '../computerUse';
import './pip.css';
import {Tip} from './Tooltip';

const INSET={top:12,right:16,bottom:12,left:16};
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
/** The newest source of one chat: a pushed browser frame or the transcript's newest computer-use step. */
function useChatSource(chatId:string|null):{source?:PipSource;running:boolean} {
  const ui=useComputerUi();
  const items=useStoreSelector(state=>chatId?state.timelines[chatId]?.value:undefined);
  const status=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.status);
  const shot=useMemo(()=>items?latestComputerShot(items):undefined,[items]);
  return {source:chatId?pickSource(ui.frames[chatId],shot):undefined,running:status==='running'||status==='stopping'};
}
function useNow(active:boolean,everyMs=1000):number {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active)return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),everyMs);return()=>window.clearInterval(timer);},[active,everyMs]);
  return now;
}
const conversationArea=()=>{const el=document.querySelector<HTMLElement>('.center .chat')??document.querySelector<HTMLElement>('.chat');const r=el?.getBoundingClientRect();return r&&r.width>0?{left:r.left,top:r.top,width:r.width,height:r.height}:{left:0,top:0,width:window.innerWidth,height:window.innerHeight};};

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

/** Floating live thumbnail over the conversation; one per window, showing the active chat's own activity. */
export function ComputerPip() {
  const chatId=useStoreSelector(state=>state.activeChatId);
  const screen=useStoreSelector(state=>state.screen);
  const ui=useComputerUi();
  const {source,running}=useChatSource(chatId);
  // RUN-X1: the agent's browser tab shows in the right pane as soon as it opens, for the chat the user is looking at.
  useEffect(()=>wireComputerEvents(event=>{
    if(event.type!=='computerBrowserOpened'||event.chatId!==getState().activeChatId)return;
    visitSource({chatId:String(event.chatId),target:'browser',app:hostOf(String(event.url)),label:'',at:Date.now(),owner:String(event.owner),profileId:String(event.profileId),url:String(event.url)});
  }),[]);
  const now=useNow(!!source);
  const shown=screen==='work'&&!ui.docked&&pipShouldShow(source,running,now);
  const url=useShotUrl(shown?source:undefined);
  const perms=usePermissions(shown&&source?.target==='computer');
  const ref=useRef<HTMLElement>(null);
  const [size,setSize]=useState({width:ui.placement.width,height:Math.round(ui.placement.width*0.625)+30});
  const [dragging,setDragging]=useState<{x:number;y:number}|null>(null);
  const [area,setArea]=useState(conversationArea);
  useEffect(()=>{if(!shown)return;const update=()=>setArea(conversationArea());update();window.addEventListener('resize',update);const timer=window.setInterval(update,1500);return()=>{window.removeEventListener('resize',update);window.clearInterval(timer);};},[shown]);
  useEffect(()=>{const el=ref.current;if(!el||!shown)return;const observer=new ResizeObserver(entries=>{const box=entries[0]?.contentRect;if(box)setSize({width:Math.round(box.width),height:Math.round(box.height)});});observer.observe(el);return()=>observer.disconnect();},[shown,ui.minimized]);
  const drag=useRef<{startX:number;startY:number;originX:number;originY:number;moved:boolean}|null>(null);
  const resize=useRef<{startX:number;width:number}|null>(null);
  const position=useMemo(()=>cornerPosition(ui.placement.corner,area,size,INSET),[ui.placement.corner,area,size]);
  const onHeadPointerDown=(event:React.PointerEvent)=>{
    if(event.button!==0||(event.target as HTMLElement).closest('button'))return;
    drag.current={startX:event.clientX,startY:event.clientY,originX:position.x,originY:position.y,moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeadPointerMove=(event:React.PointerEvent)=>{
    const d=drag.current;if(!d)return;
    const dx=event.clientX-d.startX,dy=event.clientY-d.startY;
    if(!d.moved&&Math.hypot(dx,dy)<4)return;
    d.moved=true;setDragging({x:d.originX+dx,y:d.originY+dy});
  };
  const onHeadPointerUp=(event:React.PointerEvent)=>{
    const d=drag.current;drag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(!d?.moved){setDragging(null);return;}
    const center={x:d.originX+(event.clientX-d.startX)+size.width/2,y:d.originY+(event.clientY-d.startY)+size.height/2};
    setPlacement({corner:snapCorner(center,area)});setDragging(null);
  };
  const onResizePointerDown=(event:React.PointerEvent)=>{event.stopPropagation();resize.current={startX:event.clientX,width:ui.placement.width};event.currentTarget.setPointerCapture(event.pointerId);};
  const onResizePointerMove=(event:React.PointerEvent)=>{const r=resize.current;if(!r)return;const sign=ui.placement.corner.endsWith('right')?-1:1;setPlacement({width:clampPipWidth(r.width+sign*(event.clientX-r.startX))});};
  const onResizePointerUp=(event:React.PointerEvent)=>{resize.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  const openFull=useCallback(()=>{if(source)openViewer({chatId:source.chatId,live:true});},[source]);
  if(!shown||!source)return null;
  const owner=ui.control[source.chatId]??'agent';
  const freshness=frameFreshness(now-source.at,running);
  const title=source.app||(source.target==='browser'?'Browser':'Computer');
  const style:React.CSSProperties=dragging?{left:dragging.x,top:dragging.y,width:ui.placement.width}:{left:position.x,top:position.y,width:ui.placement.width};
  if(ui.minimized) return <button type="button" ref={ref as React.RefObject<HTMLButtonElement|null>} className={`pip-pill is-${freshness}`} style={{left:position.x,top:position.y}} title="Show the live view" aria-label={`Show computer use: ${source.label}`} onClick={()=>setMinimized(false)}>
    <span className="pip-dot" aria-hidden="true"/><span className="pip-pill-title">{title}</span><span className="pip-pill-label">{source.label}</span>
  </button>;
  return <div ref={ref as React.RefObject<HTMLDivElement|null>} className={`pip is-${freshness}${dragging?' is-dragging':''} corner-${ui.placement.corner}`} style={style} role="region" aria-label={`Computer use: ${title}`} data-owner={owner}>
    <div className="pip-head" onPointerDown={onHeadPointerDown} onPointerMove={onHeadPointerMove} onPointerUp={onHeadPointerUp} onPointerCancel={()=>{drag.current=null;setDragging(null);}}>
      {source.target==='browser'?<Globe size={12} aria-hidden="true"/>:<AppWindow size={12} aria-hidden="true"/>}
      <span className="pip-title" title={source.url||title}>{title}</span>
      <span className={`pip-fresh is-${freshness}`} title={source.at?`Last frame ${formatAge(now-source.at)}`:undefined}>{FRESH_LABEL[freshness]}{freshness==='stale'||freshness==='disconnected'?` · ${formatAge(now-source.at)}`:''}</span>
      <span className="pip-controls">
        <Tip label="Open full size in the right pane"><button type="button" className="icon-button" aria-label="Expand" onClick={openFull}><Maximize2 size={12}/></button></Tip>
        <Tip label="Dock in the right pane"><button type="button" className="icon-button" aria-label="Dock to right pane" onClick={()=>{openViewer({chatId:source.chatId,live:true});setDocked(true);}}><PanelRight size={12}/></button></Tip>
        <Tip label="Collapse to a pill"><button type="button" className="icon-button" aria-label="Hide" onClick={()=>setMinimized(true)}><EyeOff size={12}/></button></Tip>
      </span>
    </div>
    <button type="button" className="pip-frame" aria-label="Open the latest screenshot full size" onClick={openFull}>
      {url?<img src={url} alt={source.label} draggable={false} decoding="async"/>:<span className="pip-empty">{source.running?'Waiting for the first frame…':'No screenshot yet'}</span>}
      {owner==='user'&&<span className="pip-badge">You have control</span>}
    </button>
    <div className="pip-foot">
      <span className={`pip-label${source.failed?' is-error':''}`} title={source.failed||source.label}>{source.failed?`Failed: ${source.failed}`:source.label}</span>
      <span className="pip-owner" title={owner==='agent'?'The agent is driving':'You are driving; the agent waits'}>{owner==='agent'?'Agent':'You'}</span>
    </div>
    <div className="pip-actions"><ControlButtons source={source} owner={owner} running={running}/></div>
    <PermissionNotice perms={perms}/>
    <div className="pip-resize" role="separator" aria-label="Resize the live view" aria-orientation="vertical" aria-valuemin={PIP_MIN} aria-valuemax={PIP_MAX} aria-valuenow={ui.placement.width} tabIndex={0}
      onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onPointerCancel={()=>{resize.current=null;}}
      onKeyDown={event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();setPlacement({width:ui.placement.width+(event.key==='ArrowRight'?16:-16)});}}/>
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
