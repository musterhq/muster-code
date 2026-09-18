import type {Folder} from '../../shared/protocol';
export type ResourceReference={folderId:string;path:string;line?:number;absolute:string};
/** Resolve only inside folders belonging to this conversation. Host rechecks realpaths. */
export function resourceReference(href:string,folders:Folder[],primaryId?:string):ResourceReference|null{
 let path:string;try{path=decodeURIComponent(href);}catch{return null;}
 if(/[\u0000-\u001f\u007f]/.test(path)||path.startsWith('//'))return null;
 const suffix=path.match(/(?::|#L)(\d+)(?::\d+|(?:-L?\d+))?$/);
 const line=suffix?Number(suffix[1]):undefined;if(suffix)path=path.slice(0,-suffix[0].length);
 if(path.includes('#')||path.includes('?')||/^[a-z][a-z0-9+.-]*:/i.test(path))return null;
 const absolute=path.startsWith('/');
 let folder=absolute?[...folders].sort((a,b)=>b.path.length-a.path.length).find(f=>path.startsWith(f.path.replace(/\/$/,'')+'/')):folders.find(f=>f.id===primaryId)??(folders.length===1?folders[0]:undefined);
 if(!folder)return null;
 if(absolute)path=path.slice(folder.path.replace(/\/$/,'').length+1);
 const parts:string[]=[];for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return null;parts.pop();}else parts.push(part);}
 if(!parts.length)return null;
 path=parts.join('/');return {folderId:folder.id,path,absolute:folder.path.replace(/\/$/,'')+'/'+path,...(line&&line<=10000000?{line}:{})};
}
