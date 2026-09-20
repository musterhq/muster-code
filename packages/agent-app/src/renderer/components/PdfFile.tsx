import React,{useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,PDFDocumentLoadingTask,RenderTask,TextLayer} from 'pdfjs-dist';
import type {DocumentPreview} from '../../shared/protocol';
import {openBrowserTab} from '../store';

type PdfLibrary=typeof import('pdfjs-dist');
export function PdfFile({document,onLocation}:{document:DocumentPreview;onLocation:(location:string)=>void}) {
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[scale,setScale]=useState<number|null>(null),[width,setWidth]=useState(500),[error,setError]=useState(''),[busy,setBusy]=useState(true),[password,setPassword]=useState(''),[locked,setLocked]=useState(false);
  const [links,setLinks]=useState<{label:string;url?:string;dest?:unknown}[]>([]);
  const lib=useRef<PdfLibrary|null>(null),canvas=useRef<HTMLCanvasElement>(null),text=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),unlock=useRef<((password:string)=>void)|null>(null);
  useEffect(()=>{
    let cancelled=false,task:PDFDocumentLoadingTask|undefined;
    setPdf(null);setError('');setBusy(true);setPage(1);setLocked(false);
    void import('pdfjs-dist').then(async module=>{
      if(cancelled)return;lib.current=module;
      module.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',window.location.href).href;
      const binary=atob(document.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      task=module.getDocument({data:bytes,useSystemFonts:true,maxImageSize:16777216,disableAutoFetch:true});
      task.onPassword=(callback:(password:string)=>void)=>{if(!cancelled){unlock.current=callback;setLocked(true);setBusy(false);}};
      const loaded=await task.promise;
      if(!cancelled){setPdf(loaded);setLocked(false);}else void task.destroy();
    }).catch(e=>{if(!cancelled){setError(e instanceof Error?e.message:String(e));setBusy(false);}});
    return()=>{cancelled=true;unlock.current=null;void task?.destroy();};
  },[document.revision]);
  useEffect(()=>{const el=surface.current;if(!el)return;const observer=new ResizeObserver(entries=>setWidth(Math.max(160,entries[0].contentRect.width-32)));observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!pdf || !lib.current)return;
    let cancelled=false,render:RenderTask|undefined,layer:TextLayer|undefined;
    setBusy(true);setError('');setLinks([]);onLocation(`Page ${page}`);
    void (async()=>{
      const item=await pdf.getPage(page);if(cancelled || !canvas.current || !text.current)return;
      const base=item.getViewport({scale:1}),zoom=scale ?? width/base.width,viewport=item.getViewport({scale:zoom});
      // Keep backing canvas below 5M pixels even on a Retina display or high zoom.
      const ratio=Math.min(window.devicePixelRatio||1,Math.sqrt(5_000_000/(viewport.width*viewport.height)));
      const element=canvas.current; element.width=Math.max(1,Math.floor(viewport.width*ratio));element.height=Math.max(1,Math.floor(viewport.height*ratio));element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;
      render=item.render({canvas:element,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});
      await render.promise;if(cancelled)return;
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor",String(zoom));
      layer=new lib.current!.TextLayer({textContentSource:item.streamTextContent(),container:text.current,viewport});
      await layer.render();if(cancelled)return;
      const annotations=await item.getAnnotations();
      if(!cancelled){setLinks(annotations.filter(a=>a.subtype==='Link' || a.subtype==='Text').slice(0,100).map(a=>({label:a.contentsObj?.str || a.titleObj?.str || a.url || (a.dest?'Document link':'Note'),url:a.url,dest:a.dest})));setBusy(false);}
    })().catch(e=>{if(!cancelled && e?.name!=='RenderingCancelledException'){setError(e instanceof Error?e.message:String(e));setBusy(false);}});
    return()=>{cancelled=true;render?.cancel();layer?.cancel();};
  },[pdf,page,scale,width]);
  async function follow(link:{url?:string;dest?:unknown}) {
    try {
      if(link.url){if(!/^https?:\/\//i.test(link.url))throw new Error('Only web links can be opened.');openBrowserTab(link.url);}
      else if(link.dest && pdf){const destination=typeof link.dest==='string'?await pdf.getDestination(link.dest):link.dest;if(Array.isArray(destination)){const index=typeof destination[0]==='number'?destination[0]:await pdf.getPageIndex(destination[0]);setPage(Math.min(pdf.numPages,Math.max(1,index+1)));}}
    } catch(e){setError(String(e));}
  }
  return <div className="pdf-file">
    <div className="document-toolbar" role="group" aria-label="Document navigation">
      <button disabled={!pdf || page<=1} onClick={()=>setPage(p=>p-1)}>Previous page</button>
      <label>Page <input aria-label="Page number" type="number" min={1} max={pdf?.numPages??1} value={page} onChange={event=>{const next=Number(event.target.value);if(pdf && Number.isInteger(next) && next>=1 && next<=pdf.numPages)setPage(next);}}/> / {pdf?.numPages??'…'}</label>
      <button disabled={!pdf || page>=pdf.numPages} onClick={()=>setPage(p=>p+1)}>Next page</button>
      <select aria-label="Document zoom" value={scale??'fit'} onChange={event=>setScale(event.target.value==='fit'?null:Number(event.target.value))}><option value="fit">Fit width</option>{[.5,.75,1,1.25,1.5,2].map(s=><option key={s} value={s}>{s*100}%</option>)}</select>
    </div>
    {locked && <form className="pdf-password" onSubmit={event=>{event.preventDefault();unlock.current?.(password);setPassword('');setBusy(true);}}><label>PDF password <input type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)}/></label><button>Unlock document</button></form>}
    {error && <p className="pane-error" role="alert">Cannot display document: {error}</p>}
    <div className="pdf-scroll" ref={surface} role="region" aria-label="Document page" tabIndex={0}>
      {busy && <div className="document-loading" role="status">Rendering page…</div>}
      <div className="pdf-page" style={{visibility:pdf && !locked?'visible':'hidden'}}><canvas ref={canvas} aria-label={`Page ${page}`}/><div ref={text} className="textLayer"/></div>
    </div>
    {!!links.length && <details className="pdf-links"><summary>Page links and embedded notes ({links.length})</summary>{links.map((link,i)=>link.url || link.dest?<button key={i} onClick={()=>void follow(link)}>{link.label}</button>:<p key={i}>{link.label}</p>)}</details>}
    {document.converted && <p className="file-format-note">Local {document.sourceFormat.toUpperCase()} preview · original unchanged. Fonts and pagination may differ from the authoring app.</p>}
  </div>;
}
