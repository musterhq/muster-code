import React,{useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AppWindow,ArrowLeft,ArrowRight,Camera,Check,ChevronDown,Crosshair,Download,ExternalLink,Globe,Monitor,RotateCw,Scan,Shield,ShieldAlert,Smartphone,Square,SquareTerminal,Tablet,UserRound,X} from 'lucide-react';
import {invoke,subscribe} from '../bridge';
import {getState,subscribeStore} from '../store';
import {stageAttachment,runtimeMessage} from '../composerBridge';
import {BROWSER_VIEWPORTS,browserAddress,browserScopeProfile,type BrowserConsoleEntry,type BrowserProfile,type BrowserState,type BrowserViewport} from '../../shared/browser-protocol';
import './browser-tab.css';

export interface BrowserTabProps {owner:string;profileId:string;profileName?:string;initialUrl?:string;active?:boolean;onUrlChange?:(url:string)=>void}

/** Which profile each browser tab was bound to. The store still records 'personal' for
 * every tab, so the scoped binding lives here and survives reloads. */
const PROFILE_MAP='muster.browserProfiles', PROFILE_MAP_LIMIT=200;
function profileMap():Record<string,string> {
  try {const value=JSON.parse(localStorage.getItem(PROFILE_MAP)??'{}');return value && typeof value==='object' && !Array.isArray(value)?value:{};} catch {return {};}
}
export function rememberProfile(owner:string,profileId:string):void {
  try {
    const map=profileMap();delete map[owner];map[owner]=profileId;
    const keys=Object.keys(map);for(const key of keys.slice(0,Math.max(0,keys.length-PROFILE_MAP_LIMIT)))delete map[key];
    localStorage.setItem(PROFILE_MAP,JSON.stringify(map));
  } catch {/* Storage unavailable: the binding lasts for this session. */}
}
function activeScope() {
  const state=getState(),chat=state.snapshot?.chats.find(item=>item.id===state.activeChatId);
  return chat?{chatId:chat.id,folderId:chat.folderId,projectId:chat.projectId}:undefined;
}
/** A remembered binding wins; an explicit non-default profile is kept; otherwise the chat's scope. */
export function resolveBrowserProfile(owner:string,requested:string):{id:string;bound:boolean} {
  const remembered=profileMap()[owner];
  if(typeof remembered==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(remembered)) return {id:remembered,bound:true};
  if(requested && requested!=='personal') return {id:requested,bound:true};
  return {id:browserScopeProfile(activeScope()),bound:!!getState().snapshot};
}
export function browserProfileLabel(id:string):string {
  if(id==='personal') return 'Personal';
  const snapshot=getState().snapshot;
  if(id.startsWith('folder-')) return snapshot?.folders.find(item=>browserScopeProfile({folderId:item.id})===id)?.name ?? 'Folder profile';
  if(id.startsWith('project-')) return snapshot?.projects.find(item=>browserScopeProfile({projectId:item.id})===id)?.name ?? 'Project profile';
  return id;
}
const VIEWPORT_ICON:Record<BrowserViewport,React.ReactNode>={fill:<Monitor size={14}/>,mobile:<Smartphone size={14}/>,tablet:<Tablet size={14}/>,desktop:<Monitor size={14}/>};
const viewportLabel=(preset:BrowserViewport)=>preset==='fill'?'Fill panel':BROWSER_VIEWPORTS[preset].label;
const bytes=(value:number)=>value>=1048576?`${(value/1048576).toFixed(1)} MB`:value>=1024?`${Math.round(value/1024)} KB`:`${value} B`;
const hostOf=(url:string)=>{try{return new URL(url).host;}catch{return url;}};
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

type MenuId='viewport'|'profile';
/** Toolbar popover. role="menu" also detaches the native page while it is open. */
function ToolbarMenu({id,open,onOpen,label,button,children}:{id:MenuId;open:MenuId|null;onOpen:(id:MenuId|null)=>void;label:string;button:React.ReactNode;children:React.ReactNode}) {
  const root=useRef<HTMLDivElement>(null),shown=open===id;
  useEffect(()=>{
    if(!shown)return;
    const away=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))onOpen(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')onOpen(null);};
    document.addEventListener('mousedown',away,true);document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('mousedown',away,true);document.removeEventListener('keydown',key,true);};
  },[shown,onOpen]);
  return <div className="browser-menu-anchor" ref={root}>
    <button className={`browser-icon browser-menu-button${shown?' is-open':''}`} aria-haspopup="menu" aria-expanded={shown} aria-label={label} title={label} onClick={()=>onOpen(shown?null:id)}>{button}</button>
    {shown && <div className="browser-menu" role="menu" aria-label={label}>{children}</div>}
  </div>;
}

/** The native view is a separate sandboxed renderer. This component owns only its
 * toolbar and geometry lease; hiding/unmounting never destroys page history.
 */
export function BrowserTab({owner,profileId:requestedProfile,initialUrl='about:blank',active=true,onUrlChange}:BrowserTabProps) {
  const [profile,setProfile]=useState(()=>resolveBrowserProfile(owner,requestedProfile));
  const profileId=profile.id;
  // A primitive snapshot: the tab re-renders on a folder/Project rename, not on every store change.
  const profileLabel=useSyncExternalStore(subscribeStore,()=>browserProfileLabel(profileId));
  const [browser,setBrowser]=useState<BrowserState>();
  const [address,setAddress]=useState(initialUrl==='about:blank'?'':initialUrl);
  const [error,setError]=useState(''),[ready,setReady]=useState(false),[attempt,setAttempt]=useState(0);
  const [menu,setMenuState]=useState<MenuId|null>(null),[profiles,setProfiles]=useState<BrowserProfile[]>([]),[confirmClear,setConfirmClear]=useState(false);
  const [consoleOpen,setConsoleOpen]=useState(false),[consoleEntries,setConsoleEntries]=useState<BrowserConsoleEntry[]>([]);
  const [picking,setPicking]=useState<'element'|'region'|null>(null),[flash,setFlash]=useState('');
  const host=useRef<HTMLDivElement>(null),editing=useRef(false),current=useRef<BrowserState|undefined>(undefined);
  const mountURL=useRef(initialUrl);mountURL.current=initialUrl;
  const urlChange=useRef(onUrlChange);urlChange.current=onUrlChange;
  const apply=useRef<(state:BrowserState)=>void>(()=>{});
  const epoch=useRef(0),flashTimer=useRef(0),consoleList=useRef<HTMLOListElement>(null);
  const setMenu=useCallback((id:MenuId|null)=>setMenuState(id),[]);
  const pickingRef=useRef(false);pickingRef.current=!!picking;

  useEffect(()=>{if(profile.bound)rememberProfile(owner,profile.id);},[owner,profile]);
  // Resolved before the snapshot arrived: bind to the chat's scope once it is known.
  useEffect(()=>{
    if(profile.bound)return;
    return subscribeStore(()=>{if(!getState().snapshot)return;setProfile(resolveBrowserProfile(owner,requestedProfile));});
  },[owner,requestedProfile,profile.bound]);
  useEffect(()=>()=>window.clearTimeout(flashTimer.current),[]);
  const notify=(text:string)=>{setFlash(text);window.clearTimeout(flashTimer.current);flashTimer.current=window.setTimeout(()=>setFlash(''),3200);};

  useEffect(()=>{
    if(!active)return;
    epoch.current++;
    let disposed=false,visible=false,moving=false,frame=0,lastBounds='',opened=false;
    const surfaceId=crypto.randomUUID();
    const surface={owner,surfaceId};
    current.current=undefined;setBrowser(undefined);setReady(false);setError('');
    const accept=(next:BrowserState)=>{
      if(disposed || next.owner!==owner || next.profileId!==profileId || (current.current && next.revision<current.current.revision))return;
      const priorURL=current.current?.url ?? mountURL.current;
      current.current=next;setBrowser(next);
      if(!editing.current)setAddress(next.url==='about:blank'?'':next.url);
      if(next.url!==priorURL)urlChange.current?.(next.url);
      schedule();
    };
    apply.current=accept;
    const hide=()=>{
      lastBounds='';
      if(visible){visible=false;void invoke('browser.hide',surface).catch(()=>{});}
    };
    const update=()=>{
      frame=0;if(disposed || !opened || !host.current)return;
      const element=host.current,rect=element.getBoundingClientRect(),report=current.current;
      const overlay=Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[data-native-preview-overlay],[data-browser-overlay]')).some(element=>element.getClientRects().length>0);
      if(moving || document.hidden || element.closest('[hidden],[aria-hidden="true"]') || rect.width<1 || rect.height<1 || overlay || report?.error || report?.certificateError || (report?.url==='about:blank' && !report.loading)){hide();return;}
      const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
      if(visible && lastBounds===key)return;
      visible=true;lastBounds=key;
      void invoke('browser.position',{...surface,bounds}).catch(cause=>{if(!disposed){hide();setError(message(cause));}});
    };
    function schedule(){if(!disposed && !frame)frame=requestAnimationFrame(update);}
    const start=()=>{moving=true;hide();};
    const end=()=>{moving=false;schedule();};
    const focus=()=>{
      visible=false;lastBounds='';
      if(opened)void invoke('browser.status',{owner}).then(accept).catch(cause=>{if(!disposed)setError(message(cause));});
      schedule();
    };
    const resize=new ResizeObserver(schedule);if(host.current)resize.observe(host.current);
    const mutations=new MutationObserver(schedule);
    mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','aria-hidden','open','class','style']});
    const unsubscribe=subscribe(event=>{
      if(event.type==='browserState')accept(event.state);
      else if(event.type==='browserClosed' && event.owner===owner){opened=false;visible=false;setReady(false);setError('This browser has closed. Reopen it to continue.');}
    });
    window.addEventListener('muster:layout-start',start);window.addEventListener('muster:layout-end',end);
    window.addEventListener('resize',schedule);window.addEventListener('focus',focus);
    document.addEventListener('visibilitychange',focus);document.addEventListener('scroll',schedule,true);
    // A tab moving to another profile drops its old page first; main never swaps a live page's storage.
    // Main's own record decides (IPC is ordered, so an earlier in-flight open is already applied),
    // which also covers a remount or a scope that resolved while the first open was pending.
    void invoke('browser.status',{owner}).then(prior=>prior.profileId!==profileId?invoke('browser.release',{owner}):undefined,()=>undefined).then(()=>invoke('browser.open',{...surface,profileId,url:mountURL.current})).then(next=>{
      if(disposed){void invoke('browser.hide',surface).catch(()=>{});return;}
      opened=true;setReady(true);accept(next);schedule();
    }).catch(cause=>{if(!disposed)setError(message(cause));});
    return()=>{
      // A pick in progress must not keep listening on a page the user can no longer see.
      if(pickingRef.current){void invoke('browser.cancelPick',{owner}).catch(()=>{});setPicking(null);}
      disposed=true;epoch.current++;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();unsubscribe();
      // Always send cleanup, including when open completed after the first hide.
      visible=false;void invoke('browser.hide',surface).catch(()=>{});
      window.removeEventListener('muster:layout-start',start);window.removeEventListener('muster:layout-end',end);
      window.removeEventListener('resize',schedule);window.removeEventListener('focus',focus);
      document.removeEventListener('visibilitychange',focus);document.removeEventListener('scroll',schedule,true);
      apply.current=()=>{};
    };
  },[owner,profileId,active,attempt]);

  // The console drawer re-reads the bounded main-process log whenever its counters move.
  useEffect(()=>{
    if(!consoleOpen || !ready)return;
    let live=true;
    void invoke('browser.console',{owner}).then(entries=>{if(live)setConsoleEntries(entries);}).catch(()=>{});
    return()=>{live=false;};
  },[consoleOpen,ready,owner,browser?.consoleCount,browser?.consoleErrors]);
  useEffect(()=>{const list=consoleList.current;if(list)list.scrollTop=list.scrollHeight;},[consoleEntries]);
  useEffect(()=>{
    if(menu!=='profile')return;
    let live=true;setConfirmClear(false);
    void invoke('browser.profiles',undefined).then(list=>{if(live)setProfiles(list);}).catch(()=>{});
    return()=>{live=false;};
  },[menu]);

  const guarded=async<T,>(run:()=>Promise<T>):Promise<T|undefined>=>{
    const request=epoch.current;setError('');
    try {const value=await run();return request===epoch.current?value:undefined;} catch(cause){if(request===epoch.current)setError(message(cause));return undefined;}
  };
  const action=async(command:'browser.back'|'browser.forward'|'browser.reload'|'browser.stop'|'browser.closePopup')=>{
    const next=await guarded(()=>invoke(command,{owner}));if(next)apply.current(next);
  };
  const navigate=async(event:React.FormEvent)=>{
    event.preventDefault();
    const next=await guarded(()=>{const url=browserAddress(address);editing.current=false;return invoke('browser.navigate',{owner,url});});
    if(next)apply.current(next);
  };
  const setViewport=async(preset:BrowserViewport)=>{setMenu(null);const next=await guarded(()=>invoke('browser.setViewport',{owner,preset}));if(next)apply.current(next);};
  const download=async(choice:'save'|'cancel'|'reveal'|'dismiss')=>{
    const id=browser?.download?.id;if(!id)return;
    const next=await guarded(()=>invoke('browser.download',{owner,id,action:choice}));if(next)apply.current(next);
  };
  const switchProfile=(id:string)=>{
    setMenu(null);if(id===profileId)return;
    rememberProfile(owner,id);setProfile({id,bound:true});setConsoleEntries([]);
  };
  const clearData=async()=>{
    if(!confirmClear){setConfirmClear(true);return;}
    setMenu(null);
    if(await guarded(()=>invoke('browser.clearData',{profileId}).then(()=>true)))notify(`Cleared site data for ${profileLabel}.`);
  };
  /** Page context goes to the composer as a chip ('muster:composer-add-context'); screenshots are staged first. */
  // The composer acknowledges a chip with preventDefault(); unacknowledged context is never reported as added.
  const addContext=(detail:Record<string,unknown>)=>!window.dispatchEvent(new CustomEvent('muster:composer-add-context',{detail,cancelable:true}));
  const pickElement=async()=>{
    setPicking('element');
    const picked=await guarded(()=>invoke('browser.pickElement',{owner}));
    setPicking(null);
    if(!picked)return;
    const label=`<${picked.tag}> · ${hostOf(picked.url)}`;
    const lines=[`Element from ${picked.url}`,`Selector: ${picked.selector}`];
    if(picked.text)lines.push(`Text: ${picked.text}`);
    lines.push('',picked.outerHTML+(picked.truncated?'\n<!-- truncated -->':''));
    const text=lines.join('\n');
    if(addContext({id:`browser-element:${crypto.randomUUID()}`,type:'selection',label,text,source:{kind:'browser',owner,url:picked.url,selector:picked.selector,rect:picked.rect}})){notify(`Added ${label} to the chat.`);return;}
    try {await navigator.clipboard.writeText(text);notify(`Copied ${label}. Paste it into the chat.`);} catch {setError('The element could not be added to the chat or copied.');}
  };
  const capture=async(select:boolean)=>{
    const scope=activeScope();
    if(!scope){setError('Open a chat to attach a screenshot.');return;}
    if(select)setPicking('region');
    const shot=await guarded(()=>invoke('browser.capture',{owner,select}));
    setPicking(null);
    if(!shot)return;
    const site=hostOf(shot.url).replace(/[^a-zA-Z0-9.-]/g,'_')||'page',stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    try {
      const ref=await stageAttachment({chatId:scope.chatId,name:`screenshot-${site}-${stamp}.png`,mime:'image/png',dataBase64:shot.dataUrl.slice(shot.dataUrl.indexOf(',')+1)});
      notify(addContext({id:`browser-capture:${ref.id}`,type:'image',label:`Screenshot · ${hostOf(shot.url)}`,source:{kind:'browser',owner,url:shot.url,title:shot.title},attachment:ref,dataUrl:shot.dataUrl})
        ?'Screenshot added to the chat.':'Screenshot saved to this chat. It appears in the composer when you reopen the chat.');
    } catch(cause){setError(runtimeMessage(cause));}
  };
  const cancelPick=()=>{void invoke('browser.cancelPick',{owner}).catch(()=>{});};
  const openExternal=()=>void guarded(()=>invoke('browser.openExternal',{owner}));

  const reportedError=error || browser?.error;
  const page=!!browser && browser.url!=='about:blank';
  const tools=ready && page && !picking && !browser?.certificateError;
  const viewport=browser?.viewport ?? 'fill';
  const pending=browser?.download;
  const profileChoices=menu==='profile'?[...new Set([profileId,'personal',browserScopeProfile(activeScope()),...profiles.map(item=>item.id)])]:[];
  return <div className="browser-tab" aria-label="Embedded browser">
    <div className="browser-toolbar">
      <div className="browser-navigation" role="group" aria-label="Browser navigation">
        <button className="browser-icon" disabled={!ready || !browser?.canGoBack} aria-label="Go back" title="Go back" onClick={()=>void action('browser.back')}><ArrowLeft size={15}/></button>
        <button className="browser-icon" disabled={!ready || !browser?.canGoForward} aria-label="Go forward" title="Go forward" onClick={()=>void action('browser.forward')}><ArrowRight size={15}/></button>
        <button className="browser-icon" disabled={!ready} aria-label={browser?.loading?'Stop loading':'Reload page'} title={browser?.loading?'Stop loading':'Reload page'} onClick={()=>void action(browser?.loading?'browser.stop':'browser.reload')}>{browser?.loading?<Square size={13}/>:<RotateCw size={14}/>}</button>
      </div>
      <form className="browser-address-form" onSubmit={event=>void navigate(event)}>
        {browser?.certificateError?<ShieldAlert size={14} className="is-danger" aria-label="Certificate error"/>:<Globe size={14} aria-hidden="true"/>}
        <input aria-label="Website address" placeholder="Enter a website address" value={address} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={!ready} onFocus={()=>{editing.current=true;}} onChange={event=>setAddress(event.target.value)} onBlur={()=>{editing.current=false;}} onKeyDown={event=>{if(event.key==='Escape'){editing.current=false;setAddress(current.current?.url==='about:blank'?'':current.current?.url??'');event.currentTarget.blur();}}}/>
        <button type="submit" disabled={!ready || !address.trim()} aria-label="Navigate to website">Go</button>
      </form>
      <div className="browser-tools" role="group" aria-label="Page tools">
        <button className="browser-icon" disabled={!tools} aria-label="Pick element for chat" title="Pick an element and add it to the chat" onClick={()=>void pickElement()}><Crosshair size={14}/></button>
        <button className="browser-icon" disabled={!tools} aria-label="Capture region for chat" title="Drag a region to attach a screenshot (Shift-click: visible page)" onClick={event=>void capture(!event.shiftKey)}><Camera size={14}/></button>
        <button className={`browser-icon${consoleOpen?' is-on':''}`} disabled={!ready} aria-pressed={consoleOpen} aria-label={`Console${browser?.consoleErrors?`, ${browser.consoleErrors} errors`:''}`} title="Console and network errors" onClick={()=>setConsoleOpen(value=>!value)}>
          <SquareTerminal size={14}/>{!!browser?.consoleErrors && <span className="browser-badge" aria-hidden="true">{browser.consoleErrors>99?'99+':browser.consoleErrors}</span>}
        </button>
        <ToolbarMenu id="viewport" open={menu} onOpen={setMenu} label={`Viewport: ${viewportLabel(viewport)}`} button={VIEWPORT_ICON[viewport]}>
          {(['fill','mobile','tablet','desktop'] as const).map(preset=><button key={preset} role="menuitemradio" aria-checked={viewport===preset} disabled={!ready} onClick={()=>void setViewport(preset)}>
            <span className="browser-menu-icon">{VIEWPORT_ICON[preset]}</span><span className="browser-menu-label">{viewportLabel(preset)}</span>{viewport===preset && <Check size={13} className="browser-menu-check"/>}
          </button>)}
        </ToolbarMenu>
        <ToolbarMenu id="profile" open={menu} onOpen={setMenu} label={`Browser profile: ${profileLabel}`} button={<><UserRound size={14}/><span className="browser-profile-name">{profileLabel}</span><ChevronDown size={11}/></>}>
          <p className="browser-menu-heading">Browser profile</p>
          {profileChoices.map(id=><button key={id} role="menuitemradio" aria-checked={id===profileId} onClick={()=>switchProfile(id)}>
            <span className="browser-menu-icon">{id===profileId?<Check size={13}/>:null}</span><span className="browser-menu-label">{browserProfileLabel(id)}</span>
            <span className="browser-menu-detail">{id==='personal'?'All chats':id.startsWith('project-')?'Project':id.startsWith('folder-')?'Folder':''}</span>
          </button>)}
          <div className="browser-menu-separator" role="separator"/>
          <button role="menuitem" className={confirmClear?'is-danger':''} onClick={()=>void clearData()}>
            <span className="browser-menu-icon"><X size={13}/></span><span className="browser-menu-label">{confirmClear?`Sign out of every site in ${profileLabel}`:'Clear site data…'}</span>
          </button>
          <p className="browser-menu-note">Sign-ins and cookies stay in <code>{profileId}</code>. Other profiles can't read them. Switching reloads this tab in the chosen profile.</p>
        </ToolbarMenu>
        <button className="browser-icon" disabled={!ready || !page} aria-label="Open in default browser" title="Open in your default browser" onClick={openExternal}><ExternalLink size={14}/></button>
      </div>
    </div>
    <div className="browser-load-status" role="status" aria-live="polite">
      {browser?.favicon?<img className="browser-favicon" src={browser.favicon} alt="" width={14} height={14}/>:page?<Globe size={12} aria-hidden="true"/>:null}
      <span className="browser-title">{!ready && !error?'Opening browser…':browser?.loading?'Loading page…':browser?.title || (browser?.url==='about:blank'?'New browser page':'Browser')}</span>
      {viewport!=='fill' && <span className="browser-chip">{viewportLabel(viewport)}</span>}
    </div>
    {reportedError && <div className="browser-error" role="alert"><p>{reportedError}</p><div className="browser-actions"><button onClick={()=>ready?void action('browser.reload'):setAttempt(value=>value+1)}>{ready?'Retry page':'Reopen browser'}</button>{ready && page && <button onClick={openExternal}>Open in default browser</button>}</div></div>}
    {picking && <div className="browser-bar is-accent" role="status"><Scan size={13} aria-hidden="true"/><span className="browser-bar-text">{picking==='element'?'Click an element on the page to add it to the chat. Esc cancels.':'Drag over the page to capture a region. Esc cancels.'}</span><button onClick={cancelPick}>Cancel</button></div>}
    {browser?.popup && <div className="browser-bar" role="status"><AppWindow size={13} aria-hidden="true"/><span className="browser-bar-text">Sign-in window · {hostOf(browser.popup.url)}{browser.popup.title?` — ${browser.popup.title}`:''}</span><button onClick={()=>void action('browser.closePopup')}>Close</button></div>}
    {pending && <div className={`browser-bar${pending.state==='failed'?' is-danger':''}`} role="status" aria-label="Download">
      <Download size={13} aria-hidden="true"/>
      <span className="browser-bar-text">{pending.state==='pending'?<><b>{pending.filename}</b>{pending.totalBytes?` · ${bytes(pending.totalBytes)}`:''}</>
        :pending.state==='saving'?<>Saving <b>{pending.filename}</b>{pending.totalBytes?` · ${Math.min(100,Math.round(pending.receivedBytes/pending.totalBytes*100))}%`:` · ${bytes(pending.receivedBytes)}`}</>
        :pending.state==='saved'?<>Saved <b>{pending.savedName}</b> to Downloads</>
        :pending.state==='cancelled'?<>Download of <b>{pending.filename}</b> cancelled</>:<>Download of <b>{pending.filename}</b> failed</>}</span>
      {pending.state==='pending' && <><button className="is-primary" onClick={()=>void download('save')}>Save to Downloads</button><button onClick={()=>void download('cancel')}>Cancel</button></>}
      {pending.state==='saving' && <button onClick={()=>void download('cancel')}>Cancel</button>}
      {pending.state==='saved' && <button onClick={()=>void download('reveal')}>Show in Finder</button>}
      {(pending.state==='saved' || pending.state==='cancelled' || pending.state==='failed') && <button className="browser-bar-close" aria-label="Dismiss download notice" onClick={()=>void download('dismiss')}><X size={12}/></button>}
    </div>}
    {(flash || browser?.notice) && <p className="browser-notice" role="status">{flash || browser?.notice}</p>}
    <div ref={host} className="browser-surface" role="region" aria-label="Website content" aria-busy={browser?.loading??false}>
      {ready && browser?.url==='about:blank' && !reportedError && <div className="browser-empty"><Globe size={26} aria-hidden="true"/><p>Browse a website</p><span>Enter an HTTP or HTTPS address above.</span></div>}
      {browser?.certificateError && <div className="browser-interstitial" role="alert">
        <ShieldAlert size={28} aria-hidden="true"/>
        <p>This connection isn't private</p>
        <span>{hostOf(browser.certificateError.url)} presented a certificate that couldn't be verified ({browser.certificateError.code}). Muster won't bypass certificate checks.</span>
        <div className="browser-actions"><button className="is-primary" onClick={openExternal}>Open in default browser</button><button disabled={!browser.canGoBack} onClick={()=>void action('browser.back')}>Go back</button></div>
      </div>}
    </div>
    {consoleOpen && <section className="browser-console" aria-label="Console">
      <header><span className="browser-console-title">Console</span><span className="browser-console-count">{consoleEntries.length} {consoleEntries.length===1?'entry':'entries'}{browser?.consoleErrors?` · ${browser.consoleErrors} errors`:''}</span>
        <button disabled={!consoleEntries.length} onClick={()=>void invoke('browser.console',{owner,clear:true}).then(setConsoleEntries).catch(cause=>setError(message(cause)))}>Clear</button>
        <button className="browser-bar-close" aria-label="Close console" onClick={()=>setConsoleOpen(false)}><X size={12}/></button></header>
      {consoleEntries.length?<ol ref={consoleList}>{consoleEntries.map((entry,index)=><li key={`${entry.at}-${index}`} className={`is-${entry.level}`}>
        <span className="browser-console-level">{entry.level==='network'?'net':entry.level==='warning'?'warn':entry.level}</span>
        <span className="browser-console-message">{entry.message}</span>
        {entry.source && <span className="browser-console-source" title={entry.source}>{entry.source.split('/').pop()||entry.source}{entry.line?`:${entry.line}`:''}</span>}
      </li>)}</ol>:<p className="browser-console-empty">No console messages or failed requests yet.</p>}
    </section>}
    <footer className="browser-profile" title={`${profileLabel} profile (${profileId}). Tabs with this profile share site sign-ins. Other profiles are isolated. Site data survives restarts; back/forward history ends when this tab closes.`}><Shield size={12} aria-hidden="true"/><span>{profileLabel} profile</span><span>History lasts for this tab</span></footer>
  </div>;
}
