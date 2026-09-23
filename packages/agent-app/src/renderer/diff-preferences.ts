import {useEffect, useState} from 'react';

/**
 * Review preferences live in localStorage (optional: every access is
 * try/catch). A folder's own entry wins; otherwise the global default entry
 * applies; otherwise the built-in defaults. Writes notify mounted diffs
 * (DiffView, InlineDiff) through a window event so wrap and font size stay in
 * step across panes.
 */
export interface DiffPreferences {split:boolean;wrap:boolean;ignoreWhitespace:boolean;fontSize:number;fullFile:boolean}
/** `fullFile` is the "Inline diff length" setting: on (the default) every diff shows the whole file; off shows changes with context. */
export const DEFAULT_DIFF_PREFERENCES:DiffPreferences={split:false,wrap:false,ignoreWhitespace:false,fontSize:12,fullFile:true};
const GLOBAL_KEY='muster.diff.preferences';
const CHANGE_EVENT='muster:diff-preferences';
const folderKey=(folderId:string)=>`${GLOBAL_KEY}:${folderId}`;

function parse(raw:string|null,base:DiffPreferences):DiffPreferences|null {
  if(!raw)return null;
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object')return null;
  return {
    split:typeof value.split==='boolean' ? value.split : base.split,
    wrap:typeof value.wrap==='boolean' ? value.wrap : base.wrap,
    ignoreWhitespace:typeof value.ignoreWhitespace==='boolean' ? value.ignoreWhitespace : base.ignoreWhitespace,
    fontSize:Number.isInteger(value.fontSize) ? Math.max(10,Math.min(18,value.fontSize)) : base.fontSize,
    fullFile:typeof value.fullFile==='boolean' ? value.fullFile : base.fullFile,
  };
}
function read(key:string,base:DiffPreferences):DiffPreferences|null {
  try {return parse(localStorage.getItem(key),base);} catch {return null;}
}
function write(key:string,value:DiffPreferences):boolean {
  try {localStorage.setItem(key,JSON.stringify(value));} catch {return false;}
  try {window.dispatchEvent(new CustomEvent(CHANGE_EVENT,{detail:key}));} catch {/* no window in tests */}
  return true;
}

export function readGlobalDiffPreferences():DiffPreferences {return read(GLOBAL_KEY,DEFAULT_DIFF_PREFERENCES) ?? DEFAULT_DIFF_PREFERENCES;}
/** No folder id (tool output outside a folder) reads the global defaults. */
export function readDiffPreferences(folderId?:string):DiffPreferences {
  const global=readGlobalDiffPreferences();
  return folderId ? read(folderKey(folderId),global) ?? global : global;
}
export function hasFolderDiffPreferences(folderId:string):boolean {try {return localStorage.getItem(folderKey(folderId))!==null;} catch {return false;}}
export function saveDiffPreferences(folderId:string,value:DiffPreferences):boolean {return write(folderKey(folderId),value);}
export function saveGlobalDiffPreferences(value:DiffPreferences):boolean {return write(GLOBAL_KEY,value);}
function remove(key:string):boolean {
  try {localStorage.removeItem(key);} catch {return false;}
  try {window.dispatchEvent(new CustomEvent(CHANGE_EVENT,{detail:key}));} catch {/* no window in tests */}
  return true;
}
/** PRO-10: drop a folder's own diff settings so it inherits the global defaults again. */
export function clearFolderDiffPreferences(folderId:string):boolean {return remove(folderKey(folderId));}
/** PRO-10: drop the global diff defaults so every folder without its own inherits the built-in values. */
export function clearGlobalDiffPreferences():boolean {return remove(GLOBAL_KEY);}
export function hasGlobalDiffPreferences():boolean {try {return localStorage.getItem(GLOBAL_KEY)!==null;} catch {return false;}}
export function subscribeDiffPreferences(listener:()=>void):()=>void {
  if(typeof window==='undefined')return ()=>{};
  window.addEventListener(CHANGE_EVENT,listener);
  return ()=>window.removeEventListener(CHANGE_EVENT,listener);
}
/** Live preferences for a pane; re-reads when any diff pane saves. */
export function useDiffPreferences(folderId?:string):DiffPreferences {
  const [value,setValue]=useState(()=>readDiffPreferences(folderId));
  useEffect(()=>{
    setValue(readDiffPreferences(folderId));
    return subscribeDiffPreferences(()=>setValue(readDiffPreferences(folderId)));
  },[folderId]);
  return value;
}

interface Viewed {id:string;revision:string}
// Lists ask once per row; parse the stored marks only when the raw value changes.
let viewedCache:{raw:string;rows:Viewed[]}|undefined;
function viewedEntries():Viewed[] {
  try {
    const raw=localStorage.getItem('muster.diff.viewed') || '[]';
    if(viewedCache?.raw===raw)return viewedCache.rows.slice();
    const value=JSON.parse(raw);
    const rows:Viewed[]=Array.isArray(value) ? value.slice(-200).filter(row=>row && typeof row.id==='string' && row.id.length<5000 && typeof row.revision==='string' && /^[a-f0-9]{64}$/.test(row.revision)) : [];
    viewedCache={raw,rows};
    return rows.slice();
  } catch {return [];}
}
export function viewedRevision(id:string):string|undefined {return viewedEntries().find(row=>row.id===id)?.revision;}
export function saveViewedRevision(id:string,revision:string|undefined):boolean {
  try {
    const entries=viewedEntries().filter(row=>row.id!==id);
    if(revision)entries.push({id,revision});
    localStorage.setItem('muster.diff.viewed',JSON.stringify(entries.slice(-200)));return true;
  } catch {return false;}
}

/** Viewed marks are per file and per baseline: a file viewed against HEAD is not viewed against the last agent turn. */
export function reviewViewedKey(folderId:string,path:string,baselineKey:string):string {return `review:${folderId}:${path}@${baselineKey}`;}
export type ViewedState = 'viewed'|'changed'|undefined;
/** 'changed' when the file was viewed at another revision (it changed again since). */
export function viewedState(key:string,revision:string|undefined):ViewedState {
  const saved=viewedRevision(key);
  return !saved||!revision ? undefined : saved===revision ? 'viewed' : 'changed';
}
const VIEWED_EVENT='muster:diff-viewed';
export function saveViewed(key:string,revision:string|undefined):boolean {
  const saved=saveViewedRevision(key,revision);
  try {window.dispatchEvent(new CustomEvent(VIEWED_EVENT));} catch {/* no window in tests */}
  return saved;
}
/** Re-render lists (Changes, turn pill) when any Viewed mark changes. */
export function useViewedVersion():number {
  const [version,setVersion]=useState(0);
  useEffect(()=>{
    if(typeof window==='undefined')return;
    const bump=()=>setVersion(value=>value+1);
    window.addEventListener(VIEWED_EVENT,bump);
    return ()=>window.removeEventListener(VIEWED_EVENT,bump);
  },[]);
  return version;
}
