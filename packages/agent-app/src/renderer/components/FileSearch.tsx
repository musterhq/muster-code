import React, {useEffect, useState} from 'react';
import {Search} from 'lucide-react';
import {invoke} from '../bridge';
import {openFile} from '../store';
import type {Commands} from '../../shared/protocol';
import {FileTree} from './FileTree';
import {FileTypeIcon} from './FileTypeIcon';
import {ResourceState} from './ResourceState';

export type FileSearchResult = {result: Commands['files.search']['output'] | null; error: string; retry: () => void};

/** Debounced, bounded host search; an empty query clears results without a request. */
export function useFileSearch(folderId: string | undefined, path: string, query: string): FileSearchResult {
  const [result,setResult] = useState<Commands['files.search']['output'] | null>(null);
  const [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setResult(null); setError('');
    if (!folderId || !query.trim()) return;
    const timer = setTimeout(() => {
      void invoke('files.search',{folderId,path,query}).then(value=>{if(live)setResult(value);},cause=>{if(live)setError(cause instanceof Error ? cause.message : String(cause));});
    },250);
    return () => {live = false; clearTimeout(timer);};
  },[folderId,path,query,attempt]);
  return {result, error, retry: () => setAttempt(value => value + 1)};
}

export function FileSearch({folderId,path,activePath}: {folderId:string; path:string; activePath?:string}) {
  const [query,setQuery] = useState('');
  const {result,error,retry} = useFileSearch(folderId,path,query);
  return <>
    <label className="file-search"><Search size={13}/><input type="search" aria-label="Find files in folder" placeholder="Find files…" maxLength={256} value={query} onChange={event=>setQuery(event.target.value)}/></label>
    {!query.trim() ? <FileTree folderId={folderId} path={path} activePath={activePath}/> : error ? <ResourceState kind="error" message={error} onRetry={retry} compact/> : !result ? <ResourceState kind="loading" label="Finding files" rows={3} compact/> : <>
      {!result.entries.length && <ResourceState kind="empty" message="No matching files found." compact/>}
      <ul className="tree">{result.entries.map(entry=><li key={entry.path}><button className="tree-row" title={entry.path} aria-current={entry.path===activePath?'page':undefined} onClick={()=>void openFile(folderId,entry.path)}><FileTypeIcon path={entry.path}/><span>{entry.path}</span></button></li>)}</ul>
      {result.truncated && <p className="file-format-note" role="status">Partial results: search limits, inaccessible folders or links were encountered. Narrow your search or browse the folder.</p>}
    </>}
  </>;
}
