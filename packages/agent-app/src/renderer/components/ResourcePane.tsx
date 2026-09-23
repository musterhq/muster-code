import {transitionLayout} from '../layoutMotion';
import { Maximize2, Minimize2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore';
import { Workspace } from './Workspace';
import { ComputerPip, ComputerViewer } from './ComputerPip';
import { useComputerUi } from '../computerUse';
import { dragPaneWidth } from '../paneResize';

const KEY = 'muster.resourceWidth';
function initialWidth() {
  try { const value = Number(localStorage.getItem(KEY)); if (value >= 280 && value <= 2000) return value; } catch {}
  return Math.round(window.innerWidth / 3);
}

/** Optional file/tool surface. Chat activity is rendered in its own persistent rail. */
export function ResourcePane({suspended=false}:{suspended?:boolean}) {
  const {navWidth, navHidden, tabs, resourcesHidden} = useStore();
  // CUA-02: a docked live view or an opened screenshot takes the pane over until it is closed.
  const viewer = useComputerUi().viewer;
  const [width, setWidth] = useState(initialWidth);
  const [maximized, setMaximized] = useState(false);
  const [viewport, setViewport] = useState(window.innerWidth);
  const drag = useRef<{x:number; width:number} | null>(null);
  const [resizing, setResizing] = useState(false);
  const frame = useRef(0);
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  const latest = useRef(width); latest.current = width;
  useEffect(()=>{const onResize=()=>setViewport(window.innerWidth);window.addEventListener('resize',onResize);return()=>window.removeEventListener('resize',onResize);},[]);
  // The summary card floats inside the conversation, so it claims no pane width.
  const activityRailWidth = 0;
  const maxWidth = Math.max(280, viewport-(navHidden?0:navWidth)-activityRailWidth-480);
  const effectiveWidth = Math.min(maxWidth, Math.max(280,width));
  const persist = () => {try{localStorage.setItem(KEY,String(latest.current));}catch{}};
  const toggleMaximized = () => {
    transitionLayout(()=>setMaximized(value=>!value));
    requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.resource-maximize, .resource-compact-open')?.focus());
  };
  // Keep a usable conversation and the permanent activity summary at narrow widths.
  if (!suspended && !resourcesHidden && viewport - (navHidden?0:navWidth) - activityRailWidth < 720 && !maximized) {
    return <><ComputerPip/><button className="icon-button resource-compact-open" style={{right:activityRailWidth+12}} aria-label={`Open resources (${tabs.length})`} onClick={toggleMaximized}>
      <Maximize2 size={14}/>
    </button></>;
  }
  const hidden=(resourcesHidden&&!viewer)||suspended;
  return <><ComputerPip/><aside className="workspace" aria-label="Resources" aria-hidden={hidden} data-maximized={!hidden&&maximized} data-resizing={resizing||undefined} hidden={hidden}
    style={{width:hidden?0:maximized ? `calc(100% - ${navHidden?0:navWidth}px - ${activityRailWidth}px)` : effectiveWidth,minWidth:hidden?0:280,maxWidth:'none',position:'relative'}}>
    {!maximized && <div className="resource-separator" role="separator" aria-label="Resize resources" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxWidth} aria-valuenow={effectiveWidth} tabIndex={0}
      onPointerDown={e=>{drag.current={x:e.clientX,width:effectiveWidth};setResizing(true);e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{if(drag.current){const value=dragPaneWidth(drag.current,e,maxWidth);if(value===null){drag.current=null;setResizing(false);persist();return;}latest.current=value;cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>setWidth(latest.current));}}}
      onPointerUp={e=>{drag.current=null;setResizing(false);setWidth(latest.current);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);persist();}}
      onPointerCancel={()=>{drag.current=null;setResizing(false);}}
      onLostPointerCapture={()=>{if(!drag.current)return;drag.current=null;setResizing(false);setWidth(latest.current);persist();}}
      onDoubleClick={()=>{latest.current=Math.round(viewport/3);setWidth(latest.current);persist();}}
      onKeyDown={e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();const delta=(e.shiftKey?32:8)*(e.key==='ArrowLeft'?1:-1);const value=Math.min(maxWidth,Math.max(280,effectiveWidth+delta));latest.current=value;setWidth(value);persist();}} />}
    <div className="right-pane-content">
      {viewer ? <ComputerViewer/> : <Workspace onToggleResourceMaximize={toggleMaximized} resourceMaximized={maximized} headerAction={<button className="icon-button resource-maximize" aria-label={maximized?'Restore resource pane':'Maximize resource pane'} title={maximized?'Restore':'Maximize'} aria-pressed={maximized} onClick={toggleMaximized}>
        {maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>} />}
    </div>
  </aside></>;
}
