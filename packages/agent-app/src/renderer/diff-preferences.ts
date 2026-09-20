export interface DiffPreferences {split:boolean;wrap:boolean;ignoreWhitespace:boolean;fontSize:number}
export function readDiffPreferences(folderId:string):DiffPreferences {
  try {
    const value=JSON.parse(localStorage.getItem('muster.diff.preferences:'+folderId) || '{}');
    return {split:value?.split===true,wrap:value?.wrap===true,ignoreWhitespace:value?.ignoreWhitespace===true,fontSize:Number.isInteger(value?.fontSize) ? Math.max(10,Math.min(18,value.fontSize)) : 12};
  } catch {return {split:false,wrap:false,ignoreWhitespace:false,fontSize:12};}
}
interface Viewed {id:string;revision:string}
function viewedEntries():Viewed[] {
  try {
    const value=JSON.parse(localStorage.getItem('muster.diff.viewed') || '[]');
    return Array.isArray(value) ? value.slice(-200).filter(row=>row && typeof row.id==='string' && row.id.length<5000 && typeof row.revision==='string' && /^[a-f0-9]{64}$/.test(row.revision)) : [];
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
