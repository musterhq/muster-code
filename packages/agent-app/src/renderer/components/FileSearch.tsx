import React, {useEffect, useState} from 'react';
import {Search, File} from 'lucide-react';
import {invoke} from '../bridge';
import {openFile} from '../store';
import type {Commands} from '../../shared/protocol';
import {FileTree} from './FileTree';

export function FileSearch({folderId,path,activePath}: {folderId:string; path:string; activePath?:string}) {
  const [query,setQuery] = useState('');
  const [result,setResult] = useState<Commands['files.search']['output'] | null>(null);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  useEffect(() => {
    let live = true; setResult(null); setError('');
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void invoke('files.search',{folderId,path,query}).then(value=>{if(live)setResult(value);},cause=>{if(live)setError(cause instanceof Error ? cause.message : String(cause));});
    },250);
    return () => {live = false; clearTimeout(timer);};
  },[folderId,path,query,retry]);
  return <>
    <label className="file-search"><Search size={13}/><input type="search" aria-label="Find files in folder" placeholder="Find files…" maxLength={256} value={query} onChange={event=>setQuery(event.target.value)}/></label>
    {!query.trim() ? <FileTree folderId={folderId} path={path} activePath={activePath}/> : error ? <div className="tree-error"><span>{error}</span><button onClick={()=>setRetry(value=>value+1)}>Retry</button></div> : !result ? <p className="tree-loading" role="status">Finding files…</p> : <>
      {!result.entries.length && <p className="tree-empty">No matching files found.</p>}
      <ul className="tree">{result.entries.map(entry=><li key={entry.path}><button className="tree-row" title={entry.path} aria-current={entry.path===activePath?'page':undefined} onClick={()=>void openFile(folderId,entry.path)}><File size={13}/><span>{entry.path}</span></button></li>)}</ul>
      {result.truncated && <p className="file-format-note" role="status">Partial results: search limits, inaccessible folders or links were encountered. Narrow your search or browse the folder.</p>}
    </>}
  </>;
}
