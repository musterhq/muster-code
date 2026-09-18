import { Maximize2, Minimize2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore';
import { Workspace } from './Workspace';

const KEY = 'muster.resourceWidth';
function initialWidth() {
  try { const value = Number(localStorage.getItem(KEY)); if (value >= 280 && value <= 2000) return value; } catch {}
  return Math.round(window.innerWidth / 3);
}

export function ResourcePane() {
  const {navWidth} = useStore();
  const [width, setWidth] = useState(initialWidth);
  const [maximized, setMaximized] = useState(false);
  const [viewport, setViewport] = useState(window.innerWidth);
  const drag = useRef<{x:number; width:number} | null>(null);
  const latest = useRef(width); latest.current = width;
  useEffect(()=>{const onResize=()=>setViewport(window.innerWidth);window.addEventListener('resize',onResize);return()=>window.removeEventListener('resize',onResize);},[]);
  const maxWidth = Math.max(280, viewport-navWidth-360);
  const effectiveWidth = Math.min(maxWidth, Math.max(280,width));
  const persist = () => {try{localStorage.setItem(KEY,String(latest.current));}catch{}};
  return <aside className="workspace" aria-label="Resources" data-maximized={maximized}
    style={{width:maximized ? `calc(100% - ${navWidth}px)` : effectiveWidth,maxWidth:'none',position:'relative'}}>
    {!maximized && <div className="resource-separator" role="separator" aria-label="Resize resources" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxWidth} aria-valuenow={effectiveWidth} tabIndex={0}
      onPointerDown={e=>{drag.current={x:e.clientX,width:effectiveWidth};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{if(drag.current)setWidth(Math.min(maxWidth,Math.max(280,drag.current.width+drag.current.x-e.clientX)));}}
      onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);persist();}}
      onPointerCancel={()=>{drag.current=null;}}
      onDoubleClick={()=>{const value=Math.round(viewport/3);latest.current=value;setWidth(value);persist();}}
      onKeyDown={e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();const delta=(e.shiftKey?32:8)*(e.key==='ArrowLeft'?1:-1);const value=Math.min(maxWidth,Math.max(280,effectiveWidth+delta));latest.current=value;setWidth(value);persist();}} />}
    <button className="icon-button resource-maximize" aria-label={maximized?'Restore resource pane':'Maximize resource pane'} aria-pressed={maximized} onClick={()=>setMaximized(v=>!v)}>
      {maximized?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button>
    <Workspace />
  </aside>;
}
