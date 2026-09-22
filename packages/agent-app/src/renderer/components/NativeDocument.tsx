import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '../bridge';
import {filePresentation, friendlyFileError} from './filePresentation';
import {PdfFile} from './PdfFile';
import {WorkbookFile} from './WorkbookFile';
import {FileAnnotations} from './FileAnnotations';
import type {FileBody} from '../store';

/** A local AppKit view occupies this measured slot; file bytes never leave the Mac. */
function NativeSurface({folderId,path,revision,onError}:{folderId:string;path:string;revision:object;onError:(error:string)=>void}) {
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const owner=`preview:${crypto.randomUUID()}`;
    let disposed=false,visible=false,moving=false,frame=0,lastBounds='';
    const hide=()=>{if(visible){visible=false;lastBounds='';void invoke('files.nativeHide',{owner}).catch(()=>{});}};
    const update=()=>{
      frame=0;if(disposed || !host.current)return;
      const element=host.current,rect=element.getBoundingClientRect();
      const overlay=Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[data-native-preview-overlay]')).some(el=>el.getClientRects().length>0);
      if(moving || document.hidden || element.closest('[hidden]') || rect.width<1 || rect.height<1 || overlay){hide();return;}
      const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
      if(visible && lastBounds===key)return;
      const starting=!visible;visible=true;lastBounds=key;
      const request=starting?invoke('files.nativeShow',{owner,folderId,path,bounds}):invoke('files.nativePosition',{owner,bounds});
      void request.catch(error=>{if(!disposed){hide();onError(error instanceof Error?error.message:String(error));}});
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    const start=()=>{moving=true;hide();};const end=()=>{moving=false;schedule();};
    const focus=()=>{visible=false;lastBounds='';schedule();};
    const resize=new ResizeObserver(schedule);if(host.current)resize.observe(host.current);
    const mutations=new MutationObserver(schedule);
    mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','aria-hidden','open']});
    window.addEventListener('muster:layout-start',start);window.addEventListener('muster:layout-end',end);
    window.addEventListener('resize',schedule);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    schedule();
    return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();hide();window.removeEventListener('muster:layout-start',start);window.removeEventListener('muster:layout-end',end);window.removeEventListener('resize',schedule);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[folderId,path,revision,onError]);
  return <div ref={host} className="native-preview-surface" role="region" aria-label={`macOS preview of ${path}`}/>;
}

export function NativeDocument({folderId,path,revision}:{folderId:string;path:string;revision:object}) {
  // Keep the format-aware reader as the dependable default. macOS Quick Look
  // remains an explicit in-app renderer because support and layout vary by file.
  const [reader,setReader]=useState(true),[error,setError]=useState(''),[body,setBody]=useState<FileBody|null>(null),[loading,setLoading]=useState(false),[location,setLocation]=useState('Document'),[quote,setQuote]=useState('');
  const workbookPreview=filePresentation(path)==='workbook';
  useEffect(()=>{setBody(null);setError('');},[revision]);
  useEffect(()=>{
    if(!reader)return;
    let active=true;setLoading(true);setError('');
    const read=filePresentation(path)==='workbook'?invoke('files.workbook',{folderId,path}).then(workbook=>({text:'',truncated:false,workbook})):invoke('files.document',{folderId,path}).then(document=>({text:'',truncated:false,document}));
    void read.then(value=>{if(active)setBody(value);}).catch(e=>{if(active)setError(friendlyFileError(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[reader,folderId,path,revision]);
  const version=body?.document?.revision??body?.workbook?.revision;
  return <div className="native-document">
    <div className="native-preview-toolbar"><div role="group" aria-label="Preview renderer">{!workbookPreview && <button aria-pressed={!reader} onClick={()=>{setError('');setReader(false);}}>macOS preview</button>}<button aria-pressed={reader} onClick={()=>setReader(true)}>{workbookPreview?'Excel preview':'Reader & annotations'}</button></div><span>Local · read only</span></div>
    {error && <div className="pane-error" role="alert"><p>{error}</p>{!reader && <button onClick={()=>setReader(true)}>Open in reader</button>}</div>}
    {!reader && !error ? <NativeSurface folderId={folderId} path={path} revision={revision} onError={setError}/> : reader && loading ? <div className="pane-loading">Preparing document…</div> : reader && body?.document ? <PdfFile document={body.document} onLocation={setLocation}/> : reader && body?.workbook ? <WorkbookFile workbook={body.workbook} onLocation={(value,selected)=>{setLocation(value);setQuote(selected??'');}}/> : null}
    {reader && version && <FileAnnotations folderId={folderId} path={path} revision={version} location={location} quote={quote}/>}
  </div>;
}
