import React,{useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';

/** CSS width of one rail thumbnail; the backing store is capped at 2x. */
export const RAIL_THUMB_WIDTH=96;
// Thumbnails this far outside the rail viewport paint ahead; farther ones release their canvas.
const RAIL_MARGIN='400px 0px';

const RailThumb=React.memo(function RailThumb({pdf,number,aspect,near,current,register,onJump}:{pdf:PDFDocumentProxy;number:number;aspect:number;near:boolean;current:boolean;register:(number:number,element:HTMLButtonElement|null)=>void;onJump:(page:number)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),[painted,setPainted]=useState(false);
  useEffect(()=>{
    const element=canvas.current;
    if(!near){if(element){element.width=0;element.height=0;}setPainted(false);return;}
    let cancelled=false,render:RenderTask|undefined;
    void (async()=>{
      const page=await pdf.getPage(number);if(cancelled||!canvas.current)return;
      const base=page.getViewport({scale:1}),ratio=Math.min(window.devicePixelRatio||1,2);
      const viewport=page.getViewport({scale:RAIL_THUMB_WIDTH/Math.max(1,base.width)});
      const target=canvas.current;target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));
      render=page.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});
      await render.promise;if(!cancelled)setPainted(true);
    })().catch(()=>{/* a thumbnail that cannot paint keeps its blank page */});
    return()=>{cancelled=true;render?.cancel();};
  },[pdf,number,near]);
  useEffect(()=>{const element=canvas.current;return()=>{if(element){element.width=0;element.height=0;}};},[]);
  const height=Math.round(RAIL_THUMB_WIDTH*aspect);
  return <button type="button" className="pdf-rail-thumb" data-page={number} data-painted={painted||undefined} aria-current={current?'page':undefined} aria-label={`Page ${number}`} ref={element=>register(number,element)} onClick={()=>onJump(number)}>
    <canvas ref={canvas} style={{width:RAIL_THUMB_WIDTH,height}} aria-hidden="true"/>
    <span className="pdf-rail-number" aria-hidden="true">{number}</span>
  </button>;
});

/** USER-34: a collapsible column of page thumbnails; the current page is marked and a click jumps to it.
 *  Only thumbnails near the rail's viewport hold a canvas (without IntersectionObserver, the first eight). */
export function PdfThumbnailRail({pdf,aspects,current,onJump,visible}:{pdf:PDFDocumentProxy;aspects:readonly number[];current:number;onJump:(page:number)=>void;visible:boolean}) {
  const rail=useRef<HTMLElement>(null),thumbs=useRef(new Map<number,HTMLButtonElement>()),observer=useRef<IntersectionObserver|null>(null);
  const [near,setNear]=useState<ReadonlySet<number>>(()=>new Set(Array.from({length:Math.min(8,aspects.length)},(_,i)=>i+1)));
  useEffect(()=>{
    const root=rail.current;if(!root||typeof IntersectionObserver!=='function')return;
    const watcher=new IntersectionObserver(entries=>setNear(previous=>{
      const next=new Set(previous);
      for(const entry of entries){const number=Number((entry.target as HTMLElement).dataset.page);if(entry.isIntersecting)next.add(number);else next.delete(number);}
      return next.size===previous.size&&[...next].every(n=>previous.has(n))?previous:next;
    }),{root,rootMargin:RAIL_MARGIN});
    observer.current=watcher;
    for(const element of thumbs.current.values())watcher.observe(element);
    return()=>{watcher.disconnect();observer.current=null;};
  },[pdf]);
  const register=React.useCallback((number:number,element:HTMLButtonElement|null)=>{
    const previous=thumbs.current.get(number);if(previous===element)return;
    if(previous)observer.current?.unobserve(previous);
    if(element){thumbs.current.set(number,element);observer.current?.observe(element);}else thumbs.current.delete(number);
  },[]);
  // Keep the current page's thumbnail in view as the document scrolls.
  useEffect(()=>{const element=thumbs.current.get(current);if(element&&typeof element.scrollIntoView==='function')element.scrollIntoView({block:'nearest'});},[current]);
  const onKeyDown=(event:React.KeyboardEvent)=>{
    const step=event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:event.key==='Home'?-Infinity:event.key==='End'?Infinity:0;
    if(!step)return;event.preventDefault();
    const next=Math.min(aspects.length,Math.max(1,current+step));onJump(next);thumbs.current.get(next)?.focus();
  };
  return <nav className="pdf-rail" ref={rail} aria-label="Page thumbnails" onKeyDown={onKeyDown}>
    {aspects.map((aspect,index)=><RailThumb key={index} pdf={pdf} number={index+1} aspect={aspect} near={visible&&near.has(index+1)} current={current===index+1} register={register} onJump={onJump}/>)}
  </nav>;
}
