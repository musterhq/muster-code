import React,{useEffect,useState} from 'react';
import {invoke} from '../bridge';
import {filePresentation, friendlyFileError, isLibreOfficeMissing} from './filePresentation';
import {NativeSurface} from './NativeSurface';
import {PdfFile} from './PdfFile';
import {WorkbookFile} from './WorkbookFile';
import {FileAnnotations} from './FileAnnotations';
import type {FileBody} from '../store';

export function NativeDocument({folderId,path,revision,onToggleResourceMaximize,resourceMaximized=false}:{folderId:string;path:string;revision:object;onToggleResourceMaximize?:()=>void;resourceMaximized?:boolean}) {
  // Keep the format-aware reader as the dependable default. macOS Quick Look
  // remains an explicit in-app renderer because support and layout vary by file.
  const [reader,setReader]=useState(true),[error,setError]=useState(''),[body,setBody]=useState<FileBody|null>(null),[loading,setLoading]=useState(false),[location,setLocation]=useState('Document'),[quote,setQuote]=useState(''),[note,setNote]=useState('');
  const workbookPreview=filePresentation(path)==='workbook';
  useEffect(()=>{setBody(null);setError('');},[revision]);
  // The macOS renderer reads the file natively; do not keep the reader's decoded
  // copy (base64 PDF or parsed workbook) alive behind it.
  useEffect(()=>{if(!reader)setBody(null);},[reader]);
  useEffect(()=>{
    if(!reader)return;
    let active=true;setLoading(true);setError('');
    const read=filePresentation(path)==='workbook'?invoke('files.workbook',{folderId,path}).then(workbook=>({text:'',truncated:false,workbook})):invoke('files.document',{folderId,path}).then(document=>({text:'',truncated:false,document}));
    void read.then(value=>{if(active)setBody(value);}).catch(e=>{if(!active)return;
      // Without LibreOffice the reader cannot convert Office files; fall back to macOS Quick Look instead of an error.
      if(!workbookPreview&&isLibreOfficeMissing(e)){setReader(false);setNote('Showing macOS preview (LibreOffice not installed)');return;}
      setError(friendlyFileError(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[reader,folderId,path,revision]);
  const version=body?.document?.revision??body?.workbook?.revision;
  return <div className="native-document">
    <div className="native-preview-toolbar"><div role="group" aria-label="Preview renderer">{!workbookPreview && <button aria-pressed={!reader} onClick={()=>{setError('');setReader(false);}}>macOS preview</button>}<button aria-pressed={reader} onClick={()=>{setNote('');setReader(true);}}>{workbookPreview?'Excel preview':'Reader & annotations'}</button></div>{note&&!reader?<span role="status">{note}</span>:<span>Local · read only</span>}</div>
    {error && <div className="pane-error" role="alert"><p>{error}</p>{!reader && <button onClick={()=>setReader(true)}>Open in reader</button>}</div>}
    {!reader && !error ? <NativeSurface folderId={folderId} path={path} revision={revision} onError={setError}/> : reader && loading ? <div className="pane-loading">Preparing document…</div> : reader && body?.document ? <PdfFile document={body.document} onLocation={setLocation}/> : reader && body?.workbook ? <WorkbookFile workbook={body.workbook} onLocation={(value,selected)=>{setLocation(value);setQuote(selected??'');}} onToggleFullPage={onToggleResourceMaximize} fullPage={resourceMaximized}/> : null}
    {reader && version && <FileAnnotations folderId={folderId} path={path} revision={version} location={location} quote={quote}/>}
  </div>;
}
