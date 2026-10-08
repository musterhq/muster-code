/** Codex-style computer-use picture-in-picture (CUA-01/02/03/07/09) and the right-pane screenshot viewer (CUA-06). */
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AppWindow,Download,ExternalLink,Eye,Globe,Hand,PanelRightOpen,Paperclip,Play,Square,X} from 'lucide-react';
import {invoke} from '../bridge';
import {getState,notifyError,notifySuccess,openTab,stopChat,type WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {stageAttachment} from '../composerBridge';
import {rememberProfile} from './BrowserTab';
import {ImageFile} from './ImageFile';
import type {ComputerPermissions} from '../../shared/domains/computer-protocol';
import {PIP_STACK_MAX,STACK_PEEK,STACK_WIDTH,dockedSessions,formatAge,frameFreshness,hostOf,mergeSources,orderPipSources,pipShouldShow,raiseSession,recentComputerSources,screenshotName,sessionKey,sessionTabId,setMinimized,setSnapshot,sourceKey,stackAnchor,stackHeight,stackWidth,toolImageUrl,useComputerUi,wireComputerEvents,type Box,type Freshness,type PipSource} from '../computerUse';
import {clampPipPosition,exceedsDragThreshold,loadPipCorner,pipCornerOrigin,savePipCorner,settlePipDrop,springSettled,springStep,type PipCorner,type PipPoint,type PipRect,type PipSize,type SpringState} from '../pipLayout';
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

/** Where the stack sits now: measured from the summary card and the conversation (see stackAnchor), or parked
 *  in the corner the user dropped it in (see pipLayout). */
const rectOf=(el:Element|null|undefined):Box|undefined=>{
  if(!el)return undefined;const r=el.getBoundingClientRect();
  return r.width>0&&r.height>0?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:undefined;
};
const windowRect=():PipRect=>({left:0,top:0,width:window.innerWidth,height:window.innerHeight});
/** The conversation area, inside the window: where a dropped stack parks. */
function conversationBounds():PipRect {
  const box=rectOf(document.querySelector('main.center')??document.querySelector('.center'));
  const win=windowRect();
  if(!box)return win;
  const left=Math.max(win.left,box.left),top=Math.max(win.top,box.top),right=Math.min(win.width,box.right),bottom=Math.min(win.height,box.bottom);
  return right-left>0&&bottom-top>0?{left,top,width:right-left,height:bottom-top}:win;
}
function measureStack(count:number,corner:PipCorner|undefined):{right:number;top:number;width:number} {
  if(typeof document==='undefined')return {right:14,top:56,width:STACK_WIDTH};
  const center=document.querySelector<HTMLElement>('main.center')??document.querySelector<HTMLElement>('.center');
  const card=rectOf(center?.querySelector('.summary-card:not([hidden])')),box=rectOf(center);
  const css=center?getComputedStyle(center):undefined;
  const px=(name:string,fallback:number)=>{const value=parseFloat(css?.getPropertyValue(name)??'');return Number.isFinite(value)?value:fallback;};
  const width=stackWidth(card),size={width,height:stackHeight(width,count)};
  if(corner){const origin=pipCornerOrigin(corner,size,conversationBounds());return {right:Math.max(0,window.innerWidth-origin.x-width),top:origin.y,width};}
  return {...stackAnchor(box,card,{top:px('--summary-top',56),bottom:px('--summary-bottom',16)},size,window.innerWidth),width};
}
function useStackAnchor(active:boolean,count:number,corner:PipCorner|undefined,frozen:React.MutableRefObject<boolean>) {
  const [anchor,setAnchor]=useState(()=>measureStack(count,corner));
  useEffect(()=>{
    if(!active)return;
    const update=()=>{if(frozen.current)return;setAnchor(prev=>{const next=measureStack(count,corner);return prev.right===next.right&&prev.top===next.top&&prev.width===next.width?prev:next;});};
    update();
    window.addEventListener('resize',update);
    // The summary card folds, grows and hides without a window resize; a light poll follows it.
    const timer=window.setInterval(update,700);
    const center=document.querySelector('main.center');
    const observer=typeof ResizeObserver==='undefined'||!center?undefined:new ResizeObserver(update);
    if(center)observer?.observe(center);
    return()=>{window.removeEventListener('resize',update);window.clearInterval(timer);observer?.disconnect();};
  },[active,count,corner]);
  return [anchor,setAnchor] as const;
}

const reducedMotion=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Smooth dragging: pointer events write a transform on the stack inside requestAnimationFrame (no React renders
 *  while moving); a release clamps to the window, snaps to the nearest corner and a spring settles it there. */
function usePipDrag(stack:React.RefObject<HTMLDivElement|null>,frozen:React.MutableRefObject<boolean>,onDrop:(corner:PipCorner,target:PipPoint,width:number)=>void) {
  const live=useRef<{id:number;start:PipPoint;base:PipPoint;offset0:PipPoint;offset:PipPoint;size:PipSize;moved:boolean;last:{t:number;x:number;y:number};v:PipPoint}|null>(null);
  const offset=useRef<PipPoint>({x:0,y:0}),raf=useRef(0),pending=useRef(false),dragged=useRef(false);
  const paint=()=>{pending.current=false;const el=stack.current;if(el)el.style.transform=offset.current.x||offset.current.y?`translate3d(${offset.current.x}px,${offset.current.y}px,0)`:'';};
  const schedule=()=>{if(pending.current)return;pending.current=true;raf.current=requestAnimationFrame(paint);};
  useEffect(()=>()=>cancelAnimationFrame(raf.current),[]);
  const finish=(el:HTMLElement,id:number)=>{if(el.hasPointerCapture?.(id))el.releasePointerCapture(id);};
  return {
    wasDrag:()=>dragged.current,
    onPointerDown:(event:React.PointerEvent<HTMLElement>)=>{
      const el=stack.current;if(!el||event.button!==0||(event.target as HTMLElement).closest('.pip-control,.pip-open'))return;
      cancelAnimationFrame(raf.current);pending.current=false;dragged.current=false;
      const rect=el.getBoundingClientRect(),off={...offset.current};
      live.current={id:event.pointerId,start:{x:event.clientX,y:event.clientY},base:{x:rect.left-off.x,y:rect.top-off.y},offset0:off,offset:off,size:{width:rect.width,height:rect.height},moved:false,last:{t:performance.now(),x:event.clientX,y:event.clientY},v:{x:0,y:0}};
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove:(event:React.PointerEvent<HTMLElement>)=>{
      const drag=live.current;if(!drag||drag.id!==event.pointerId)return;
      const here={x:event.clientX,y:event.clientY};
      if(!drag.moved){if(!exceedsDragThreshold(drag.start,here))return;drag.moved=true;dragged.current=true;frozen.current=true;stack.current?.classList.add('is-dragging');}
      const wanted={x:drag.base.x+drag.offset0.x+here.x-drag.start.x,y:drag.base.y+drag.offset0.y+here.y-drag.start.y};
      const clamped=clampPipPosition(wanted,drag.size,windowRect());
      drag.offset={x:clamped.x-drag.base.x,y:clamped.y-drag.base.y};offset.current=drag.offset;
      const now=performance.now(),dt=Math.max(1,now-drag.last.t);
      drag.v={x:(here.x-drag.last.x)/dt*1000,y:(here.y-drag.last.y)/dt*1000};drag.last={t:now,x:here.x,y:here.y};
      schedule();
    },
    onPointerUp:(event:React.PointerEvent<HTMLElement>)=>{
      const drag=live.current;live.current=null;finish(event.currentTarget,event.pointerId);
      if(!drag||!drag.moved){frozen.current=false;return;}
      const el=stack.current;if(!el){frozen.current=false;return;}
      stack.current?.classList.remove('is-dragging');
      const here={x:drag.base.x+drag.offset.x,y:drag.base.y+drag.offset.y};
      const {corner,target}=settlePipDrop(here,drag.size,conversationBounds());
      // Park the layout at the target now and keep the picture where the hand left it; the spring closes the gap.
      el.style.top=`${target.y}px`;el.style.right=`${Math.max(0,window.innerWidth-target.x-drag.size.width)}px`;
      offset.current={x:here.x-target.x,y:here.y-target.y};paint();
      onDrop(corner,target,drag.size.width);
      if(reducedMotion()){offset.current={x:0,y:0};paint();frozen.current=false;return;}
      let state:SpringState={x:offset.current.x,y:offset.current.y,vx:Math.max(-900,Math.min(900,drag.v.x))*.35,vy:Math.max(-900,Math.min(900,drag.v.y))*.35},prev=performance.now();
      const tick=(now:number)=>{
        state=springStep(state,{x:0,y:0},(now-prev)/1000);prev=now;
        if(springSettled(state,{x:0,y:0})){offset.current={x:0,y:0};paint();frozen.current=false;return;}
        offset.current={x:state.x,y:state.y};paint();raf.current=requestAnimationFrame(tick);
      };
      raf.current=requestAnimationFrame(tick);
    },
    onPointerCancel:(event:React.PointerEvent<HTMLElement>)=>{
      live.current=null;finish(event.currentTarget,event.pointerId);
      offset.current={x:0,y:0};paint();frozen.current=false;stack.current?.classList.remove('is-dragging');
    },
  };
}

type DragHandlers=ReturnType<typeof usePipDrag>;
/** One live thumbnail in the cluster. Front card opens its tab; a back card comes to the front. */
function PipCard({source,depth,count,docked,freshness,owner,now,drag}:{source:PipSource;depth:number;count:number;docked:boolean;freshness:Freshness;owner:'agent'|'user';now:number;drag:DragHandlers}) {
  const url=useShotUrl(source);
  const front=depth===0,title=sourceTitle(source);
  const age=source.at?formatAge(now-source.at):'';
  const status=front&&source.failed?'failed':front&&(freshness==='stale'||freshness==='disconnected')?freshness:undefined;
  const tip=[title,source.failed?`Failed: ${source.failed}`:source.label,front&&age?`Last frame ${age}`:''].filter(Boolean).join(' · ');
  const open=()=>openSessionTab(source);
  const click=()=>{if(drag.wasDrag())return;if(front||count===1)open();else raiseSession(sessionKey(source));};
  return <div className={`pip-card${front?' is-front':''}${front&&owner==='user'?' is-user':''}${docked?' is-docked':''}`} style={{'--depth':docked?0:depth,zIndex:docked?0:count-depth} as React.CSSProperties} data-session={sessionKey(source)} data-docked={docked||undefined}>
    <button type="button" className="pip-card-main" tabIndex={docked?-1:0} title={tip} data-status={status}
      aria-label={front?`Open ${title} in the sidebar: ${source.failed?`failed, ${source.failed}`:source.label}`:`Bring ${title} to the front`}
      onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerCancel} onClick={click} onDoubleClick={open}>
      {url?<img src={url} alt="" draggable={false} decoding="async"/>:<span className="pip-empty"><AppGlyph app={source.app} target={source.target} size={26}/></span>}
      {status&&<span className={`pip-card-status is-${status}`} aria-hidden="true"/>}
    </button>
    {!front&&!docked&&<button type="button" className="pip-open" aria-label={`Open ${title} in the sidebar`} title="Open in the sidebar" onClick={open}><PanelRightOpen size={12} strokeWidth={2.2}/></button>}
  </div>;
}
const sourceTitle=(source:PipSource)=>source.target==='browser'?(source.url?hostOf(source.url):source.app&&source.app!=='Browser'?source.app:'Browser'):source.app||'Computer';

/** Opens a session in the right sidebar as its own tab (the sidebar opens if it was closed), or focuses the tab it already has. */
export function openSessionTab(source:PipSource):void {
  if(source.target==='browser'&&source.owner&&source.profileId){visitSource(source);return;}
  openTab({id:sessionTabId(source),kind:'liveView',title:sourceTitle(source),chatId:source.chatId});
}
/** A transcript screenshot opens as a tab too; the picture is held in the UI store, never in the saved workspace. */
export function openScreenshotTab(source:PipSource):void {
  const id=`shot:${source.chatId}:${source.itemId??source.at}:${(source.image?.id??'').slice(0,12)}`.replace(/[^a-zA-Z0-9_.:-]+/g,'-');
  setSnapshot(id,source);
  openTab({id,kind:'liveView',title:`Screenshot · ${sourceTitle(source)}`,chatId:source.chatId});
}

/** The sidebar tab that is on screen right now, or null when the sidebar is closed or showing something else. */
const selectVisibleTab=(state:ReturnType<typeof getState>)=>!state.resourcesHidden&&state.rightPaneMode==='resources'&&state.screen==='work'?state.activeTabId:null;

/** Codex-style picture-in-picture: a frameless cluster of live window thumbnails at the conversation's right,
 *  under the summary card; one card per app or page the agent used lately. The user can raise any card, drag the
 *  cluster to a corner, and open a session as a sidebar tab, at which point its card steps aside. */
export function ComputerPip({paneVisible=true}:{paneVisible?:boolean}={}) {
  const chatId=useStoreSelector(state=>state.activeChatId);
  const screen=useStoreSelector(state=>state.screen);
  const visibleTabId=useStoreSelector(selectVisibleTab);
  const ui=useComputerUi();
  const {sources,running}=useChatSources(chatId);
  useEffect(()=>wireComputerEvents(),[]);
  const cards=useMemo(()=>orderPipSources(sources,ui.raised).slice(0,PIP_STACK_MAX),[sources,ui.raised]);
  const docked=useMemo(()=>dockedSessions(cards,paneVisible?visibleTabId:null),[cards,visibleTabId,paneVisible]);
  const open=cards.filter(card=>!docked.has(sessionKey(card)));
  const source=open[0]??cards[0];
  const now=useNow(!!source);
  const shown=screen==='work'&&pipShouldShow(sources[0],running,now);
  const perms=usePermissions(shown&&open.some(card=>card.target==='computer'));
  const [corner,setCorner]=useState<PipCorner|undefined>(loadPipCorner);
  const frozen=useRef(false),stack=useRef<HTMLDivElement>(null);
  const [anchor,setAnchor]=useStackAnchor(shown,ui.minimized?1:Math.max(1,open.length),corner,frozen);
  const drag=usePipDrag(stack,frozen,(next,target,width)=>{
    savePipCorner(next);setCorner(next);setAnchor({right:Math.max(0,window.innerWidth-target.x-width),top:target.y,width});
  });
  const [busy,setBusy]=useState(false);
  if(!shown||!source)return null;
  const owner=ui.control[source.chatId]??'agent';
  const freshness=frameFreshness(now-source.at,running);
  const title=sourceTitle(source);
  const setOwner=async(next:'agent'|'user')=>{setBusy(true);try{await invoke('computer.control',{chatId:source.chatId,owner:next});}catch(cause){notifyError(cause);}finally{setBusy(false);}};
  if(!open.length) return <div className="pip-stack is-empty" aria-hidden="true" ref={stack} style={{top:anchor.top,right:anchor.right,width:anchor.width}}>
    <div className="pip-cards" style={{height:stackHeight(anchor.width,1)}}>{cards.map(card=><PipCard key={sourceKey(card)} source={card} depth={0} count={1} docked freshness={freshness} owner={owner} now={now} drag={drag}/>)}</div>
  </div>;
  if(ui.minimized) return <button type="button" className={`pip-pill is-${freshness}`} style={{top:anchor.top,right:anchor.right}} title={`Show the live view · ${source.label}`} aria-label={`Show computer use: ${source.label}`} onClick={()=>setMinimized(false)}>
    <span className="pip-dot" aria-hidden="true"/><AppGlyph app={source.app} target={source.target} size={14}/><span className="pip-pill-title">{title}</span>{open.length>1&&<span className="pip-pill-count">+{open.length-1}</span>}
  </button>;
  const peek=STACK_PEEK*(open.length-1);
  const depthOf=new Map(open.map((card,index)=>[sessionKey(card),index] as const));
  return <div ref={stack} className={`pip-stack is-${freshness}${corner?' is-placed':''}`} style={{top:anchor.top,right:anchor.right,width:anchor.width}} role="region" aria-label={`Computer use: ${open.map(sourceTitle).join(', ')}`} data-owner={owner} data-count={open.length}>
    <div className="pip-cards" style={{height:stackHeight(anchor.width,open.length)}}>
      {cards.map(card=>{const key=sessionKey(card),isDocked=docked.has(key);return <PipCard key={sourceKey(card)} source={card} depth={depthOf.get(key)??0} count={open.length} docked={isDocked} freshness={freshness} owner={owner} now={now} drag={drag}/>;})}
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

/** A session (or one transcript screenshot) as a right-sidebar tab: the live feed with zoom, Visit/Open app, attach and export.
 *  Closing the tab hands the session back to its picture-in-picture. */
export function LiveViewTab({tab}:{tab:Pick<WorkspaceTab,'id'|'chatId'|'title'>}) {
  const ui=useComputerUi();
  const shot=tab.id.startsWith('shot:');
  const {sources,running}=useChatSources(shot?null:tab.chatId??null);
  const found=shot?ui.snapshots[tab.id]:sources.find(candidate=>sessionTabId(candidate)===tab.id);
  // The session can slide out of the recent list while idle; keep showing its last picture rather than blanking the tab.
  const last=useRef<PipSource|undefined>(undefined);
  if(found)last.current=found;
  const source=found??last.current;
  const url=useShotUrl(source);
  const now=useNow(!shot&&!!source);
  useEffect(()=>wireComputerEvents(),[]);
  const perms=usePermissions(!!source&&source.target==='computer');
  const owner=source?ui.control[source.chatId]??'agent':'agent';
  const freshness=source&&!shot?frameFreshness(now-source.at,running):'ended';
  const title=source?sourceTitle(source):tab.title;
  return <section className="computer-viewer" aria-label={shot?'Screenshot':'Live computer use'} data-session-tab={tab.id}>
    <header className="computer-viewer-head">
      {source?.target==='browser'?<Globe size={13} aria-hidden="true"/>:<AppWindow size={13} aria-hidden="true"/>}
      <span className="computer-viewer-title" title={source?.url||title}>{title}</span>
      {!shot&&<span className={`pip-fresh is-${freshness}`}>{FRESH_LABEL[freshness]}{source&&(freshness==='stale'||freshness==='disconnected')?` · ${formatAge(now-source.at)}`:''}</span>}
      <span className="computer-viewer-spacer"/>
      {!shot&&source&&<ControlButtons source={source} owner={owner} running={running} compact/>}
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
      :<div className="computer-viewer-empty" role="status"><Eye size={16} aria-hidden="true"/>{source?'Loading the screenshot…':shot?'This screenshot is no longer in memory.':'Waiting for the agent. This session shows here once it acts.'}</div>}
  </section>;
}
