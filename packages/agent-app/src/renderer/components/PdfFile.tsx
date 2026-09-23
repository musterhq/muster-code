import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {usePageVisible} from '../pageVisibility';
import {ChevronDown,ChevronUp,PanelLeft} from 'lucide-react';
import {PdfThumbnailRail} from './PdfThumbnailRail';
import type {PDFDocumentProxy,PDFDocumentLoadingTask,RenderTask,TextLayer} from 'pdfjs-dist';
import type {DocumentPreview} from '../../shared/protocol';
import {openBrowserTab} from '../store';

type PdfLibrary=typeof import('pdfjs-dist');
type Size=readonly [number,number];
// Backing store per page stays under 4M pixels (~16 MB) even on Retina at high zoom.
const MAX_PIXELS=4_000_000;
// Pages this far outside the viewport are painted ahead of the scroll; farther ones release their canvas.
const PAINT_MARGIN='900px 0px';
const RAIL_KEY='muster.pdf.thumbnails';
const readRail=()=>{try{return window.localStorage.getItem(RAIL_KEY)==='1';}catch{return false;}};

/** One paper page: a sized placeholder that paints only while near the viewport and frees its canvas when it leaves. */
const PdfPage=React.memo(function PdfPage({pdf,lib,number,size,zoom,near,register,onSize,onError}:{pdf:PDFDocumentProxy;lib:PdfLibrary;number:number;size:Size;zoom:number;near:boolean;register:(number:number,element:HTMLDivElement|null)=>void;onSize:(number:number,size:Size)=>void;onError:(message:string)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),text=useRef<HTMLDivElement>(null),[painted,setPainted]=useState(false);
  useEffect(()=>{
    if(!near)return;
    let cancelled=false,render:RenderTask|undefined,layer:TextLayer|undefined;
    void (async()=>{
      const item=await pdf.getPage(number);if(cancelled || !canvas.current || !text.current)return;
      const base=item.getViewport({scale:1});
      if(Math.abs(base.width-size[0])>.5 || Math.abs(base.height-size[1])>.5)onSize(number,[base.width,base.height]);
      const viewport=item.getViewport({scale:zoom});
      const ratio=Math.min(window.devicePixelRatio||1,Math.sqrt(MAX_PIXELS/(viewport.width*viewport.height)));
      const element=canvas.current;element.width=Math.max(1,Math.floor(viewport.width*ratio));element.height=Math.max(1,Math.floor(viewport.height*ratio));
      render=item.render({canvas:element,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});
      await render.promise;if(cancelled)return;
      setPainted(true);
      text.current.replaceChildren();
      text.current.style.setProperty('--total-scale-factor',String(zoom));
      layer=new lib.TextLayer({textContentSource:item.streamTextContent(),container:text.current,viewport});
      await layer.render();
    })().catch(e=>{if(!cancelled && e?.name!=='RenderingCancelledException')onError(e instanceof Error?e.message:String(e));});
    return()=>{cancelled=true;render?.cancel();layer?.cancel();};
  },[pdf,lib,number,zoom,near]);
  // Leaving the paint window releases the canvas, text spans and the page's decoded resources.
  const wasNear=useRef(false);
  useEffect(()=>{
    if(near){wasNear.current=true;return;}
    if(!wasNear.current)return;
    wasNear.current=false;
    const element=canvas.current;if(element){element.width=0;element.height=0;}
    text.current?.replaceChildren();setPainted(false);
    void pdf.getPage(number).then(item=>{try{item.cleanup();}catch{/* document already destroyed */}},()=>{});
  },[near,pdf,number]);
  useEffect(()=>{const element=canvas.current,layer=text.current;return()=>{if(element){element.width=0;element.height=0;}layer?.replaceChildren();};},[]);
  const width=size[0]*zoom,height=size[1]*zoom;
  return <div className="pdf-page" data-page={number} data-painted={painted||undefined} ref={element=>register(number,element)} style={{width,height}} aria-label={`Page ${number}`} role="group">
    <canvas ref={canvas} style={{width,height}} aria-hidden="true"/>
    <div ref={text} className="textLayer"/>
  </div>;
});

/** PDFs and converted Office documents as a continuous stack of white pages on a grey desk, like a print preview. */
export function PdfFile({document,onLocation}:{document:DocumentPreview;onLocation:(location:string)=>void}) {
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[sizes,setSizes]=useState<Size[]>([]),[page,setPage]=useState(1),[scale,setScale]=useState<number|null>(null),[width,setWidth]=useState(0);
  const [near,setNear]=useState<ReadonlySet<number>>(()=>new Set([1,2])),[error,setError]=useState(''),[busy,setBusy]=useState(true),[password,setPassword]=useState(''),[locked,setLocked]=useState(false);
  const [links,setLinks]=useState<{label:string;url?:string;dest?:unknown}[]>([]);
  // USER-34: the thumbnail rail's open state is a per-viewer convenience remembered across documents.
  const [rail,setRail]=useState(readRail);
  const toggleRail=()=>setRail(open=>{const next=!open;try{window.localStorage.setItem(RAIL_KEY,next?'1':'0');}catch{/* storage unavailable */}return next;});
  // PER-04: a hidden window keeps no painted page canvases; they repaint near the viewport on return.
  const visible=usePageVisible();
  const lib=useRef<PdfLibrary|null>(null),surface=useRef<HTMLDivElement>(null),unlock=useRef<((password:string)=>void)|null>(null);
  const pages=useRef(new Map<number,HTMLDivElement>()),observer=useRef<IntersectionObserver|null>(null),position=useRef(0),frame=useRef(0);
  useEffect(()=>{
    let cancelled=false,task:PDFDocumentLoadingTask|undefined;
    setPdf(null);setSizes([]);setError('');setBusy(true);setPage(1);setLocked(false);
    void import('pdfjs-dist').then(async module=>{
      if(cancelled)return;lib.current=module;
      module.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',window.location.href).href;
      const binary=atob(document.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      task=module.getDocument({data:bytes,useSystemFonts:true,maxImageSize:16777216,disableAutoFetch:true});
      task.onPassword=(callback:(password:string)=>void)=>{if(!cancelled){unlock.current=callback;setLocked(true);setBusy(false);}};
      const loaded=await task.promise;
      if(cancelled){void task.destroy();return;}
      // Every page starts at the first page's size; each corrects itself when it paints.
      const first=(await loaded.getPage(1)).getViewport({scale:1});
      if(cancelled)return;
      setSizes(Array.from({length:loaded.numPages},()=>[first.width,first.height] as const));
      setPdf(loaded);setLocked(false);setBusy(false);
    }).catch(e=>{if(!cancelled){setError(e instanceof Error?e.message:String(e));setBusy(false);}});
    // Destroying the loading task destroys the document and terminates its pdf.js worker.
    return()=>{cancelled=true;unlock.current=null;void task?.destroy();task=undefined;};
  },[document.revision]);
  useEffect(()=>{
    const el=surface.current;if(!el || typeof ResizeObserver!=='function')return;
    // A pane drag settles before pages repaint at the new width.
    let timer:ReturnType<typeof setTimeout>|undefined,first=true;
    const resize=new ResizeObserver(entries=>{const next=Math.max(160,Math.round(entries[0].contentRect.width-48));clearTimeout(timer);timer=setTimeout(()=>setWidth(next),first?0:90);first=false;});
    resize.observe(el);return()=>{clearTimeout(timer);resize.disconnect();};
  },[]);
  // Only pages near the viewport paint; without IntersectionObserver the first two do.
  useEffect(()=>{
    const root=surface.current;if(!pdf || !root || typeof IntersectionObserver!=='function')return;
    const watcher=new IntersectionObserver(entries=>setNear(previous=>{
      const next=new Set(previous);
      for(const entry of entries){const number=Number((entry.target as HTMLElement).dataset.page);if(entry.isIntersecting)next.add(number);else next.delete(number);}
      return next.size===previous.size && [...next].every(n=>previous.has(n))?previous:next;
    }),{root,rootMargin:PAINT_MARGIN});
    observer.current=watcher;
    for(const element of pages.current.values())watcher.observe(element);
    return()=>{watcher.disconnect();observer.current=null;};
  },[pdf]);
  const register=useCallback((number:number,element:HTMLDivElement|null)=>{
    const previous=pages.current.get(number);
    if(previous===element)return;
    if(previous)observer.current?.unobserve(previous);
    if(element){pages.current.set(number,element);observer.current?.observe(element);}else pages.current.delete(number);
  },[]);
  const onSize=useCallback((number:number,size:Size)=>setSizes(previous=>{const next=previous.slice();next[number-1]=size;return next;}),[]);
  // Fit width, but a maximized pane still reads like paper rather than a poster. Pages wait for the first
  // measurement so the opening pages are not painted once at 100% and again at the fitted zoom.
  const fit=sizes[0] && width?Math.min(width,1100)/sizes[0][0]:1;
  const zoom=scale ?? fit;
  // Zoom and resize keep the same place in the document.
  useLayoutEffect(()=>{const el=surface.current;if(el && position.current)el.scrollTop=position.current*el.scrollHeight;},[zoom]);
  useEffect(()=>{onLocation(`Page ${page}`);},[page]);
  useEffect(()=>{
    if(!pdf)return;
    let cancelled=false;setLinks([]);
    void pdf.getPage(page).then(item=>item.getAnnotations()).then(annotations=>{if(!cancelled)setLinks(annotations.filter(a=>a.subtype==='Link' || a.subtype==='Text').slice(0,100).map(a=>({label:a.contentsObj?.str || a.titleObj?.str || a.url || (a.dest?'Document link':'Note'),url:a.url,dest:a.dest})));},()=>{});
    return()=>{cancelled=true;};
  },[pdf,page]);
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  const onScroll=()=>{
    const el=surface.current;if(!el)return;
    position.current=el.scrollHeight?el.scrollTop/el.scrollHeight:0;
    cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{
      // The current page is the last one whose top edge is above 40% of the viewport.
      const line=el.scrollTop+el.clientHeight*.4;let low=1,high=sizes.length,found=1;
      while(low<=high){const mid=(low+high)>>1,top=pages.current.get(mid)?.offsetTop??0;if(top<=line){found=mid;low=mid+1;}else high=mid-1;}
      setPage(found);
    });
  };
  const jump=(target:number)=>{
    if(!pdf)return;const number=Math.min(pdf.numPages,Math.max(1,target));
    const element=pages.current.get(number),el=surface.current;
    if(element && el)el.scrollTo({top:element.offsetTop-16});
    setPage(number);
  };
  async function follow(link:{url?:string;dest?:unknown}) {
    try {
      if(link.url){if(!/^https?:\/\//i.test(link.url))throw new Error('Only web links can be opened.');openBrowserTab(link.url);}
      else if(link.dest && pdf){const destination=typeof link.dest==='string'?await pdf.getDestination(link.dest):link.dest;if(Array.isArray(destination)){const index=typeof destination[0]==='number'?destination[0]:await pdf.getPageIndex(destination[0]);jump(index+1);}}
    } catch(e){setError(String(e));}
  }
  const zoomValue=scale===null?'fit':String(scale);
  return <div className="pdf-file">
    <div className="document-toolbar" role="group" aria-label="Document navigation">
      <button type="button" className="document-step pdf-rail-toggle" aria-label="Page thumbnails" aria-pressed={rail} title={rail?'Hide page thumbnails':'Show page thumbnails'} disabled={!pdf||locked} onClick={toggleRail}><PanelLeft size={14}/></button>
      <button type="button" className="document-step" aria-label="Previous page" disabled={!pdf || page<=1} onClick={()=>jump(page-1)}><ChevronUp size={14}/></button>
      <button type="button" className="document-step" aria-label="Next page" disabled={!pdf || page>=pdf.numPages} onClick={()=>jump(page+1)}><ChevronDown size={14}/></button>
      <label className="document-page-field"><input aria-label="Page number" type="number" min={1} max={pdf?.numPages??1} value={page} onChange={event=>{const next=Number(event.target.value);if(pdf && Number.isInteger(next) && next>=1 && next<=pdf.numPages)jump(next);}}/><span>of {pdf?.numPages??'…'}</span></label>
      <select aria-label="Document zoom" value={zoomValue} onChange={event=>setScale(event.target.value==='fit'?null:Number(event.target.value))}><option value="fit">Fit width</option>{[.5,.75,1,1.25,1.5,2].map(s=><option key={s} value={s}>{s*100}%</option>)}</select>
    </div>
    {locked && <form className="pdf-password" onSubmit={event=>{event.preventDefault();unlock.current?.(password);setPassword('');setBusy(true);}}><label>PDF password <input type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)}/></label><button>Unlock document</button></form>}
    {error && <p className="pane-error" role="alert">Cannot display document: {error}</p>}
    <div className="pdf-body">
    {rail && pdf && !locked && <PdfThumbnailRail pdf={pdf} aspects={sizes.map(size=>size[1]/Math.max(1,size[0]))} current={page} onJump={jump} visible={visible}/>}
    <div className="pdf-scroll" ref={surface} onScroll={onScroll} role="region" aria-label="Document pages" tabIndex={0}>
      {busy && <div className="document-loading" role="status">Loading document…</div>}
      {pdf && lib.current && !locked && (width>0 || typeof ResizeObserver!=='function') && sizes.map((size,index)=><PdfPage key={index} pdf={pdf} lib={lib.current!} number={index+1} size={size} zoom={zoom} near={visible&&(typeof IntersectionObserver==='function'?near.has(index+1):index<2)} register={register} onSize={onSize} onError={setError}/>)}
    </div>
    </div>
    {!!links.length && <details className="pdf-links"><summary>Page {page} links and notes ({links.length})</summary>{links.map((link,i)=>link.url || link.dest?<button key={i} onClick={()=>void follow(link)}>{link.label}</button>:<p key={i}>{link.label}</p>)}</details>}
    {document.converted && <p className="file-format-note">Local {document.sourceFormat.toUpperCase()} preview · original unchanged. Fonts and pagination may differ from the authoring app.</p>}
  </div>;
}
