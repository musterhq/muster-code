import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,Globe,RotateCw,Shield,Square} from 'lucide-react';
import {invoke,subscribe} from '../bridge';
import {browserAddress,type BrowserState} from '../../shared/browser-protocol';
import './browser-tab.css';

export interface BrowserTabProps {owner:string;profileId:string;profileName?:string;initialUrl?:string;active?:boolean;onUrlChange?:(url:string)=>void}
/** The native view is a separate sandboxed renderer. This component owns only its
 * toolbar and geometry lease; hiding/unmounting never destroys page history.
 */
export function BrowserTab({owner,profileId,profileName='Personal',initialUrl='about:blank',active=true,onUrlChange}:BrowserTabProps) {
  const [browser,setBrowser]=useState<BrowserState>();
  const [address,setAddress]=useState(initialUrl==='about:blank'?'':initialUrl);
  const [error,setError]=useState(''),[ready,setReady]=useState(false),[attempt,setAttempt]=useState(0);
  const host=useRef<HTMLDivElement>(null),editing=useRef(false),current=useRef<BrowserState|undefined>(undefined);
  const mountURL=useRef(initialUrl);mountURL.current=initialUrl;
  const urlChange=useRef(onUrlChange);urlChange.current=onUrlChange;
  const apply=useRef<(state:BrowserState)=>void>(()=>{});
  const epoch=useRef(0);

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
      if(moving || document.hidden || element.closest('[hidden],[aria-hidden="true"]') || rect.width<1 || rect.height<1 || overlay || report?.error || (report?.url==='about:blank' && !report.loading)){hide();return;}
      const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
      if(visible && lastBounds===key)return;
      visible=true;lastBounds=key;
      void invoke('browser.position',{...surface,bounds}).catch(cause=>{if(!disposed){hide();setError(cause instanceof Error?cause.message:String(cause));}});
    };
    function schedule(){if(!disposed && !frame)frame=requestAnimationFrame(update);}
    const start=()=>{moving=true;hide();};
    const end=()=>{moving=false;schedule();};
    const focus=()=>{
      visible=false;lastBounds='';
      if(opened)void invoke('browser.status',{owner}).then(accept).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:String(cause));});
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
    void invoke('browser.open',{...surface,profileId,url:mountURL.current}).then(next=>{
      if(disposed){void invoke('browser.hide',surface).catch(()=>{});return;}
      opened=true;setReady(true);accept(next);schedule();
    }).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:String(cause));});
    return()=>{
      disposed=true;epoch.current++;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();unsubscribe();
      // Always send cleanup, including when open completed after the first hide.
      visible=false;void invoke('browser.hide',surface).catch(()=>{});
      window.removeEventListener('muster:layout-start',start);window.removeEventListener('muster:layout-end',end);
      window.removeEventListener('resize',schedule);window.removeEventListener('focus',focus);
      document.removeEventListener('visibilitychange',focus);document.removeEventListener('scroll',schedule,true);
      apply.current=()=>{};
    };
  },[owner,profileId,active,attempt]);

  const action=async(command:'browser.back'|'browser.forward'|'browser.reload'|'browser.stop')=>{
    const request=epoch.current;
    setError('');
    try {const next=await invoke(command,{owner});if(request===epoch.current)apply.current(next);} catch(cause){if(request===epoch.current)setError(cause instanceof Error?cause.message:String(cause));}
  };
  const navigate=async(event:React.FormEvent)=>{
    const request=epoch.current;
    event.preventDefault();setError('');
    try {
      const url=browserAddress(address);editing.current=false;
      const next=await invoke('browser.navigate',{owner,url});if(request===epoch.current)apply.current(next);
    } catch(cause){if(request===epoch.current)setError(cause instanceof Error?cause.message:String(cause));}
  };
  const reportedError=error || browser?.error;
  return <div className="browser-tab" aria-label="Embedded browser">
    <div className="browser-toolbar">
      <div className="browser-navigation" role="group" aria-label="Browser navigation">
        <button className="browser-icon" disabled={!ready || !browser?.canGoBack} aria-label="Go back" title="Go back" onClick={()=>void action('browser.back')}><ArrowLeft size={15}/></button>
        <button className="browser-icon" disabled={!ready || !browser?.canGoForward} aria-label="Go forward" title="Go forward" onClick={()=>void action('browser.forward')}><ArrowRight size={15}/></button>
        <button className="browser-icon" disabled={!ready} aria-label={browser?.loading?'Stop loading':'Reload page'} title={browser?.loading?'Stop loading':'Reload page'} onClick={()=>void action(browser?.loading?'browser.stop':'browser.reload')}>{browser?.loading?<Square size={13}/>:<RotateCw size={14}/>}</button>
      </div>
      <form className="browser-address-form" onSubmit={event=>void navigate(event)}>
        <Globe size={14} aria-hidden="true"/>
        <input aria-label="Website address" placeholder="Enter a website address" value={address} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={!ready} onFocus={()=>{editing.current=true;}} onChange={event=>setAddress(event.target.value)} onBlur={()=>{editing.current=false;}} onKeyDown={event=>{if(event.key==='Escape'){editing.current=false;setAddress(current.current?.url==='about:blank'?'':current.current?.url??'');event.currentTarget.blur();}}}/>
        <button type="submit" disabled={!ready || !address.trim()} aria-label="Navigate to website">Go</button>
      </form>
    </div>
    <div className="browser-load-status" role="status" aria-live="polite">{!ready && !error?'Opening browser…':browser?.loading?'Loading page…':browser?.title || (browser?.url==='about:blank'?'New browser page':'Browser')}</div>
    {reportedError && <div className="browser-error" role="alert"><p>{reportedError}</p><button onClick={()=>ready?void action('browser.reload'):setAttempt(value=>value+1)}>{ready?'Retry page':'Reopen browser'}</button></div>}
    {browser?.notice && <p className="browser-notice" role="status">{browser.notice}</p>}
    <div ref={host} className="browser-surface" role="region" aria-label="Website content" aria-busy={browser?.loading??false}>
      {ready && browser?.url==='about:blank' && !reportedError && <div className="browser-empty"><Globe size={26} aria-hidden="true"/><p>Browse a website</p><span>Enter an HTTP or HTTPS address above.</span></div>}
    </div>
    <footer className="browser-profile" title={`${profileName} profile (${profileId}). Tabs with this profile share site sign-ins. Other profiles are isolated. Site data survives restarts; back/forward history ends when this tab closes.`}><Shield size={12} aria-hidden="true"/><span>{profileName} profile</span><span>History lasts for this tab</span></footer>
  </div>;
}
