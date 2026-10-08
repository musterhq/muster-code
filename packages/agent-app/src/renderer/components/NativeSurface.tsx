import React, {useEffect, useRef} from 'react';
import {invoke} from '../bridge';
import {OVERLAY_SELECTOR,observeOverlayChanges,sameBounds,type Bounds} from '../overlayObserver';

/**
 * A local AppKit Quick Look view occupies this measured slot; file bytes never leave the Mac.
 * The native view hides while menus, dialogs or layout transitions would sit above it.
 */
export function NativeSurface({folderId,path,revision,onError}:{folderId:string;path:string;revision:object;onError:(error:string)=>void}) {
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const owner=`preview:${crypto.randomUUID()}`;
    let disposed=false,visible=false,moving=false,frame=0,lastBounds:Bounds|null=null;
    const hide=()=>{if(visible){visible=false;lastBounds=null;void invoke('files.nativeHide',{owner}).catch(()=>{});}};
    const update=()=>{
      frame=0;if(disposed || !host.current)return;
      const element=host.current,rect=element.getBoundingClientRect();
      const overlay=Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(el=>el.getClientRects().length>0);
      if(moving || document.hidden || element.closest('[hidden]') || rect.width<1 || rect.height<1 || overlay){hide();return;}
      const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      if(visible && sameBounds(lastBounds,bounds))return;
      const starting=!visible;visible=true;lastBounds=bounds;
      const request=starting?invoke('files.nativeShow',{owner,folderId,path,bounds}):invoke('files.nativePosition',{owner,bounds});
      void request.catch(error=>{if(!disposed){hide();onError(error instanceof Error?error.message:String(error));}});
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    const start=()=>{moving=true;hide();};const end=()=>{moving=false;schedule();};
    const focus=()=>{visible=false;lastBounds=null;schedule();};
    const resize=new ResizeObserver(schedule);if(host.current)resize.observe(host.current);
    const stopMutations=observeOverlayChanges(()=>host.current,schedule,['hidden','aria-hidden','open']);
    window.addEventListener('muster:layout-start',start);window.addEventListener('muster:layout-end',end);
    window.addEventListener('resize',schedule);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    schedule();
    return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();stopMutations();hide();window.removeEventListener('muster:layout-start',start);window.removeEventListener('muster:layout-end',end);window.removeEventListener('resize',schedule);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[folderId,path,revision,onError]);
  return <div ref={host} className="native-preview-surface" role="region" aria-label={`macOS preview of ${path}`}/>;
}
